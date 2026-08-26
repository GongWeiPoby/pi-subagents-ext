/**
 * Reattaching running subagents after a pi-tasks reload.
 *
 * The agent -> task map lives only in the extension instance, so a reload starts
 * with an empty one while the subagents keep running. Without reattachment their
 * completion events are dropped and the tasks stay in_progress forever — in a
 * persisted list, across every future session.
 *
 * Each test boots a second extension over the same store file: that is what a
 * reload looks like from here.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../../src/tasks/index.js";
import { flush, installSubagentsMock, mockPi, mockSessionCtx } from "./helpers/mock-pi.js";

// Pinned so the developer's own <agentDir>/tasks-config.json cannot change what
// these tests exercise.
const config = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../../src/tasks/tasks-config.js", () => ({
  loadGlobalTasksConfig: () => ({ ...config.current }),
  loadTasksConfig: () => ({ ...config.current }),
  saveTasksConfig: () => {},
}));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-tasks-reattach-"));
  process.env.PI_TASKS = join(dir, "tasks.json");
  config.current = {};
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PI_TASKS;
  rmSync(dir, { recursive: true, force: true });
});

/** Boot an extension, run an agent-backed task, and leave the agent running. */
async function sessionWithRunningAgent() {
  const mock = mockPi();
  const rpc = installSubagentsMock(mock.pi);
  initExtension(mock.pi as any);
  await mock.executeTool("TaskCreate", { subject: "Long job", description: "d", agentType: "general-purpose" });
  await mock.executeTool("TaskExecute", { task_ids: ["1"] });
  rpc.unsub();
  return mock;
}

/** Boot a fresh extension over the same store and announce the reload. */
async function reload() {
  const mock = mockPi();
  const rpc = installSubagentsMock(mock.pi);
  initExtension(mock.pi as any);
  await mock.fireLifecycle("session_start", { reason: "reload" }, mockSessionCtx("s1"));
  return { mock, rpc };
}

const statusOf = async (mock: ReturnType<typeof mockPi>, id = "1") =>
  (await mock.executeTool("TaskGet", { taskId: id })).content[0].text;

