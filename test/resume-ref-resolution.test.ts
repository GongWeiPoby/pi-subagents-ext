/**
 * Agent tool `resume` reference resolution — the lmux incident.
 *
 * Report: a foreground agent finished at its turn limit; the orchestrator,
 * holding no real id (a foreground result carries its agent id only in
 * renderer details, which never reach the model — #174), invented one and
 * passed `resume: "<invented>"`. The tool answered
 * `Agent not found: "...". It may have been cleaned up.` while the record was
 * alive and perfectly resumable — and the orchestrator, told the handle had
 * been "cleaned up", abandoned the conversation and started a fresh agent,
 * losing all context.
 *
 * These tests pin the two halves of the fix:
 *
 *   1. `resume` accepts a handle (`name`/type-derived), like
 *      `get_subagent_result` and `steer_subagent` already did — so a caller
 *      that assigned the name can reach the agent without ever holding an id.
 *   2. A miss lists the agents that ARE resumable right now, so the caller
 *      retries with a real reference instead of concluding eviction.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

vi.mock("../src/output-file.js", async () => {
  const actual = await vi.importActual<typeof import("../src/output-file.js")>("../src/output-file.js");
  return {
    ...actual,
    createOutputFilePath: vi.fn(() => "/tmp/fake-subagent.output"),
    writeInitialEntry: vi.fn(),
    ensureOutputFile: vi.fn(),
    streamToOutputFile: vi.fn(() => vi.fn()),
  };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function makeCtx(cwd: string) {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "session-1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

function resultText(result: any): string {
  const content = result?.content;
  if (Array.isArray(content)) return content.map((c: any) => c?.text ?? "").join("\n");
  return String(content ?? result?.text ?? JSON.stringify(result));
}

describe("Agent tool — resume reference resolution", () => {
  let cwd: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;
  let session: any;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-resume-ref-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-resume-ref-agent-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(cwd);

    session = {
      messages: [
        { role: "user", content: "first task" },
        { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      ],
      subscribe: vi.fn(() => vi.fn()),
      steer: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      await Promise.resolve();
      options.onSessionCreated?.(session);
      return { responseText: "done", session, aborted: false, steered: false };
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed answer" } as any);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  /** Spawn a FOREGROUND agent with a `name` and let it settle — the incident's shape. */
  async function spawnNamedForeground(tools: Map<string, any>, ctx: any, name: string) {
    const res = await tools.get("Agent").execute(
      "spawn-call",
      { prompt: "first task", description: "First task", subagent_type: "general-purpose", name, run_in_background: false },
      undefined,
      undefined,
      ctx,
    );
    // Foreground results never print an Agent ID — the premise of the incident.
    expect(resultText(res)).not.toMatch(/Agent ID:/);
    return res;
  }

  it("resumes by the handle the caller itself assigned", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);
    await spawnNamedForeground(tools, ctx, "workspace-worker");

    const res = await tools.get("Agent").execute(
      "resume-call",
      { prompt: "keep going", description: "Keep going", subagent_type: "general-purpose", resume: "workspace-worker", run_in_background: false },
      undefined,
      undefined,
      ctx,
    );

    expect(resumeAgent).toHaveBeenCalledTimes(1);
    expect(resultText(res)).toContain("resumed answer");
    expect(resultText(res)).not.toContain("Agent not found");

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it("resumes by the type-derived handle when no name was given", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);
    await tools.get("Agent").execute(
      "spawn-call",
      { prompt: "first task", description: "First task", subagent_type: "general-purpose", run_in_background: false },
      undefined,
      undefined,
      ctx,
    );

    // general-purpose → handle "general-purpose"
    await tools.get("Agent").execute(
      "resume-call",
      { prompt: "keep going", description: "Keep going", subagent_type: "general-purpose", resume: "general-purpose", run_in_background: false },
      undefined,
      undefined,
      ctx,
    );

    expect(resumeAgent).toHaveBeenCalledTimes(1);

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it("still resumes by raw agent id", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);
    const spawnRes = await tools.get("Agent").execute(
      "spawn-call",
      { prompt: "first task", description: "First task", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctx,
    );
    const id = /Agent ID: (\S+)/.exec(resultText(spawnRes))?.[1];
    expect(id).toBeDefined();
    await new Promise((r) => setTimeout(r, 0));

    await tools.get("Agent").execute(
      "resume-call",
      { prompt: "keep going", description: "Keep going", subagent_type: "general-purpose", resume: id, run_in_background: false },
      undefined,
      undefined,
      ctx,
    );

    expect(resumeAgent).toHaveBeenCalledTimes(1);

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it("an invented id lists the resumable agents instead of blaming cleanup", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);
    await spawnNamedForeground(tools, ctx, "workspace-worker");

    const res = await tools.get("Agent").execute(
      "resume-call",
      { prompt: "keep going", description: "Keep going", subagent_type: "general-purpose", resume: "22d569a3-5d0e-446", run_in_background: false },
      undefined,
      undefined,
      ctx,
    );

    const text = resultText(res);
    expect(text).toContain("Agent not found");
    expect(text).toContain("resumable");
    // The real agent is named with its handle, id, type and settled status.
    expect(text).toContain("workspace-worker");
    expect(text).toContain("general-purpose");
    expect(text).toMatch(/id: [0-9a-f-]+/);

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it("does not list running agents as resumable", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);
    // One settled agent (resumable), one still running.
    await spawnNamedForeground(tools, ctx, "settled-worker");
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const bg = await tools.get("Agent").execute(
      "spawn-bg",
      { prompt: "long task", description: "Long task", subagent_type: "general-purpose", name: "busy-worker", run_in_background: true },
      undefined,
      undefined,
      ctx,
    );
    const busyId = /Agent ID: (\S+)/.exec(resultText(bg))?.[1];
    expect(busyId).toBeDefined();

    const res = await tools.get("Agent").execute(
      "resume-call",
      { prompt: "keep going", description: "Keep going", subagent_type: "general-purpose", resume: "does-not-exist", run_in_background: false },
      undefined,
      undefined,
      ctx,
    );

    const text = resultText(res);
    expect(text).toContain("settled-worker");
    expect(text).not.toContain("busy-worker");
    expect(text).not.toContain(busyId!);

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it("keeps the old not-found shape when nothing is resumable", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);

    const res = await tools.get("Agent").execute(
      "resume-call",
      { prompt: "keep going", description: "Keep going", subagent_type: "general-purpose", resume: "nope", run_in_background: false },
      undefined,
      undefined,
      ctx,
    );

    const text = resultText(res);
    expect(text).toBe('Agent not found: "nope". It may have been cleaned up.');

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });
});
