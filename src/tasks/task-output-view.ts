import type { ResultArtifactStatus } from "../types.js";
import {
  aggregateWorkflowCoverage,
  sanitizeWorkflowAttemptText,
  type WorkflowChildAttempt,
  type WorkflowCoverageAggregate,
} from "../workflow/attempt.js";
import type { TaskExecutionRef } from "./execution-contract.js";
import type { TaskWorkflowAggregateMetadata } from "./types.js";

export const TASK_OUTPUT_CHILD_LIMIT = 100;
export const TASK_OUTPUT_PRIVATE_MARKER = "Output persistence disabled.";

export interface TaskOutputAgentSummary {
  id: string;
  artifactId?: string;
  artifactStatus?: ResultArtifactStatus;
  model?: string;
  resultBodyEnabled?: boolean;
  status?: string;
  toolCalls?: number;
  tokens?: number;
  turns?: number;
}

export interface TaskOutputWorkflowSummary {
  id: string;
  artifactId?: string;
  artifactError?: string;
  artifactStatus?: ResultArtifactStatus;
  attempts: readonly WorkflowChildAttempt[];
  coverage?: WorkflowCoverageAggregate;
  doneCount?: number;
  elapsedMs?: number;
  evidenceIncomplete?: boolean;
  name?: string;
  replayedCount?: number;
  resultBodyEnabled?: boolean;
  status: string;
  totalCount?: number;
  totalTokens?: number;
  totalToolCalls?: number;
}

export interface TaskOutputSummaryContext {
  agent?: TaskOutputAgentSummary;
  execution?: TaskExecutionRef;
  owner?: string;
  taskId?: string;
  taskStatus?: string;
  workflow?: TaskOutputWorkflowSummary;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ARTIFACT_STATUSES: readonly ResultArtifactStatus[] = [
  "pending",
  "complete",
  "metadata-only",
  "failed",
  "skipped",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseTaskWorkflowAggregateMetadata(
  value: unknown,
  workflowId: string,
  taskId: string,
): TaskWorkflowAggregateMetadata | undefined {
  if (!isRecord(value)
    || value.artifactId !== `workflow-${workflowId}`
    || !ARTIFACT_STATUSES.includes(value.artifactStatus as ResultArtifactStatus)
    || typeof value.resultBodyEnabled !== "boolean"
    || (value.status !== "completed" && value.status !== "failed" && value.status !== "killed")
    || !isRecord(value.coverage)
    || !isRecord(value.taskBinding)
    || value.taskBinding.kind !== "workflow"
    || value.taskBinding.executorId !== workflowId
    || value.taskBinding.taskId !== taskId
    || (value.evidenceIncomplete !== undefined && typeof value.evidenceIncomplete !== "boolean")) {
    return undefined;
  }
  const binding = value.taskBinding as unknown as TaskExecutionRef;
  for (const [label, id] of [
    ["artifact id", value.artifactId],
    ["store id", binding.storeId],
    ["task id", binding.taskId],
    ["task attempt id", binding.taskAttemptId],
    ["executor attempt id", binding.attemptId],
    ["workflow id", binding.executorId],
  ] as const) {
    if (typeof id !== "string") return undefined;
    assertTaskOutputSafeId(id, label);
  }
  return value as unknown as TaskWorkflowAggregateMetadata;
}

export function assertTaskOutputSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value) || value.includes("..")) throw new Error(`Invalid ${label} in TaskOutput metadata`);
}

function safeLine(value: string, maxLength = 256): string {
  return sanitizeWorkflowAttemptText(value, maxLength) || "unavailable";
}

function safeId(value: string | undefined): string {
  if (value === undefined) return "unavailable";
  assertTaskOutputSafeId(value, "identifier");
  return value;
}

function artifactLine(artifactId: string | undefined, artifactStatus: ResultArtifactStatus | undefined): string {
  if (artifactId === undefined) return "Artifact: unavailable";
  return `Artifact: ${safeId(artifactId)} [${safeLine(artifactStatus ?? "unknown", 32)}]`;
}

function privacyLine(resultBodyEnabled: boolean | undefined): string {
  if (resultBodyEnabled === false) return `Result body: ${TASK_OUTPUT_PRIVATE_MARKER}`;
  return "Result body: not read by this view";
}

function coverageLine(coverage: WorkflowCoverageAggregate): string {
  return [
    `logical=${coverage.coveredLogicalChildCount}/${coverage.logicalChildCount}`,
    `physical=${coverage.physical.completed}/${coverage.physical.total}`,
    `failed=${coverage.physical.failed}`,
    `pending=${coverage.pendingLogicalChildCount}`,
    `status=${coverage.coverage}`,
  ].join(" ");
}

function totalTokens(attempt: WorkflowChildAttempt): number | undefined {
  const tokens = attempt.usage?.tokens;
  return tokens === undefined ? undefined : tokens.input + tokens.output + tokens.cacheWrite;
}

function summaryHeader(context: TaskOutputSummaryContext): string[] {
  const lines = ["TaskOutput summary"];
  if (context.taskId !== undefined) {
    lines.push(`Task: #${safeId(context.taskId)}`);
    lines.push(`Task status: ${safeLine(context.taskStatus ?? "unknown", 32)}`);
    lines.push(`Owner: ${safeId(context.owner)}`);
  }
  if (context.execution !== undefined) {
    const execution = context.execution;
    lines.push(`Executor: ${execution.kind} ${safeId(execution.executorId)}`);
    lines.push(`Attempt: task=${safeId(execution.taskAttemptId)} executor=${safeId(execution.attemptId)}`);
  } else if (context.workflow === undefined && context.agent === undefined) {
    lines.push("Executor: none");
    lines.push("Attempt: unavailable");
  }
  return lines;
}

