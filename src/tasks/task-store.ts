/**
 * task-store.ts — File-backed task store with CRUD, dependency management, and file locking.
 *
 * Session-scoped (default): in-memory Map — no disk I/O.
 * Shared (PI_TASK_LIST_ID set): ~/.pi/tasks/<listId>.json with file locking.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type {
  TaskExecutionBinding,
  TaskExecutionClaim,
  TaskExecutionClaimOptions,
  TaskExecutionRef,
  TaskExecutionSettle,
} from "./execution-contract.js";
import {
  isTaskExecutionBinding,
  isTaskExecutionClaim,
  isTaskExecutionRef,
  sameTaskExecutionAttempt,
} from "./execution-contract.js";
import { sortTasks, type TaskSortOrder } from "./task-sort.js";
import type {
  Task,
  TaskExecutionStopReservation,
  TaskMetadata,
  TaskStatus,
  TaskStoreData,
} from "./types.js";

const TASKS_DIR = join(homedir(), ".pi", "tasks");
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100; // 5s max

/**
 * Simple file-based locking. Returns the token written into the lock file, which
 * must be handed back to `releaseLock`.
 *
 * The token is `<pid>:<uuid>`: the PID prefix is what the staleness check below
 * parses, and the UUID suffix makes it unique so a holder can tell its own lock
 * from a successor's. Both halves matter — see `releaseLock`.
 */
