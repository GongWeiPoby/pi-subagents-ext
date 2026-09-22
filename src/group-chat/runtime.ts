/**
 * group-chat/runtime.ts — Per-process seat queues. Binding is on the Pi session.
 */

import { describeMention, handleBase } from "../mention.js";
import { nextModelFallback } from "../model-fallback.js";
import { seatPrompt } from "./prompts.js";
import { GroupStore } from "./store.js";
import type { AgentSnapshot, GroupChatHost, LogLine, QueuedWake, RoomBinding, RoomMember, RoomMeta } from "./types.js";
import { MAX_HOP, SEAT_RETRY_LIMIT } from "./types.js";

interface SeatState {
  inFlight?: string;
  lastFrom?: string;
  currentHop?: number;
  queue: QueuedWake[];
  draining?: boolean;
  cancelled?: boolean;
}

const seats = new Map<string, SeatState>();

function seatKey(sessionId: string, handle: string): string {
  return `${sessionId}:${handle.toLowerCase()}`;
}

function stateFor(sessionId: string, handle: string): SeatState {
  const key = seatKey(sessionId, handle);
  let state = seats.get(key);
  if (!state) {
    state = { queue: [] };
    seats.set(key, state);
  }
  return state;
}

export function queuedCount(sessionId: string, handle: string): number {
  return stateFor(sessionId, handle).queue.length;
}

export function isInFlight(sessionId: string, handle: string): boolean {
  return stateFor(sessionId, handle).inFlight !== undefined;
}

export function dropQueued(sessionId: string, handle: string, id?: string): QueuedWake[] {
  const state = stateFor(sessionId, handle);
  if (!id) {
    const dropped = state.queue;
    state.queue = [];
    return dropped;
  }
  const dropped = state.queue.filter(item => item.id === id);
  state.queue = state.queue.filter(item => item.id !== id);
  return dropped;
}

export function dropAllQueued(sessionId: string): QueuedWake[] {
  const dropped: QueuedWake[] = [];
  for (const [key, state] of seats) {
    if (!key.startsWith(`${sessionId}:`)) continue;
    dropped.push(...state.queue);
    state.queue = [];
  }
  return dropped;
}

function nextHop(fromHop: number): number {
  return fromHop > 0 ? fromHop + 1 : 1;
}

export function hopExhausted(hop: number): boolean {
  return hop > MAX_HOP;
}

const FATAL =
  /stopped by the user|not approved|unknown agent type|cannot hand off|hop limit|do not hand this stage|^aborted$/i;

export function isRetryableSeatError(message: string): boolean {
  return !FATAL.test(message);
}

