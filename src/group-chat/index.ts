/**
 * group-chat/index.ts — Hosted chat rooms: /chat, RoomEnsure, seat bus.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRoomCommand } from "./commands.js";
import { registerRoomTools } from "./tools.js";
import type { GroupChatHost } from "./types.js";

export { hasAcpMention, restoreRoomStatus, tryHandleRoomInput } from "./commands.js";
export { hostPrompt } from "./prompts.js";
export { dropAllQueued, isInFlight, queuedCount } from "./runtime.js";
export { createSeatTools } from "./seat-tools.js";
export { GroupStore } from "./store.js";
export type { AgentSnapshot, GroupChatHost, RoomBinding } from "./types.js";
export { MAX_HOP, MAX_SEATS, ROOM_ENTRY_TYPE, ROOM_LINE_ENTRY_TYPE } from "./types.js";
export { extractMentionHandles, planWake, selectWokenMembers } from "./wake.js";

export function registerGroupChat(pi: ExtensionAPI, host: () => GroupChatHost): void {
  registerRoomCommand(pi, host);
  registerRoomTools(pi, host);
}
