import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const fixture = resolve("test/fixtures/acp-test-agent.mjs");

let environment: Hermetic | undefined;
let shutdown: (() => Promise<void>) | undefined;

afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
  delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi-subagents:manager")];
  environment?.restore();
  environment = undefined;
});

function writeApproval(staticEnv: Record<string, string> = {}) {
  mkdirSync(getAgentDir(), { recursive: true });
  writeFileSync(join(getAgentDir(), "acp-agents.json"), JSON.stringify({
    version: 1,
    agents: [{
      registryId: "codex-acp",
      displayName: "Codex",
      handle: "acp-codex",
      registryVersion: "1.0.0",
      sourceUrl: "https://example.test/codex",
      command: process.execPath,
      args: [fixture],
      staticEnv,
      approvedAt: "2026-09-15T00:00:00.000Z",
      enabled: true,
    }],
  }));
}

function boot(enabled: boolean, staticEnv: Record<string, string> = {}) {
  environment = hermeticDir({ testAgents: true, settings: { outputTranscript: false } });
  mkdirSync(getAgentDir(), { recursive: true });
  writeFileSync(join(getAgentDir(), "subagents.json"), JSON.stringify({ acpEnabled: enabled }));
  writeApproval(staticEnv);
  const booted = makePi();
  subagentsExtension(booted.pi);
  shutdown = booted.lifecycle.get("session_shutdown");
  return booted;
}

function tuiContext() {
  return ctx({
    mode: "tui",
    hasUI: true,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
      onTerminalInput: vi.fn(() => vi.fn()),
      addAutocompleteProvider: vi.fn(),
    },
    sessionManager: {
      getSessionId: vi.fn(() => "root-session"),
      getSessionFile: vi.fn(() => undefined),
      getEntries: vi.fn(() => []),
      getBranch: vi.fn(() => []),
    },
  });
}

