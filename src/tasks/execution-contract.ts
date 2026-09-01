/** Pure execution identity contract shared by tasks, agents, workflows, and RPC. */

export type TaskExecutionKind = "agent" | "workflow";

interface TaskExecutionIdentity {
  readonly storeId: string;
  readonly taskId: string;
  readonly taskAttemptId: string;
  readonly attemptId: string;
  readonly kind: TaskExecutionKind;
}

/** A Todo attempt claimed before its concrete executor has been created. */
export interface TaskExecutionClaim extends TaskExecutionIdentity {
  readonly executorId?: never;
}

/** Immutable authority carried by exactly one bound executor. */
export interface TaskExecutionRef extends TaskExecutionIdentity {
  readonly executorId: string;
}

/** Canonical persisted execution state: unbound during startup, bound afterward. */
export type TaskExecutionBinding = TaskExecutionClaim | TaskExecutionRef;

export interface TaskExecutionClaimOptions {
  attemptId?: string;
  kind?: TaskExecutionKind;
  taskAttemptId?: string;
}

export interface TaskExecutionSettle {
  status: "completed" | "pending";
  error?: string;
  result?: string;
  /** Keep the ref briefly so a confirmed stop can accept its same-attempt partial output. */
  retainBinding?: boolean;
}

function isExecutionKind(value: unknown): value is TaskExecutionKind {
  return value === "agent" || value === "workflow";
}

function isExecutionIdentity(
  value: unknown,
  taskId?: string,
): value is TaskExecutionIdentity & Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<TaskExecutionIdentity>;
  return typeof identity.storeId === "string" && identity.storeId.length > 0
    && typeof identity.taskId === "string" && (taskId === undefined || identity.taskId === taskId)
    && typeof identity.taskAttemptId === "string" && identity.taskAttemptId.length > 0
    && typeof identity.attemptId === "string" && identity.attemptId.length > 0
    && isExecutionKind(identity.kind);
}

export function isTaskExecutionClaim(value: unknown, taskId?: string): value is TaskExecutionClaim {
  return isExecutionIdentity(value, taskId) && !("executorId" in value);
}

export function isTaskExecutionRef(value: unknown, taskId?: string): value is TaskExecutionRef {
  return isExecutionIdentity(value, taskId)
    && "executorId" in value
    && typeof value.executorId === "string"
    && value.executorId.length > 0;
}

export function isTaskExecutionBinding(value: unknown, taskId?: string): value is TaskExecutionBinding {
  return isTaskExecutionClaim(value, taskId) || isTaskExecutionRef(value, taskId);
}

/** Compare one Todo/executor attempt without granting an executor to an unbound claim. */
export function sameTaskExecutionAttempt(
  current: TaskExecutionBinding | undefined,
  expected: TaskExecutionBinding,
): boolean {
  if (current === undefined) return false;
  if (current.storeId !== expected.storeId
    || current.taskId !== expected.taskId
    || current.taskAttemptId !== expected.taskAttemptId
    || current.attemptId !== expected.attemptId
    || current.kind !== expected.kind) {
    return false;
  }
  return isTaskExecutionRef(expected)
    ? isTaskExecutionRef(current) && current.executorId === expected.executorId
    : true;
}
