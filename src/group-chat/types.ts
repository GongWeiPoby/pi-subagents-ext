/**
 * group-chat/types.ts — Room metadata, log lines, and host seams.
 */

export const ROOM_ENTRY_TYPE = "subagents:room";
export const ROOM_LINE_ENTRY_TYPE = "subagents:room-line";
export const MAX_SEATS = 6;
export const MAX_HOP = 3;
export const TRANSCRIPT_CAP = 40;
/** Extra attempts after the first failure (11 runs total). */
export const SEAT_RETRY_LIMIT = 10;

export interface RoomMember {
  handle: string;
  type: string;
  agentId?: string;
}

export interface RoomMeta {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  members: RoomMember[];
}

export type LogKind = "user" | "say" | "tell" | "handoff" | "system" | "cancel";

export interface LogLine {
  id: string;
  ts: string;
  kind: LogKind;
  role: "user" | "assistant" | "system";
  handle?: string;
  to?: string[];
  wake?: boolean;
  hop: number;
  originUserMsg?: string;
  text: string;
}

export interface RoomBinding {
  roomId: string;
  leader: "main";
  wakeDefault: "host";
  chat: true;
  members: RoomMember[];
}

export interface AgentSnapshot {
  id: string;
  handle?: string;
  alias?: string;
  status: string;
  result?: string;
  error?: string;
  hasSession: boolean;
}

export interface LiveAgentRef {
  id: string;
  status: string;
  hasSession: boolean;
}

export interface QueuedWake {
  id: string;
  seat: string;
  kind: "tell" | "handoff";
  from: string;
  text: string;
  hop: number;
  originUserMsg?: string;
}

export interface GroupChatHost {
  spawn(type: string, prompt: string, options: { description: string; name?: string; model?: string; customTools?: import("@earendil-works/pi-coding-agent").ToolDefinition[] }): Promise<AgentSnapshot>;
  resume(id: string, prompt: string, options?: { customTools?: import("@earendil-works/pi-coding-agent").ToolDefinition[] }): Promise<AgentSnapshot | undefined>;
  abort(id: string): boolean;
  resolveLive(handle: string): LiveAgentRef | undefined;
  getRecord(id: string): LiveAgentRef | undefined;
  resolveType(spec: string): string | undefined;
  sessionId(): string | undefined;
  appendBinding(binding: RoomBinding | null): void;
  readBinding(): RoomBinding | null;
  appendRoomLine(line: { handle: string; text: string; to?: string[] }): void;
  seatTools(handle: string): import("@earendil-works/pi-coding-agent").ToolDefinition[];
  /** Model key this seat starts on (`provider/modelId`). */
  modelFor(type: string): string | undefined;
  modelFallbacks(): Record<string, string>;
  cwd(): string;
}
