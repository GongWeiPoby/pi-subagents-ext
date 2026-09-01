/**
 * workflow-task.test.ts — the record one run lives in.
 *
 * Most of `task.ts` is covered through the tool and command suites, which drive
 * it the way the extension does. The pause bookkeeping is not: it is a small
 * state machine that spans the record and the run's control surface, and the
 * two ways it can go wrong — flipping the record without telling the runtime,
 * or letting a held run keep counting elapsed time — are both invisible from
 * the outside. So it gets driven directly, against a control stub.
 */

import { describe, expect, it, vi } from "vitest";
import type { WorkflowChildAttempt } from "../src/workflow/attempt.js";
import type { WorkflowControl } from "../src/workflow/runtime.js";
import {
  completeWorkflowTask,
  createWorkflowTask,
  failWorkflowTask,
  pauseWorkflowTask,
  resolveResumeTarget,
  resumeWorkflowTask,
  updateWorkflowAttempt,
  updateWorkflowProgressBatch,
  type WorkflowTask,
} from "../src/workflow/task.js";

function stubControl(): WorkflowControl & { pause: ReturnType<typeof vi.fn> } {
  return {
    pause: vi.fn(),
    resume: vi.fn(),
    isPaused: vi.fn(() => false),
    skip: vi.fn(() => true),
    retry: vi.fn(() => true),
  } as unknown as WorkflowControl & { pause: ReturnType<typeof vi.fn> };
}

function runningTask(): { task: WorkflowTask; control: ReturnType<typeof stubControl> } {
  const task = createWorkflowTask({ id: "wf_abc123", script: "", startTime: 1_000 });
  const control = stubControl();
  task.control = control;
  return { task, control };
}

function childAttempt(overrides: Partial<WorkflowChildAttempt> = {}): WorkflowChildAttempt {
  return {
    logicalChildIndex: 0,
    logicalChildId: "workflow-child-0",
    physicalAttempt: 1,
    status: "running",
    invocation: "spawn",
    queuedAt: 1_000,
    startedAt: 1_100,
    usage: { turns: 1, toolCalls: 2, tokens: { input: 3, output: 4, cacheWrite: 5 } },
    ...overrides,
  };
}

describe("Todo execution binding", () => {
  it("keeps the controller ref on the workflow task", () => {
    const taskExecutionRef = {
      storeId: "store-1",
      taskId: "7",
      taskAttemptId: "task-attempt-1",
      attemptId: "workflow-attempt-1",
      kind: "workflow" as const,
      executorId: "wf_abc123",
    };

    const task = createWorkflowTask({
      id: "wf_abc123",
      script: "",
      taskExecutionRef,
    });

    expect(task.taskExecutionRef).toEqual(taskExecutionRef);
  });
});

describe("pausing a run", () => {
  it("tells the run to hold, not just the record", () => {
    // Flipping the status alone would show a paused run in every surface while
    // it kept starting agents.
    const { task, control } = runningTask();

    expect(pauseWorkflowTask(task, 5_000)).toBe(true);
    expect(control.pause).toHaveBeenCalledTimes(1);
    expect(task.status).toBe("paused");
    expect(task.pausedAt).toBe(5_000);
  });

  it("banks the held time on resume, so elapsed does not count it", () => {
    const { task, control } = runningTask();
    pauseWorkflowTask(task, 5_000);

    expect(resumeWorkflowTask(task, 9_000)).toBe(true);
    expect(control.resume).toHaveBeenCalledTimes(1);
    expect(task.status).toBe("running");
    expect(task.totalPausedMs).toBe(4_000);
    expect(task.pausedAt).toBeUndefined();
  });

  it("accumulates across several pauses", () => {
    const { task } = runningTask();
    pauseWorkflowTask(task, 2_000);
    resumeWorkflowTask(task, 3_000);
    pauseWorkflowTask(task, 4_000);
    resumeWorkflowTask(task, 10_000);

    expect(task.totalPausedMs).toBe(7_000);
  });

  it("refuses when there is no run behind the record", () => {
    // A task whose run has settled keeps its progress but loses its control;
    // pausing it would be a status the runtime never agreed to.
    const task = createWorkflowTask({ id: "wf_abc123", script: "" });
    expect(pauseWorkflowTask(task)).toBe(false);
    expect(task.status).toBe("running");
  });

  it("refuses to pause twice or resume something running", () => {
    const { task, control } = runningTask();
    expect(pauseWorkflowTask(task, 1_000)).toBe(true);
    expect(pauseWorkflowTask(task, 2_000)).toBe(false);
    expect(control.pause).toHaveBeenCalledTimes(1);
    // And the first pause's clock is untouched by the refused second one.
    expect(task.pausedAt).toBe(1_000);

    expect(resumeWorkflowTask(task, 3_000)).toBe(true);
    expect(resumeWorkflowTask(task, 4_000)).toBe(false);
    expect(control.resume).toHaveBeenCalledTimes(1);
  });
});

