/**
 * task.ts — the background record one workflow run lives in.
 *
 * A `SubagentWorkflow` tool call returns a task id immediately and the run continues
 * without it, so the run's state cannot live in the tool call's closure: the
 * inline card, the completion notification and (later) the `/agents → Workflows` dialog
 * all read it after `execute` has returned. This is that record, shaped after
 * Claude Code's `local_workflow` task so the fields line up with what the
 * renderers already expect.
 *
 * The progress log is append-only and collapses by index (see `progress.ts`),
 * so every derived counter here is recomputed from the log rather than
 * incremented as entries arrive — a re-emitted agent entry replaces its
 * predecessor, and adding its tokens on top would double-count them.
 */

import { randomUUID } from "node:crypto";
import type { TaskExecutionRef } from "../tasks/types.js";
import { escapeXml } from "../xml.js";
import {
  aggregateWorkflowCoverage,
  cloneWorkflowChildAttempt,
  snapshotWorkflowChildAttempt,
  type WorkflowChildAttempt,
  type WorkflowCoverageAggregate,
} from "./attempt.js";
import { type FleetWorkflowPhase, workflowFleetPhases } from "./fleet.js";
import type { WorkflowJournalEntry } from "./journal.js";
import type { WorkflowMeta } from "./meta.js";
import { collapse, elapsedMs, stats, type WorkflowEntry, type WorkflowRunStatus } from "./progress.js";
import type { WorkflowControl, WorkflowRunResult } from "./runtime.js";