describe("reattaching subagents after reload", () => {
  it("completes the task when the agent finishes after a reload", async () => {
    await sessionWithRunningAgent();
    const { mock } = await reload();

    mock.emitEvent("subagents:completed", { id: "agent-1", result: "the answer" });
    await flush();

    const task = await statusOf(mock);
    expect(task).toContain("Status: completed");
    expect(task).toContain("the answer");
  });

  it("reverts the task to pending when the agent fails after a reload", async () => {
    await sessionWithRunningAgent();
    const { mock } = await reload();

    mock.emitEvent("subagents:failed", { id: "agent-1", error: "out of turns", status: "error" });
    await flush();

    const task = await statusOf(mock);
    expect(task).toContain("Status: pending");
    expect(task).toContain("out of turns");
  });

  it("keeps the partial result when the agent was stopped before a reload", async () => {
    await sessionWithRunningAgent();
    const { mock } = await reload();

    mock.emitEvent("subagents:failed", { id: "agent-1", result: "half done", status: "stopped" });
    await flush();

    const task = await statusOf(mock);
    expect(task).toContain("Status: completed");
    expect(task).toContain("half done");
  });

  it("lets a blocking TaskOutput resolve on the reattached agent's event", async () => {
    await sessionWithRunningAgent();
    const { mock } = await reload();

    const pending = mock.executeTool("TaskOutput", { task_id: "1", block: true, timeout: 5000 });
    await flush();
    mock.emitEvent("subagents:completed", { id: "agent-1", result: "done" });

    expect((await pending).content[0].text).toBe("Task #1 [completed] — subagent agent-1\n\ndone");
  });

  it("resolves an agent ID to its task after a reload", async () => {
    await sessionWithRunningAgent();
    const { mock } = await reload();

    const res = await mock.executeTool("TaskOutput", { task_id: "agent-1", block: false, timeout: 30000 });
    expect(res.content[0].text).toBe("Task #1 [in_progress] — subagent agent-1");
  });

  it("restores cascade options for a running agent after reload", async () => {
    config.current = { autoCascade: true };
    const first = mockPi();
    const firstRpc = installSubagentsMock(first.pi);
    initExtension(first.pi as never);
    await first.executeTool("TaskCreate", {
      subject: "Blocker",
      description: "d",
      agentType: "general-purpose",
    });
    await first.executeTool("TaskCreate", {
      subject: "Dependent",
      description: "d",
      agentType: "general-purpose",
    });
    await first.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });
    await first.executeTool("TaskExecute", {
      task_ids: ["1"],
      additional_context: "carry this context",
      model: "cascade-model",
      max_turns: 7,
    });
    firstRpc.unsub();

    const reloaded = await reload();
    reloaded.mock.emitEvent("subagents:completed", { id: "agent-1", result: "done" });
    await flush();

    expect(reloaded.rpc.spawned).toHaveLength(1);
    expect(reloaded.rpc.spawned[0].options.model).toBe("cascade-model");
    expect(reloaded.rpc.spawned[0].options.maxTurns).toBe(7);
    expect(reloaded.rpc.spawned[0].prompt).toContain("carry this context");
    expect(await statusOf(reloaded.mock, "2")).toContain("Status: in_progress");
    reloaded.rpc.unsub();
  });

  it("does not reattach a task that is no longer in progress", async () => {
    // A failed agent leaves metadata.agentId behind on a task reverted to pending.
    // Reattaching that would let a late event resurrect work the user reset.
    const first = await sessionWithRunningAgent();
    first.emitEvent("subagents:failed", { id: "agent-1", error: "boom", status: "error" });
    await flush();
    expect(await statusOf(first)).toContain("Status: pending");

    const { mock } = await reload();
    mock.emitEvent("subagents:completed", { id: "agent-1", result: "late" });
    await flush();

    const task = await statusOf(mock);
    expect(task).toContain("Status: pending");
    expect(task).not.toContain("late");
  });

  it("ignores a late completion after a running task is manually reset", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as never);
    await mock.executeTool("TaskCreate", {
      subject: "Retry me",
      description: "d",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    await mock.executeTool("TaskUpdate", { taskId: "1", status: "pending" });
    mock.emitEvent("subagents:completed", { id: "agent-1", result: "late" });
    await flush();

    const task = await statusOf(mock);
    expect(task).toContain("Status: pending");
    expect(task).not.toContain("late");
    rpc.unsub();
  });

  it("ignores a duplicate event after the reattached agent already reported", async () => {
    await sessionWithRunningAgent();
    const { mock } = await reload();

    mock.emitEvent("subagents:completed", { id: "agent-1", result: "first" });
    await flush();
    // A second session_start must not re-map the now-completed task.
    await mock.fireLifecycle("before_agent_start", {}, mockSessionCtx("s1"));
    mock.emitEvent("subagents:failed", { id: "agent-1", error: "late failure", status: "error" });
    await flush();

    const task = await statusOf(mock);
    expect(task).toContain("Status: completed");
    expect(task).not.toContain("late failure");
  });

  it("does not carry an agent mapping into the next session", async () => {
    // Task IDs restart at 1 in every session, so a mapping left over from the
    // previous one points at an unrelated task here. The agent's completion would
    // then close a task it never ran and overwrite its metadata.
    delete process.env.PI_TASKS; // session scope: /new re-points the store
    vi.spyOn(process, "cwd").mockReturnValue(dir);

    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);

    await mock.fireLifecycle("session_start", { reason: "startup" }, mockSessionCtx("session-a"));
    await mock.executeTool("TaskCreate", { subject: "A's job", description: "d", agentType: "general-purpose" });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    await mock.fireLifecycle("session_start", { reason: "new" }, mockSessionCtx("session-b"));
    await mock.executeTool("TaskCreate", { subject: "B's unrelated task", description: "d" });

    mock.emitEvent("subagents:completed", { id: "agent-1", result: "belongs to session A" });
    await flush();

    const task = await statusOf(mock);
    expect(task).toContain("B's unrelated task");
    expect(task).toContain("Status: pending");
    expect(task).not.toContain("belongs to session A");
    rpc.unsub();
  });

  it("stops a delayed spawn when the task is reset before the reply", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi, { spawnReplyDelayMs: 20 });
    initExtension(mock.pi as never);
    await mock.executeTool("TaskCreate", {
      subject: "Reset during spawn",
      description: "d",
      agentType: "general-purpose",
    });

    const delayed = mock.executeTool("TaskExecute", { task_ids: ["1"] });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "pending" });
    expect((await delayed).content[0].text).toContain("task changed before launch completed");

    expect(rpc.stopped).toEqual(["agent-1"]);
    const task = await statusOf(mock);
    expect(task).toContain("Status: pending");
    expect(task).not.toContain("Owner: agent-1");
    rpc.unsub();
  });

  it("finishes a delayed TaskUpdate against its original store", async () => {
    delete process.env.PI_TASKS;
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi, { stopReplyDelayMs: 20 });
    initExtension(mock.pi as never);
    const sessionA = mockSessionCtx("session-a", { cwd: dir });
    const sessionB = mockSessionCtx("session-b", { cwd: dir });

    await mock.fireLifecycle("session_start", { reason: "startup" }, sessionA);
    await mock.executeTool("TaskCreate", {
      subject: "A's running task",
      description: "d",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    const updating = mock.executeTool("TaskUpdate", { taskId: "1", status: "deleted" });

    await mock.fireLifecycle("session_start", { reason: "new" }, sessionB);
    await mock.executeTool("TaskCreate", { subject: "B's task", description: "d" });
    await updating;

    const task = await statusOf(mock);
    expect(task).toContain("B's task");
    expect(task).toContain("Status: pending");
    rpc.unsub();
  });

  it("does not detach a replacement-session agent after a delayed TaskStop", async () => {
    delete process.env.PI_TASKS;
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi, { stopReplyDelayMs: 20 });
    initExtension(mock.pi as never);
    const sessionA = mockSessionCtx("session-a", { cwd: dir });
    const sessionB = mockSessionCtx("session-b", { cwd: dir });

    await mock.fireLifecycle("session_start", { reason: "startup" }, sessionA);
    await mock.executeTool("TaskCreate", {
      subject: "A's running task",
      description: "d",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    const stopping = mock.executeTool("TaskStop", { task_id: "1" });

    await mock.fireLifecycle("session_start", { reason: "new" }, sessionB);
    await mock.executeTool("TaskCreate", {
      subject: "B's running task",
      description: "d",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    await stopping;

    expect(await statusOf(mock)).toContain("Owner: agent-2");
    mock.emitEvent("subagents:completed", { id: "agent-2", result: "B done" });
    await flush();
    expect(await statusOf(mock)).toContain("Status: completed");
    rpc.unsub();
  });

  it("does not read replacement-session state after an output wait", async () => {
    delete process.env.PI_TASKS;
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as never);
    const sessionA = mockSessionCtx("session-a", { cwd: dir });
    const sessionB = mockSessionCtx("session-b", { cwd: dir });

    await mock.fireLifecycle("session_start", { reason: "startup" }, sessionA);
    await mock.executeTool("TaskCreate", {
      subject: "A's job",
      description: "d",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    const waiting = mock.executeTool("TaskOutput", { task_id: "1", block: true, timeout: 5000 });
    await flush();

    await mock.fireLifecycle("session_start", { reason: "new" }, sessionB);
    await mock.executeTool("TaskCreate", { subject: "B's task", description: "d" });
    mock.emitEvent("subagents:completed", { id: "agent-1", result: "A's result" });

    await expect(waiting).rejects.toThrow("Task context changed while waiting for output");
    expect(await statusOf(mock)).toContain("B's task");
    rpc.unsub();
  });

  it("does not attach a delayed cascaded spawn to the replacement session", async () => {
    delete process.env.PI_TASKS;
    config.current = { autoCascade: true };
    const mock = mockPi();
    const firstRpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as never);
    const sessionA = mockSessionCtx("session-a", { cwd: dir });
    const sessionB = mockSessionCtx("session-b", { cwd: dir });

    await mock.fireLifecycle("session_start", { reason: "startup" }, sessionA);
    await mock.executeTool("TaskCreate", {
      subject: "A blocker",
      description: "d",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "A dependent",
      description: "d",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    firstRpc.unsub();
    const delayedRpc = installSubagentsMock(mock.pi, { spawnReplyDelayMs: 20 });
    mock.emitEvent("subagents:completed", { id: "agent-1", result: "done" });
    await mock.fireLifecycle("session_start", { reason: "new" }, sessionB);
    await mock.executeTool("TaskCreate", { subject: "B's task", description: "d" });
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(delayedRpc.spawned).toHaveLength(1);
    expect(delayedRpc.stopped).toEqual(["agent-1"]);
    const task = await statusOf(mock);
    expect(task).toContain("B's task");
    expect(task).toContain("Status: pending");
    expect(task).not.toContain("Owner:");
    delayedRpc.unsub();
  });

  it("does not attach a delayed spawn reply to the replacement session", async () => {
    delete process.env.PI_TASKS;
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi, { spawnReplyDelayMs: 20 });
    initExtension(mock.pi as never);
    const sessionA = mockSessionCtx("session-a", { cwd: dir });
    const sessionB = mockSessionCtx("session-b", { cwd: dir });

    await mock.fireLifecycle("session_start", { reason: "startup" }, sessionA);
    await mock.executeTool("TaskCreate", {
      subject: "A's delayed job",
      description: "d",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "A's second job",
      description: "d",
      agentType: "general-purpose",
    });
    const delayed = mock.executeTool("TaskExecute", { task_ids: ["1", "2"] });

    await mock.fireLifecycle("session_start", { reason: "new" }, sessionB);
    await mock.executeTool("TaskCreate", { subject: "B's task", description: "d" });
    expect((await delayed).content[0].text).toContain("session changed before launch completed");
    expect(rpc.spawned).toHaveLength(1);

    const task = await statusOf(mock);
    expect(task).toContain("B's task");
    expect(task).toContain("Status: pending");
    expect(task).not.toContain("agent-1");
    rpc.unsub();
  });

  it("reattaches every running agent, not just the first", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
    for (const subject of ["A", "B"]) {
      await mock.executeTool("TaskCreate", { subject, description: "d", agentType: "general-purpose" });
    }
    await mock.executeTool("TaskExecute", { task_ids: ["1", "2"] });
    rpc.unsub();

    const reloaded = await reload();
    reloaded.mock.emitEvent("subagents:completed", { id: "agent-2", result: "b done" });
    reloaded.mock.emitEvent("subagents:completed", { id: "agent-1", result: "a done" });
    await flush();

    expect(await statusOf(reloaded.mock, "1")).toContain("Status: completed");
    expect(await statusOf(reloaded.mock, "2")).toContain("Status: completed");
  });
});
