/**
 * entry.ts — what a finished workflow leaves behind in the session transcript.
 *
 * A workflow started from `--subagents-workflow-file` has no tool call to hang
 * its result card on, so it appends a custom session entry instead. That entry
 * has to survive a reload, which is why this is a plain-JSON snapshot rather
 * than the live {@link WorkflowTask}: the task holds an `AbortController`, the
 * script source and the run's control handle, none of which belongs in a
 * session file.
 *
 * Deliberately free of any renderer import. The card this data renders through
 * lives in `ui/workflow-card.ts` (`renderWorkflowEntryCard`), so the shape a
 * session file stores does not depend on the code that draws it.
 */

import type { WorkflowMeta } from "./meta.js";
import type { WorkflowAgentEntry, WorkflowEntry, WorkflowRunStatus } from "./progress.js";
import { WORKFLOW_RESULT_BODY_DISABLED, type WorkflowTask } from "./task.js";

/** `customType` of the session entry a flag-launched workflow renders through. */
export const WORKFLOW_ENTRY_TYPE = "subagents:workflow";

/** The persisted snapshot of a settled run. */
export interface WorkflowEntryData {
  name: string;
  status: WorkflowRunStatus;
  startTime: number;
  endTime?: number;
  progress: WorkflowEntry[];
  agentCount: number;
  totalTokens: number;
  meta?: WorkflowMeta;
  /** Fixed non-content result marker stored only when body persistence is disabled. */
  resultSummary?: string;
  /** Extension-owned aggregate manifest locator; never a child body or preview. */
  aggregateArtifactPath?: string;
  aggregateArtifactStatus?: WorkflowTask["aggregateArtifactStatus"];
}

function privatePhaseTitle(task: WorkflowTask, phaseIndex: number): string {
  return task.meta?.phases?.[phaseIndex]?.title ?? `Phase ${phaseIndex + 1}`;
}

/**
 * Retain only the structural and numeric fields needed to reconstruct a settled
 * card. Labels, errors, activity, previews and logs can all be derived from a
 * child result by the script, so privacy-off entries replace them rather than
 * trying to recognize sensitive values after the fact.
 */
function privacySafeProgress(task: WorkflowTask): WorkflowEntry[] {
  const progress: WorkflowEntry[] = [];
  for (const entry of task.workflowProgress) {
    if (entry.type === "workflow_log") continue;
    if (entry.type === "workflow_phase") {
      progress.push({
        type: "workflow_phase",
        index: entry.index,
        title: privatePhaseTitle(task, entry.index),
      });
      continue;
    }

    const safe: WorkflowAgentEntry = {
      type: "workflow_agent",
      index: entry.index,
      label: `Agent ${entry.index + 1}`,
      state: entry.state,
    };
    if (entry.phaseIndex !== undefined) {
      safe.phaseIndex = entry.phaseIndex;
      safe.phaseTitle = privatePhaseTitle(task, entry.phaseIndex);
    }
    for (const field of ["skipped", "blocked", "cached"] as const) {
      if (entry[field] !== undefined) safe[field] = entry[field];
    }
    for (const field of [
      "queuedAt",
      "startedAt",
      "lastProgressAt",
      "attempt",
      "tokens",
      "turnCount",
      "toolCalls",
      "durationMs",
    ] as const) {
      if (entry[field] !== undefined) safe[field] = entry[field];
    }
    if (entry.lastAttemptReason !== undefined) safe.lastAttemptReason = entry.lastAttemptReason;
    progress.push(safe);
  }
  progress.push({ type: "workflow_log", message: WORKFLOW_RESULT_BODY_DISABLED });
  return progress;
}

/** Snapshot a settled task for {@link WORKFLOW_ENTRY_TYPE}. */
export function workflowEntryData(task: WorkflowTask, resultBodyEnabled: boolean): WorkflowEntryData {
  const base: WorkflowEntryData = {
    name: task.workflowName ?? task.id,
    status: task.status,
    startTime: task.startTime,
    endTime: task.endTime,
    progress: resultBodyEnabled ? task.workflowProgress : privacySafeProgress(task),
    agentCount: task.agentCount,
    totalTokens: task.totalTokens,
    ...(task.meta !== undefined ? { meta: task.meta } : {}),
  };
  if (resultBodyEnabled) return base;
  return {
    ...base,
    resultSummary: WORKFLOW_RESULT_BODY_DISABLED,
    ...(task.aggregateArtifactPath !== undefined ? { aggregateArtifactPath: task.aggregateArtifactPath } : {}),
    ...(task.aggregateArtifactStatus !== undefined ? { aggregateArtifactStatus: task.aggregateArtifactStatus } : {}),
  };
}
