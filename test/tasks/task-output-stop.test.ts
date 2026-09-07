/**
 * Tests for the TaskOutput and TaskStop tools — subagent-backed tasks, agent-ID
 * resolution, blocking waits, and the error paths.
 *
 * Note: nothing in the extension calls `tracker.track()` (pi's bash tool has no
 * background mode yet), so the ProcessTracker branches of these tools are not
 * reachable from a tool call. ProcessTracker itself is covered in
 * process-tracker.test.ts.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionTaskDir } from "../../src/output-file.js";
import { writeResultArtifact, writeWorkflowAggregateArtifact } from "../../src/result-artifact.js";
import type { TaskExecutionRef } from "../../src/tasks/execution-contract.js";
import type { TaskExecutionCoordinator } from "../../src/tasks/index.js";
import initExtension from "../../src/tasks/index.js";
import { TASK_OUTPUT_RESULT_MAX_LIMIT } from "../../src/tasks/task-output-view.js";
import {
  aggregateWorkflowCoverage,
  type WorkflowChildAttempt,
  type WorkflowCoverageAggregate,
} from "../../src/workflow/attempt.js";
import { flush, installSubagentsMock, mockPi, mockSessionCtx } from "./helpers/mock-pi.js";

beforeEach(() => { process.env.PI_TASKS = "off"; });
afterEach(() => { delete process.env.PI_TASKS; });

/** Create an agent-backed task and launch it, returning the harness. */
async function launchAgentTask(mock: ReturnType<typeof mockPi>, subject = "Agent task") {
  await mock.executeTool("TaskCreate", { subject, description: "d", agentType: "Worker" });
  await mock.executeTool("TaskExecute", { task_ids: ["1"] });
}

