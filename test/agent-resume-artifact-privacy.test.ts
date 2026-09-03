import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as agentRunnerModule from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof agentRunnerModule>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { sessionTaskDir } from "../src/output-file.js";

const SESSION_ID = "resume-privacy-session";

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
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
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
    sessionManager: {
      getSessionId: vi.fn(() => SESSION_ID),
      getSessionFile: vi.fn(() => join(cwd, "parent.jsonl")),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

function resultText(result: any): string {
  const content = result?.content;
  if (Array.isArray(content)) return content.map((entry: any) => entry?.text ?? "").join("\n");
  return String(content ?? result?.text ?? JSON.stringify(result));
}

function agentIdOf(result: any): string {
  const id = /Agent ID: (\S+)/.exec(resultText(result))?.[1];
  if (!id) throw new Error(`missing agent id: ${JSON.stringify(result)}`);
  return id;
}

function managerRecord(id: string) {
  const key = Symbol.for("pi-subagents:manager");
  const registry = (globalThis as Record<PropertyKey, any>)[key];
  const record = registry?.getRecord(id);
  if (!record) throw new Error(`missing agent record: ${id}`);
  return record;
}

describe("Agent resume result-body privacy", () => {
  let cwd: string;
  let agentDir: string;
  let taskDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;
  let shutdown: (() => Promise<void>) | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "resume-privacy-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "resume-privacy-agent-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    process.chdir(cwd);

    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(
      join(agentDir, "agents", "quiet.md"),
      "---\ndescription: Private agent\noutput_transcript: false\n---\n\nKeep results private.\n",
    );
    taskDir = sessionTaskDir(cwd, SESSION_ID);

    const session = {
      messages: [],
      subscribe: vi.fn(() => vi.fn()),
      steer: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      return { responseText: "initial private body", session, aborted: false, steered: false };
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed private body" } as any);
  });

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(dirname(taskDir), { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it.each([
    ["foreground", false, "deleted"],
    ["background", true, "deleted"],
    ["foreground", false, "enabled"],
    ["background", true, "enabled"],
  ] as const)("keeps a %s resume metadata-only when the private policy is %s", async (_label, background, change) => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);
    shutdown = async () => { await lifecycle.get("session_shutdown")?.({}, ctx); };

    const spawned = await tools.get("Agent").execute(
      "spawn-private",
      { prompt: "first", description: "Private run", subagent_type: "quiet", run_in_background: true },
      undefined,
      undefined,
      ctx,
    );
    const id = agentIdOf(spawned);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(managerRecord(id).artifactStatus).toBe("metadata-only");
    expect(managerRecord(id).resultBodyEnabled).toBe(false);

    if (change === "deleted") {
      unlinkSync(join(agentDir, "agents", "quiet.md"));
    } else {
      writeFileSync(
        join(agentDir, "agents", "quiet.md"),
        "---\ndescription: Private agent\noutput_transcript: true\n---\n\nChanged policy must not affect this attempt.\n",
      );
    }

    await tools.get("Agent").execute(
      "resume-forged",
      {
        prompt: "continue",
        description: "Forged resume",
        subagent_type: "general-purpose",
        resume: id,
        run_in_background: background,
      },
      undefined,
      undefined,
      ctx,
    );
    if (background) await managerRecord(id).promise;

    const record = managerRecord(id);
    expect(record.type).toBe("quiet");
    expect(record.resultBodyEnabled).toBe(false);
    expect(record.outputFile).toBeUndefined();
    expect(record.artifactStatus).toBe("metadata-only");
    expect(record.resultBodyPath).toBeUndefined();
    const manifest = readFileSync(record.resultArtifactPath, "utf-8");
    expect(manifest).not.toContain("resumed private body");
    expect(manifest).not.toContain("initial private body");
  });
});
