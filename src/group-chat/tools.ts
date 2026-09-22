/**
 * group-chat/tools.ts — Host-facing RoomEnsure / RoomLeave plus tell/handoff/cancel.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { SUBAGENT_TOOL_NAMES } from "../agent-runner.js";
import { parseMemberSpecs } from "./commands.js";
import { bindingFromRoom } from "./runtime.js";
import { createHostRoomTools } from "./seat-tools.js";
import { GroupStore } from "./store.js";
import type { GroupChatHost } from "./types.js";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

export function registerRoomTools(pi: ExtensionAPI, host: () => GroupChatHost): void {
  pi.registerTool({
    name: SUBAGENT_TOOL_NAMES.ROOM_JOIN,
    label: "Room Ensure",
    description:
      "Turn this Pi session into a hosted chat room. Members are user-defined agent types (1-6). The main model is the host. Use /chat off or RoomLeave to leave.",
    promptSnippet: "Open a hosted multi-agent chat room on this session",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Room display name." })),
      members: Type.String({
        description: "Comma- or space-separated agent types. Required when creating.",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const h = host();
      const store = new GroupStore(ctx.cwd);
      const members = parseMemberSpecs(params.members, spec => h.resolveType(spec));
      const existing = params.name ? store.find(params.name) : undefined;
      const room = existing ?? store.create(params.name?.trim() || members.map(m => m.handle).join("-"), members);
      if (existing) {
        existing.members = members;
        store.writeMeta(existing);
      }
      h.appendBinding(bindingFromRoom(room));
      return textResult(`Chat on. Room ${room.name} (${room.id}). Seats: ${room.members.map(m => `@${m.handle}`).join(", ")}. Bare user text reaches you as host; call room_tell or handoff to wake a seat.`);
    },
  });

  pi.registerTool({
    name: SUBAGENT_TOOL_NAMES.ROOM_LEAVE,
    label: "Room Leave",
    description: "Turn chat mode off for this session. Queued seat work is dropped; running turns keep going.",
    promptSnippet: "Leave the hosted chat room",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      const h = host();
      const sessionId = h.sessionId();
      if (sessionId) {
        const { dropAllQueued } = await import("./runtime.js");
        dropAllQueued(sessionId);
      }
      h.appendBinding(null);
      return textResult("Chat off. Submits go to the main model.");
    },
  });

  for (const tool of createHostRoomTools(host)) {
    pi.registerTool(tool);
  }
}