describe("ACP extension wiring", () => {
  it("keeps AcpAgent out of the tool registry while the feature is off", () => {
    const { tools } = boot(false);
    expect(tools.has("AcpAgent")).toBe(false);
  });

  it("registers AcpAgent and routes leading/inline mentions through the main turn", async () => {
    const { tools, lifecycle } = boot(true);
    expect(tools.has("AcpAgent")).toBe(true);

    const context = tuiContext();
    await lifecycle.get("session_start")({ type: "session_start" }, context);

    expect(await lifecycle.get("input")(
      { type: "input", text: "@acp-codex review this", source: "interactive" },
      context,
    )).toEqual({ action: "continue" });
    const before = await lifecycle.get("before_agent_start")({
      type: "before_agent_start",
      prompt: "@acp-codex review this",
      systemPrompt: "base",
    }, context);
    expect(before.systemPrompt).toContain('AcpAgent(agent="codex-acp")');
    expect(before.systemPrompt).not.toContain("acceptance criteria");

    expect(await lifecycle.get("input")(
      { type: "input", text: "ask @acp-codex to review", source: "interactive" },
      context,
    )).toEqual({ action: "continue" });
  });

  it("runs an approved ACP agent through the real tool and result path", async () => {
    const { tools, lifecycle } = boot(true);
    const context = tuiContext();
    await lifecycle.get("session_start")({ type: "session_start" }, context);

    const launched = await tools.get("AcpAgent").execute(
      "tc-acp",
      { agent: "codex-acp", resume: "", prompt: "hello", description: "Review with Codex" },
      undefined,
      undefined,
      context,
    );
    const text = launched.content[0].text as string;
    const id = /Attempt ID: (\S+)/.exec(text)?.[1];
    expect(id).toBeTruthy();
    expect(launched.terminate).toBe(true);

    const result = await tools.get("get_subagent_result").execute(
      "tc-result",
      { agent_id: id, wait: true },
      undefined,
      undefined,
      context,
    );
    expect(result.content[0].text).toContain("fixture:hello");
    expect(result.content[0].text).toContain("Runtime: acp");
  });

  it("returns a background receipt before session startup failure and wakes the main model with the result", async () => {
    const { pi, tools, lifecycle } = boot(true, { ACP_FAIL_SESSION_NEW: "1" });
    const context = tuiContext();
    await lifecycle.get("session_start")({ type: "session_start" }, context);

    const launched = await tools.get("AcpAgent").execute(
      "tc-acp-fail",
      { agent: "codex-acp", prompt: "hello", description: "Fail startup" },
      undefined,
      undefined,
      context,
    );
    const id = /Attempt ID: (\S+)/.exec(launched.content[0].text as string)?.[1];
    expect(id).toBeTruthy();
    expect(launched.terminate).toBe(true);

    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalled());
    const notification = vi.mocked(pi.sendMessage).mock.calls.at(-1);
    expect(notification?.[0].content).toContain("ACP startup failed during session/new");
    expect(notification?.[1]).toMatchObject({ triggerTurn: true });
  });

  it("keeps @main as an escape hatch for literal ACP handles", async () => {
    const { lifecycle } = boot(true);
    const context = tuiContext();
    await lifecycle.get("session_start")({ type: "session_start" }, context);
    expect(await lifecycle.get("input")(
      { type: "input", text: "@main @acp-codex is literal text", source: "interactive" },
      context,
    )).toEqual({ action: "transform", text: "@acp-codex is literal text" });
    expect(await lifecycle.get("before_agent_start")({
      type: "before_agent_start",
      prompt: "@acp-codex is literal text",
      systemPrompt: "base",
    }, context)).toBeUndefined();
  });

  it("adds approved ACP handles to autocomplete", async () => {
    const { lifecycle } = boot(true);
    const context = tuiContext();
    await lifecycle.get("session_start")({ type: "session_start" }, context);
    const factory = vi.mocked(context.ui.addAutocompleteProvider).mock.calls[0][0];
    const provider = factory({ getSuggestions: vi.fn().mockResolvedValue(null), applyCompletion: vi.fn() });
    const result = await provider.getSuggestions(["@acp-c"], 0, 6, { signal: new AbortController().signal });
    expect(result.items.map((item: { value: string }) => item.value)).toContain("@acp-codex");
    const prefix = await provider.getSuggestions(["@acp-"], 0, 5, { signal: new AbortController().signal });
    expect(prefix.items.map((item: { value: string }) => item.value)).toContain("@acp-codex");
  });

  it("hides AcpAgent after the last approval is disabled and refreshes the approved-agent list", async () => {
    const { tools, lifecycle, pi } = boot(true);
    const context = tuiContext();
    await lifecycle.get("session_start")({ type: "session_start" }, context);
    expect(pi.getActiveTools()).toContain("AcpAgent");
    expect(tools.get("AcpAgent").description).toContain("codex-acp");
    expect(tools.get("AcpAgent").description).not.toContain("other-acp");

    mkdirSync(getAgentDir(), { recursive: true });
    writeFileSync(join(getAgentDir(), "acp-agents.json"), JSON.stringify({
      version: 1,
      agents: [
        {
          registryId: "codex-acp",
          displayName: "Codex",
          handle: "acp-codex",
          registryVersion: "1.0.0",
          sourceUrl: "https://example.test/codex",
          command: process.execPath,
          args: [fixture],
          staticEnv: {},
          approvedAt: "2026-09-15T00:00:00.000Z",
          enabled: true,
        },
        {
          registryId: "other-acp",
          displayName: "Other",
          handle: "acp-other",
          registryVersion: "1.0.0",
          sourceUrl: "https://example.test/other",
          command: process.execPath,
          args: [fixture],
          staticEnv: {},
          approvedAt: "2026-09-15T00:00:00.000Z",
          enabled: true,
        },
      ],
    }));
    await lifecycle.get("session_start")({ type: "session_start" }, context);
    expect(tools.get("AcpAgent").description).toContain("codex-acp");
    expect(tools.get("AcpAgent").description).toContain("other-acp");

    writeFileSync(join(getAgentDir(), "acp-agents.json"), JSON.stringify({
      version: 1,
      agents: [{
        registryId: "codex-acp",
        displayName: "Codex",
        handle: "acp-codex",
        registryVersion: "1.0.0",
        sourceUrl: "https://example.test/codex",
        command: process.execPath,
        args: [fixture],
        staticEnv: {},
        approvedAt: "2026-09-15T00:00:00.000Z",
        enabled: false,
      }],
    }));
    await lifecycle.get("session_start")({ type: "session_start" }, context);
    expect(pi.getActiveTools()).not.toContain("AcpAgent");
  });
});
