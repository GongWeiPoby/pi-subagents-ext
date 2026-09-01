/** Pure data model for one workflow child invocation attempt. */

import type { LifetimeUsage } from "../usage.js";

export const WORKFLOW_CHILD_ATTEMPT_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "skipped",
  "killed",
  "replayed",
] as const;

export type WorkflowChildAttemptStatus = (typeof WORKFLOW_CHILD_ATTEMPT_STATUSES)[number];

export const WORKFLOW_CHILD_ATTEMPT_INVOCATIONS = ["spawn", "resume", "retry", "replay"] as const;

export type WorkflowChildAttemptInvocation = (typeof WORKFLOW_CHILD_ATTEMPT_INVOCATIONS)[number];

/** Counts of physical attempt records, or the latest attempt for each logical child. */
export interface WorkflowChildAttemptStatusCounts {
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  skipped: number;
  killed: number;
  replayed: number;
}

export interface WorkflowChildAttemptUsage {
  turns: number;
  toolCalls: number;
  tokens: LifetimeUsage;
}

export interface WorkflowChildAttempt {
  /** Stable position assigned to the logical child by the workflow. */
  logicalChildIndex: number;
  /** Stable, safe identifier shared by all physical attempts for this child. */
  logicalChildId: string;
  /** One-based attempt number; retries create another record rather than replacing one. */
  physicalAttempt: number;
  status: WorkflowChildAttemptStatus;
  invocation: WorkflowChildAttemptInvocation;
  /** Manager record reference. It is an identifier, never a path or embedded record. */
  recordId?: string;
  /** Immutable result-attempt reference. It is an identifier, never a path or artifact body. */
  artifactId?: string;
  /** The artifact/attempt this resume or retry originated from. */
  sourceAttemptId?: string;
  queuedAt?: number;
  startedAt?: number;
  completedAt?: number;
  /** Usage from this physical attempt only, not a lifetime or workflow total. */
  usage?: WorkflowChildAttemptUsage;
  /** Effective model labels captured at the attempt boundary. */
  model?: string;
  modelId?: string;
  thinking?: string;
  cached?: boolean;
  skipped?: boolean;
  /** Single-line, control-free, bounded error summary. */
  error?: string;
}

export type WorkflowCoverageStatus = "complete" | "partial" | "failed" | "unknown";

export interface WorkflowCoverageAggregate {
  /** Number of distinct logical children represented by the attempts. */
  logicalChildCount: number;
  /** Number of physical records supplied, including retries. */
  physicalAttemptCount: number;
  /** Logical children whose latest attempt is completed or replayed. */
  coveredLogicalChildCount: number;
  /** Logical children that are terminal but not covered. */
  uncoveredLogicalChildCount: number;
  /** Logical children whose latest attempt is still queued or running. */
  pendingLogicalChildCount: number;
  /** Counts every supplied physical attempt, including superseded retries. */
  physical: WorkflowChildAttemptStatusCounts;
  /** Counts only the latest physical attempt for each logical child. */
  logical: WorkflowChildAttemptStatusCounts;
  /** Coverage is independent from the workflow run's completed/failed status. */
  coverage: WorkflowCoverageStatus;
  complete: boolean;
}

const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UNSAFE_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/g;
const MAX_ERROR_LENGTH = 512;
const MAX_DISPLAY_TEXT_LENGTH = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStatus(value: unknown): value is WorkflowChildAttemptStatus {
  return typeof value === "string" && WORKFLOW_CHILD_ATTEMPT_STATUSES.includes(value as WorkflowChildAttemptStatus);
}

function isInvocation(value: unknown): value is WorkflowChildAttemptInvocation {
  return typeof value === "string"
    && WORKFLOW_CHILD_ATTEMPT_INVOCATIONS.includes(value as WorkflowChildAttemptInvocation);
}

