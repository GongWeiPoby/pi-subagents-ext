/**
 * types.ts — Type definitions for the task management system.
 */

import type { ChildProcess } from "node:child_process";

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
}

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  activeForm?: string;
  owner?: string;
  metadata: TaskMetadata;
  blocks: string[];
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
}

/** Serialized store format on disk. */
export interface TaskStoreData {
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
