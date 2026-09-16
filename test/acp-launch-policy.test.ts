import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAdapterLaunchEnv,
  codexInitialAgentModeFromToml,
  cursorLaunchArgs,
  grokLaunchArgs,
  grokPermissionModeFromToml,
  launchArgsFor,
} from "../src/acp/launch-policy.js";
import type { ApprovedAcpAgent } from "../src/acp/registry.js";

const approval = (over: Partial<ApprovedAcpAgent> = {}): ApprovedAcpAgent => ({
  registryId: "fixture-acp",
  displayName: "Fixture",
  handle: "acp-fixture",
  registryVersion: "1.0.0",
  sourceUrl: "file://fixture",
  command: "npx",
  args: ["agent", "stdio"],
  staticEnv: {},
  approvedAt: "2026-09-15T00:00:00.000Z",
  enabled: true,
  ...over,
});

describe("codexInitialAgentModeFromToml", () => {
  it("maps sandbox/approval the way Codeg does", () => {
    expect(codexInitialAgentModeFromToml('sandbox_mode = "read-only"\n')).toBe("read-only");
    expect(codexInitialAgentModeFromToml('sandbox_mode = "workspace-write"\n')).toBe("agent");
    expect(codexInitialAgentModeFromToml(
      'sandbox_mode = "danger-full-access"\napproval_policy = "never"\n',
    )).toBe("agent-full-access");
    expect(codexInitialAgentModeFromToml(
      'sandbox_mode = "danger-full-access"\napproval_policy = "on-request"\n',
    )).toBe("agent");
    expect(codexInitialAgentModeFromToml("")).toBeUndefined();
  });

  it("does not map root keys when default_permissions is set", () => {
    expect(codexInitialAgentModeFromToml(
      'approval_policy = "never"\nsandbox_mode = "danger-full-access"\ndefault_permissions = ":read-only"\n',
    )).toBeUndefined();
  });
});

describe("grokPermissionModeFromToml", () => {
  it("reads [ui].permission_mode and skips default", () => {
    expect(grokPermissionModeFromToml('[ui]\npermission_mode = "bypassPermissions"\n')).toBe("bypassPermissions");
    expect(grokPermissionModeFromToml('[ui]\npermission_mode = "always-approve"\n')).toBe("bypassPermissions");
    expect(grokPermissionModeFromToml('[ui]\npermission_mode = "default"\n')).toBeUndefined();
  });
});

describe("launch args", () => {
  it("puts Grok flags before the agent subcommand", () => {
    const home = mkdtempSync(join(tmpdir(), "pi-grok-home-"));
    mkdirSync(join(home, ".grok"));
    writeFileSync(join(home, ".grok", "config.toml"), '[ui]\npermission_mode = "dontAsk"\n');
    expect(grokLaunchArgs(["agent", "stdio"], home)).toEqual([
      "--no-auto-update",
      "--permission-mode",
      "dontAsk",
      "agent",
      "stdio",
    ]);
    rmSync(home, { recursive: true, force: true });
  });

  it("adds Cursor --force and --model from env", () => {
    expect(cursorLaunchArgs(["acp"], { CURSOR_FORCE: "1", CURSOR_MODEL: "gpt-5" }))
      .toEqual(["--model", "gpt-5", "--force", "acp"]);
  });

  it("routes Grok/Cursor through launchArgsFor", () => {
    expect(launchArgsFor(approval({ registryId: "cursor", args: ["acp"] }), { CURSOR_FORCE: "true" }))
      .toEqual(["--force", "acp"]);
    expect(launchArgsFor(approval({ registryId: "grok-build", args: ["agent", "stdio"] }), {})).toEqual([
      "--no-auto-update",
      "agent",
      "stdio",
    ]);
    expect(launchArgsFor(approval({ registryId: "fixture-acp", args: ["stdio"] }), {})).toEqual(["stdio"]);
  });
});

describe("applyAdapterLaunchEnv", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it("sets Codex MCP/mode env from config.toml and strips npx prefix leakage", () => {
    const home = mkdtempSync(join(tmpdir(), "pi-codex-home-"));
    homes.push(home);
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), [
      'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      "",
    ].join("\n"));
    const env = applyAdapterLaunchEnv(
      { npm_config_prefix: "/wrong", INITIAL_AGENT_MODE: "  " },
      approval({ registryId: "codex-acp", command: "npx" }),
      home,
    );
    expect(env.DISABLE_MCP_CONFIG_FILTERING).toBe("true");
    expect(env.INITIAL_AGENT_MODE).toBe("agent-full-access");
    expect(env.npm_config_prefix).toBeUndefined();
  });

  it("keeps an explicit INITIAL_AGENT_MODE and an approved npm prefix", () => {
    const env = applyAdapterLaunchEnv(
      { INITIAL_AGENT_MODE: "read-only", npm_config_prefix: "/from-parent" },
      approval({ registryId: "codex-acp", staticEnv: { npm_config_prefix: "/approved", INITIAL_AGENT_MODE: "read-only" } }),
      "/missing-home",
    );
    expect(env.INITIAL_AGENT_MODE).toBe("read-only");
    expect(env.npm_config_prefix).toBe("/from-parent");
  });
});