/** Whether a value is safe to retain as an internal record/artifact reference. */
export function isSafeWorkflowReference(value: unknown): value is string {
  return typeof value === "string" && SAFE_REFERENCE_PATTERN.test(value) && !value.includes("..");
}

function safeReference(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isSafeWorkflowReference(value)) throw new Error(`invalid ${label}`);
  return value;
}

/** Remove terminal, bidi and other formatting controls from a display field. */
export function sanitizeWorkflowAttemptText(value: string, maxLength = MAX_DISPLAY_TEXT_LENGTH): string {
  const sanitized = value.replace(/\r\n?/g, "\n").replace(UNSAFE_TEXT, "").replace(/\s+/g, " ").trim();
  return sanitized.length <= maxLength ? sanitized : `${sanitized.slice(0, maxLength - 3)}...`;
}

function safeError(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("invalid attempt error");
  const firstLine = value.replace(/\r\n?/g, "\n").split("\n", 1)[0];
  const sanitized = sanitizeWorkflowAttemptText(firstLine, MAX_ERROR_LENGTH);
  return sanitized || undefined;
}

function finiteTime(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonNegativeInteger(value, label);
  if (result === 0) throw new Error(`invalid ${label}`);
  return result;
}

function usage(value: unknown): WorkflowChildAttemptUsage | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !isRecord(value.tokens)) throw new Error("invalid attempt usage");
  const turns = nonNegativeInteger(value.turns, "attempt turns");
  const toolCalls = nonNegativeInteger(value.toolCalls, "attempt tool calls");
  const tokenFields = ["input", "output", "cacheWrite"] as const;
  const tokens: LifetimeUsage = {
    input: 0,
    output: 0,
    cacheWrite: 0,
  };
  for (const field of tokenFields) {
    const token = value.tokens[field];
    if (typeof token !== "number" || !Number.isFinite(token) || token < 0) {
      throw new Error(`invalid attempt ${field} tokens`);
    }
    tokens[field] = token;
  }
  for (const field of ["cacheRead", "cost"] as const) {
    const token = value.tokens[field];
    if (token !== undefined) {
      if (typeof token !== "number" || !Number.isFinite(token) || token < 0) {
        throw new Error(`invalid attempt ${field}`);
      }
      tokens[field] = token;
    }
  }
  return { turns, toolCalls, tokens };
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`invalid ${label}`);
  return value;
}

/**
 * Validate and retain only the attempt fields that belong in the data model.
 * Unknown fields, including prompt/text/path fields from an untrusted adapter,
 * are deliberately dropped.
 */
export function createWorkflowChildAttempt(input: WorkflowChildAttempt): WorkflowChildAttempt {
  if (!isRecord(input)) throw new Error("invalid workflow child attempt");
  const logicalChildIndex = nonNegativeInteger(input.logicalChildIndex, "logical child index");
  const logicalChildId = safeReference(input.logicalChildId, "logical child id");
  if (logicalChildId === undefined) throw new Error("invalid logical child id");
  if (!isStatus(input.status)) throw new Error("invalid attempt status");
  if (!isInvocation(input.invocation)) throw new Error("invalid attempt invocation");

  const result: WorkflowChildAttempt = {
    logicalChildIndex,
    logicalChildId,
    physicalAttempt: positiveInteger(input.physicalAttempt, "physical attempt"),
    status: input.status,
    invocation: input.invocation,
  };
  const recordId = safeReference(input.recordId, "record id");
  const artifactId = safeReference(input.artifactId, "artifact id");
  const sourceAttemptId = safeReference(input.sourceAttemptId, "source attempt id");
  if (recordId !== undefined) result.recordId = recordId;
  if (artifactId !== undefined) result.artifactId = artifactId;
  if (sourceAttemptId !== undefined) result.sourceAttemptId = sourceAttemptId;

  for (const [field, label] of [["queuedAt", "queued time"], ["startedAt", "started time"], ["completedAt", "completed time"]] as const) {
    const time = finiteTime(input[field], label);
    if (time !== undefined) result[field] = time;
  }
  const attemptUsage = usage(input.usage);
  if (attemptUsage !== undefined) result.usage = attemptUsage;
  for (const field of ["model", "modelId", "thinking"] as const) {
    const value = input[field];
    if (value !== undefined) {
      if (typeof value !== "string") throw new Error(`invalid ${field}`);
      const sanitized = sanitizeWorkflowAttemptText(value);
      if (sanitized) result[field] = sanitized;
    }
  }
  const cached = optionalBoolean(input.cached, "cached flag");
  const skipped = optionalBoolean(input.skipped, "skipped flag");
  if (cached !== undefined) result.cached = cached;
  if (skipped !== undefined) result.skipped = skipped;
  const error = safeError(input.error);
  if (error !== undefined) result.error = error;
  return result;
}