function acquireLock(lockPath: string): string {
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = `${process.pid}:${randomUUID()}`;

  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      // O_EXCL: fail if file exists
      writeFileSync(lockPath, token, { flag: "wx" });
      return token;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        // Check for stale lock (process no longer running)
        try {
          const pid = parseInt(readFileSync(lockPath, "utf-8"), 10);
          // A lock naming a dead process is stale. So is one with no readable PID,
          // but only after a couple of polls: the file is created before the PID is
          // written to it, so a live acquirer can look unparseable for a moment —
          // one that crashed in that window looks that way forever.
          if (pid > 0 ? !isProcessRunning(pid) : i >= 2) {
            unlinkSync(lockPath);
            continue;
          }
        } catch { /* ignore read errors */ }
        // Wait and retry
        const start = Date.now();
        while (Date.now() - start < LOCK_RETRY_MS) { /* busy wait */ }
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Failed to acquire lock: ${lockPath}`);
}

/**
 * Release a lock, but only if we still hold it. A lock can be reclaimed out from
 * under a live holder — `isProcessRunning` answers from the local process table,
 * so a session in another PID namespace (container, or a list shared over NFS)
 * can read our PID as dead. Without the token check we would then delete the
 * successor's lock and two sessions would write the file at once.
 */
function releaseLock(lockPath: string, token: string): void {
  try {
    if (readFileSync(lockPath, "utf-8") === token) unlinkSync(lockPath);
  } catch { /* ignore — already gone */ }
}

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Fill defaults for tasks persisted by older versions. Task files written
 * before the blocking feature have no `blockedBy`/`blocks`/`metadata`, so
 * consumers that read those fields unguarded (e.g. `task.blockedBy.length`)
 * would throw. Normalizing at the load boundary lets every consumer trust the
 * shape. Also guards against wrong types in hand-edited files.
 */
function cloneTask(task: Task): Task {
  return structuredClone(task);
}

function normalizeTask(t: Task, storeId: string): Task {
  const now = Date.now();
  const metadata = t.metadata && typeof t.metadata === "object" && !Array.isArray(t.metadata) ? t.metadata : {};
  let execution = isTaskExecutionBinding(t.execution, t.id) && t.execution.storeId === storeId
    ? t.execution
    : undefined;

  // Current pre-binding stores persisted the same authority in mutable metadata.
  // Migrate it deterministically from fields already on disk; never mint a new
  // attempt token on each load.
  if (t.status === "in_progress" && execution === undefined
    && typeof metadata.agentId === "string" && metadata.agentId.length > 0) {
    const taskAttemptId = typeof metadata.taskAttemptId === "string" && metadata.taskAttemptId.length > 0
      ? metadata.taskAttemptId
      : `legacy-${t.id}-${typeof t.updatedAt === "number" ? t.updatedAt : 0}-${metadata.agentId}`;
    execution = {
      storeId,
      taskId: t.id,
      taskAttemptId,
      attemptId: `legacy-${taskAttemptId}`,
      kind: "agent",
      executorId: metadata.agentId,
    };
  }

  const executionStop: TaskExecutionStopReservation | undefined = execution !== undefined
    && t.status !== "in_progress"
    && t.executionStop !== undefined
    && typeof t.executionStop.token === "string"
    && t.executionStop.token.length > 0
    && (t.executionStop.status === "completed" || t.executionStop.status === "pending")
    ? t.executionStop
    : undefined;

  return {
    ...t,
    metadata,
    ...(execution !== undefined ? { execution } : { execution: undefined }),
    ...(executionStop !== undefined ? { executionStop } : { executionStop: undefined }),
    blocks: Array.isArray(t.blocks) ? t.blocks : [],
    blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy : [],
    createdAt: typeof t.createdAt === "number" ? t.createdAt : now,
    updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : now,
  };
}

export class TaskStore {
  private filePath: string | undefined;
  private lockPath: string | undefined;
  /** Stable for this store generation and persisted for file-backed stores. */
  private storeId: string = randomUUID();
  private needsMigration = false;

  // In-memory state (always kept in sync)
  private nextId = 1;
  private tasks = new Map<string, Task>();

  constructor(listIdOrPath?: string) {
    if (!listIdOrPath) return;
    const isAbsPath = isAbsolute(listIdOrPath);
    const filePath = isAbsPath ? listIdOrPath : join(TASKS_DIR, `${listIdOrPath}.json`);
    // Directory is created lazily on the first write (acquireLock/save both
    // mkdir it), so a session that never persists a task leaves no .pi/tasks/.
    this.filePath = filePath;
    this.lockPath = filePath + ".lock";
    this.load();
    // Existing stores are migrated under the same lock as every mutation. This
    // persists the generated store id once, so two future instances agree.
    if (this.needsMigration) this.withLock(() => {});
  }

  /**
   * Read store from disk (file-backed mode only).
   *
   * `normalizeTask` hardens each record; this hardens the envelope around them.
   * A truncated write, a bad merge or a hand edit can leave a file that parses
   * but has no `tasks` array or no usable `nextId`, and both used to corrupt the
   * store: the missing array threw mid-load and left it wiped, and the missing
   * counter produced the task ID "NaN", then IDs restarting at "0" and colliding
   * with live tasks. Anything unusable now leaves the current state alone.
   */
  private load(): void {
    if (!this.filePath) return;
    if (!existsSync(this.filePath)) return;
    try {
      const data: unknown = JSON.parse(readFileSync(this.filePath, "utf-8"));
      if (!data || typeof data !== "object") return;
      const { storeId, nextId, tasks } = data as Partial<TaskStoreData>;
      if (!Array.isArray(tasks)) return;
      if (typeof storeId === "string" && storeId.length > 0) {
        this.storeId = storeId;
      } else {
        this.needsMigration = true;
      }

      // Build the replacement before touching the live state, so a bad record
      // can't leave the store half-loaded.
      const loaded = new Map<string, Task>();
      let maxId = 0;
      for (const t of tasks) {
        if (!t || typeof t !== "object" || typeof t.id !== "string") continue;
        if (t.status === "in_progress" && typeof t.metadata?.agentId === "string"
          && !isTaskExecutionBinding(t.execution, t.id)) {
          this.needsMigration = true;
        }
        loaded.set(t.id, normalizeTask(t, this.storeId));
        const numericId = Number(t.id);
        if (Number.isFinite(numericId) && numericId > maxId) maxId = numericId;
      }
      this.tasks = loaded;
      // Every future task ID comes from this counter, so it has to clear the IDs
      // already in use — whether the file omitted it or recorded a stale one.
      this.nextId = typeof nextId === "number" && Number.isInteger(nextId) && nextId > maxId ? nextId : maxId + 1;
    } catch { /* unreadable or not JSON — keep the state we have */ }
  }

  /** Write store to disk atomically (file-backed mode only). */
  private save(): void {
    if (!this.filePath) return;
    const data: TaskStoreData = {
      storeId: this.storeId,
      nextId: this.nextId,
      tasks: Array.from(this.tasks.values()),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = this.filePath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, this.filePath);
  }

  /** Execute a mutation with file locking (if file-backed). */
  private withLock<T>(fn: () => T): T {
    if (!this.lockPath) return fn();
    const token = acquireLock(this.lockPath);
    try {
      this.load(); // Re-read latest state
      const result = fn();
      this.save();
      this.needsMigration = false;
      return result;
    } finally {
      releaseLock(this.lockPath, token);
    }
  }

  create(subject: string, description: string, activeForm?: string, metadata?: TaskMetadata): Task {
    return this.withLock(() => {
      const now = Date.now();
      const task: Task = {
        id: String(this.nextId++),
        subject,
        description,
        status: "pending",
        activeForm,
        owner: undefined,
        metadata: structuredClone(metadata ?? {}),
        blocks: [],
        blockedBy: [],
        createdAt: now,
        updatedAt: now,
      };
      this.tasks.set(task.id, task);
      return cloneTask(task);
    });
  }

  get(id: string): Task | undefined {
    if (this.filePath) this.load();
    const task = this.tasks.get(id);
    return task ? cloneTask(task) : undefined;
  }

  /** Atomically move a pending task to in_progress. Returns the claimed task,
   *  or undefined when it is missing or another session already claimed it.
   *
   *  The string overload preserves the historical taskAttemptId argument. */
  claimPending(
    id: string,
    claim?: string | TaskExecutionClaimOptions,
  ): (Task & { execution: TaskExecutionClaim }) | undefined {
    return this.withLock(() => {
      const task = this.tasks.get(id);
      if (!task || task.status !== "pending" || task.execution !== undefined) return undefined;
      const options = typeof claim === "string" ? { taskAttemptId: claim } : claim ?? {};
      const taskAttemptId = options.taskAttemptId ?? randomUUID();
      task.status = "in_progress";
      const execution: TaskExecutionClaim = {
        storeId: this.storeId,
        taskId: id,
        taskAttemptId,
        attemptId: options.attemptId ?? randomUUID(),
        kind: options.kind ?? "agent",
      };
      task.execution = execution;
      // A new attempt never inherits outcome or executor display data from the
      // previous one. Mutable metadata remains compatibility/history only.
      delete task.metadata.result;
      delete task.metadata.lastError;
      delete task.metadata.agentId;
      delete task.metadata.workflowId;
      task.owner = undefined;
      // Compatibility read for older clients. It is not used as CAS authority.
      task.metadata.taskAttemptId = taskAttemptId;
      task.updatedAt = Date.now();
      const claimed = cloneTask(task);
      return { ...claimed, execution: { ...execution } };
    });
  }

  /** Bind exactly one executor to the current claim. Idempotent for that executor. */
  bindExecution(claim: TaskExecutionClaim, executorId: string): TaskExecutionRef | undefined {
    if (!isTaskExecutionClaim(claim) || !executorId) return undefined;
    return this.withLock(() => {
      const task = this.tasks.get(claim.taskId);
      const current = task?.execution;
      if (!task || task.status !== "in_progress" || !current || !sameTaskExecutionAttempt(current, claim)) return undefined;
      if (isTaskExecutionRef(current) && current.executorId !== executorId) return undefined;
      const bound: TaskExecutionRef = { ...claim, executorId };
      task.execution = bound;
      task.owner = executorId;
      if (bound.kind === "agent") {
        task.metadata.agentId = executorId;
        delete task.metadata.workflowId;
      } else {
        task.metadata.workflowId = executorId;
        delete task.metadata.agentId;
      }
      task.updatedAt = Date.now();
      return { ...bound };
    });
  }

  /**
   * Reserve a terminal status for an executor that is being stopped. The
   * binding remains attached until the caller finishes its CAS update, so a
   * replacement claim cannot enter the gap between stopping the executor and
   * writing the requested Todo status.
   */
  prepareExecutionStop(
    ref: TaskExecutionRef,
    status: "completed" | "pending",
    error?: string,
  ): string | undefined {
    if (!isTaskExecutionRef(ref)) return undefined;
    return this.withLock(() => {
      const task = this.tasks.get(ref.taskId);
      if (!task || task.status !== "in_progress" || task.executionStop !== undefined
        || !sameTaskExecutionAttempt(task.execution, ref)) return undefined;
      const token = randomUUID();
      task.status = status;
      task.executionStop = {
        token,
        status,
        ...(error !== undefined ? { error } : {}),
      };
      task.updatedAt = Date.now();
      return token;
    });
  }

  /** Roll back a terminal stop reservation when session teardown invalidates it. */
  rollbackExecutionStop(ref: TaskExecutionRef, token: string, error?: string): boolean {
    if (!isTaskExecutionRef(ref) || !token) return false;
    return this.withLock(() => {
      const task = this.tasks.get(ref.taskId);
      if (!task || task.executionStop?.token !== token
        || !sameTaskExecutionAttempt(task.execution, ref)) return false;
      task.status = "pending";
      task.execution = undefined;
      task.executionStop = undefined;
      task.owner = undefined;
      delete task.metadata.result;
      if (error !== undefined) task.metadata.lastError = error;
      else delete task.metadata.lastError;
      task.updatedAt = Date.now();
      return true;
    });
  }

  /** Restore a stop reservation when the executor could not be stopped. */
  restoreExecution(ref: TaskExecutionRef, token: string): boolean {
    if (!isTaskExecutionRef(ref) || !token) return false;
    return this.withLock(() => {
      const task = this.tasks.get(ref.taskId);
      if (!task || task.executionStop?.token !== token
        || !sameTaskExecutionAttempt(task.execution, ref)) return false;
      task.status = "in_progress";
      task.executionStop = undefined;
      task.owner = ref.executorId;
      task.updatedAt = Date.now();
      return true;
    });
  }

  /** Apply a non-terminal executor mutation while the captured ref is current. */
  updateExecution(ref: TaskExecutionRef, fields: {
    status?: TaskStatus | "deleted";
    subject?: string;
    description?: string;
    activeForm?: string;
    owner?: string;
    metadata?: Record<string, unknown>;
    addBlocks?: string[];
    addBlockedBy?: string[];
  }): boolean {
    if (!isTaskExecutionRef(ref) || (fields.status !== undefined && fields.status !== "in_progress")) return false;
    return this.update(ref.taskId, fields, ref).casMatched === true;
  }

  /** Finalize exactly the stop reservation returned by prepareExecutionStop. */
  finalizeExecutionStop(
    ref: TaskExecutionRef,
    token: string,
    fields: {
      status: "completed" | "pending" | "deleted";
      subject?: string;
      description?: string;
      activeForm?: string;
      owner?: string;
      metadata?: Record<string, unknown>;
      addBlocks?: string[];
      addBlockedBy?: string[];
    },
    retainBinding = false,
  ): ReturnType<TaskStore["update"]> {
    return this.update(ref.taskId, fields, ref, token, retainBinding);
  }

  /** Commit one bound executor's outcome. Stale, malformed, cross-store, or
   *  duplicate refs are rejected without mutating the task. A terminal task
   *  may still carry its ref while TaskUpdate finishes a stop reservation; the
   *  stopped lifecycle event must not clear that authority before the caller's
   *  final ref-CAS. */
  settleExecution(ref: TaskExecutionRef, outcome: TaskExecutionSettle): boolean {
    if (!isTaskExecutionRef(ref) || (outcome.status !== "completed" && outcome.status !== "pending")) return false;
    return this.withLock(() => {
      const task = this.tasks.get(ref.taskId);
      if (!task || !sameTaskExecutionAttempt(task.execution, ref) || task.executionStop !== undefined) return false;
      if (task.status !== "in_progress") return false;
      task.status = outcome.status;
      if (outcome.result !== undefined) task.metadata.result = outcome.result;
      else delete task.metadata.result;
      if (outcome.error !== undefined) task.metadata.lastError = outcome.error;
      else if (outcome.status === "completed") delete task.metadata.lastError;
      if (outcome.status === "pending") task.owner = undefined;
      if (!outcome.retainBinding) task.execution = undefined;
      task.executionStop = undefined;
      task.updatedAt = Date.now();
      return true;
    });
  }

  /**
   * Accept partial output emitted after a stop RPC confirmed the same attempt.
   * This cannot change status or trigger completion side effects. A TaskUpdate
   * stop reservation can retain the ref until its final update CAS; TaskStop
   * passes the default and releases it immediately.
   */
  recordSettledExecutionResult(ref: TaskExecutionRef, result?: string, retainBinding = false): boolean {
    if (!isTaskExecutionRef(ref)) return false;
    return this.withLock(() => {
      const task = this.tasks.get(ref.taskId);
      if (!task || task.status !== "completed" || !sameTaskExecutionAttempt(task.execution, ref)) return false;
      if (result !== undefined && result !== "") task.metadata.result = result;
      if (task.executionStop === undefined && !retainBinding) task.execution = undefined;
      task.updatedAt = Date.now();
      return true;
    });
  }

  /** Roll back a claim that failed before (or just after) binding. */
  rollbackExecution(claim: TaskExecutionBinding, error?: string): boolean {
    if (!isTaskExecutionBinding(claim)) return false;
    return this.withLock(() => {
      const task = this.tasks.get(claim.taskId);
      if (!task || task.status !== "in_progress" || !sameTaskExecutionAttempt(task.execution, claim)) return false;
      task.status = "pending";
      task.execution = undefined;
      task.executionStop = undefined;
      task.owner = undefined;
      delete task.metadata.result;
      if (error !== undefined) task.metadata.lastError = error;
      task.updatedAt = Date.now();
      return true;
    });
  }

  /** List all tasks, sorted by the given order (defaults to ID ascending). */
  list(sortOrder: TaskSortOrder = "id"): Task[] {
    if (this.filePath) this.load();
    return sortTasks(Array.from(this.tasks.values(), cloneTask), sortOrder);
  }

  update(id: string, fields: {
    status?: TaskStatus | "deleted";
    subject?: string;
    description?: string;
    activeForm?: string;
    owner?: string;
    metadata?: Record<string, unknown>;
    addBlocks?: string[];
    addBlockedBy?: string[];
  }, expectedExecution?: TaskExecutionBinding, expectedStopToken?: string, retainBinding = false): {
    task: Task | undefined;
    changedFields: string[];
    warnings: string[];
    casMatched?: boolean;
  } {
    return this.withLock(() => {
      const expectsCas = expectedExecution !== undefined || expectedStopToken !== undefined;
      const task = this.tasks.get(id);
      if (!task) return {
        task: undefined,
        changedFields: [],
        warnings: [],
        ...(expectsCas ? { casMatched: false } : {}),
      };
      const executionMatched = expectedExecution !== undefined
        && isTaskExecutionBinding(expectedExecution)
        && isTaskExecutionBinding(task.execution)
        && sameTaskExecutionAttempt(task.execution, expectedExecution)
        && (isTaskExecutionRef(expectedExecution) || isTaskExecutionClaim(task.execution));
      if (expectedExecution !== undefined && !executionMatched) {
        return { task: cloneTask(task), changedFields: [], warnings: [], casMatched: false };
      }
      const stopMatched = expectedStopToken !== undefined
        && expectedExecution !== undefined
        && task.executionStop?.token === expectedStopToken;
      const claimMatched = executionMatched
        && expectedExecution !== undefined
        && isTaskExecutionClaim(expectedExecution);
      if ((expectedStopToken !== undefined && !stopMatched)
        || (task.executionStop !== undefined && !stopMatched)
        || (task.execution !== undefined && task.status !== "in_progress" && !stopMatched)
        || (task.execution !== undefined && task.status === "in_progress"
          && fields.status !== undefined && fields.status !== "in_progress"
          && !stopMatched && !claimMatched)) {
        return { task: cloneTask(task), changedFields: [], warnings: [], casMatched: false };
      }
      if (stopMatched) {
        const reservedStatus = task.executionStop?.status;
        const requestedStatus = fields.status === "pending" ? "pending" : "completed";
        if (reservedStatus !== requestedStatus) {
          return { task: cloneTask(task), changedFields: [], warnings: [], casMatched: false };
        }
      }

      const changedFields: string[] = [];
      const warnings: string[] = [];

      // Handle deletion
      if (fields.status === "deleted") {
        this.tasks.delete(id);
        // Clean up dependency edges pointing to this task
        for (const t of this.tasks.values()) {
          t.blocks = t.blocks.filter(bid => bid !== id);
          t.blockedBy = t.blockedBy.filter(bid => bid !== id);
        }
        return {
          task: undefined,
          changedFields: ["deleted"],
          warnings: [],
          ...(expectsCas ? { casMatched: true } : {}),
        };
      }

      if (fields.status !== undefined) {
        const previousStatus = task.status;
        if (stopMatched) {
          const reservedError = task.executionStop?.error;
          if (fields.status === "pending") {
            delete task.metadata.result;
            task.owner = undefined;
          }
          if (reservedError !== undefined) task.metadata.lastError = reservedError;
          else delete task.metadata.lastError;
        }
        task.status = fields.status;
        if (fields.status !== "in_progress" || previousStatus !== "in_progress") {
          if (!retainBinding) task.execution = undefined;
        }
        if (stopMatched) task.executionStop = undefined;
        changedFields.push("status");
      }
      if (fields.subject !== undefined) {
        task.subject = fields.subject;
        changedFields.push("subject");
      }
      if (fields.description !== undefined) {
        task.description = fields.description;
        changedFields.push("description");
      }
      if (fields.activeForm !== undefined) {
        task.activeForm = fields.activeForm;
        changedFields.push("activeForm");
      }
      if (fields.owner !== undefined) {
        task.owner = fields.owner;
        changedFields.push("owner");
      }

      // Metadata: shallow merge, null deletes keys
      if (fields.metadata !== undefined) {
        for (const [key, value] of Object.entries(fields.metadata)) {
          if (value === null) {
            delete task.metadata[key];
          } else {
            task.metadata[key] = structuredClone(value);
          }
        }
        changedFields.push("metadata");
      }

      // Bidirectional dependency edges
      if (fields.addBlocks && fields.addBlocks.length > 0) {
        for (const targetId of fields.addBlocks) {
          if (!task.blocks.includes(targetId)) {
            task.blocks.push(targetId);
          }
          const target = this.tasks.get(targetId);
          if (target && !target.blockedBy.includes(id)) {
            target.blockedBy.push(id);
            target.updatedAt = Date.now();
          }
          // Warnings for problematic edges
          if (targetId === id) {
            warnings.push(`#${id} blocks itself`);
          } else if (!target) {
            warnings.push(`#${targetId} does not exist`);
          } else if (target.blocks.includes(id)) {
            warnings.push(`cycle: #${id} and #${targetId} block each other`);
          }
        }
        changedFields.push("blocks");
      }

      if (fields.addBlockedBy && fields.addBlockedBy.length > 0) {
        for (const targetId of fields.addBlockedBy) {
          if (!task.blockedBy.includes(targetId)) {
            task.blockedBy.push(targetId);
          }
          const target = this.tasks.get(targetId);
          if (target && !target.blocks.includes(id)) {
            target.blocks.push(id);
            target.updatedAt = Date.now();
          }
          // Warnings for problematic edges
          if (targetId === id) {
            warnings.push(`#${id} blocks itself`);
          } else if (!target) {
            warnings.push(`#${targetId} does not exist`);
          } else if (task.blocks.includes(targetId)) {
            warnings.push(`cycle: #${id} and #${targetId} block each other`);
          }
        }
        changedFields.push("blockedBy");
      }

      task.updatedAt = Date.now();
      return {
        task: cloneTask(task),
        changedFields,
        warnings,
        ...(expectsCas ? { casMatched: true } : {}),
      };
    });
  }

  /** Delete a task by ID. Returns true if deleted. */
  delete(id: string): boolean {
    return this.withLock(() => {
      const task = this.tasks.get(id);
      if (!task || task.execution !== undefined) return false;
      this.tasks.delete(id);
      // Clean up dependency edges
      for (const t of this.tasks.values()) {
        t.blocks = t.blocks.filter(bid => bid !== id);
        t.blockedBy = t.blockedBy.filter(bid => bid !== id);
      }
      return true;
    });
  }

  /** Remove all tasks. */
  clearAll(): number {
    return this.withLock(() => {
      let count = 0;
      for (const [id, task] of this.tasks) {
        if (task.execution !== undefined) continue;
        this.tasks.delete(id);
        count++;
      }
      if (count > 0) {
        const validIds = new Set(this.tasks.keys());
        for (const task of this.tasks.values()) {
          task.blocks = task.blocks.filter(id => validIds.has(id));
          task.blockedBy = task.blockedBy.filter(id => validIds.has(id));
        }
      }
      return count;
    });
  }

  /** Capture full store state — used to carry tasks into a forked session. */
  snapshot(): TaskStoreData {
    if (this.filePath) this.load();
    return {
      storeId: this.storeId,
      nextId: this.nextId,
      tasks: Array.from(this.tasks.values(), task => structuredClone(task)),
    };
  }

  /** Seed an empty store from a snapshot. No-op if the store already has tasks,
   *  so re-pointing to an already-seeded fork file never duplicates. */
  seed(data: TaskStoreData): void {
    this.withLock(() => {
      if (this.tasks.size > 0) return;
      this.nextId = data.nextId;
      this.tasks.clear();
      for (const source of data.tasks) {
        const task = structuredClone(source);
        // A fork is a new store generation. It may copy the work list, but it
        // cannot inherit commit authority held by the parent's executor.
        if (task.status === "in_progress") {
          task.status = "pending";
          task.owner = undefined;
          delete task.metadata.agentId;
          delete task.metadata.workflowId;
          delete task.metadata.taskAttemptId;
        }
        task.execution = undefined;
        task.executionStop = undefined;
        this.tasks.set(task.id, normalizeTask(task, this.storeId));
      }
    });
  }

  /** Delete the backing file (if file-backed and empty). */
  deleteFileIfEmpty(): boolean {
    if (!this.filePath || !this.lockPath) return false;
    const token = acquireLock(this.lockPath);
    try {
      this.load();
      if (this.tasks.size > 0) return false;
      try { unlinkSync(this.filePath); } catch { /* ignore */ }
      return true;
    } finally {
      releaseLock(this.lockPath, token);
    }
  }

  /** Remove all completed tasks. */
  clearCompleted(): number {
    return this.withLock(() => {
      let count = 0;
      for (const [id, task] of this.tasks) {
        if (task.status === "completed" && task.execution === undefined) {
          this.tasks.delete(id);
          count++;
        }
      }
      // Clean up dependency edges for deleted tasks
      if (count > 0) {
        const validIds = new Set(this.tasks.keys());
        for (const t of this.tasks.values()) {
          t.blocks = t.blocks.filter(bid => validIds.has(bid));
          t.blockedBy = t.blockedBy.filter(bid => validIds.has(bid));
        }
      }
      return count;
    });
  }
}
