import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ApprovedAcpAgent,
  catalogAcpAgents,
  deriveAcpHandle,
  launchCandidateFor,
  loadAcpApprovals,
  parseAcpRegistry,
  removeAcpApproval,
  upsertAcpApproval,
} from "../src/acp/registry.js";

describe("ACP registry and approvals", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-acp-registry-"));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  const approval = (overrides: Partial<ApprovedAcpAgent> = {}): ApprovedAcpAgent => ({
    registryId: "codex-acp",
    displayName: "Codex",
    handle: "acp-codex",
    registryVersion: "1.2.3",
    sourceUrl: "https://example.test/codex",
    command: "npx",
    args: ["@agentclientprotocol/codex-acp@1.2.3"],
    staticEnv: { DISABLE_UPDATE: "1" },
    approvedAt: "2026-09-15T00:00:00.000Z",
    enabled: true,
    ...overrides,
  });

  it("derives stable acp-prefixed handles", () => {
    expect(deriveAcpHandle("codex-acp")).toBe("acp-codex");
    expect(deriveAcpHandle("gemini")).toBe("acp-gemini");
  });

  it("round-trips machine approvals and rejects duplicate handles", () => {
    expect(upsertAcpApproval(approval(), agentDir).ok).toBe(true);
    expect(loadAcpApprovals(agentDir).agents).toEqual([approval()]);

    const conflict = upsertAcpApproval(approval({ registryId: "other", displayName: "Other" }), agentDir);
    expect(conflict).toEqual({ ok: false, error: "Handle @acp-codex is already approved for codex-acp." });
  });

  it("removes an approval without touching other entries", () => {
    expect(upsertAcpApproval(approval(), agentDir).ok).toBe(true);
    expect(upsertAcpApproval(approval({
      registryId: "claude-acp",
      displayName: "Claude",
      handle: "acp-claude",
    }), agentDir).ok).toBe(true);
    expect(removeAcpApproval("codex-acp", agentDir)).toBe(true);
    expect(loadAcpApprovals(agentDir).agents.map(agent => agent.registryId)).toEqual(["claude-acp"]);
  });

  it("fails closed on malformed approvals", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(join(agentDir, "acp-agents.json"), "not json");
    expect(loadAcpApprovals(agentDir)).toEqual({ version: 1, agents: [] });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("parses registry entries and builds pinned npx candidates", () => {
    const registry = parseAcpRegistry({
      version: "1.0.0",
      agents: [{
        id: "codex-acp",
        name: "Codex",
        version: "1.11.0",
        description: "Codex adapter",
        repository: "https://example.test/codex",
        distribution: {
          npx: {
            package: "@agentclientprotocol/codex-acp@1.11.0",
            args: ["--flag"],
            env: { TEST: "1" },
          },
        },
      }],
    });
    expect(registry.agents).toHaveLength(1);
    expect(launchCandidateFor(registry.agents[0], agentDir)).toMatchObject({
      registryId: "codex-acp",
      command: process.platform === "win32" ? "npx.cmd" : "npx",
      args: ["--prefix", agentDir, "-y", "@agentclientprotocol/codex-acp@1.11.0", "--flag"],
      staticEnv: { TEST: "1" },
      requiresInstalledBinary: false,
    });
  });

  it("builds installable binary candidates and rejects malformed identity metadata", () => {
    const platform = process.platform === "darwin" ? "darwin"
      : process.platform === "linux" ? "linux"
        : process.platform === "win32" ? "windows"
          : "unsupported";
    const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : "unsupported";
    const target = `${platform}-${arch}`;
    const registry = parseAcpRegistry({
      version: "1.0.0",
      agents: [
        {
          id: "binary-agent",
          name: "Binary Agent",
          version: "2.0.0",
          description: "Binary fixture",
          distribution: {
            binary: {
              [target]: {
                archive: "https://example.test/agent.tar.gz",
                cmd: "./agent",
                sha256: "A".repeat(64),
              },
            },
          },
        },
        {
          id: "../invalid",
          name: "Invalid",
          version: "1",
          description: "invalid id",
          distribution: { npx: { package: "invalid@1" } },
        },
        {
          id: "bad-hash",
          name: "Bad Hash",
          version: "1",
          description: "invalid hash",
          distribution: {
            binary: {
              [target]: { archive: "https://example.test/agent", cmd: "./agent", sha256: "bad" },
            },
          },
        },
      ],
    });

    expect(registry.agents.map(agent => agent.id)).toEqual(["binary-agent"]);
    expect(launchCandidateFor(registry.agents[0], agentDir)).toMatchObject({
      distribution: "binary",
      archive: "https://example.test/agent.tar.gz",
      sha256: "a".repeat(64),
      requiresInstalledBinary: true,
    });
  });

  it("lists Codeg's 15 built-ins, including Kimi Code", () => {
    expect(catalogAcpAgents().map(agent => agent.id)).toEqual([
      "claude-acp",
      "codex-acp",
      "gemini",
      "openclaw-acp",
      "opencode",
      "cline",
      "hermes",
      "codebuddy-code",
      "kimi-code",
      "pi-acp",
      "grok-build",
      "cursor",
      "deepseek-acp",
      "qoder-cli",
      "antigravity-acp",
    ]);
    const kimi = catalogAcpAgents().find(agent => agent.id === "kimi-code");
    expect(kimi?.distribution.npx?.package).toBe("@moonshot-ai/kimi-code@0.42.0");
    expect(kimi?.distribution.npx?.args).toEqual(["acp"]);
  });
});
