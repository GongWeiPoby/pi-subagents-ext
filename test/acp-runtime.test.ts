import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovedAcpAgent } from "../src/acp/registry.js";
import { AcpSessionRuntime, resolvePathLauncher } from "../src/acp/runtime.js";
import { emptyTurnError } from "../src/acp/turn-diagnostics.js";

const fixture = resolve("test/fixtures/acp-test-agent.mjs");

describe("AcpSessionRuntime", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-acp-runtime-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  const approval = (args = [fixture]): ApprovedAcpAgent => ({
    registryId: "fixture-acp",
    displayName: "Fixture",
    handle: "acp-fixture",
    registryVersion: "1.0.0",
    sourceUrl: "file://fixture",
    command: process.execPath,
    args,
    staticEnv: {},
    approvedAt: "2026-09-15T00:00:00.000Z",
    enabled: true,
  });

  it("initializes, auto-allows permission, streams updates and completes", async () => {
    const runtime = await AcpSessionRuntime.start({ approval: approval(), cwd });
    const text = vi.fn();
    const tool = vi.fn();
    const usage = vi.fn();
    const result = await runtime.run("hello", {
      onText: text,
      onToolCall: tool,
      onUsage: usage,
    });

    expect(runtime.info.agentName).toBe("Fixture Agent");
    expect(runtime.info.resumeMode).toBe("none");
    expect(result).toMatchObject({ text: "fixture:hello", stopReason: "end_turn" });
    expect(text).toHaveBeenLastCalledWith("hello", "fixture:hello");
    expect(tool).toHaveBeenCalledWith("tool-1", "Fixture write", "in_progress");
    expect(usage).toHaveBeenCalledWith({ used: 10, size: 100, cost: { amount: 0.01, currency: "USD" } });
    expect(runtime.stderr).toContain(`cwd=${cwd}`);
    await runtime.close();
    expect(runtime.isClosed).toBe(true);
  });

  it("maps Codex config.toml into INITIAL_AGENT_MODE and strips npx prefix env", async () => {
    const home = join(cwd, "home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), [
      'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      "",
    ].join("\n"));
    const previousHome = process.env.HOME;
    const previousPrefix = process.env.npm_config_prefix;
    process.env.HOME = home;
    process.env.npm_config_prefix = "/leaked-prefix";
    let runtime: AcpSessionRuntime | undefined;
    try {
      runtime = await AcpSessionRuntime.start({
        approval: { ...approval(), registryId: "codex-acp" },
        cwd,
      });
      expect((await runtime.run("env:INITIAL_AGENT_MODE")).text).toBe("agent-full-access");
      expect((await runtime.run("env:DISABLE_MCP_CONFIG_FILTERING")).text).toBe("true");
      expect((await runtime.run("env:npm_config_prefix")).text).toBe("");
    } finally {
      await runtime?.close();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPrefix === undefined) delete process.env.npm_config_prefix;
      else process.env.npm_config_prefix = previousPrefix;
    }
  });

  it("projects Claude settings env into the adapter without overriding approved static env", async () => {
    const configDir = join(cwd, ".claude");
    mkdirSync(configDir);
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      env: {
        ACP_CONFIG_ENV: "  from-config  ",
        ACP_STATIC_ENV: "from-config",
        ACP_EMPTY_ENV: "   ",
      },
    }));
    const previousEmpty = process.env.ACP_EMPTY_ENV;
    process.env.ACP_EMPTY_ENV = "from-parent";
    let runtime: AcpSessionRuntime | undefined;
    try {
      runtime = await AcpSessionRuntime.start({
        approval: {
          ...approval(),
          registryId: "claude-acp",
          staticEnv: {
            CLAUDE_CONFIG_DIR: configDir,
            ACP_STATIC_ENV: "from-static",
          },
        },
        cwd,
      });

      expect((await runtime.run("env:ACP_CONFIG_ENV")).text).toBe("from-config");
      expect((await runtime.run("env:ACP_STATIC_ENV")).text).toBe("from-static");
      expect((await runtime.run("env:ACP_EMPTY_ENV")).text).toBe("from-parent");
    } finally {
      await runtime?.close();
      if (previousEmpty === undefined) delete process.env.ACP_EMPTY_ENV;
      else process.env.ACP_EMPTY_ENV = previousEmpty;
    }
  });

  it("projects Gemini and Qwen native settings env into their adapters", async () => {
    const profiles = [
      {
        registryId: "gemini",
        homeEnv: "GEMINI_CLI_HOME",
        home: join(cwd, "gemini-home"),
        settingsDir: join(cwd, "gemini-home", ".gemini"),
      },
      {
        registryId: "qwen-code",
        homeEnv: "QWEN_HOME",
        home: join(cwd, "qwen-home"),
        settingsDir: join(cwd, "qwen-home"),
      },
    ];
    for (const profile of profiles) {
      mkdirSync(profile.settingsDir, { recursive: true });
      writeFileSync(join(profile.settingsDir, "settings.json"), JSON.stringify({
        env: { ACP_PROFILE_ENV: profile.registryId },
      }));
      const runtime = await AcpSessionRuntime.start({
        approval: {
          ...approval(),
          registryId: profile.registryId,
          staticEnv: { [profile.homeEnv]: profile.home },
        },
        cwd,
      });
      expect((await runtime.run("env:ACP_PROFILE_ENV")).text).toBe(profile.registryId);
      await runtime.close();
    }
  });

  it("explains turn-time authentication failures", async () => {
    const runtime = await AcpSessionRuntime.start({ approval: approval(), cwd });
    await expect(runtime.run("auth-error")).rejects.toThrow(/non-interactive prompt/);
    await runtime.close();
  });

  it("surfaces a structured prompt-response failure hidden behind end_turn", async () => {
    const runtime = await AcpSessionRuntime.start({ approval: approval(), cwd });
    await expect(runtime.run("empty-meta")).rejects.toThrow(
      /Provider unavailable: The configured gateway returned HTTP 503/,
    );
    await runtime.close();
  });

  it("redacts secrets in prompt-response failure metadata", () => {
    const message = emptyTurnError({
      registryId: "fixture-acp",
      agentName: "Fixture",
      sessionId: "session-1",
      response: {
        stopReason: "end_turn",
        _meta: {
          jetbrains: {
            air: {
              sessionFailure: {
                title: "Authorization failed",
                details: "Bearer tok_live_abcdefg sk-live-secretvalue99",
              },
            },
          },
        },
      },
      stderrBefore: "",
      stderrAfter: "",
      env: {},
    });
    expect(message).toContain("Bearer [REDACTED]");
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain("tok_live_abcdefg");
    expect(message).not.toContain("sk-live-secretvalue99");
  });

  it("includes bounded agent stderr when an adapter returns an empty end_turn", async () => {
    const runtime = await AcpSessionRuntime.start({ approval: approval(), cwd });
    await expect(runtime.run("empty-stderr")).rejects.toThrow(
      /ended the turn without producing any response[\s\S]*provider request failed with HTTP 503/,
    );
    await runtime.close();
  });

  it("uses an agent diagnostic adapter when the ACP wire hides the underlying failure", async () => {
    const kimiHome = join(cwd, "kimi-home");
    const runtime = await AcpSessionRuntime.start({
      approval: {
        ...approval(),
        registryId: "kimi-code",
        staticEnv: {
          KIMI_CODE_HOME: kimiHome,
          ACP_EMPTY_KIMI_FAILURE: "1",
        },
      },
      cwd,
    });
    await expect(runtime.run("empty-kimi-failure")).rejects.toThrow(
      /OAuthUnauthorizedError: Token for "kimi-code" has no refresh_token; re-login required[\s\S]*sign in again/,
    );
    await runtime.close();
  });

  it("sends session cancel when the caller aborts", async () => {
    const runtime = await AcpSessionRuntime.start({ approval: approval(), cwd });
    const controller = new AbortController();
    const run = runtime.run("wait", {}, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const result = await run;
    expect(result.stopReason).toBe("cancelled");
    await runtime.close();
  });

  it("bounds agent output and marks truncation", async () => {
    const runtime = await AcpSessionRuntime.start({ approval: approval(), cwd });
    const result = await runtime.run("large");
    expect(result.text).toContain("[ACP output truncated at 256 KiB]");
    expect(Buffer.byteLength(result.text)).toBeLessThan(257 * 1024);
    await runtime.close();
  });

  it("force-closes an adapter that ignores cancellation", async () => {
    const runtime = await AcpSessionRuntime.start({ approval: approval(), cwd });
    const controller = new AbortController();
    const run = runtime.run("ignore-cancel", {}, controller.signal);
    setTimeout(() => controller.abort(), 30);
    await expect(run).rejects.toThrow();
    expect(runtime.isClosed).toBe(true);
  });

  it("resumes a known session when requested", async () => {
    const first = await AcpSessionRuntime.start({ approval: approval(), cwd });
    const sessionId = first.info.sessionId;
    await first.close();

    const resumed = await AcpSessionRuntime.start({
      approval: approval(),
      cwd,
      resume: { sessionId, mode: "resume" },
    });
    expect(resumed.info).toMatchObject({ sessionId, resumeMode: "resume" });
    expect((await resumed.run("again")).text).toBe("fixture:again");
    await resumed.close();
  });

  it("identifies session/new authentication failures", async () => {
    await expect(AcpSessionRuntime.start({
      approval: { ...approval(), staticEnv: { ACP_FAIL_SESSION_NEW: "1" } },
      cwd,
    })).rejects.toThrow(/during session\/new.*Authentication required[\s\S]*Fixture Login \(fixture-login\)/);
  });

  it("fails startup on malformed ACP stdout", async () => {
    await expect(AcpSessionRuntime.start({
      approval: approval(["-e", "process.stdout.write('not-json\\n')"]),
      cwd,
    })).rejects.toThrow(/during initialize/);
  });

  it("fails startup when the approved command does not exist", async () => {
    await expect(AcpSessionRuntime.start({
      approval: { ...approval(), command: join(cwd, "missing-agent") },
      cwd,
    })).rejects.toThrow(/during initialize.*(?:ENOENT|spawn)/);
  });
});

describe("resolvePathLauncher", () => {
  it("resolves npx from PATH and ignores a same-named file in cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-acp-path-"));
    try {
      const pathDir = join(root, "bin");
      const cwd = join(root, "cwd");
      mkdirSync(pathDir);
      mkdirSync(cwd);
      const onPath = join(pathDir, "npx");
      const onPathCmd = join(pathDir, "npx.cmd");
      const inCwd = join(cwd, "npx");
      writeFileSync(onPath, "#!/bin/sh\n");
      writeFileSync(onPathCmd, "@echo off\n");
      writeFileSync(inCwd, "#!/bin/sh\n");
      chmodSync(onPath, 0o755);
      chmodSync(inCwd, 0o755);
      expect(resolvePathLauncher("npx", { PATH: pathDir }, "linux")).toBe(onPath);
      expect(resolvePathLauncher("npx.cmd", { Path: pathDir }, "win32")).toBe(onPathCmd);
      expect(() => resolvePathLauncher("npx", { PATH: "" }, "linux")).toThrow(/not found on PATH/);
      expect(resolvePathLauncher(onPath, { PATH: "" })).toBe(onPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
