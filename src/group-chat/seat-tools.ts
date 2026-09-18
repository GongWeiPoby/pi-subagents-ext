/**
 * group-chat/seat-tools.ts — room_say / room_tell / handoff / room_pass for seats;
 * host also gets room_tell / handoff / room_cancel / RoomEnsure.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { SUBAGENT_TOOL_NAMES } from "../agent-runner.js";
import { abortSeat, dropQueued, enqueueSeatWork, latestUserHop } from "./runtime.js";
import { GroupStore } from "./store.js";
import type { GroupChatHost, RoomMember } from "./types.js";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function findSeat(host: GroupChatHost, handle: string): RoomMember | undefined {
  const binding = host.readBinding();
  return binding?.members.find(m => m.handle.toLowerCase() === handle.toLowerCase());
}

export function createSeatTools(host: () => GroupChatHost, selfHandle: string) {
  const say = defineTool({
    name: "room_say",
    label: "Room say",
    description: "Post to the shared room log. Naming another seat in this text does not wake them.",
    parameters: Type.Object({ text: Type.String() }, { additionalProperties: false }),
    execute: async (_id, params) => {
      const h = host();
      const binding = h.readBinding();
      if (!binding) return textResult("No active chat room.");
      new GroupStore(h.cwd()).append(binding.roomId, {
        kind: "say",
        role: "assistant",
        handle: selfHandle,
        hop: 0,
        text: params.text,
      });
      h.appendRoomLine({ handle: selfHandle, text: params.text });
      return textResult("Posted.");
    },
  });

  const tell = defineTool({
    name: "room_tell",
    label: "Room tell",
    description: "Wake another seat asynchronously. Does not end your turn. Prose @mentions do not deliver.",
    parameters: Type.Object({
      to: Type.String({ description: "Seat handle or main" }),
      text: Type.String(),
    }, { additionalProperties: false }),
    execute: async (_id, params) => deliver(host(), selfHandle, params.to, params.text, "tell"),
  });

  const handoff = defineTool({
    name: "handoff",
    label: "Handoff",
    description: "Transfer the next stage to another seat, then end this turn. Do not hand back to the sender.",
    parameters: Type.Object({
      to: Type.String(),
      text: Type.String(),
    }, { additionalProperties: false }),
    execute: async (_id, params) => deliver(host(), selfHandle, params.to, params.text, "handoff"),
  });

  const pass = defineTool({
    name: "room_pass",
    label: "Room pass",
    description: "Skip speaking this turn.",
    parameters: Type.Object({ reason: Type.Optional(Type.String()) }, { additionalProperties: false }),
    execute: async (_id, params) => textResult(params.reason?.trim() ? `Passed: ${params.reason}` : "Passed."),
  });

  return [say, tell, handoff, pass];
}

async function deliver(
  h: GroupChatHost,
  from: string,
  toRaw: string,
  text: string,
  kind: "tell" | "handoff",
) {
  const binding = h.readBinding();
  const sessionId = h.sessionId();
  if (!binding || !sessionId) return textResult("No active chat room.");
  const to = toRaw.replace(/^@/, "").trim();
  if (to.toLowerCase() === "main") {
    const store = new GroupStore(h.cwd());
    store.append(binding.roomId, {
      kind,
      role: "assistant",
      handle: from,
      to: ["main"],
      wake: false,
      hop: 0,
      text,
    });
    h.appendRoomLine({ handle: from, text, to: ["main"] });
    return textResult("Noted for the host. The user/host sees this on the next host turn.");
  }
  const seat = findSeat(h, to);
  if (!seat) return textResult(`Unknown seat @${to}.`);
  const store = new GroupStore(h.cwd());
  const room = store.readMeta(binding.roomId);
  if (!room) return textResult("Room metadata missing.");
  const { hop, origin } = latestUserHop(store.readLog(room.id));
  const result = await enqueueSeatWork({
    store,
    room,
    host: h,
    sessionId,
    seat,
    kind,
    from,
    text,
    hop,
    originUserMsg: origin,
  });
  if (!result.ok) return textResult(result.error);
  const note = kind === "handoff"
    ? "Handoff recorded. End this turn without narrating it; the next seat owns the next stage."
    : result.queued ? "Queued; the seat is busy." : "Delivered.";
  return textResult(`${note} id=${result.id}`);
}

export function createHostRoomTools(host: () => GroupChatHost) {
  const tell = defineTool({
    name: "room_tell",
    label: "Room tell",
    description: "Wake a chat-room seat. Naming them in prose does not deliver. Busy seats queue.",
    promptSnippet: "Wake a room seat without ending the host turn",
    parameters: Type.Object({
      to: Type.String(),
      text: Type.String(),
    }, { additionalProperties: false }),
    execute: async (_id, params) => deliver(host(), "main", params.to, params.text, "tell"),
  });

  const handoff = defineTool({
    name: "handoff",
    label: "Handoff",
    description: "Transfer the next stage to a seat. Do not hand a stage back to its sender.",
    promptSnippet: "Hand a room stage to another seat",
    parameters: Type.Object({
      to: Type.String(),
      text: Type.String(),
    }, { additionalProperties: false }),
    execute: async (_id, params) => deliver(host(), "main", params.to, params.text, "handoff"),
  });

  const cancel = defineTool({
    name: "room_cancel",
    label: "Room cancel",
    description: "Drop queued work for a seat. Set running true only to abort the in-flight turn. Do not room_tell a seat to stop.",
    parameters: Type.Object({
      seat: Type.String(),
      id: Type.Optional(Type.String()),
      running: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    execute: async (_id, params) => {
      const h = host();
      const binding = h.readBinding();
      const sessionId = h.sessionId();
      if (!binding || !sessionId) return textResult("No active chat room.");
      const seat = findSeat(h, params.seat.replace(/^@/, ""));
      if (!seat) return textResult(`Unknown seat @${params.seat}.`);
      const dropped = dropQueued(sessionId, seat.handle, params.id);
      const store = new GroupStore(h.cwd());
      for (const item of dropped) {
        store.append(binding.roomId, {
          kind: "cancel",
          role: "system",
          handle: seat.handle,
          hop: item.hop,
          text: `cancelled ${item.kind} ${item.id}`,
        });
      }
      let aborted = false;
      if (params.running) aborted = abortSeat(h, sessionId, seat);
      return textResult(
        `Cancelled ${dropped.length} queued item(s)` +
          (aborted ? "; aborted the running turn." : params.running ? "; no running turn to abort." : "."),
      );
    },
  });

  return [tell, handoff, cancel];
}

export { SUBAGENT_TOOL_NAMES };