export function formatTaskOutputSummary(context: TaskOutputSummaryContext): string {
  const lines = summaryHeader(context);
  if (context.workflow !== undefined) {
    const workflow = context.workflow;
    const name = workflow.name === undefined ? "" : ` "${safeLine(workflow.name)}"`;
    lines.push(`Workflow: ${safeId(workflow.id)} [${safeLine(workflow.status, 32)}]${name}`);
    if (workflow.doneCount !== undefined && workflow.totalCount !== undefined) {
      lines.push(`Progress: ${workflow.doneCount}/${workflow.totalCount} children${workflow.replayedCount ? `, ${workflow.replayedCount} replayed` : ""}`);
    }
    if (workflow.totalTokens !== undefined || workflow.totalToolCalls !== undefined || workflow.elapsedMs !== undefined) {
      lines.push(`Usage: tokens=${workflow.totalTokens ?? 0} tools=${workflow.totalToolCalls ?? 0} elapsedMs=${workflow.elapsedMs ?? 0}`);
    }
    const coverage = workflow.coverage ?? aggregateWorkflowCoverage(workflow.attempts);
    lines.push(`Coverage: ${coverageLine(coverage)}`);
    lines.push(`Evidence incomplete: ${workflow.evidenceIncomplete ? "yes" : "no"}`);
    lines.push(`Child attempts: ${workflow.attempts.length}`);
    lines.push(artifactLine(workflow.artifactId, workflow.artifactStatus));
    if (workflow.artifactError !== undefined) lines.push(`Artifact error: ${safeLine(workflow.artifactError)}`);
    lines.push(privacyLine(workflow.resultBodyEnabled));
    return lines.join("\n");
  }

  if (context.agent !== undefined) {
    const agent = context.agent;
    lines.push(`Agent: ${safeId(agent.id)}`);
    if (agent.status !== undefined) lines.push(`Agent status: ${safeLine(agent.status, 32)}`);
    if (agent.model !== undefined) lines.push(`Model: ${safeLine(agent.model)}`);
    if (agent.turns !== undefined || agent.toolCalls !== undefined || agent.tokens !== undefined) {
      lines.push(`Usage: turns=${agent.turns ?? 0} tools=${agent.toolCalls ?? 0} tokens=${agent.tokens ?? 0}`);
    }
    lines.push(artifactLine(agent.artifactId, agent.artifactStatus));
    lines.push(privacyLine(agent.resultBodyEnabled));
    return lines.join("\n");
  }

  lines.push("Artifact: unavailable");
  lines.push("Result body: not read by this view");
  return lines.join("\n");
}

export function formatTaskOutputChildren(context: TaskOutputSummaryContext): string {
  if (context.workflow === undefined) {
    return `${formatTaskOutputSummary(context)}\nChildren: not applicable (executor is not a workflow)`;
  }

  const workflow = context.workflow;
  const attempts = workflow.attempts.slice(0, TASK_OUTPUT_CHILD_LIMIT);
  const lines = [
    "TaskOutput workflow children",
    ...summaryHeader(context).slice(1),
    `Workflow: ${safeId(workflow.id)} [${safeLine(workflow.status, 32)}]`,
    `Children: showing ${attempts.length} of ${workflow.attempts.length} attempts (limit ${TASK_OUTPUT_CHILD_LIMIT})`,
  ];

  for (const attempt of attempts) {
    const fields = [
      `index=${attempt.logicalChildIndex}`,
      `attempt=${attempt.physicalAttempt}`,
      `status=${attempt.status}`,
      `invocation=${attempt.invocation}`,
    ];
    const model = attempt.modelId ?? attempt.model;
    if (model !== undefined) fields.push(`model=${safeLine(model)}`);
    if (attempt.usage !== undefined) {
      fields.push(`usage=turns:${attempt.usage.turns},tools:${attempt.usage.toolCalls},tokens:${totalTokens(attempt) ?? 0}`);
    }
    const refs = [
      attempt.recordId === undefined ? undefined : `record:${safeId(attempt.recordId)}`,
      attempt.artifactId === undefined ? undefined : `artifact:${safeId(attempt.artifactId)}`,
      attempt.sourceAttemptId === undefined ? undefined : `source:${safeId(attempt.sourceAttemptId)}`,
    ].filter((value): value is string => value !== undefined);
    if (refs.length > 0) fields.push(`refs=${refs.join(",")}`);
    if (workflow.resultBodyEnabled === false
      && (attempt.status === "failed" || attempt.status === "skipped" || attempt.status === "killed")) {
      fields.push(`error=${TASK_OUTPUT_PRIVATE_MARKER}`);
    } else if (attempt.error !== undefined) {
      fields.push(`error=${safeLine(attempt.error, 512)}`);
    }
    lines.push(fields.join(" "));
  }
  lines.push(artifactLine(workflow.artifactId, workflow.artifactStatus));
  if (workflow.artifactError !== undefined) lines.push(`Artifact error: ${safeLine(workflow.artifactError)}`);
  lines.push(privacyLine(workflow.resultBodyEnabled));
  return lines.join("\n");
}
