import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { sessionTaskFile } from "../src/tasks/task-paths.js";
import { TaskStore } from "../src/tasks/task-store.js";
import { type Hermetic, hermeticDir } from "./helpers/boot-extension.js";

vi.mock("../src/agent-runner.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/agent-runner.js")>();
  return { ...actual, runAgent: vi.fn() };
});

type Handler = (...args: unknown[]) => unknown;
type Tool = {
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<unknown>;
};

function textOf(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
  const first = result.content[0];
  return first && typeof first === "object" && "text" in first ? String(first.text) : "";
}

function integratedHarness(
  cwd: string,
  options: { confirm?: (title: string, body: string) => Promise<boolean>; hasUI?: boolean } = {},
) {
  const tools = new Map<string, Tool>();
  const lifecycle = new Map<string, Handler[]>();
  const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  const activeTools: string[] = [];
  const events = {
    emit: vi.fn((channel: string, data: unknown) => {
      for (const handler of [...(eventHandlers.get(channel) ?? [])]) handler(data);
    }),
    on: vi.fn((channel: string, handler: (data: unknown) => void) => {
      const handlers = eventHandlers.get(channel) ?? new Set<(data: unknown) => void>();
      handlers.add(handler);
      eventHandlers.set(channel, handlers);
      return () => handlers.delete(handler);
    }),
  };
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerTool: vi.fn((tool: Tool & { name: string }) => {
      tools.set(tool.name, tool);
      if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
    }),
    registerCommand: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(() => undefined),
    on: vi.fn((event: string, handler: Handler) => {
      const handlers = lifecycle.get(event) ?? [];
      handlers.push(handler);
      lifecycle.set(event, handlers);
    }),
    events,
    getAllTools: vi.fn(() => []),
    getCommands: vi.fn(() => []),
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools: vi.fn(),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false })),
  };
  let sessionId = "binding-session";
  const context = {
    mode: "tui",
    hasUI: options.hasUI ?? false,
    cwd,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
      addAutocompleteProvider: vi.fn(),
      onTerminalInput: vi.fn(() => vi.fn()),
      confirm: vi.fn(options.confirm ?? (async () => true)),
    },
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: {
      getSessionId: vi.fn(() => sessionId),
      getSessionFile: vi.fn(() => `/sessions/${sessionId}.jsonl`),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent"),
    isIdle: vi.fn(() => true),
  };

  subagentsExtension(pi as never);

  return {
    context,
    events,
    pi,
    setSessionId(next: string) { sessionId = next; },
    async execute(name: string, params: Record<string, unknown>) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.execute(`tc-${name}`, params, undefined, undefined, context);
    },
    async fire(event: string, payload: unknown = {}) {
      for (const handler of lifecycle.get(event) ?? []) await handler(payload, context);
    },
  };
}

const inlineMeta = 'export const meta = { name: "todo-binding", description: "exercise Todo binding" };\n';