describe("TaskOutput", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(() => {
    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
  });

  afterEach(() => { rpc.unsub(); });

  it("defaults to a blocking 30-second join when optional arguments are omitted", async () => {
    await launchAgentTask(mock);
    expect(mock.tools.get("TaskOutput").parameters.required).toEqual(["task_id"]);

    const pending = mock.executeTool("TaskOutput", { task_id: "1" });
    await flush();
    rpc.complete("agent-1", "done");

    expect((await pending).content[0].text).toBe("Task #1 [completed] — subagent agent-1\n\ndone");
  });

  it("returns the current status without waiting when block is false", async () => {
    await launchAgentTask(mock);
    const res = await mock.executeTool("TaskOutput", { task_id: "1", block: false, timeout: 30000 });
    expect(res.content[0].text).toBe("Task #1 [in_progress] — subagent agent-1");
  });

  it("resolves a blocking wait when the agent completes", async () => {
    await launchAgentTask(mock);
    const pending = mock.executeTool("TaskOutput", { task_id: "1", block: true, timeout: 5000 });
    await flush();
    rpc.complete("agent-1", "done");
    expect((await pending).content[0].text).toContain("[completed]");
  });

  it("resolves a blocking wait when the agent fails", async () => {
    await launchAgentTask(mock);
    const pending = mock.executeTool("TaskOutput", { task_id: "1", block: true, timeout: 5000 });
    await flush();
    rpc.fail("agent-1", "boom");
    // The failure listener reverts the task to pending so it can be retried.
    expect((await pending).content[0].text).toContain("[pending]");
  });

  it("gives up after the timeout when the agent never reports back", async () => {
    await launchAgentTask(mock);
    const started = Date.now();
    const res = await mock.executeTool("TaskOutput", { task_id: "1", block: true, timeout: 60 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(res.content[0].text).toContain("[in_progress]");
  });

  it("stops waiting when the tool call is aborted", async () => {
    await launchAgentTask(mock);
    const controller = new AbortController();
    const pending = mock.executeToolWithSignal(
      "TaskOutput",
      { task_id: "1", block: true, timeout: 30000 },
      controller.signal,
    );
    await flush();
    controller.abort();
    expect((await pending).content[0].text).toContain("[in_progress]");
  });

  it("returns immediately when the tool call is already aborted", async () => {
    await launchAgentTask(mock);
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();

    const result = await mock.executeToolWithSignal(
      "TaskOutput",
      { task_id: "1", block: true, timeout: 30000 },
      controller.signal,
    );

    expect(Date.now() - started).toBeLessThan(100);
    expect(result.content[0].text).toContain("[in_progress]");
  });

  it("does not wait for a task that is no longer in_progress", async () => {
    await launchAgentTask(mock);
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });
    // block=true with a long timeout — this must return immediately, not hang.
    const res = await mock.executeTool("TaskOutput", { task_id: "1", block: true, timeout: 30000 });
    expect(res.content[0].text).toContain("[completed]");
  });

  it("keeps legacy metadata-only agent tasks queryable", async () => {
    await mock.executeTool("TaskCreate", { subject: "Legacy agent", description: "d" });
    await mock.executeTool("TaskUpdate", {
      taskId: "1",
      status: "in_progress",
      metadata: { agentId: "legacy-agent" },
    });

    const result = await mock.executeTool("TaskOutput", {
      task_id: "1",
      block: false,
    });

    expect(result.content[0].text).toBe("Task #1 [in_progress] — subagent legacy-agent");
  });

  it("strips runtime-owned workflow aggregate metadata at task creation", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Forged aggregate",
      description: "d",
      metadata: {
        workflowAggregate: {
          artifactId: "workflow-wf_forged",
          artifactStatus: "skipped",
          coverage: aggregateWorkflowCoverage([]),
          resultBodyEnabled: false,
          status: "completed",
          taskBinding: {
            storeId: "forged-store",
            taskId: "1",
            taskAttemptId: "forged-task-attempt",
            attemptId: "forged-workflow-attempt",
            kind: "workflow",
            executorId: "wf_forged",
          },
        },
      },
    });

    await expect(mock.executeTool("TaskOutput", {
      task_id: "wf_forged",
      block: false,
      view: "summary",
    })).rejects.toThrow("No workflow run with ID wf_forged");
  });

  it("throws for an unknown ID", async () => {
    await expect(mock.executeTool("TaskOutput", { task_id: "99", block: false, timeout: 30000 }))
      .rejects.toThrow("No task found with ID 99");
  });

  it("rejects an empty ID instead of matching an arbitrary agent", async () => {
    // Every agent ID starts with "", so an empty id would prefix-match whichever
    // entry the agent map happens to yield first.
    await launchAgentTask(mock);
    await expect(mock.executeTool("TaskOutput", { task_id: "", block: false, timeout: 30000 }))
      .rejects.toThrow("task_id is required");
  });

  it("returns metadata-only summaries for manual tasks", async () => {
    await mock.executeTool("TaskCreate", { subject: "Manual", description: "private task description" });

    const result = await mock.executeTool("TaskOutput", {
      task_id: "1",
      block: false,
      view: "summary",
    });

    expect(result.content[0].text).toBe([
      "TaskOutput summary",
      "Task: #1",
      "Task status: pending",
      "Owner: unavailable",
      "Executor: none",
      "Attempt: unavailable",
      "Artifact: unavailable",
      "Result body: not read by this view",
    ].join("\n"));
    expect(result.content[0].text).not.toContain("private task description");
  });

  it("falls back to summary with an explicit children-not-applicable marker for agents", async () => {
    await launchAgentTask(mock);

    const result = await mock.executeTool("TaskOutput", {
      task_id: "1",
      block: false,
      view: "children",
    });

    expect(result.content[0].text).toContain("TaskOutput summary");
    expect(result.content[0].text).toContain("Agent: agent-1");
    expect(result.content[0].text).toContain("Children: not applicable (executor is not a workflow)");
  });

  it("uses canonical Agent attempt metadata without reading result or error bodies", async () => {
    await launchAgentTask(mock);
    await mock.executeTool("TaskUpdate", { taskId: "1", metadata: { workflowId: "wf_stale" } });
    const managerSymbol = Symbol.for("pi-subagents:manager");
    const previous = (globalThis as Record<symbol, unknown>)[managerSymbol];
    (globalThis as Record<symbol, unknown>)[managerSymbol] = {
      getRecord: () => ({
        id: "agent-1",
        artifactId: "agent-attempt-safe",
        artifactStatus: "complete",
        status: "running",
        result: "PRIVATE_AGENT_RESULT",
        error: "PRIVATE_AGENT_ERROR",
        resultBodyEnabled: false,
        toolUses: 3,
        turnCount: 2,
        lifetimeUsage: { input: 10, output: 20, cacheWrite: 5 },
        invocation: { modelId: "provider/model-safe" },
        taskExecutionRef: rpc.taskExecutionRef("agent-1"),
      }),
    };
    try {
      const result = await mock.executeTool("TaskOutput", {
        task_id: "1",
        block: false,
        view: "summary",
      });
      const text = result.content[0].text;
      expect(text).toContain("Executor: agent agent-1");
      expect(text).toContain("Agent status: running");
      expect(text).toContain("Attempt: task=");
      expect(text).toContain("Artifact: agent-attempt-safe [complete]");
      expect(text).toContain("Usage: turns=2 tools=3 tokens=35");
      expect(text).toContain("Result body: Output persistence disabled.");
      expect(text).not.toMatch(/PRIVATE_AGENT_RESULT|PRIVATE_AGENT_ERROR/);
    } finally {
      if (previous === undefined) delete (globalThis as Record<symbol, unknown>)[managerSymbol];
      else (globalThis as Record<symbol, unknown>)[managerSymbol] = previous;
    }
  });

  it("keeps legacy metadata-only Agent tasks available in summary view", async () => {
    await mock.executeTool("TaskCreate", { subject: "Legacy agent", description: "d" });
    await mock.executeTool("TaskUpdate", {
      taskId: "1",
      status: "in_progress",
      metadata: { agentId: "legacy-agent" },
    });

    const result = await mock.executeTool("TaskOutput", {
      task_id: "1",
      block: false,
      view: "summary",
    });

    expect(result.content[0].text).toContain("Agent: legacy-agent");
    expect(result.content[0].text).toContain("Agent status: in_progress");
  });

  it("reads only an explicitly requested Agent artifact body and preserves Markdown slices", async () => {
    await launchAgentTask(mock);
    const cwd = mkdtempSync(join(tmpdir(), "pi-task-output-result-"));
    const sessionId = "agent-result-session";
    const taskDir = sessionTaskDir(cwd, sessionId);
    const written = writeResultArtifact({
      taskDir,
      artifactId: "agent-attempt-live",
      agentId: "agent-1",
      status: "completed",
      startedAt: 1_000,
      completedAt: 2_000,
      invocation: "spawn",
      usage: {
        turns: 1,
        toolCalls: 2,
        tokens: { input: 3, output: 4, cacheWrite: 0 },
      },
      result: "# Result\r\n\r\nline 2\u001b[31m",
      includeBody: true,
    });
    const managerSymbol = Symbol.for("pi-subagents:manager");
    const previous = (globalThis as Record<symbol, unknown>)[managerSymbol];
    (globalThis as Record<symbol, unknown>)[managerSymbol] = {
      getRecord: () => ({
        id: "agent-1",
        artifactId: "agent-attempt-live",
        artifactStatus: "complete",
        status: "completed",
        result: "PRIVATE_IN_MEMORY_RESULT",
        resultBodyEnabled: true,
        taskExecutionRef: rpc.taskExecutionRef("agent-1"),
      }),
    };
    const context = mockSessionCtx(sessionId, { cwd });
    try {
      const defaultView = await mock.executeTool("TaskOutput", {
        task_id: "1",
        block: false,
      }, context);
      expect(defaultView.content[0].text).not.toMatch(/# Result|PRIVATE_IN_MEMORY_RESULT/);

      const summary = await mock.executeTool("TaskOutput", {
        task_id: "1",
        block: false,
        view: "summary",
      }, context);
      expect(summary.content[0].text).toContain("Result body: not read by this view");
      expect(summary.content[0].text).not.toMatch(/# Result|PRIVATE_IN_MEMORY_RESULT/);
      expect(rpc.consumed).toEqual([]);

      const result = await mock.executeTool("TaskOutput", {
        task_id: "1",
        block: false,
        view: "result",
        offset: 10,
        limit: 6,
      }, context);
      expect(result.content[0].text).toContain(
        "Result: offset=10 limit=6 total=21 showing=10-16 more=true\n\nline 2",
      );
      expect(result.content[0].text).not.toContain("PRIVATE_IN_MEMORY_RESULT");
      expect(result.content[0].text).not.toMatch(/[\u001b\u202E]/);
      expect(rpc.consumed).toEqual(["agent-1"]);

      const beyond = await mock.executeTool("TaskOutput", {
        task_id: "1",
        block: false,
        view: "result",
        offset: 1_000,
        limit: 6,
      }, context);
      expect(beyond.content[0].text).toContain(
        "Result: offset=1000 limit=6 total=21 showing=1000-1000 more=false",
      );
      expect(rpc.consumed).toEqual(["agent-1", "agent-1"]);

      writeFileSync(written.bodyPath!, "tampered\n");
      await expect(mock.executeTool("TaskOutput", {
        task_id: "1",
        block: false,
        view: "result",
      }, context)).rejects.toThrow("result body digest mismatch");
      await expect(mock.executeTool("TaskOutput", {
        task_id: "1",
        block: false,
        view: "summary",
      }, context)).resolves.toBeDefined();
      expect(rpc.consumed).toEqual(["agent-1", "agent-1"]);
    } finally {
      if (previous === undefined) delete (globalThis as Record<symbol, unknown>)[managerSymbol];
      else (globalThis as Record<symbol, unknown>)[managerSymbol] = previous;
      rmSync(dirname(dirname(taskDir)), { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    { status: "running", artifactStatus: "complete", resultBodyEnabled: true },
    { status: "queued", artifactStatus: "complete", resultBodyEnabled: false },
    { status: "completed", artifactStatus: "pending", resultBodyEnabled: true },
  ])("returns unavailable without reading an Agent body for $status/$artifactStatus", async ({
    status,
    artifactStatus,
    resultBodyEnabled,
  }) => {
    await launchAgentTask(mock);
    const managerSymbol = Symbol.for("pi-subagents:manager");
    const previous = (globalThis as Record<symbol, unknown>)[managerSymbol];
    (globalThis as Record<symbol, unknown>)[managerSymbol] = {
      getRecord: () => ({
        id: "agent-1",
        artifactId: "agent-attempt-unavailable",
        artifactStatus,
        status,
        resultBodyEnabled,
        taskExecutionRef: rpc.taskExecutionRef("agent-1"),
      }),
    };
    try {
      const result = await mock.executeTool("TaskOutput", {
        task_id: "1",
        block: false,
        view: "result",
      }, mockSessionCtx("agent-unavailable-session"));

      expect(result.content[0].text).toContain("Result: result body is unavailable");
      expect(rpc.consumed).toEqual([]);
    } finally {
      if (previous === undefined) delete (globalThis as Record<symbol, unknown>)[managerSymbol];
      else (globalThis as Record<symbol, unknown>)[managerSymbol] = previous;
    }
  });

  it("uses the fixed privacy marker without exposing an Agent's in-memory result", async () => {
    await launchAgentTask(mock);
    const managerSymbol = Symbol.for("pi-subagents:manager");
    const previous = (globalThis as Record<symbol, unknown>)[managerSymbol];
    (globalThis as Record<symbol, unknown>)[managerSymbol] = {
      getRecord: () => ({
        id: "agent-1",
        status: "completed",
        result: "PRIVATE_IN_MEMORY_RESULT",
        resultBodyEnabled: false,
        taskExecutionRef: rpc.taskExecutionRef("agent-1"),
      }),
    };
    try {
      const result = await mock.executeTool("TaskOutput", {
        task_id: "1",
        block: false,
        view: "result",
      });
      expect(result.content[0].text).toContain("Result: Output persistence disabled.");
      expect(result.content[0].text).not.toContain("PRIVATE_IN_MEMORY_RESULT");
      expect(rpc.consumed).toEqual([]);
    } finally {
      if (previous === undefined) delete (globalThis as Record<symbol, unknown>)[managerSymbol];
      else (globalThis as Record<symbol, unknown>)[managerSymbol] = previous;
    }
  });

  it("does not invent Agent result reload support without an in-memory artifact locator", async () => {
    await mock.executeTool("TaskCreate", { subject: "Reloaded Agent", description: "d" });
    await mock.executeTool("TaskUpdate", {
      taskId: "1",
      status: "completed",
      metadata: { agentId: "reloaded-agent", result: "PRIVATE_RELOADED_RESULT" },
    });

    const result = await mock.executeTool("TaskOutput", {
      task_id: "1",
      block: false,
      view: "result",
    }, mockSessionCtx("reloaded-agent-session"));

    expect(result.content[0].text).toContain("Agent: reloaded-agent");
    expect(result.content[0].text).toContain("Result: result body is unavailable");
    expect(result.content[0].text).not.toContain("PRIVATE_RELOADED_RESULT");
  });

  it("rejects invalid explicit views", async () => {
    await mock.executeTool("TaskCreate", { subject: "Manual", description: "d" });
    await expect(mock.executeTool("TaskOutput", {
      task_id: "1",
      block: false,
      view: "bogus",
    })).rejects.toThrow("Invalid TaskOutput view: bogus");
  });

  it.each([
    { field: "offset", value: -1 },
    { field: "offset", value: 1.5 },
    { field: "offset", value: TASK_OUTPUT_RESULT_MAX_LIMIT + 1 },
    { field: "limit", value: -1 },
    { field: "limit", value: 1.5 },
    { field: "limit", value: TASK_OUTPUT_RESULT_MAX_LIMIT + 1 },
  ])("rejects invalid result $field=$value", async ({ field, value }) => {
    await mock.executeTool("TaskCreate", { subject: "Manual", description: "d" });
    await expect(mock.executeTool("TaskOutput", {
      task_id: "1",
      block: false,
      view: "result",
      [field]: value,
    })).rejects.toThrow(`TaskOutput ${field} must be a non-negative integer within the result limit`);
  });

  it("throws for a task with neither a process nor an agent", async () => {
    await mock.executeTool("TaskCreate", { subject: "Manual", description: "d" });
    await expect(mock.executeTool("TaskOutput", { task_id: "1", block: false, timeout: 30000 }))
      .rejects.toThrow("No background process for task 1");
  });
});

describe("TaskOutput — workflow runs", () => {
  interface WorkflowSnapshot {
    id: string;
    status: "running" | "paused" | "completed" | "failed" | "killed";
    name?: string;
    doneCount: number;
    totalCount: number;
    replayedCount: number;
    totalTokens: number;
    totalToolCalls: number;
    elapsedMs: number;
    output?: string;
    scriptPath?: string;
    taskExecutionRef?: TaskExecutionRef;
    attempts?: readonly WorkflowChildAttempt[];
    coverage?: WorkflowCoverageAggregate;
    resultBodyEnabled?: boolean;
    aggregateArtifactId?: string;
    aggregateArtifactStatus?: "pending" | "complete" | "metadata-only" | "failed" | "skipped";
    evidenceIncomplete?: boolean;
  }

  function workflowHarness(initial: WorkflowSnapshot) {
    let current: WorkflowSnapshot | undefined = initial;
    let settleWait: (() => void) | undefined;
    const consume = vi.fn();
    const adapter = {
      get: (id: string) => current?.id === id ? current : undefined,
      list: () => current ? [current.id] : [],
      wait: (_id: string, options: { signal?: AbortSignal; timeoutMs: number }) =>
        new Promise<WorkflowSnapshot | undefined>((resolve) => {
          let finished = false;
          const finish = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", finish);
            resolve(current);
          };
          const timer = setTimeout(finish, options.timeoutMs);
          settleWait = finish;
          if (options.signal?.aborted) finish();
          else options.signal?.addEventListener("abort", finish, { once: true });
        }),
      consume,
    };
    return {
      adapter,
      consume,
      set(next: WorkflowSnapshot | undefined) { current = next; },
      settle() { settleWait?.(); },
    };
  }

  const running = (): WorkflowSnapshot => ({
    id: "wf_test123",
    status: "running",
    name: "status regression",
    doneCount: 1,
    totalCount: 3,
    replayedCount: 0,
    totalTokens: 120,
    totalToolCalls: 4,
    elapsedMs: 2500,
    scriptPath: "/tmp/wf_test123.workflow.js",
  });

  it("prefers a live canonical workflow binding over colliding legacy metadata", async () => {
    const mock = mockPi();
    const harness = workflowHarness(running());
    const taskExecutions = initExtension(mock.pi as never, { workflowOutput: harness.adapter });
    await mock.executeTool("TaskCreate", { subject: "Stale legacy", description: "d" });
    await mock.executeTool("TaskUpdate", {
      taskId: "1",
      metadata: { workflowId: "wf_test123" },
    });
    await mock.executeTool("TaskCreate", { subject: "Canonical", description: "d" });
    const claim = taskExecutions.claim(
      "2",
      "workflow",
      "canonical-workflow-attempt",
      "canonical-task-attempt",
    );
    expect(claim).toBeDefined();
    const ref = taskExecutions.bind(claim!, "wf_test123");
    expect(ref).toBeDefined();
    harness.set({ ...running(), taskExecutionRef: ref });

    const result = await mock.executeTool("TaskOutput", {
      task_id: "wf_test123",
      block: false,
      view: "summary",
    });

    expect(result.content[0].text).toContain("Task: #2");
    expect(result.content[0].text).toContain("Executor: workflow wf_test123");
    expect(result.content[0].text).not.toContain("Task: #1");
  });

  it("returns workflow status without blocking or consuming its future notification", async () => {
    const mock = mockPi();
    const harness = workflowHarness(running());
    initExtension(mock.pi as never, { workflowOutput: harness.adapter });

    const result = await mock.executeTool("TaskOutput", { task_id: "wf_test123", block: false });

    expect(result.content[0].text).toContain('Workflow wf_test123 [running] "status regression"');
    expect(result.content[0].text).toContain("1/3 agents");
    expect(result.content[0].text).toContain("120 tokens");
    expect(harness.consume).not.toHaveBeenCalled();
  });

  it("escapes terminal, line, C1, bidi, and carriage-return controls in workflow metadata", async () => {
    const mock = mockPi();
    const harness = workflowHarness({
      ...running(),
      status: "completed",
      name: "safe\nforged\tname\u001b[2J\u0085\u202ename\rnext",
      scriptPath: "/tmp/safe\nforged\tpath\u001b]8;;file\u0007\u2066path\r.js",
      output: "first line\nsecond\tcolumn\u001b[31m\u009bhidden\u202eright\rreturn",
    });
    initExtension(mock.pi as never, { workflowOutput: harness.adapter });

    const result = await mock.executeTool("TaskOutput", { task_id: "wf_test123", block: false });
    const text = result.content[0].text;

    expect(text).toContain('"safe\\u000aforged\\u0009name\\u001b[2J\\u0085\\u202ename\\u000dnext"');
    expect(text).toContain(
      "Script: /tmp/safe\\u000aforged\\u0009path\\u001b]8;;file\\u0007\\u2066path\\u000d.js",
    );
    expect(text).toContain("first line\nsecond\tcolumn\\u001b[31m\\u009bhidden\\u202eright\\u000dreturn");
    expect(text).toMatch(/first line\nsecond\tcolumn/);
    expect(text).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/);
  });

  it("returns a workflow summary without reading or consuming its result body", async () => {
    const mock = mockPi();
    const harness = workflowHarness({
      ...running(),
      status: "completed",
      output: "PRIVATE_WORKFLOW_RESULT",
      resultBodyEnabled: false,
      aggregateArtifactId: "workflow-wf_test123",
      aggregateArtifactStatus: "metadata-only",
      evidenceIncomplete: true,
      attempts: [{
        logicalChildIndex: 0,
        logicalChildId: "workflow-child-0",
        physicalAttempt: 1,
        status: "failed",
        invocation: "spawn",
        error: "PRIVATE_CHILD_ERROR",
      }],
    });
    initExtension(mock.pi as never, { workflowOutput: harness.adapter });

    const result = await mock.executeTool("TaskOutput", {
      task_id: "wf_test123",
      block: false,
      view: "summary",
    });
    const text = result.content[0].text;

    expect(text).toContain("TaskOutput summary");
    expect(text).toContain("Workflow: wf_test123 [completed]");
    expect(text).toContain("Coverage: logical=0/1 physical=0/1 failed=1 pending=0 status=failed");
    expect(text).toContain("Evidence incomplete: yes");
    expect(text).toContain("Artifact: workflow-wf_test123 [metadata-only]");
    expect(text).toContain("Result body: Output persistence disabled.");
    expect(text).not.toMatch(/PRIVATE_WORKFLOW_RESULT|PRIVATE_CHILD_ERROR/);

    const privateResult = await mock.executeTool("TaskOutput", {
      task_id: "wf_test123",
      block: false,
      view: "result",
    });
    expect(privateResult.content[0].text).toContain("Result: Output persistence disabled.");
    expect(privateResult.content[0].text).not.toContain("PRIVATE_WORKFLOW_RESULT");
    expect(harness.consume).not.toHaveBeenCalled();
  });

  it.each([
    { status: "running" as const, artifactStatus: "complete" as const },
    { status: "paused" as const, artifactStatus: "complete" as const },
    { status: "completed" as const, artifactStatus: "pending" as const },
    { status: "failed" as const, artifactStatus: "failed" as const },
    { status: "killed" as const, artifactStatus: "skipped" as const },
  ])("returns unavailable without reading a Workflow body for $status/$artifactStatus", async ({
    status,
    artifactStatus,
  }) => {
    const mock = mockPi();
    const harness = workflowHarness({
      ...running(),
      status,
      output: "PRIVATE_LIVE_WORKFLOW_RESULT",
      resultBodyEnabled: true,
      aggregateArtifactId: "workflow-wf_test123",
      aggregateArtifactStatus: artifactStatus,
    });
    initExtension(mock.pi as never, { workflowOutput: harness.adapter });

    const result = await mock.executeTool("TaskOutput", {
      task_id: "wf_test123",
      block: false,
      view: "result",
      offset: 0,
      limit: 50,
    }, mockSessionCtx("live-workflow-session"));

    expect(result.content[0].text).toContain("Workflow: wf_test123");
    expect(result.content[0].text).toContain("Result: workflow aggregate body is unavailable");
    expect(result.content[0].text).not.toContain("PRIVATE_LIVE_WORKFLOW_RESULT");
    expect(harness.consume).not.toHaveBeenCalled();
  });

  it("consumes a settled Workflow only after returning its persisted body", async () => {
    const mock = mockPi();
    const cwd = mkdtempSync(join(tmpdir(), "pi-task-output-workflow-result-"));
    const sessionId = "workflow-result-session";
    const taskDir = sessionTaskDir(cwd, sessionId);
    writeWorkflowAggregateArtifact({
      taskDir,
      artifactId: "workflow-wf_test123",
      workflowId: "wf_test123",
      status: "completed",
      startedAt: 1_000,
      completedAt: 2_000,
      coverage: aggregateWorkflowCoverage([]),
      childAttempts: [],
      resultSummary: "persisted workflow result",
      result: "# Persisted workflow result",
      includeBody: true,
    });
    const harness = workflowHarness({
      ...running(),
      status: "completed",
      output: "PRIVATE_IN_MEMORY_WORKFLOW_RESULT",
      resultBodyEnabled: true,
      aggregateArtifactId: "workflow-wf_test123",
      aggregateArtifactStatus: "complete",
    });
    initExtension(mock.pi as never, { workflowOutput: harness.adapter });
    try {
      const result = await mock.executeTool("TaskOutput", {
        task_id: "wf_test123",
        block: false,
        view: "result",
      }, mockSessionCtx(sessionId, { cwd }));

      expect(result.content[0].text).toContain("# Persisted workflow result");
      expect(result.content[0].text).not.toContain("PRIVATE_IN_MEMORY_WORKFLOW_RESULT");
      expect(harness.consume).toHaveBeenCalledTimes(1);
      expect(harness.consume).toHaveBeenCalledWith("wf_test123");
    } finally {
      rmSync(dirname(dirname(taskDir)), { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("bounds workflow child rows and applies privacy markers", async () => {
    const mock = mockPi();
    const attempts: WorkflowChildAttempt[] = Array.from({ length: 105 }, (_, index) => ({
      logicalChildIndex: index,
      logicalChildId: `workflow-child-${index}`,
      physicalAttempt: 1,
      status: index === 0 ? "failed" : "completed",
      invocation: "spawn",
      recordId: `record-${index}`,
      artifactId: `artifact-${index}`,
      modelId: "provider/model-safe",
      usage: { turns: 1, toolCalls: 2, tokens: { input: 3, output: 4, cacheWrite: 5 } },
      ...(index === 0 ? { error: "PRIVATE_CHILD_ERROR" } : {}),
    }));
    const harness = workflowHarness({
      ...running(),
      attempts,
      resultBodyEnabled: false,
      aggregateArtifactId: "workflow-wf_test123",
      aggregateArtifactStatus: "pending",
    });
    initExtension(mock.pi as never, { workflowOutput: harness.adapter });

    const result = await mock.executeTool("TaskOutput", {
      task_id: "wf_test123",
      block: false,
      view: "children",
    });
    const text = result.content[0].text;
    const childRows = text.split("\n").filter(line => line.startsWith("index="));

    expect(text).toContain("Children: showing 100 of 105 attempts (limit 100)");
    expect(childRows).toHaveLength(100);
    expect(childRows[0]).toContain("error=Output persistence disabled.");
    expect(text).not.toContain("PRIVATE_CHILD_ERROR");
    expect(text).not.toContain("index=100 ");
    expect(harness.consume).not.toHaveBeenCalled();
  });

  it.each([
    { label: "privacy off", resultBodyEnabled: false },
    { label: "privacy on", resultBodyEnabled: true },
  ])("handles a live skipped child error with $label", async ({ resultBodyEnabled }) => {
    const mock = mockPi();
    const privateError = `PRIVATE_SKIPPED_CHILD_ERROR_${"x".repeat(600)}`;
    const harness = workflowHarness({
      ...running(),
      attempts: [{
        logicalChildIndex: 0,
        logicalChildId: "workflow-child-0",
        physicalAttempt: 1,
        status: "skipped",
        invocation: "spawn",
        skipped: true,
        error: privateError,
      }],
      resultBodyEnabled,
      aggregateArtifactId: "workflow-wf_test123",
      aggregateArtifactStatus: resultBodyEnabled ? "complete" : "metadata-only",
    });
    initExtension(mock.pi as never, { workflowOutput: harness.adapter });

    const result = await mock.executeTool("TaskOutput", {
      task_id: "wf_test123",
      block: false,
      view: "children",
    });
    const text = result.content[0].text;
    const childRow = text.split("\n").find(line => line.startsWith("index=0 "));

    expect(childRow).toContain("status=skipped");
    if (resultBodyEnabled) {
      const error = childRow?.split(" error=")[1];
      expect(error).toHaveLength(512);
      expect(error).toMatch(/^PRIVATE_SKIPPED_CHILD_ERROR_.*\.\.\.$/);
    } else {
      expect(childRow).toContain("error=Output persistence disabled.");
      expect(text).not.toContain("PRIVATE_SKIPPED_CHILD_ERROR_");
    }
    expect(harness.consume).not.toHaveBeenCalled();
  });

  it("waits for workflow completion and consumes the delivered output", async () => {
    const mock = mockPi();
    const harness = workflowHarness(running());
    initExtension(mock.pi as never, { workflowOutput: harness.adapter });

    const pending = mock.executeTool("TaskOutput", {
      task_id: "wf_test123",
      block: true,
      timeout: 5000,
    });
    void pending.catch(() => {});
    await flush();
    harness.set({ ...running(), status: "completed", doneCount: 3, output: "all checks passed" });
    harness.settle();

    expect((await pending).content[0].text).toContain("all checks passed");
    expect(harness.consume).toHaveBeenCalledTimes(1);
    expect(harness.consume).toHaveBeenCalledWith("wf_test123");
  });

  it("leaves a timed-out running workflow unconsumed", async () => {
    const mock = mockPi();
    const harness = workflowHarness(running());
    initExtension(mock.pi as never, { workflowOutput: harness.adapter });

    const result = await mock.executeTool("TaskOutput", {
      task_id: "wf_test123",
      block: true,
      timeout: 20,
    });

    expect(result.content[0].text).toContain("[running]");
    expect(harness.consume).not.toHaveBeenCalled();
  });

  it("leaves an aborted running workflow unconsumed", async () => {
    const mock = mockPi();
    const harness = workflowHarness(running());
    initExtension(mock.pi as never, { workflowOutput: harness.adapter });
    const controller = new AbortController();

    const pending = mock.executeToolWithSignal(
      "TaskOutput",
      { task_id: "wf_test123", block: true, timeout: 30000 },
      controller.signal,
    );
    void pending.catch(() => {});
    await flush();
    controller.abort();

    expect((await pending).content[0].text).toContain("[running]");
    expect(harness.consume).not.toHaveBeenCalled();
  });

  it("returns already-settled output and consumes it exactly once per returned result", async () => {
    const mock = mockPi();
    const harness = workflowHarness({
      ...running(),
      status: "failed",
      output: "gate failed",
    });
    initExtension(mock.pi as never, { workflowOutput: harness.adapter });

    const result = await mock.executeTool("TaskOutput", { task_id: "wf_test123", block: false });

    expect(result.content[0].text).toContain("[failed]");
    expect(result.content[0].text).toContain("gate failed");
    expect(harness.consume).toHaveBeenCalledTimes(1);
  });

  it("uses a workflow-specific error for an unknown workflow run ID", async () => {
    const mock = mockPi();
    const harness = workflowHarness(running());
    initExtension(mock.pi as never, { workflowOutput: harness.adapter });

    await expect(mock.executeTool("TaskOutput", { task_id: "wf_missing", block: false }))
      .rejects.toThrow("No workflow run with ID wf_missing");
    await expect(mock.executeTool("TaskOutput", { task_id: "wf_missing", block: false }))
      .rejects.toThrow("wf_test123");
  });
});

describe("TaskOutput — persisted workflow views", () => {
  interface WorkflowAggregateReaderInput {
    cwd: string;
    sessionId: string;
    workflowId: string;
    taskBinding?: TaskExecutionRef;
  }

  const attempts: WorkflowChildAttempt[] = [{
    logicalChildIndex: 0,
    logicalChildId: "workflow-child-0",
    physicalAttempt: 1,
    status: "completed",
    invocation: "spawn",
    recordId: "record-safe",
    artifactId: "artifact-safe",
    usage: { turns: 1, toolCalls: 2, tokens: { input: 3, output: 4, cacheWrite: 5 } },
  }];
  const coverage = aggregateWorkflowCoverage(attempts);

  async function seed(
    mock: ReturnType<typeof mockPi>,
    coordinator: TaskExecutionCoordinator,
    options: {
      artifactStatus?: "pending" | "complete" | "metadata-only" | "failed" | "skipped";
      coverage?: WorkflowCoverageAggregate;
      resultBodyEnabled?: boolean;
      taskId?: string;
    } = {},
  ): Promise<TaskExecutionRef> {
    await mock.executeTool("TaskCreate", {
      subject: "Reloaded workflow",
      description: "d",
    });
    const taskId = options.taskId ?? "1";
    const claim = coordinator.claim(taskId, "workflow");
    if (!claim) throw new Error(`Could not claim task ${taskId} for workflow fixture`);
    const ref = coordinator.bind(claim, "wf_reload123");
    if (!ref) throw new Error(`Could not bind task ${taskId} for workflow fixture`);
    expect(coordinator.update(ref, {
      metadata: {
        workflowAggregate: {
          artifactId: "workflow-wf_reload123",
          artifactStatus: options.artifactStatus ?? "complete",
          coverage: options.coverage ?? coverage,
          resultBodyEnabled: options.resultBodyEnabled ?? true,
          status: "completed",
          taskBinding: ref,
        },
        workflowId: "wf_reload123",
      },
    })).toBe(true);
    expect(coordinator.settle(ref, { status: "completed" })).toBe(true);
    return ref;
  }

  it("falls back to persisted aggregate metadata and never uses the reader on the legacy default view", async () => {
    const mock = mockPi();
    const reader = vi.fn((input: WorkflowAggregateReaderInput) => ({
      manifestPath: "/managed/workflow-wf_reload123.json",
      manifest: {
        schemaVersion: 1 as const,
        artifactId: "workflow-wf_reload123",
        workflowId: "wf_reload123",
        workflowName: "reloaded",
        status: "completed" as const,
        startedAt: new Date(1_000).toISOString(),
        completedAt: new Date(2_000).toISOString(),
        coverage,
        childAttempts: attempts,
        resultSummary: "PRIVATE_SUMMARY_NOT_FOR_VIEW",
        resultBodyPath: "workflow-wf_reload123.md",
        resultDigest: `sha256:${"0".repeat(64)}`,
        taskBinding: input.taskBinding,
        artifactStatus: "complete" as const,
      },
    }));
    const coordinator = initExtension(mock.pi as never, { workflowAggregateReader: reader });
    const ref = await seed(mock, coordinator);
    const context = mockSessionCtx("reload-session");

    await mock.executeTool("TaskOutput", { task_id: "1", block: false }, context);
    expect(reader).not.toHaveBeenCalled();

    const summary = await mock.executeTool("TaskOutput", {
      task_id: "1",
      block: false,
      view: "summary",
    }, context);
    expect(summary.content[0].text).toContain("Workflow: wf_reload123 [completed] \"reloaded\"");
    expect(summary.content[0].text).toContain(
      `Attempt: task=${ref.taskAttemptId} executor=${ref.attemptId}`,
    );
    expect(summary.content[0].text).toContain("Artifact: workflow-wf_reload123 [complete]");
    expect(summary.content[0].text).not.toContain("PRIVATE_SUMMARY_NOT_FOR_VIEW");

    const children = await mock.executeTool("TaskOutput", {
      task_id: "wf_reload123",
      block: false,
      view: "children",
    }, context);
    expect(children.content[0].text).toContain("index=0 attempt=1 status=completed invocation=spawn");
    expect(reader).toHaveBeenCalledTimes(2);
    expect(reader).toHaveBeenLastCalledWith({
      cwd: context.cwd,
      sessionId: "reload-session",
      workflowId: "wf_reload123",
      taskBinding: ref,
    });
  });

  it.each(["pending", "failed", "skipped"] as const)(
    "returns unavailable for persisted aggregate status %s without calling the manifest reader",
    async artifactStatus => {
      const mock = mockPi();
      const reader = vi.fn(() => {
        throw new Error("manifest reader must not run");
      });
      const coordinator = initExtension(mock.pi as never, { workflowAggregateReader: reader });
      await seed(mock, coordinator, { artifactStatus });

      const result = await mock.executeTool("TaskOutput", {
        task_id: "1",
        block: false,
        view: "result",
      }, mockSessionCtx("reload-session"));

      expect(result.content[0].text).toContain("Result: workflow aggregate body is unavailable");
      expect(reader).not.toHaveBeenCalled();
    },
  );

  it("keeps legacy workflow metadata queryable when no aggregate exists", async () => {
    const mock = mockPi();
    initExtension(mock.pi as never);
    await mock.executeTool("TaskCreate", { subject: "Legacy workflow", description: "d" });
    await mock.executeTool("TaskUpdate", {
      taskId: "1",
      status: "completed",
      metadata: { workflowId: "wf_legacy123" },
    });

    const summary = await mock.executeTool("TaskOutput", {
      task_id: "wf_legacy123",
      block: false,
      view: "summary",
    });

    expect(summary.content[0].text).toContain("Task: #1");
    expect(summary.content[0].text).toContain("Workflow: wf_legacy123 [completed]");
  });

  it("prefers a validated aggregate binding over colliding legacy workflow metadata", async () => {
    const mock = mockPi();
    const reader = vi.fn((input: WorkflowAggregateReaderInput) => ({
      manifestPath: "/managed/workflow-wf_reload123.json",
      manifest: {
        schemaVersion: 1 as const,
        artifactId: "workflow-wf_reload123",
        workflowId: "wf_reload123",
        workflowName: "validated aggregate",
        status: "completed" as const,
        startedAt: new Date(1_000).toISOString(),
        completedAt: new Date(2_000).toISOString(),
        coverage,
        childAttempts: attempts,
        taskBinding: input.taskBinding,
        artifactStatus: "complete" as const,
      },
    }));
    const coordinator = initExtension(mock.pi as never, { workflowAggregateReader: reader });
    await mock.executeTool("TaskCreate", { subject: "Stale legacy", description: "d" });
    await mock.executeTool("TaskUpdate", {
      taskId: "1",
      status: "completed",
      metadata: { workflowId: "wf_reload123" },
    });
    const ref = await seed(mock, coordinator, { taskId: "2" });
    const context = mockSessionCtx("reload-session");

    const summary = await mock.executeTool("TaskOutput", {
      task_id: "wf_reload123",
      block: false,
      view: "summary",
    }, context);

    expect(summary.content[0].text).toContain("Task: #2");
    expect(summary.content[0].text).toContain('Workflow: wf_reload123 [completed] "validated aggregate"');
    expect(summary.content[0].text).not.toContain("Task: #1");
    expect(reader).toHaveBeenCalledWith(expect.objectContaining({ taskBinding: ref }));
  });

  it("prefers an unbound aggregate manifest over colliding legacy workflow metadata", async () => {
    const mock = mockPi();
    const reader = vi.fn(() => ({
      manifestPath: "/managed/workflow-wf_reload123.json",
      manifest: {
        schemaVersion: 1 as const,
        artifactId: "workflow-wf_reload123",
        workflowId: "wf_reload123",
        workflowName: "unbound aggregate",
        status: "completed" as const,
        startedAt: new Date(1_000).toISOString(),
        completedAt: new Date(2_000).toISOString(),
        coverage,
        childAttempts: attempts,
        artifactStatus: "metadata-only" as const,
      },
    }));
    initExtension(mock.pi as never, { workflowAggregateReader: reader });
    await mock.executeTool("TaskCreate", { subject: "Stale legacy", description: "d" });
    await mock.executeTool("TaskUpdate", {
      taskId: "1",
      status: "completed",
      metadata: { workflowId: "wf_reload123" },
    });
    const context = mockSessionCtx("reload-session");

    const children = await mock.executeTool("TaskOutput", {
      task_id: "wf_reload123",
      block: false,
      view: "children",
    }, context);

    expect(children.content[0].text).toContain("Workflow: wf_reload123 [completed]");
    expect(children.content[0].text).toContain("index=0 attempt=1 status=completed invocation=spawn");
    expect(children.content[0].text).not.toContain("Task: #1");
  });

  it("uses the same privacy marker for a reloaded skipped child without its stripped error", async () => {
    const mock = mockPi();
    const skippedAttempts: WorkflowChildAttempt[] = [{
      logicalChildIndex: 0,
      logicalChildId: "workflow-child-0",
      physicalAttempt: 1,
      status: "skipped",
      invocation: "spawn",
      skipped: true,
    }];
    const skippedCoverage = aggregateWorkflowCoverage(skippedAttempts);
    const reader = vi.fn(({ taskBinding }: WorkflowAggregateReaderInput) => ({
      manifestPath: "/managed/workflow-wf_reload123.json",
      manifest: {
        schemaVersion: 1 as const,
        artifactId: "workflow-wf_reload123",
        workflowId: "wf_reload123",
        workflowName: "reloaded private workflow",
        status: "completed" as const,
        startedAt: new Date(1_000).toISOString(),
        completedAt: new Date(2_000).toISOString(),
        coverage: skippedCoverage,
        childAttempts: skippedAttempts,
        taskBinding,
        artifactStatus: "metadata-only" as const,
      },
    }));
    const coordinator = initExtension(mock.pi as never, { workflowAggregateReader: reader });
    const ref = await seed(mock, coordinator, {
      artifactStatus: "metadata-only",
      coverage: skippedCoverage,
      resultBodyEnabled: false,
    });
    const context = mockSessionCtx("reload-session");

    const children = await mock.executeTool("TaskOutput", {
      task_id: "1",
      block: false,
      view: "children",
    }, context);

    expect(children.content[0].text).toContain("status=skipped");
    expect(children.content[0].text).toContain("error=Output persistence disabled.");
    expect(reader).toHaveBeenCalledWith(expect.objectContaining({ taskBinding: ref }));
  });

  it("reports a bounded artifact error in summary and fails children explicitly", async () => {
    const mock = mockPi();
    const reader = vi.fn(() => ({
      manifestPath: "/managed/workflow-wf_reload123.json",
      error: "workflow aggregate manifest is missing",
    }));
    const coordinator = initExtension(mock.pi as never, { workflowAggregateReader: reader });
    await seed(mock, coordinator);
    const context = mockSessionCtx("reload-session");

    const summary = await mock.executeTool("TaskOutput", {
      task_id: "1",
      block: false,
      view: "summary",
    }, context);
    expect(summary.content[0].text).toContain("Artifact error: workflow aggregate manifest is missing");
    await expect(mock.executeTool("TaskOutput", {
      task_id: "1",
      block: false,
      view: "children",
    }, context)).rejects.toThrow("workflow aggregate manifest is missing");
  });
});

describe("TaskOutput — agent ID lookups", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reports the resolved task, not a stale pre-wait snapshot", async () => {
    // Regression: `resolvedId` was computed from agentTaskMap and then discarded —
    // the status was re-read with the caller's agent ID, which never matches a task,
    // so the tool fell back to the Task object captured before the wait. Only
    // reproducible file-backed: an in-memory store hands back the live object that
    // the completion listener mutates, which masks the stale read.
    dir = mkdtempSync(join(tmpdir(), "pi-tasks-output-"));
    process.env.PI_TASKS = join(dir, "tasks.json");

    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
    try {
      await launchAgentTask(mock);

      const pending = mock.executeTool("TaskOutput", { task_id: "agent-1", block: true, timeout: 5000 });
      await flush();
      rpc.complete("agent-1", "done");

      expect((await pending).content[0].text).toBe("Task #1 [completed] — subagent agent-1\n\ndone");
    } finally {
      rpc.unsub();
    }
  });

  it("resolves an agent ID to its task when not blocking", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
    try {
      await launchAgentTask(mock);
      const res = await mock.executeTool("TaskOutput", { task_id: "agent-1", block: false, timeout: 30000 });
      expect(res.content[0].text).toBe("Task #1 [in_progress] — subagent agent-1");
    } finally {
      rpc.unsub();
    }
  });

  it("resolves a unique agent ID prefix", async () => {
    // Partial prefixes are documented as accepted, and take the startsWith branch
    // rather than the equality one.
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as never);
    try {
      await launchAgentTask(mock);
      const res = await mock.executeTool("TaskOutput", { task_id: "agent-", block: false, timeout: 30000 });
      expect(res.content[0].text).toBe("Task #1 [in_progress] — subagent agent-1");
    } finally {
      rpc.unsub();
    }
  });

  it("rejects an ambiguous agent ID prefix", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as never);
    try {
      await mock.executeTool("TaskCreate", {
        subject: "First",
        description: "d",
        agentType: "Worker",
      });
      await mock.executeTool("TaskCreate", {
        subject: "Second",
        description: "d",
        agentType: "Worker",
      });
      await mock.executeTool("TaskExecute", { task_ids: ["1", "2"] });

      await expect(mock.executeTool("TaskOutput", {
        task_id: "agent-",
        block: false,
        timeout: 30000,
      })).rejects.toThrow("Agent ID prefix is ambiguous: agent-");
    } finally {
      rpc.unsub();
    }
  });
});

