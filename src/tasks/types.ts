/**
 * types.ts — Type definitions for the task management system.
 */

import type { ChildProcess } from "node:child_process";
import type { TaskExecutionBinding } from "./execution-contract.js";

export type {
  TaskExecutionBinding,
  TaskExecutionClaim,
  TaskExecutionClaimOptions,
  TaskExecutionKind,
  TaskExecutionRef,
  TaskExecutionSettle,
} from "./execution-contract.js";

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskCascadeConfig {
  additionalContext?: string;
  maxTurns?: number;
  model?: string;
}

export interface TaskMetadata extends Record<string, unknown> {
  agentId?: string;
  agentType?: string;
  lastError?: string;
  result?: string;
  taskAttemptId?: string;
  taskCascadeConfig?: TaskCascadeConfig;
  workflowId?: string;
}

export interface TaskExecutionStopReservation {
  /** Opaque authority returned only to the caller that prepared this stop. */
  readonly token: string;
  readonly status: "completed" | "pending";
  readonly error?: string;
}

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  activeForm?: string;
  owner?: string;
  metadata: TaskMetadata;
  /** Canonical execution authority. Only TaskStore may mutate this field. */
  execution?: TaskExecutionBinding;
  /** Terminal stop reservation. Only its opaque token may release the binding. */
  executionStop?: TaskExecutionStopReservation;
  blocks: string[];
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
}

/** Serialized store format on disk. */
export interface TaskStoreData {
  /** Stable identity for CAS refs. Missing only in stores written by older versions. */
  storeId?: string;
  nextId: number;
  tasks: Task[];
}

/** Background process associated with a task. */
export interface BackgroundProcess {
  taskId: string;
  pid: number;
  command?: string;
  output: string[];
  status: "running" | "completed" | "error" | "stopped";
  exitCode?: number;
  startedAt: number;
  completedAt?: number;
  proc: ChildProcess;
  abortController: AbortController;
  waiters: Array<() => void>;
}
