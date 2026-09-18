/**
 * group-chat/wake.ts — Who a chat-on message addresses.
 *
 * No @ → host only. @handle → those seats. @everyone → all seats. @main → host.
 */

import { isReservedHandle } from "../mention.js";
import type { RoomMember } from "./types.js";

const INLINE_HANDLE = /(^|[\s。、？！])@([\w-]+)/g;

export function extractMentionHandles(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(INLINE_HANDLE)) {
    const handle = match[2];
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(handle);
  }
  return found;
}

export type WakeKind = "host" | "seats" | "everyone" | "none";

export interface WakePlan {
  kind: WakeKind;
  seats: RoomMember[];
  host: boolean;
  everyone: boolean;
}

export function planWake(text: string, members: readonly RoomMember[]): WakePlan {
  const mentioned = extractMentionHandles(text);
  if (mentioned.length === 0) return { kind: "host", seats: [], host: true, everyone: false };

  const everyone = mentioned.some(h => h.toLowerCase() === "everyone");
  if (everyone) return { kind: "everyone", seats: [...members], host: false, everyone: true };

  const wanted = new Set(mentioned.map(h => h.toLowerCase()).filter(h => h !== "main"));
  const seats = members.filter(m => wanted.has(m.handle.toLowerCase()));
  const host = mentioned.some(h => isReservedHandle(h));
  if (seats.length === 0 && !host) return { kind: "none", seats: [], host: true, everyone: false };
  if (seats.length === 0) return { kind: "host", seats: [], host: true, everyone: false };
  return { kind: "seats", seats, host, everyone: false };
}

/** @deprecated tests still import the old name; host-only when no @. */
export function selectWokenMembers(text: string, members: readonly RoomMember[]): RoomMember[] {
  return planWake(text, members).seats;
}