describe("SubagentWorkflow task_id execution binding", () => {
  let hermetic: Hermetic;
  let previousTasks: string | undefined;

  beforeEach(() => {
    hermetic = hermeticDir({
      settings: { maxConcurrent: 1, schedulingEnabled: false, workflowsEnabled: true },
    });
    previousTasks = process.env.PI_TASKS;
    process.env.PI_TASKS = "off";
    vi.mocked(runAgent).mockReset();
  });

  afterEach(() => {
    if (previousTasks === undefined) delete process.env.PI_TASKS;
    else process.env.PI_TASKS = previousTasks;
    hermetic.restore();
    vi.restoreAllMocks();
  });

  async function createTask(harness: ReturnType<typeof integratedHarness>) {
    await harness.execute("TaskCreate", {
      subject: "Bound Todo",
      description: "d",
      agentType: "general-purpose",
    });
  }

  async function taskText(harness: ReturnType<typeof integratedHarness>): Promise<string> {
    return textOf(await harness.execute("TaskGet", { taskId: "1" }));
  }

  it("blocks TaskExecute while bound and completes the Todo on workflow success", async () => {
    let finishAgent!: (value: never) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => { finishAgent = resolve; }));
    const harness = integratedHarness(hermetic.dir);
    await harness.fire("session_start", { reason: "startup" });
    await createTask(harness);

    const started = await harness.execute("SubagentWorkflow", {
      script: `${inlineMeta}return await agent("finish the workflow");`,
      task_id: "1",
    });
    expect(textOf(started)).toContain("started in the background");
    const duplicate = await harness.execute("TaskExecute", { task_ids: ["1"] });
    expect(textOf(duplicate)).toContain("not pending (status: in_progress)");
    const runningOutput = await harness.execute("TaskOutput", {
      task_id: "1",
      block: false,
    });
    expect(textOf(runningOutput)).toContain("Task #1 [in_progress] — Workflow wf_");
    expect(await taskText(harness)).toMatch(/Owner: wf_/);
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));

    finishAgent({
      responseText: "workflow result",
      session: { dispose: vi.fn() },
      aborted: false,
      steered: false,
    } as never);
    await vi.waitFor(async () => expect(await taskText(harness)).toContain("Status: completed"));
    expect(await taskText(harness)).toContain("workflow result");
    const completedOutput = await harness.execute("TaskOutput", {
      task_id: "1",
      block: false,
    });
    expect(textOf(completedOutput)).toContain("Task #1 [completed] — Workflow wf_");
    expect(textOf(completedOutput)).toContain("workflow result");
    await harness.fire("session_shutdown");
  });

  it("returns a failed workflow Todo to pending so another workflow can claim it", async () => {
    const harness = integratedHarness(hermetic.dir);
    await harness.fire("session_start", { reason: "startup" });
    await createTask(harness);

    await harness.execute("SubagentWorkflow", {
      script: `${inlineMeta}throw new Error("workflow failed");`,
      task_id: "1",
    });
    await vi.waitFor(async () => expect(await taskText(harness)).toContain("Status: pending"));
    expect(await taskText(harness)).toContain("workflow failed");

    const retry = await harness.execute("SubagentWorkflow", {
      script: `${inlineMeta}return "retry succeeded";`,
      task_id: "1",
    });
    expect(textOf(retry)).toContain("started in the background");
    await vi.waitFor(async () => expect(await taskText(harness)).toContain("Status: completed"));
    expect(await taskText(harness)).toContain("retry succeeded");
    await harness.fire("session_shutdown");
  });

  it("returns a killed workflow Todo to pending and allows a later claim", async () => {
    const harness = integratedHarness(hermetic.dir);
    await harness.fire("session_start", { reason: "startup" });
    await createTask(harness);

    await harness.execute("SubagentWorkflow", {
      script: `${inlineMeta}await new Promise(() => {});`,
      task_id: "1",
    });
    await harness.fire("session_before_switch");
    await vi.waitFor(async () => expect(await taskText(harness)).toContain("Status: pending"));
    expect(await taskText(harness)).toContain("session changed before execution settled");

    await harness.fire("session_start", { reason: "resume" });
    const retry = await harness.execute("SubagentWorkflow", {
      script: `${inlineMeta}return "after kill";`,
      task_id: "1",
    });
    expect(textOf(retry)).toContain("started in the background");
    await vi.waitFor(async () => expect(await taskText(harness)).toContain("Status: completed"));
    await harness.fire("session_shutdown");
  });

  it("holds a delayed workflow stop reservation against concurrent updates and claims", async () => {
    let finishAgent!: (value: never) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => { finishAgent = resolve; }));
    const harness = integratedHarness(hermetic.dir);
    await harness.fire("session_start", { reason: "startup" });
    await createTask(harness);

    await harness.execute("SubagentWorkflow", {
      script: `${inlineMeta}return await agent("hold controller settlement");`,
      task_id: "1",
    });
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));

    const firstUpdate = harness.execute("TaskUpdate", {
      taskId: "1",
      status: "pending",
      subject: "First update subject",
      description: "First update description",
      metadata: { firstUpdate: true },
    });
    await vi.waitFor(async () => expect(await taskText(harness)).toContain("Status: pending"));

    const secondUpdate = await harness.execute("TaskUpdate", {
      taskId: "1",
      status: "completed",
      subject: "Concurrent subject",
      metadata: { concurrent: true },
    });
    expect(textOf(secondUpdate)).toContain("previous executor was stopping; no update was applied");

    const taskExecute = await harness.execute("TaskExecute", { task_ids: ["1"] });
    expect(textOf(taskExecute)).toContain("already claimed by another session or execution");
    const workflowClaim = await harness.execute("SubagentWorkflow", {
      script: `${inlineMeta}return "must not start";`,
      task_id: "1",
    });
    expect(textOf(workflowClaim)).toContain("not pending or already has an execution");
    expect(runAgent).toHaveBeenCalledTimes(1);

    finishAgent({
      responseText: "partial controller output",
      session: { dispose: vi.fn() },
      aborted: false,
      steered: false,
    } as never);
    expect(textOf(await firstUpdate)).toContain("Updated task #1");

    const updated = await taskText(harness);
    expect(updated).toContain("Status: pending");
    expect(updated).toContain("First update subject");
    expect(updated).toContain("First update description");
    expect(updated).toContain('"firstUpdate":true');
    expect(updated).not.toContain("Concurrent subject");

    const replacement = await harness.execute("SubagentWorkflow", {
      script: `${inlineMeta}return "replacement completed";`,
      task_id: "1",
    });
    expect(textOf(replacement)).toContain("started in the background");
    await vi.waitFor(async () => expect(await taskText(harness)).toContain("Status: completed"));
    expect(await taskText(harness)).toContain("replacement completed");
    await harness.fire("session_shutdown");
  });

  it.each(["pending", "completed", "deleted"] as const)(
    "stops the old workflow before TaskUpdate sets %s",
    async status => {
      const harness = integratedHarness(hermetic.dir);
      await harness.fire("session_start", { reason: "startup" });
      await createTask(harness);

      const started = await harness.execute("SubagentWorkflow", {
        script: `${inlineMeta}await new Promise(() => {});`,
        task_id: "1",
      });
      const workflowId = /Task ID: (wf_\w+)/.exec(textOf(started))?.[1];
      expect(workflowId).toBeTruthy();

      await harness.execute("TaskUpdate", { taskId: "1", status });
      const oldWorkflow = await harness.execute("TaskOutput", {
        task_id: workflowId!,
        block: false,
      });
      expect(textOf(oldWorkflow)).toContain("[killed]");
      await new Promise(resolve => setImmediate(resolve));
      expect(harness.pi.sendMessage.mock.calls.some(call =>
        String(call[0]?.content).includes(workflowId!)
      )).toBe(false);

      const updated = await taskText(harness);
      if (status === "deleted") expect(updated).toBe("Task not found");
      else expect(updated).toContain(`Status: ${status}`);

      if (status === "pending") {
        const replacement = await harness.execute("SubagentWorkflow", {
          script: `${inlineMeta}return "replacement";`,
          task_id: "1",
        });
        expect(textOf(replacement)).toContain("started in the background");
        await vi.waitFor(async () => expect(await taskText(harness)).toContain("Status: completed"));
      }
      await harness.fire("session_shutdown");
    },
  );

  it("keeps a replacement Agent isolated after stopping the old workflow", async () => {
    let finishAgent!: (value: never) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => { finishAgent = resolve; }));
    const harness = integratedHarness(hermetic.dir);
    await harness.fire("session_start", { reason: "startup" });
    await createTask(harness);

    await harness.execute("SubagentWorkflow", {
      script: `${inlineMeta}await new Promise(() => {});`,
      task_id: "1",
    });
    await harness.execute("TaskUpdate", { taskId: "1", status: "pending" });
    const launched = await harness.execute("TaskExecute", { task_ids: ["1"] });
    expect(textOf(launched)).toContain("Launched 1 agent");
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
    expect(await taskText(harness)).toContain("Status: in_progress");
    expect(await taskText(harness)).not.toContain("Workflow aborted.");

    finishAgent({
      responseText: "new agent result",
      session: { dispose: vi.fn() },
      aborted: false,
      steered: false,
    } as never);
    await vi.waitFor(async () => expect(await taskText(harness)).toContain("Status: completed"));
    expect(await taskText(harness)).toContain("new agent result");
    await harness.fire("session_shutdown");
  });

  it("rolls back a workflow before session_shutdown removes lifecycle listeners", async () => {
    delete process.env.PI_TASKS;
    const harness = integratedHarness(hermetic.dir);
    await harness.fire("session_start", { reason: "startup" });
    await createTask(harness);
    await harness.execute("SubagentWorkflow", {
      script: `${inlineMeta}await new Promise(() => {});`,
      task_id: "1",
    });

    await harness.fire("session_shutdown");

    const oldStore = new TaskStore(sessionTaskFile(hermetic.dir, "binding-session", "session"));
    expect(oldStore.get("1")).toMatchObject({
      status: "pending",
      metadata: { lastError: "session shut down before execution settled" },
      execution: undefined,
    });
  });

  it("rolls back a bound workflow in its original store before switching sessions", async () => {
    delete process.env.PI_TASKS;
    const harness = integratedHarness(hermetic.dir);
    await harness.fire("session_start", { reason: "startup" });
    await createTask(harness);
    await harness.execute("SubagentWorkflow", {
      script: `${inlineMeta}await new Promise(() => {});`,
      task_id: "1",
    });

    await harness.fire("session_before_switch");
    harness.setSessionId("replacement-session");
    await harness.fire("session_start", { reason: "new" });

    const oldStore = new TaskStore(sessionTaskFile(hermetic.dir, "binding-session", "session"));
    expect(oldStore.get("1")).toMatchObject({
      status: "pending",
      metadata: { lastError: "session changed before execution settled" },
      execution: undefined,
    });
    await harness.fire("session_shutdown");
  });

  it("rolls back and stops running and queued Agent claims before an immediate session start", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    delete process.env.PI_TASKS;
    const harness = integratedHarness(hermetic.dir);
    await harness.fire("session_start", { reason: "startup" });
    await createTask(harness);
    await harness.execute("TaskCreate", {
      subject: "Queued Todo",
      description: "d",
      agentType: "general-purpose",
    });
    await harness.execute("TaskExecute", { task_ids: ["1", "2"] });
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));

    await harness.fire("session_before_switch");
    harness.setSessionId("replacement-session");
    await harness.fire("session_start", { reason: "new" });

    const oldStore = new TaskStore(sessionTaskFile(hermetic.dir, "binding-session", "session"));
    expect(oldStore.list()).toMatchObject([
      { id: "1", status: "pending", execution: undefined },
      { id: "2", status: "pending", execution: undefined },
    ]);
    expect(oldStore.list().every(task =>
      task.metadata.lastError === "session changed before execution settled"
    )).toBe(true);
    await harness.fire("session_shutdown");
  });

  it("shows the Todo binding in approval and leaves it pending when denied", async () => {
    const confirm = vi.fn(async () => false);
    const harness = integratedHarness(hermetic.dir, { confirm, hasUI: true });
    await harness.fire("session_start", { reason: "startup" });
    await createTask(harness);

    const denied = await harness.execute("SubagentWorkflow", {
      script: `${inlineMeta}return "unused";`,
      task_id: "1",
    });

    expect(textOf(denied)).toContain("not approved");
    expect(confirm).toHaveBeenCalledWith(
      "Run workflow?",
      expect.stringContaining("Todo binding\n- Task #1"),
    );
    expect(await taskText(harness)).toContain("Status: pending");
    await harness.fire("session_shutdown");
  });

  it("rejects malformed task_id input before claiming", async () => {
    const harness = integratedHarness(hermetic.dir);
    await harness.fire("session_start", { reason: "startup" });
    await createTask(harness);

    const malformed = await harness.execute("SubagentWorkflow", {
      script: `${inlineMeta}return "unused";`,
      task_id: "   ",
    });

    expect(textOf(malformed)).toContain("must identify one structured task");
    expect(await taskText(harness)).toContain("Status: pending");
    await harness.fire("session_shutdown");
  });
});