describe("TaskStop", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(() => {
    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
  });

  afterEach(() => { rpc.unsub(); });

  it("stops the agent and completes the task", async () => {
    await launchAgentTask(mock);
    const res = await mock.executeTool("TaskStop", { task_id: "1" });

    expect(res.content[0].text).toBe("Task #1 stopped successfully");
    expect(rpc.stopped).toEqual(["agent-1"]);
    const get = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(get.content[0].text).toContain("Status: completed");
  });

  it("preserves a partial result delivered after the stop RPC reply", async () => {
    await launchAgentTask(mock);
    await mock.executeTool("TaskStop", { task_id: "1" });

    rpc.stop("agent-1", "partial output");
    await flush();

    const get = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(get.content[0].text).toContain("Status: completed");
    expect(get.content[0].text).toContain("partial output");
  });

  it("does not replace an existing partial result with empty stopped output", async () => {
    await launchAgentTask(mock);
    await mock.executeTool("TaskUpdate", {
      taskId: "1",
      metadata: { result: "partial before stop" },
    });
    await mock.executeTool("TaskStop", { task_id: "1" });

    rpc.stop("agent-1", "");
    await flush();

    const get = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(get.content[0].text).toContain("partial before stop");
  });

  it("completes the task when stopped by agent ID", async () => {
    // Regression: the agent was stopped and success reported, but the store update
    // used the caller's agent ID instead of the resolved task ID — so the task stayed
    // in_progress forever and the widget spinner kept animating.
    await launchAgentTask(mock);
    const res = await mock.executeTool("TaskStop", { task_id: "agent-1" });

    expect(res.content[0].text).toBe("Task #1 stopped successfully");
    expect(rpc.stopped).toEqual(["agent-1"]);
    const get = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(get.content[0].text).toContain("Status: completed");
  });

  it("completes the task when stopped by a unique agent ID prefix", async () => {
    await launchAgentTask(mock);
    const res = await mock.executeTool("TaskStop", { task_id: "agent-" });

    expect(res.content[0].text).toBe("Task #1 stopped successfully");
    expect(rpc.stopped).toEqual(["agent-1"]);
    const get = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(get.content[0].text).toContain("Status: completed");
  });

  it("accepts the deprecated shell_id parameter", async () => {
    await launchAgentTask(mock);
    const res = await mock.executeTool("TaskStop", { shell_id: "1" });

    expect(res.content[0].text).toBe("Task #1 stopped successfully");
    expect(rpc.stopped).toEqual(["agent-1"]);
  });

  it("keeps the task in progress when the stop RPC fails", async () => {
    rpc.unsub();
    mock = mockPi();
    rpc = installSubagentsMock(mock.pi, { stopError: "stop refused" });
    initExtension(mock.pi as never);
    await launchAgentTask(mock);

    await expect(mock.executeTool("TaskStop", { task_id: "1" })).rejects.toThrow("stop refused");
    const get = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(get.content[0].text).toContain("Status: in_progress");
  });

  it("throws when neither task_id nor shell_id is given", async () => {
    await expect(mock.executeTool("TaskStop", {})).rejects.toThrow("task_id is required");
  });

  it("throws for a task with no running agent", async () => {
    await mock.executeTool("TaskCreate", { subject: "Manual", description: "d" });
    await expect(mock.executeTool("TaskStop", { task_id: "1" }))
      .rejects.toThrow("No running background process for task 1");
  });

  it("throws for an unknown ID", async () => {
    await expect(mock.executeTool("TaskStop", { task_id: "99" }))
      .rejects.toThrow("No running background process for task 99");
  });

  it("does not re-stop an already completed agent task", async () => {
    await launchAgentTask(mock);
    rpc.complete("agent-1", "done");
    await flush();

    await expect(mock.executeTool("TaskStop", { task_id: "1" }))
      .rejects.toThrow("No running background process for task 1");
    expect(rpc.stopped).toEqual([]);
  });
});
