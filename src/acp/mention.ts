import type { MentionTarget } from "../ui/agent-mention.js";
import type { AcpConversation } from "./conversation-manager.js";
import type { ApprovedAcpAgent } from "./registry.js";

export interface AcpMentionRouteTarget {
  handle: string;
  registryId: string;
  resume?: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function acpMentionTargets(
  approvals: readonly ApprovedAcpAgent[],
  conversations: readonly AcpConversation[],
): MentionTarget[] {
  const enabled = new Map(
    approvals.filter(approval => approval.enabled).map(approval => [approval.registryId, approval]),
  );
  const running = new Set(
    conversations
      .filter(conversation => !conversation.closed && conversation.activeAttemptId !== undefined)
      .map(conversation => conversation.registryId),
  );
  return [...enabled.values()].map(approval => ({
    kind: "acp" as const,
    handle: approval.handle,
    registryId: approval.registryId,
    description: approval.displayName,
    running: running.has(approval.registryId),
  }));
}

export function findAcpMentions(
  text: string,
  approvals: readonly ApprovedAcpAgent[],
  _conversations: readonly AcpConversation[] = [],
): AcpMentionRouteTarget[] {
  const approved = new Map(
    approvals.filter(approval => approval.enabled).map(approval => [approval.handle.toLowerCase(), approval]),
  );
  const byHandle = new Map<string, AcpMentionRouteTarget>();
  for (const [handle, approval] of approved) {
    byHandle.set(handle, { handle: approval.handle, registryId: approval.registryId });
  }
  if (byHandle.size === 0) return [];

  const handles = [...byHandle.keys()].sort((left, right) => right.length - left.length).map(escapeRegex);
  const cjk = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\p{Script=Bopomofo}";
  const pattern = new RegExp(
    `(^|[\\s。、？！${cjk}])@(${handles.join("|")})(?=$|[\\s.,;:!?，。；：！？、${cjk}])`,
    "giu",
  );
  const found: AcpMentionRouteTarget[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const handle = match[2].toLowerCase();
    if (seen.has(handle)) continue;
    const target = byHandle.get(handle);
    if (!target) continue;
    seen.add(handle);
    found.push(target);
  }
  return found;
}
