/**
 * group-chat/commands.ts — /chat on|off, /room, session binding, input hook.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findAcpMentions } from "../acp/mention.js";
import { loadAcpApprovals } from "../acp/registry.js";
import { assignHandle, handleBase } from "../mention.js";
import { bindingFromRoom, dropAllQueued, enqueueSeatWork } from "./runtime.js";
import { GroupStore } from "./store.js";
import { type GroupChatHost, MAX_SEATS, type RoomBinding, type RoomMember, type RoomMeta } from "./types.js";
import { planWake } from "./wake.js";

export function parseMemberSpecs(spec: string, resolveType: (token: string) => string | undefined): RoomMember[] {
  const tokens = spec.split(/[,\s]+/).map(token => token.trim()).filter(Boolean);
  const taken = new Set<string>();
  const members: RoomMember[] = [];
  for (const token of tokens) {
    const type = resolveType(token);
    if (!type) throw new Error(`Unknown agent type: ${token}`);
    const handle = assignHandle(handleBase(type), taken);
    taken.add(handle);
    members.push({ handle, type });
  }
  if (members.length === 0) throw new Error("Name at least one agent type.");
  if (members.length > MAX_SEATS) throw new Error(`At most ${MAX_SEATS} seats.`);
  return members;
}

function report(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(text, level);
  else console.warn(`[pi-subagents] ${text}`);
}

function describeRoom(room: RoomMeta, binding: RoomBinding | null): string {
  const on = binding?.roomId === room.id ? "chat on · " : "";
  return `${on}${room.name} (${room.id}) — ${room.members.map(m => `@${m.handle} (${m.type})`).join(", ")}`;
}

export function restoreRoomStatus(ctx: ExtensionContext, host: GroupChatHost): void {
  if (!ctx.hasUI) return;
  const binding = host.readBinding();
  ctx.ui.setStatus("subagents:room", binding ? `chat: on · ${binding.roomId}` : undefined);
}

function activate(ctx: ExtensionContext, host: GroupChatHost, room: RoomMeta): void {
  host.appendBinding(bindingFromRoom(room));
  restoreRoomStatus(ctx, host);
}

function deactivate(ctx: ExtensionContext, host: GroupChatHost, dropQueue: boolean): void {
  const sessionId = host.sessionId();
  if (dropQueue && sessionId) dropAllQueued(sessionId);
  host.appendBinding(null);
  restoreRoomStatus(ctx, host);
}

export function tryHandleRoomInput(
  event: { text: string; source?: string },
  ctx: ExtensionContext,
  host: GroupChatHost,
): { action: "continue" | "handled"; text?: string } | undefined {
  if (event.source === "extension") return undefined;
  const text = event.text.trim();
  if (!text) return undefined;
  const binding = host.readBinding();
  if (!binding) return undefined;

  const store = new GroupStore(ctx.cwd);
  const room = store.readMeta(binding.roomId);
  if (!room) {
    host.appendBinding(null);
    restoreRoomStatus(ctx, host);
    return undefined;
  }

  const userLine = store.append(room.id, { kind: "user", role: "user", hop: 0, text: event.text });
  const plan = planWake(event.text, room.members);
  const sessionId = host.sessionId();
  if (!sessionId) return undefined;

  if (plan.kind === "seats" || plan.kind === "everyone") {
    for (const seat of plan.seats) {
      void enqueueSeatWork({
        store,
        room,
        host,
        sessionId,
        seat,
        kind: "tell",
        from: "main",
        text: event.text,
        hop: 0,
        originUserMsg: userLine.id,
      });
    }
    host.appendRoomLine({ handle: "user", text: event.text, to: plan.seats.map(s => s.handle) });
  }

  if (plan.host || plan.kind === "host" || plan.kind === "none") {
    return { action: "continue" };
  }
  report(ctx, `Posted to ${room.name} (${plan.seats.map(s => `@${s.handle}`).join(", ")}). Host is not running this turn.`);
  return { action: "handled" };
}

export function hasAcpMention(text: string): boolean {
  try {
    return findAcpMentions(text, loadAcpApprovals().agents, []).length > 0;
  } catch {
    return false;
  }
}

export function registerRoomCommand(pi: ExtensionAPI, host: () => GroupChatHost): void {
  const usage = [
    "/chat on <type> [type...]  — this session becomes a chat room (host = main)",
    "/chat off                  — leave chat mode",
    "/room list | status | leave",
    "/room create <name> <type> [type...]",
  ].join("\n");

  const handle = async (raw: string, ctx: ExtensionCommandContext, fromChat: boolean) => {
    const h = host();
    const store = new GroupStore(ctx.cwd);
    const [verb, ...rest] = raw.trim().split(/\s+/);
    const tail = rest.join(" ");
    try {
      if (fromChat && verb && verb !== "off" && verb !== "leave" && verb !== "status" && verb !== "show" && verb !== "list") {
        const specs = verb === "on" ? tail : raw.trim();
        if (!specs) throw new Error("Usage: /chat on <type> [type...]");
        const members = parseMemberSpecs(specs, spec => h.resolveType(spec));
        const room = store.create(members.map(m => m.handle).join("-"), members);
        activate(ctx, h, room);
        report(ctx, `Chat on. ${describeRoom(room, h.readBinding())}`);
        return;
      }
      if (fromChat && (verb === "off" || verb === "leave")) {
        deactivate(ctx, h, true);
        report(ctx, "Chat off. Submits go to the main model.");
        return;
      }
      if (!verb || verb === "status" || verb === "show") {
        const binding = h.readBinding();
        const room = binding ? store.readMeta(binding.roomId) : undefined;
        report(ctx, room ? describeRoom(room, binding) : `Chat off.\n${usage}`);
        restoreRoomStatus(ctx, h);
        return;
      }
      if (verb === "list") {
        const rooms = store.list();
        const binding = h.readBinding();
        report(ctx, rooms.length
          ? rooms.map(room => `${room.id === binding?.roomId ? "* " : "  "}${describeRoom(room, binding)}`).join("\n")
          : "No rooms yet. /chat on <type> [type...]");
        return;
      }
      if (verb === "leave" || verb === "off") {
        deactivate(ctx, h, true);
        report(ctx, "Chat off. Submits go to the main model.");
        return;
      }
      if (verb === "create") {
        const [name, ...memberTokens] = rest;
        if (!name || memberTokens.length === 0) throw new Error("Usage: /room create <name> <type> [type...]");
        const members = parseMemberSpecs(memberTokens.join(" "), spec => h.resolveType(spec));
        const room = store.create(name, members);
        activate(ctx, h, room);
        report(ctx, `Chat on. ${describeRoom(room, h.readBinding())}`);
        return;
      }
      if (verb === "on") {
        const members = parseMemberSpecs(tail, spec => h.resolveType(spec));
        const room = store.create("chat", members);
        activate(ctx, h, room);
        report(ctx, `Chat on. ${describeRoom(room, h.readBinding())}`);
        return;
      }
      throw new Error(`Unknown subcommand: ${verb}\n${usage}`);
    } catch (err) {
      report(ctx, err instanceof Error ? err.message : String(err), "error");
    }
  };

  pi.registerCommand("chat", {
    description: "Turn this session into a hosted chat room: on <types>, off",
    handler: async (args, ctx) => handle(args.trim() ? args : "status", ctx, true),
  });
  pi.registerCommand("room", {
    description: "Group chat roster: create, list, leave, status",
    handler: async (args, ctx) => handle(args, ctx, false),
  });
}


