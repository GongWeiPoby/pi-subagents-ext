/**
 * group-chat/runtime.ts — Per-process seat queues. Binding is on the Pi session.
 */

import { describeMention, handleBase } from "../mention.js";
import { seatPrompt } from "./prompts.js";
import { GroupStore } from "./store.js";
import type { GroupChatHost, LogLine, QueuedWake, RoomBinding, RoomMember, RoomMeta } from "./types.js";
import { MAX_HOP } from "./types.js";

interface SeatState {
  inFlight?: string;
  lastFrom?: string;
  currentHop?: number;
  queue: QueuedWake[];
  draining?: boolean;
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
      try {
        const snapshot = await runSeat(host, room, member, prompt);
        const reply = snapshot.result?.trim() || snapshot.error || `(${snapshot.status})`;
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
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        store.append(room.id, {
          kind: "system",
          role: "system",
          handle: member.handle,
          hop: item.hop,
          text: error,
        });
        host.appendRoomLine({ handle: member.handle, text: error });
      } finally {
        state.inFlight = undefined;
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
): Promise<import("./types.js").AgentSnapshot> {
  const byId = member.agentId ? host.getRecord(member.agentId) : undefined;
  const live = byId ?? host.resolveLive(member.handle);
  const tools = host.seatTools(member.handle);
  if (live?.hasSession && live.status !== "running" && live.status !== "queued") {
    const resumed = await host.resume(live.id, prompt, { customTools: tools });
    if (resumed) return resumed;
  }
  return host.spawn(member.type, prompt, {
    description: describeMention(`room ${room.name}`),
    customTools: tools,
    ...(handleBase(member.type) === member.handle ? {} : { name: member.handle }),
  });
}

export function abortSeat(host: GroupChatHost, sessionId: string, member: RoomMember): boolean {
  const state = stateFor(sessionId, member.handle);
  const id = state.inFlight ? member.agentId : undefined;
  if (!id && !member.agentId) return false;
  const target = member.agentId ?? id;
  if (!target) return false;
  const ok = host.abort(target);
  if (ok) state.inFlight = undefined;
  return ok;
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
