import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovedAcpAgent } from "../src/acp/registry.js";
import { AcpSessionRuntime } from "../src/acp/runtime.js";

const LIVE = process.env.PI_ACP_LIVE === "1";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const prompt = "Do not use tools or modify files. Reply with exactly ACP_SMOKE_OK and nothing else.";

const agents: ApprovedAcpAgent[] = [
  {
    registryId: "codex-acp",
    displayName: "Codex",
    handle: "acp-codex",
    registryVersion: "1.12.0",
    sourceUrl: "https://github.com/agentclientprotocol/codex-acp",
    command: npx,
    args: ["-y", "@agentclientprotocol/codex-acp@1.12.0"],
    staticEnv: {},
    approvedAt: "2026-09-15T00:00:00.000Z",
    enabled: true,
  },
  {
    registryId: "claude-acp",
    displayName: "Claude Agent",
    handle: "acp-claude",
    registryVersion: "0.78.0",
    sourceUrl: "https://github.com/agentclientprotocol/claude-agent-acp",
    command: npx,
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.78.0"],
    staticEnv: {},
    approvedAt: "2026-09-15T00:00:00.000Z",
    enabled: true,
  },
];

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!LIVE)("real ACP adapters", () => {
  for (const approval of agents) {
    it(`${approval.displayName} initializes and completes a prompt`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), `pi-acp-live-${approval.registryId}-`));
      tempDirs.push(cwd);
      // The normal unit-test setup redirects HOME so tests cannot touch real Pi
      // state. This opt-in compatibility test must instead exercise the native
      // adapters against the caller's actual CLI credential/config directories.
      const realHome = userInfo().homedir;
      const savedHome = process.env.HOME;
      const savedUserProfile = process.env.USERPROFILE;
      const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.HOME = realHome;
      process.env.USERPROFILE = realHome;
      delete process.env.PI_CODING_AGENT_DIR;
      let runtime: AcpSessionRuntime;
      try {
        runtime = await AcpSessionRuntime.start({
          approval,
          cwd,
          signal: AbortSignal.timeout(120_000),
        });
      } finally {
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
        if (savedUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = savedUserProfile;
        if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
      }
      try {
        const result = await runtime.run(prompt, {}, AbortSignal.timeout(180_000));
        expect(result.stopReason).toBe("end_turn");
        expect(result.text).toContain("ACP_SMOKE_OK");
      } finally {
        await runtime.close();
      }
    }, 310_000);
  }
});