/** `wf_` + hex, matching Claude Code's `^wf_[a-z0-9-]{6,}$` run ids. */
export function workflowRunId(): string {
  return `wf_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export interface WorkflowTask {
  /** Discriminator, alongside Claude Code's `local_agent` / `local_bash`. */
  type: "local_workflow";
  id: string;
  status: WorkflowRunStatus;
  script: string;
  /** Where the script can be edited and re-run from. */
  scriptPath?: string;
  args?: unknown;
  /** User-selected default captured before approval/start. */
  defaultAgent?: string;
  meta?: WorkflowMeta;
  workflowName?: string;
  /** The `tool_use_id` of the call that started this, when one did. */
  toolCallId?: string;

  /** Structured Todo execution owned by this workflow controller. */
  taskExecutionRef?: TaskExecutionRef;

  /**
   * Pause, skip and retry, once the run is up.
   *
   * Absent before the runtime hands it over and after the run settles — the
   * dialog treats "no control" as "those keys do nothing", which is the same
   * thing it does for a run that has finished.
   */
  control?: WorkflowControl;
  /** When the current pause started, so `totalPausedMs` can be closed out. */
  pausedAt?: number;

  /** Where this run records its own settled calls, for a later resume. */
  journalPath?: string;
  /** A previous run's journal, when this call asked to resume one. */
  replay?: readonly WorkflowJournalEntry[];
  /** The run id this one resumed, for the result line that says so. */
  resumedFrom?: string;
  /** How many agents came back from {@link replay} instead of being spawned. */
  replayedCount: number;

  /** Physical child invocation snapshots, retained separately from UI progress. */
  workflowAttempts: WorkflowChildAttempt[];
  /** Captured result-body privacy choice for this workflow run. */
  resultBodyEnabled: boolean;
  /** Internal aggregate artifact locator and write status. */
  aggregateArtifactPath?: string;
  aggregateArtifactBodyPath?: string;
  aggregateArtifactStatus?: "complete" | "metadata-only" | "failed" | "skipped";
  aggregateArtifactError?: string;
  /** The killed run exceeded its bounded child-evidence drain window. */
  evidenceIncomplete?: boolean;
  /** The append-only event log, in emission order. */
  workflowProgress: WorkflowEntry[];
  /** Bumped once per applied batch, so a renderer can tell nothing changed. */
  progressVersion: number;
  agentCount: number;
  /**
   * Agents that have settled successfully, recomputed with the other counters.
   *
   * Cached rather than derived on read because the fleet list asks five times a
   * second: deriving it there would walk the whole append-only log on every
   * tick, which for a thousand-agent run is real work in the render loop.
   */
  doneCount: number;
  totalTokens: number;
  totalToolCalls: number;
  logs: string[];
  /** Cached execution tree for FleetView; rebuilt only when progress changes. */
  fleetPhases: FleetWorkflowPhase[];

  abortController: AbortController;
  startTime: number;
  endTime?: number;
  /** Excluded from the elapsed clock the header shows. */
  totalPausedMs: number;

  /** Session that owns this run; detached completion must never cross it. */
  sessionId?: string;
  /** Working directory captured when this workflow was started. */
  cwd?: string;
  /** Persisted parent session eligible to own internal result artifacts. */
  artifactSessionId?: string;
  /** Monotonic activation generation, invalidated before every switch. */
  sessionGeneration: number;
  /** The script's return value, once the run produced one. */
  value?: unknown;
  error?: string;
}

export function createWorkflowTask(init: {
  id: string;
  script: string;
  scriptPath?: string;
  args?: unknown;
  defaultAgent?: string;
  meta?: WorkflowMeta;
  toolCallId?: string;
  taskExecutionRef?: TaskExecutionRef;
  startTime?: number;
  journalPath?: string;
  replay?: readonly WorkflowJournalEntry[];
  resumedFrom?: string;
  sessionId?: string;
  cwd?: string;
  artifactSessionId?: string;
  sessionGeneration?: number;
  resultBodyEnabled?: boolean;
}): WorkflowTask {
  return {
    type: "local_workflow",
    id: init.id,
    status: "running",
    script: init.script,
    scriptPath: init.scriptPath,
    args: init.args,
    defaultAgent: init.defaultAgent,
    meta: init.meta,
    workflowName: init.meta?.name,
    toolCallId: init.toolCallId,
    taskExecutionRef: init.taskExecutionRef,
    journalPath: init.journalPath,
    replay: init.replay,
    resumedFrom: init.resumedFrom,
    sessionId: init.sessionId,
    cwd: init.cwd,
    artifactSessionId: init.artifactSessionId,
    sessionGeneration: init.sessionGeneration ?? 0,
    replayedCount: 0,
    workflowAttempts: [],
    resultBodyEnabled: init.resultBodyEnabled ?? true,
    workflowProgress: [],
    progressVersion: 0,
    agentCount: 0,
    doneCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    logs: [],
    fleetPhases: workflowFleetPhases([], init.meta, true),
    abortController: new AbortController(),
    startTime: init.startTime ?? Date.now(),
    totalPausedMs: 0,
  };
}

/** Apply or replace one physical child attempt without collapsing retry history. */
export function updateWorkflowAttempt(task: WorkflowTask, attempt: WorkflowChildAttempt): void {
  const snapshot = snapshotWorkflowChildAttempt(attempt);
  const index = task.workflowAttempts.findIndex(candidate =>
    candidate.logicalChildIndex === snapshot.logicalChildIndex
    && candidate.logicalChildId === snapshot.logicalChildId
    && candidate.physicalAttempt === snapshot.physicalAttempt,
  );
  if (index === -1) task.workflowAttempts.push(snapshot);
  else task.workflowAttempts[index] = snapshot;
}

/**
 * Apply one batch of progress entries.
 *
 * Batched rather than per-entry because that is how the worker emits them, and
 * because every counter below is an O(log) recompute — doing it once per fan-out
 * frame instead of once per agent is the difference that keeps a 200-agent run
 * cheap to render.
 */
export function updateWorkflowProgressBatch(
  task: WorkflowTask,
  entries: readonly WorkflowEntry[],
): void {
  if (entries.length === 0) return;
  task.workflowProgress.push(...entries);
  task.progressVersion++;

  const { agents, logs } = collapse(task.workflowProgress);
  task.logs = logs;
  // `agentCount` is what the runtime has scheduled, which can lead what the log
  // has seen — never let a recompute walk it backwards.
  task.agentCount = Math.max(task.agentCount, agents.length);

  let totalTokens = 0;
  let totalToolCalls = 0;
  let done = 0;
  for (const agent of agents) {
    totalTokens += agent.tokens ?? 0;
    totalToolCalls += agent.toolCalls ?? 0;
    // Counted off the collapsed agents, so a re-emitted row counts once.
    if (agent.state === "done") done++;
  }
  task.totalTokens = totalTokens;
  task.totalToolCalls = totalToolCalls;
  task.doneCount = done;
  task.fleetPhases = workflowFleetPhases(
    task.workflowProgress,
    task.meta,
    task.status === "running" || task.status === "paused",
  );
}

/**
 * Hold the run, and stop its clock.
 *
 * The elapsed figure every surface shows subtracts `totalPausedMs`, so a run
 * left paused overnight does not come back reading as a twelve-hour run.
 */
export function pauseWorkflowTask(task: WorkflowTask, now = Date.now()): boolean {
  if (task.status !== "running" || task.control === undefined) return false;
  task.control.pause();
  task.status = "paused";
  task.pausedAt = now;
  return true;
}

/** Let it go again, banking however long it was held. */
export function resumeWorkflowTask(task: WorkflowTask, now = Date.now()): boolean {
  if (task.status !== "paused" || task.control === undefined) return false;
  task.control.resume();
  task.status = "running";
  task.totalPausedMs = (task.totalPausedMs ?? 0) + Math.max(0, now - (task.pausedAt ?? now));
  task.pausedAt = undefined;
  return true;
}

/** Settle a task from the run's own result. */
export function completeWorkflowTask(
  task: WorkflowTask,
  result: WorkflowRunResult,
  now = Date.now(),
): void {
  // Banked before the status moves off "paused": a run that finished while held
  // still spent that time held, and the elapsed figure has to say so.
  if (task.pausedAt !== undefined) {
    task.totalPausedMs = (task.totalPausedMs ?? 0) + Math.max(0, now - task.pausedAt);
    task.pausedAt = undefined;
  }
  // Nothing left to control, and holding the handle would let the dialog offer
  // pause on a run that has already stopped.
  task.control = undefined;
  task.status = result.status;
  task.meta ??= result.meta;
  task.workflowName ??= result.meta.name;
  task.agentCount = Math.max(task.agentCount, result.agentCount);
  task.replayedCount = result.replayedCount;
  task.workflowAttempts = (result.attempts ?? []).map(cloneWorkflowChildAttempt);
  task.value = result.value;
  task.error = result.error;
  task.evidenceIncomplete = result.evidenceIncomplete;
  task.endTime = now;
  task.fleetPhases = workflowFleetPhases(task.workflowProgress, task.meta, false, now);
}

/**
 * Settle a task that never produced a result — a script rejected before the
 * worker started (bad `meta`, oversized source, non-JSON `args`).
 */
export function failWorkflowTask(task: WorkflowTask, error: string, now = Date.now()): void {
  if (task.pausedAt !== undefined) {
    task.totalPausedMs = (task.totalPausedMs ?? 0) + Math.max(0, now - task.pausedAt);
    task.pausedAt = undefined;
  }
  task.control = undefined;
  task.status = "failed";
  task.error = error;
  task.endTime = now;
  task.fleetPhases = workflowFleetPhases(task.workflowProgress, task.meta, false, now);
}

/** The run's outcome as text, for the notification and the LLM-facing result. */
export function workflowResultText(task: WorkflowTask): string {
  if (task.error !== undefined) return task.error;
  if (task.value === undefined) return "No output.";
  if (typeof task.value === "string") return task.value;
  return JSON.stringify(task.value, null, 2);
}

export const WORKFLOW_RESULT_BODY_DISABLED = "Output persistence disabled.";

/** Preview used by model-facing completion details without changing the full notification format. */
export function workflowNotificationPreview(task: WorkflowTask, maxLength: number): string {
  const result = task.resultBodyEnabled ? workflowResultText(task) : WORKFLOW_RESULT_BODY_DISABLED;
  return result.length > maxLength ? `${result.slice(0, maxLength)}…` : result;
}

/** Resolve a `resumeFromRunId` against the runs this session has seen.
 *
 * Same-session only, and deliberately so: the journal lives beside the
 * session's task files, and a run id from another session would silently find
 * nothing to replay — reporting that as "resumed" would be a lie the caller
 * could not see through. An unknown id is an error rather than a cold start,
 * because a caller that asked to resume is expecting not to pay.
 */
export function resolveResumeTarget(
  runId: string | undefined,
  tasks: ReadonlyMap<string, WorkflowTask>,
):
  | undefined
  | { ok: true; runId: string; journalPath: string; scriptPath: string }
  | { ok: false; message: string } {
  const id = runId?.trim();
  if (id === undefined || id === "") return undefined;

  const prior = tasks.get(id);
  if (prior === undefined) {
    const known = [...tasks.keys()];
    return {
      ok: false,
      message:
        `No workflow run "${id}" in this session. ` +
        (known.length > 0
          ? `Runs this session: ${known.join(", ")}.`
          : "Nothing has run yet — call this without `resumeFromRunId`."),
    };
  }
  if (prior.status === "running" || prior.status === "paused") {
    return {
      ok: false,
      message: `Workflow "${id}" is still ${prior.status}. Stop it from /agents → Workflows before resuming it.`,
    };
  }
  if (prior.journalPath === undefined) {
    return { ok: false, message: `Workflow "${id}" has no journal to resume from.` };
  }
  return {
    ok: true,
    runId: id,
    journalPath: prior.journalPath,
    // The persisted copy, which is what `scriptPath` holds when the call had
    // no file of its own.
    scriptPath: prior.scriptPath ?? "",
  };
}

/** `<task-notification>`, in the same shape a finished background agent sends. */
export function formatWorkflowNotification(task: WorkflowTask, now = Date.now()): string {
  const totals = stats(task.workflowProgress, task.agentCount);
  if (!task.resultBodyEnabled) {
    const coverage = aggregateWorkflowCoverage(task.workflowAttempts);
    const safeStatus = task.status === "completed" ? "Done" : task.status === "killed" ? "Stopped" : "Error";
    const coverageText = formatWorkflowCoverage(coverage);
    const artifactLocator = task.aggregateArtifactPath ?? "unavailable";
    return [
      `<task-notification>`,
      `<task-id>${task.id}</task-id>`,
      task.toolCallId ? `<tool-use-id>${escapeXml(task.toolCallId)}</tool-use-id>` : null,
      `<status>${escapeXml(safeStatus)}</status>`,
      `<summary>Workflow result body omitted because output persistence is disabled.</summary>`,
      `<coverage>${coverageText}</coverage>`,
      `<artifact>${escapeXml(artifactLocator)}</artifact>`,
      `<result>${WORKFLOW_RESULT_BODY_DISABLED}</result>`,
      `<usage><total_tokens>${task.totalTokens}</total_tokens><tool_uses>${task.totalToolCalls}</tool_uses><duration_ms>${elapsedMs(task, now)}</duration_ms></usage>`,
      `</task-notification>`,
    ].filter(Boolean).join("\n");
  }
  const status =
    task.status === "completed" ? "Done"
    : task.status === "killed" ? "Stopped"
    : `Error: ${task.error ?? "unknown"}`;
  const result = workflowResultText(task);
  return [
    `<task-notification>`,
    `<task-id>${task.id}</task-id>`,
    task.toolCallId ? `<tool-use-id>${escapeXml(task.toolCallId)}</tool-use-id>` : null,
    task.scriptPath ? `<script>${escapeXml(task.scriptPath)}</script>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Workflow "${escapeXml(task.workflowName ?? task.id)}" ${task.status} — ${totals.done}/${totals.total} agents${
      task.replayedCount > 0 ? `, ${task.replayedCount} replayed from ${escapeXml(task.resumedFrom ?? "an earlier run")}` : ""
    }</summary>`,
    `<result>${escapeXml(result.length > 4000 ? `${result.slice(0, 4000)}\n...(truncated)` : result)}</result>`,
    `<usage><total_tokens>${task.totalTokens}</total_tokens><tool_uses>${task.totalToolCalls}</tool_uses><duration_ms>${elapsedMs(task, now)}</duration_ms></usage>`,
    `</task-notification>`,
  ].filter(Boolean).join("\n");
}

function formatWorkflowCoverage(coverage: WorkflowCoverageAggregate): string {
  return [
    `logical=${coverage.coveredLogicalChildCount}/${coverage.logicalChildCount}`,
    `physical=${coverage.physical.completed}/${coverage.physical.total}`,
    `failed=${coverage.physical.failed}`,
    `pending=${coverage.pendingLogicalChildCount}`,
    `status=${coverage.coverage}`,
  ].join(" ");
}
