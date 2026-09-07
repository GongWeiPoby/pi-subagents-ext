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
import { TaskStore } from "../../src/tasks/task-store.js";
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
  await mock.executeTool("TaskCreate", { subject: "Long job", description: "d", agentType: "Worker" });
  await mock.executeTool("TaskExecute", { task_ids: ["1"] });
  const taskExecutionRef = rpc.taskExecutionRef("agent-1")!;
  rpc.unsub();
  return { mock, rpc, taskExecutionRef };
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
    const { taskExecutionRef } = await sessionWithRunningAgent();
    const { mock, rpc } = await reload();

    rpc.complete("agent-1", "the answer", taskExecutionRef);
    await flush();

    const task = await statusOf(mock);
    expect(task).toContain("Status: completed");
    expect(task).toContain("the answer");
  });

  it("reverts the task to pending when the agent fails after a reload", async () => {
    const { taskExecutionRef } = await sessionWithRunningAgent();
    const { mock, rpc } = await reload();

    rpc.fail("agent-1", "out of turns", taskExecutionRef);
    await flush();

    const task = await statusOf(mock);
    expect(task).toContain("Status: pending");
    expect(task).toContain("out of turns");
  });

  it("keeps the partial result when the agent was stopped before a reload", async () => {
    const { taskExecutionRef } = await sessionWithRunningAgent();
    const { mock, rpc } = await reload();

    rpc.stop("agent-1", "half done", taskExecutionRef);
    await flush();

    const task = await statusOf(mock);
    expect(task).toContain("Status: completed");
    expect(task).toContain("half done");
  });

  it("lets a blocking TaskOutput resolve on the reattached agent's event", async () => {
    const { taskExecutionRef } = await sessionWithRunningAgent();
    const { mock, rpc } = await reload();

    const pending = mock.executeTool("TaskOutput", { task_id: "1", block: true, timeout: 5000 });
    await flush();
    rpc.complete("agent-1", "done", taskExecutionRef);

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
      agentType: "Worker",
    });
    await first.executeTool("TaskCreate", {
      subject: "Dependent",
      description: "d",
      agentType: "Worker",
    });
    await first.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });
    await first.executeTool("TaskExecute", {
      task_ids: ["1"],
      additional_context: "carry this context",
      model: "cascade-model",
      max_turns: 7,
    });
    const taskExecutionRef = firstRpc.taskExecutionRef("agent-1")!;
    firstRpc.unsub();

    const reloaded = await reload();
    reloaded.rpc.complete("agent-1", "done", taskExecutionRef);
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
    const {
      mock: first,
      rpc: firstRpc,
      taskExecutionRef,
    } = await sessionWithRunningAgent();
    firstRpc.fail("agent-1", "boom", taskExecutionRef);
    await flush();
    expect(await statusOf(first)).toContain("Status: pending");

    const reloaded = await reload();
    reloaded.rpc.complete("agent-1", "late", taskExecutionRef);
    await flush();

    const task = await statusOf(reloaded.mock);
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
      agentType: "Worker",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    await mock.executeTool("TaskUpdate", { taskId: "1", status: "pending" });
    rpc.complete("agent-1", "late");
    await flush();

    const task = await statusOf(mock);
    expect(task).toContain("Status: pending");
    expect(task).not.toContain("late");
    rpc.unsub();
  });

  it("does not inherit an older result when a replacement completes without output", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as never);
    await mock.executeTool("TaskCreate", {
      subject: "No stale result",
      description: "d",
      agentType: "Worker",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    await mock.executeTool("TaskUpdate", { taskId: "1", metadata: { result: "old result" } });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "pending" });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    rpc.complete("agent-2");
    await flush();

    const task = await statusOf(mock);
    expect(task).toContain("Status: completed");
    expect(task).not.toContain("old result");
    rpc.unsub();
  });

  it.each([
    ["success", (rpc: ReturnType<typeof installSubagentsMock>) => rpc.complete("agent-1", "late success")],
    ["failure", (rpc: ReturnType<typeof installSubagentsMock>) => rpc.fail("agent-1", "late failure")],
    ["stopped output", (rpc: ReturnType<typeof installSubagentsMock>) => rpc.stop("agent-1", "late partial")],
  ])("does not let a late %s event overwrite a replacement attempt", async (_label, emitLate) => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as never);
    await mock.executeTool("TaskCreate", {
      subject: "Retry safely",
      description: "d",
      agentType: "Worker",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "pending" });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    emitLate(rpc);
    await flush();
    const duringRetry = await statusOf(mock);
    expect(duringRetry).toContain("Status: in_progress");
    expect(duringRetry).toContain("Owner: agent-2");
    expect(duringRetry).not.toMatch(/late success|late failure|late partial/);

    rpc.complete("agent-2", "current result");
    await flush();
    const settled = await statusOf(mock);
    expect(settled).toContain("Status: completed");
    expect(settled).toContain("current result");
    rpc.unsub();
  });

  it("rejects malformed and unauthorized lifecycle execution refs", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as never);
    await mock.executeTool("TaskCreate", {
      subject: "Protected event",
      description: "d",
      agentType: "Worker",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    const claim = rpc.spawned[0].options.taskExecution as Record<string, unknown>;

    rpc.complete("agent-1", "missing", "missing");
    rpc.complete("agent-1", "mismatch", "mismatch");
    rpc.complete("agent-1", "malformed", { ...claim, executorId: "" });
    rpc.complete("agent-1", "unauthorized", { ...claim, executorId: "agent-2" });
    await flush();

    const protectedTask = await statusOf(mock);
    expect(protectedTask).toContain("Status: in_progress");
    expect(protectedTask).not.toMatch(/missing|mismatch|malformed|unauthorized/);
    rpc.complete("agent-1", "authorized");
    await flush();
    expect(await statusOf(mock)).toContain("authorized");
    rpc.unsub();
  });

  it("ignores a duplicate event after the reattached agent already reported", async () => {
    const { taskExecutionRef } = await sessionWithRunningAgent();
    const { mock, rpc } = await reload();
    rpc.complete("agent-1", "first", taskExecutionRef);
    await flush();
    // A second session_start must not re-map the now-completed task.
    await mock.fireLifecycle("before_agent_start", {}, mockSessionCtx("s1"));
    rpc.fail("agent-1", "late failure", taskExecutionRef);
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
    await mock.executeTool("TaskCreate", { subject: "A's job", description: "d", agentType: "Worker" });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    await mock.fireLifecycle("session_start", { reason: "new" }, mockSessionCtx("session-b"));
    await mock.executeTool("TaskCreate", { subject: "B's unrelated task", description: "d" });

    rpc.complete("agent-1", "belongs to session A");
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
      agentType: "Worker",
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

  it("stops a just-bound agent when launch metadata loses its CAS race", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
    await mock.executeTool("TaskCreate", {
      subject: "CAS launch",
      description: "d",
      agentType: "Worker",
      metadata: { keep: "current" },
    });

    const concurrent = new TaskStore(process.env.PI_TASKS);
    const originalUpdateExecution = TaskStore.prototype.updateExecution;
    vi.spyOn(TaskStore.prototype, "updateExecution").mockImplementation(function (this: TaskStore, ref, fields) {
      if (fields.owner === "agent-1") {
        concurrent.settleExecution(ref, { status: "completed", result: "stale settled output" });
        concurrent.update("1", { status: "pending" });
        const replacement = concurrent.claimPending("1", {
          kind: "agent",
          taskAttemptId: "replacement-task-attempt",
          attemptId: "replacement-agent-attempt",
        })!.execution!;
        concurrent.bindExecution(replacement, "replacement-agent");
      }
      return originalUpdateExecution.call(this, ref, fields);
    });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    expect(result.content[0].text).toContain("launch lost the task binding");
    expect(rpc.stopped).toEqual(["agent-1"]);
    expect(new TaskStore(process.env.PI_TASKS).get("1")).toMatchObject({
      status: "in_progress",
      owner: "replacement-agent",
      metadata: { keep: "current" },
    });
    expect(new TaskStore(process.env.PI_TASKS).get("1")?.metadata.agentId).toBe("replacement-agent");
    rpc.unsub();
  });

  it("refuses a TaskUpdate when the captured executor is replaced before stop reservation", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as never);
    await mock.executeTool("TaskCreate", {
      subject: "Original subject",
      description: "d",
      agentType: "Worker",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    const concurrent = new TaskStore(process.env.PI_TASKS);
    const originalUpdate = TaskStore.prototype.update;
    let taskUpdateExpectedExecution: Parameters<TaskStore["update"]>[2];
    vi.spyOn(TaskStore.prototype, "update").mockImplementation(function (this: TaskStore, id, fields, expectedExecution, expectedStopToken, retainBinding) {
      if (id === "1" && fields.subject === "Must not overwrite replacement") {
        taskUpdateExpectedExecution = expectedExecution;
      }
      return originalUpdate.call(this, id, fields, expectedExecution, expectedStopToken, retainBinding);
    });
    const originalPrepareExecutionStop = TaskStore.prototype.prepareExecutionStop;
    vi.spyOn(TaskStore.prototype, "prepareExecutionStop").mockImplementation(function (this: TaskStore, ref, status, error) {
      if (ref.executorId === "agent-1") {
        expect(concurrent.settleExecution(ref, { status: "completed", result: "old result" })).toBe(true);
        concurrent.update("1", { status: "pending" });
        const replacementClaim = concurrent.claimPending("1", {
          kind: "agent",
          taskAttemptId: "replacement-task-attempt",
          attemptId: "replacement-agent-attempt",
        })!.execution!;
        concurrent.bindExecution(replacementClaim, "replacement-agent");
      }
      return originalPrepareExecutionStop.call(this, ref, status, error);
    });

    const result = await mock.executeTool("TaskUpdate", {
      taskId: "1",
      status: "completed",
      subject: "Must not overwrite replacement",
    });

    expect(result.content[0].text).toContain("changed while its previous executor was stopping");
    expect(taskUpdateExpectedExecution).toMatchObject({
      taskAttemptId: expect.any(String),
      attemptId: expect.any(String),
      executorId: "agent-1",
    });
    expect(rpc.stopped).toEqual([]);
    expect(new TaskStore(process.env.PI_TASKS).get("1")).toMatchObject({
      status: "in_progress",
      subject: "Original subject",
      owner: "replacement-agent",
      execution: {
        taskAttemptId: "replacement-task-attempt",
        attemptId: "replacement-agent-attempt",
        executorId: "replacement-agent",
      },
    });
    rpc.unsub();
  });

  it("keeps a TaskUpdate ref reserved when stopped output arrives before its final CAS", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi, { stopReplyDelayMs: 20 });
    initExtension(mock.pi as any);
    await mock.executeTool("TaskCreate", {
      subject: "Original subject",
      description: "Original description",
      agentType: "Worker",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    const updating = mock.executeTool("TaskUpdate", {
      taskId: "1",
      status: "completed",
      subject: "Updated subject",
      description: "Updated description",
      metadata: { requested: true },
    });
    await flush();
    rpc.stop("agent-1", "partial output");

    const result = await updating;
    expect(result.content[0].text).toContain("Updated task #1");
    const task = new TaskStore(process.env.PI_TASKS).get("1");
    expect(task).toMatchObject({
      status: "completed",
      subject: "Updated subject",
      description: "Updated description",
      metadata: { requested: true, result: "partial output" },
      execution: undefined,
    });
    rpc.unsub();
  });

  it("revokes a stale workflow binding on reload so the task can be claimed again", async () => {
    const taskStore = new TaskStore(process.env.PI_TASKS);
    taskStore.create("Stale workflow", "d", undefined, { agentType: "Worker" });
    const claim = taskStore.claimPending("1", { kind: "workflow" })!.execution!;
    const staleRef = taskStore.bindExecution(claim, "wf_stale")!;

    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "reload" }, mockSessionCtx("s1"));

    expect((await mock.executeTool("TaskOutput", { task_id: "1", block: false })).content[0].text)
      .toContain("Task #1 [pending] — workflow wf_stale");
    await mock.executeTool("TaskUpdate", {
      taskId: "1",
      subject: "Recovered workflow",
      metadata: { recovered: true },
    });
    expect(await statusOf(mock)).toContain("Recovered workflow");

    const retry = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(retry.content[0].text).toContain("Launched 1 agent");
    expect(taskStore.settleExecution(staleRef, { status: "completed", result: "stale" })).toBe(false);
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
      agentType: "Worker",
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


  it("does not restore a stop reservation after session rollback", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi, {
      stopError: "stop refused",
      stopReplyDelayMs: 20,
    });
    initExtension(mock.pi as never);
    await mock.executeTool("TaskCreate", {
      subject: "Session-bound stop",
      description: "d",
      agentType: "Worker",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    const stopping = mock.executeTool("TaskStop", { task_id: "1" });
    void stopping.catch(() => {});
    await flush();
    await mock.fireLifecycle("session_before_switch");
    await mock.fireLifecycle("session_start", { reason: "new" }, mockSessionCtx("session-b"));

    await expect(stopping).rejects.toThrow("stop refused");
    const task = await statusOf(mock);
    expect(task).toContain("Status: pending");
    expect(task).not.toContain("Status: in_progress");
    expect(task).not.toContain("Owner: agent-1");
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
      agentType: "Worker",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    const stopping = mock.executeTool("TaskStop", { task_id: "1" });

    await mock.fireLifecycle("session_start", { reason: "new" }, sessionB);
    await mock.executeTool("TaskCreate", {
      subject: "B's running task",
      description: "d",
      agentType: "Worker",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    await stopping;

    expect(await statusOf(mock)).toContain("Owner: agent-2");
    rpc.complete("agent-2", "B done");
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
      agentType: "Worker",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    const waiting = mock.executeTool("TaskOutput", { task_id: "1", block: true, timeout: 5000 });
    await flush();

    await mock.fireLifecycle("session_start", { reason: "new" }, sessionB);
    await mock.executeTool("TaskCreate", { subject: "B's task", description: "d" });
    rpc.complete("agent-1", "A's result");

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
      agentType: "Worker",
    });
    await mock.executeTool("TaskCreate", {
      subject: "A dependent",
      description: "d",
      agentType: "Worker",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    firstRpc.unsub();
    const delayedRpc = installSubagentsMock(mock.pi, { spawnReplyDelayMs: 20 });
    firstRpc.complete("agent-1", "done");
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
      agentType: "Worker",
    });
    await mock.executeTool("TaskCreate", {
      subject: "A's second job",
      description: "d",
      agentType: "Worker",
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
      await mock.executeTool("TaskCreate", { subject, description: "d", agentType: "Worker" });
    }
    await mock.executeTool("TaskExecute", { task_ids: ["1", "2"] });
    const refs = [rpc.taskExecutionRef("agent-1")!, rpc.taskExecutionRef("agent-2")!];
    rpc.unsub();

    const reloaded = await reload();
    reloaded.rpc.complete("agent-2", "b done", refs[1]);
    reloaded.rpc.complete("agent-1", "a done", refs[0]);
    await flush();

    expect(await statusOf(reloaded.mock, "1")).toContain("Status: completed");
    expect(await statusOf(reloaded.mock, "2")).toContain("Status: completed");
  });
});
