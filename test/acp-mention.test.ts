import { describe, expect, it } from "vitest";
import type { AcpConversation } from "../src/acp/conversation-manager.js";
import { acpMentionTargets, findAcpMentions } from "../src/acp/mention.js";
import type { ApprovedAcpAgent } from "../src/acp/registry.js";

const approvals: ApprovedAcpAgent[] = [
  {
    registryId: "codex-acp",
    displayName: "Codex",
    handle: "acp-codex",
    registryVersion: "1.0.0",
    sourceUrl: "https://example.test/codex",
    command: "npx",
    args: ["codex-acp"],
    staticEnv: {},
    approvedAt: "2026-09-15T00:00:00.000Z",
    enabled: true,
  },
  {
    registryId: "claude-acp",
    displayName: "Claude",
    handle: "acp-claude",
    registryVersion: "1.0.0",
    sourceUrl: "https://example.test/claude",
    command: "npx",
    args: ["claude-acp"],
    staticEnv: {},
    approvedAt: "2026-09-15T00:00:00.000Z",
    enabled: true,
  },
];

const conversation: AcpConversation = {
  id: "conversation-1",
  handle: "acp-codex",
  registryId: "codex-acp",
  displayName: "Codex",
  cwd: "/tmp/project",
  rootSessionId: "root",
  resumeMode: "resume",
  closed: false,
  lastActivityAt: 0,
};

describe("ACP mentions", () => {
  it("finds leading and inline targets in first-seen order and deduplicates", () => {
    expect(findAcpMentions(
      "@acp-codex review, then 请 @acp-claude 修改，再 @acp-codex 复查",
      approvals,
      [],
    )).toEqual([
      { handle: "acp-codex", registryId: "codex-acp" },
      { handle: "acp-claude", registryId: "claude-acp" },
    ]);
  });

  it("supports CJK text directly adjacent to an ACP mention", () => {
    expect(findAcpMentions("让@acp-codex审查", approvals, [])).toEqual([
      { handle: "acp-codex", registryId: "codex-acp" },
    ]);
  });

  it("treats @acp-* as a type mention, not a resume of an existing conversation", () => {
    expect(findAcpMentions("请 @acp-codex 再看一次", approvals, [conversation])).toEqual([
      { handle: "acp-codex", registryId: "codex-acp" },
    ]);
    expect(findAcpMentions("请 @acp-reviewer 再看一次", approvals, [conversation])).toEqual([]);
  });

  it("does not treat emails, file mentions, unknown or disabled handles as ACP targets", () => {
    const disabled = approvals.map(agent => agent.registryId === "claude-acp" ? { ...agent, enabled: false } : agent);
    expect(findAcpMentions(
      "mail x@acp-codex.com, open @src/acp.ts, ask @acp-unknown and @acp-claude",
      disabled,
      [],
    )).toEqual([]);
  });

  it("lists approved type handles, not per-conversation aliases", () => {
    expect(acpMentionTargets(approvals, [conversation]).map(target => target.handle)).toEqual([
      "acp-codex",
      "acp-claude",
    ]);
  });
});