describe("resolving a resume target", () => {
  it.each(["running", "paused"] as const)("rejects an active %s run", status => {
    const { task } = runningTask();
    task.status = status;
    task.journalPath = "/tmp/run.workflow.jsonl";
    task.scriptPath = "/tmp/run.workflow.js";

    expect(resolveResumeTarget(task.id, new Map([[task.id, task]]))).toEqual({
      ok: false,
      message: `Workflow "${task.id}" is still ${status}. Stop it from /agents → Workflows before resuming it.`,
    });
  });
});

describe("settling a run", () => {
  const result = {
    status: "completed" as const,
    value: 1,
    meta: { name: "wf", description: "d" },
    progress: [],
    agentCount: 0,
    replayedCount: 0,
  };

  it("drops the control so a finished run cannot be paused", () => {
    const { task } = runningTask();
    completeWorkflowTask(task, result);

    expect(task.control).toBeUndefined();
    expect(task.workflowAttempts).toEqual([]);
    expect(pauseWorkflowTask(task)).toBe(false);
  });

  it("stores non-empty live and completed attempt snapshots with clone isolation", () => {
    const { task } = runningTask();
    const live = childAttempt();

    updateWorkflowAttempt(task, live);
    live.usage!.tokens.input = 99;
    expect(task.workflowAttempts).toEqual([expect.objectContaining({
      status: "running",
      usage: { turns: 1, toolCalls: 2, tokens: { input: 3, output: 4, cacheWrite: 5 } },
    })]);

    const completed = childAttempt({
      status: "completed",
      completedAt: 1_200,
      artifactId: "artifact-1",
      usage: { turns: 2, toolCalls: 3, tokens: { input: 6, output: 7, cacheWrite: 8 } },
    });
    updateWorkflowAttempt(task, completed);
    expect(task.workflowAttempts).toHaveLength(1);
    expect(task.workflowAttempts[0]).toMatchObject({ status: "completed", artifactId: "artifact-1" });

    const completedResult = { ...result, agentCount: 1, attempts: [completed] };
    completeWorkflowTask(task, completedResult);

    completed.usage!.tokens.output = 77;
    task.workflowAttempts[0].usage!.tokens.cacheWrite = 88;
    expect(task.workflowAttempts).toEqual([expect.objectContaining({
      status: "completed",
      artifactId: "artifact-1",
      usage: { turns: 2, toolCalls: 3, tokens: { input: 6, output: 7, cacheWrite: 88 } },
    })]);
    expect(completed.usage).toEqual({
      turns: 2,
      toolCalls: 3,
      tokens: { input: 6, output: 77, cacheWrite: 8 },
    });
  });

  it("banks a pause that was still open when the run finished", () => {
    // A run held at a pause can still settle — its last agents finish and the
    // script returns. That time was spent held, and elapsed has to say so.
    const { task } = runningTask();
    pauseWorkflowTask(task, 4_000);
    completeWorkflowTask(task, result, 9_000);

    expect(task.pausedAt).toBeUndefined();
    expect(task.totalPausedMs).toBe(5_000);
    expect(task.endTime).toBe(9_000);
    expect(task.status).toBe("completed");
  });

  it("banks an open pause and freezes interrupted children when setup fails", () => {
    const { task } = runningTask();
    updateWorkflowProgressBatch(task, [{
      type: "workflow_agent",
      index: 0,
      label: "started child",
      state: "progress",
      startedAt: 2_000,
      lastProgressAt: 4_000,
    }]);
    pauseWorkflowTask(task, 5_000);

    failWorkflowTask(task, "bad meta", 11_000);

    expect(task.control).toBeUndefined();
    expect(task.status).toBe("failed");
    expect(task.pausedAt).toBeUndefined();
    expect(task.totalPausedMs).toBe(6_000);
    expect(task.endTime).toBe(11_000);
    expect(task.fleetPhases[0].agents[0]).toMatchObject({
      state: "interrupted",
      startedAt: 2_000,
      completedAt: 11_000,
    });
  });
});