export function seatRetryDelayMs(retry: number): number {
  return Math.min(32_000, 2_000 * 2 ** (retry - 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function failedSnapshot(snapshot: AgentSnapshot): string | undefined {
  if (snapshot.status === "error" || snapshot.status === "stopped" || snapshot.status === "aborted") {
    return snapshot.error?.trim() || snapshot.status;
  }
  return undefined;
}

export async function enqueueSeatWork(opts: {
  store: GroupStore;
  room: RoomMeta;
  host: GroupChatHost;
  sessionId: string;
  seat: RoomMember;
  kind: "tell" | "handoff";
  from: string;
  text: string;
  hop: number;
  originUserMsg?: string;
}): Promise<{ ok: true; queued: boolean; id: string } | { ok: false; error: string }> {
  if (opts.seat.handle.toLowerCase() === opts.from.toLowerCase()) {
    return { ok: false, error: "cannot hand off to yourself" };
  }
  const sourceLast = opts.from === "main" ? undefined : stateFor(opts.sessionId, opts.from).lastFrom;
  if (opts.kind === "handoff" && sourceLast && sourceLast.toLowerCase() === opts.seat.handle.toLowerCase()) {
    return { ok: false, error: "do not hand this stage back to its sender; post the result with room_say instead" };
  }
  const hop = nextHop(opts.hop);
  if (hopExhausted(hop)) {
    return { ok: false, error: `group hop limit ${MAX_HOP} reached; finish in the shared log instead` };
  }
  const line = opts.store.append(opts.room.id, {
    kind: opts.kind,
    role: "assistant",
    handle: opts.from,
    to: [opts.seat.handle],
    wake: true,
    hop,
    text: opts.text,
    originUserMsg: opts.originUserMsg,
  });
  const state = stateFor(opts.sessionId, opts.seat.handle);
  const item: QueuedWake = {
    id: line.id,
    seat: opts.seat.handle,
    kind: opts.kind,
    from: opts.from,
    text: opts.text,
    hop,
    originUserMsg: opts.originUserMsg,
  };
  const busy = Boolean(state.inFlight) || state.queue.length > 0 || Boolean(state.draining);
  state.queue.push(item);
  void drainSeat(opts.store, opts.room, opts.host, opts.sessionId, opts.seat);
  return { ok: true, queued: busy, id: line.id };
}

async function drainSeat(
  store: GroupStore,
  room: RoomMeta,
  host: GroupChatHost,
  sessionId: string,
  member: RoomMember,
): Promise<void> {
  const state = stateFor(sessionId, member.handle);
  if (state.draining) return;
  state.draining = true;
  try {
    while (state.queue.length > 0) {
      const item = state.queue.shift();
      if (!item) break;
      state.inFlight = item.id;
      state.lastFrom = item.from;
      state.currentHop = item.hop;
      const lines = store.readLog(room.id);
      const prompt = seatPrompt(room, member.handle, lines);
      let modelOverride: string | undefined;
      const triedModels = new Set<string>();
      try {
        while (true) {
        let lastError: string | undefined;
        let snapshot: AgentSnapshot | undefined;
        for (let attempt = 0; attempt <= SEAT_RETRY_LIMIT; attempt++) {
          if (state.cancelled) {
            lastError = lastError || "aborted";
            snapshot = undefined;
            break;
          }
          if (attempt > 0) {
            store.append(room.id, {
              kind: "system",
              role: "system",
              handle: member.handle,
              hop: item.hop,
              text: `retry ${attempt}/${SEAT_RETRY_LIMIT} after: ${lastError}`,
            });
            await sleep(seatRetryDelayMs(attempt));
            if (state.cancelled) {
              lastError = "aborted";
              snapshot = undefined;
              break;
            }
          }
          try {
            snapshot = await runSeat(host, room, member, prompt, modelOverride);
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            if (!isRetryableSeatError(lastError) || attempt === SEAT_RETRY_LIMIT) break;
            continue;
          }
          lastError = failedSnapshot(snapshot);
          if (!lastError) break;
          if (!isRetryableSeatError(lastError) || attempt === SEAT_RETRY_LIMIT) break;
        }
        if (snapshot && !lastError) {
          const reply = snapshot.result?.trim() || `(${snapshot.status})`;
          store.append(room.id, {
            kind: "say",
            role: "assistant",
            handle: member.handle,
            hop: item.hop,
            originUserMsg: item.originUserMsg,
            text: reply,
          });
          host.appendRoomLine({ handle: member.handle, text: reply, to: item.kind === "handoff" ? [item.seat] : undefined });
          if (snapshot.id && snapshot.id !== member.agentId) {
            member.agentId = snapshot.id;
            store.writeMeta(room);
            const binding = host.readBinding();
            if (binding && binding.roomId === room.id) {
              const seat = binding.members.find(m => m.handle === member.handle);
              if (seat) seat.agentId = snapshot.id;
              host.appendBinding(binding);
            }
          }
          break;
        }
        const current = modelOverride ?? host.modelFor(member.type);
        if (current) triedModels.add(current);
        const next = lastError && isRetryableSeatError(lastError) && !state.cancelled && current
          ? nextModelFallback(current, host.modelFallbacks(), triedModels)
          : undefined;
        if (!next) {
          const error = lastError || "seat turn failed";
          store.append(room.id, {
            kind: "system",
            role: "system",
            handle: member.handle,
            hop: item.hop,
            text: error,
          });
          host.appendRoomLine({ handle: member.handle, text: error });
          break;
        }
        modelOverride = next;
        store.append(room.id, {
          kind: "system",
          role: "system",
          handle: member.handle,
          hop: item.hop,
          text: `switching to ${next} after: ${lastError}`,
        });
        }
      } finally {
        state.inFlight = undefined;
        state.cancelled = false;
      }
    }
  } finally {
    state.draining = false;
  }
}

async function runSeat(
  host: GroupChatHost,
  room: RoomMeta,
  member: RoomMember,
  prompt: string,
  model?: string,
): Promise<import("./types.js").AgentSnapshot> {
  const byId = !model && member.agentId ? host.getRecord(member.agentId) : undefined;
  const live = model ? undefined : byId ?? host.resolveLive(member.handle);
  const tools = host.seatTools(member.handle);
  if (live?.hasSession && live.status !== "running" && live.status !== "queued") {
    const resumed = await host.resume(live.id, prompt, { customTools: tools });
    if (resumed) return resumed;
  }
  return host.spawn(member.type, prompt, {
    description: describeMention(`room ${room.name}`),
    customTools: tools,
    ...(model ? { model } : {}),
    ...(handleBase(member.type) === member.handle ? {} : { name: member.handle }),
  });
}

export function abortSeat(host: GroupChatHost, sessionId: string, member: RoomMember): boolean {
  const state = stateFor(sessionId, member.handle);
  state.cancelled = true;
  const target = member.agentId;
  if (!target) return Boolean(state.inFlight || state.draining);
  return host.abort(target);
}

export function bindingFromRoom(room: RoomMeta): RoomBinding {
  return {
    roomId: room.id,
    leader: "main",
    wakeDefault: "host",
    chat: true,
    members: room.members,
  };
}

export function latestUserHop(lines: readonly LogLine[]): { hop: number; origin?: string } {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].kind === "user") return { hop: lines[i].hop, origin: lines[i].id };
  }
  return { hop: 0 };
}