/** Return a detached, validated snapshot suitable for persistence or aggregation. */
export function snapshotWorkflowChildAttempt(attempt: WorkflowChildAttempt): WorkflowChildAttempt {
  return createWorkflowChildAttempt(attempt);
}

/** Alias emphasizing that snapshots do not share their nested usage object. */
export function cloneWorkflowChildAttempt(attempt: WorkflowChildAttempt): WorkflowChildAttempt {
  return snapshotWorkflowChildAttempt(attempt);
}

function emptyCounts(): WorkflowChildAttemptStatusCounts {
  return {
    total: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    killed: 0,
    replayed: 0,
  };
}

function countAttempt(counts: WorkflowChildAttemptStatusCounts, attempt: WorkflowChildAttempt): void {
  counts.total++;
  counts[attempt.status]++;
}

function logicalKey(attempt: WorkflowChildAttempt): string {
  return `${attempt.logicalChildIndex}\u0000${attempt.logicalChildId}`;
}

function isCovered(status: WorkflowChildAttemptStatus): boolean {
  return status === "completed" || status === "replayed";
}

function isPending(status: WorkflowChildAttemptStatus): boolean {
  return status === "queued" || status === "running";
}

/**
 * Aggregate physical attempts and logical-child coverage without mutating input.
 * A retry's earlier failure remains visible in `physical`, while `logical` uses
 * the highest physical attempt for coverage. `complete` here means coverage
 * complete only; a workflow can have status `completed` while this is false.
 */
export function aggregateWorkflowCoverage(
  attempts: readonly WorkflowChildAttempt[],
): WorkflowCoverageAggregate {
  const physical = emptyCounts();
  const latest = new Map<string, WorkflowChildAttempt>();
  for (const original of attempts) {
    const attempt = snapshotWorkflowChildAttempt(original);
    countAttempt(physical, attempt);
    const key = logicalKey(attempt);
    const previous = latest.get(key);
    if (previous === undefined || attempt.physicalAttempt > previous.physicalAttempt) latest.set(key, attempt);
  }

  const logical = emptyCounts();
  for (const attempt of latest.values()) countAttempt(logical, attempt);

  const logicalChildCount = latest.size;
  const coveredLogicalChildCount = [...latest.values()].filter(attempt => isCovered(attempt.status)).length;
  const pendingLogicalChildCount = [...latest.values()].filter(attempt => isPending(attempt.status)).length;
  const uncoveredLogicalChildCount = logicalChildCount - coveredLogicalChildCount - pendingLogicalChildCount;
  const coverage: WorkflowCoverageStatus = logicalChildCount === 0 || pendingLogicalChildCount > 0
    ? "unknown"
    : coveredLogicalChildCount === logicalChildCount
      ? "complete"
      : coveredLogicalChildCount === 0
        ? "failed"
        : "partial";

  return {
    logicalChildCount,
    physicalAttemptCount: physical.total,
    coveredLogicalChildCount,
    uncoveredLogicalChildCount,
    pendingLogicalChildCount,
    physical,
    logical,
    coverage,
    complete: coverage === "complete",
  };
}
