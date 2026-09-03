/**
 * Shared task lists: several pi sessions pointing at the same file. Each mutation
 * takes the lock, re-reads the file, applies, and writes back — these tests pin that
 * contract, since the alternative (mutating stale in-memory state) silently drops
 * the other session's writes.
 *
 * Not covered on purpose: retry-to-exhaustion against a live lock holder. That is
 * 100 retries x 50ms of busy wait — five seconds of wall clock for one assertion.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../../src/tasks/task-store.js";

// A seam inside the critical section. save() ends with renameSync, so a hook there
// runs while the store holds the lock — the only way to stage a lock changing hands
// mid-operation, since acquire and release are both internal to withLock.
const renameHook = vi.hoisted(() => ({ current: null as null | (() => void) }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      renameHook.current?.();
      return actual.renameSync(...args);
    },
  };
});

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-tasks-lock-"));
  file = join(dir, "tasks.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("TaskStore — shared file access", () => {
  it("assigns distinct IDs when two sessions create tasks in turn", () => {
    const a = new TaskStore(file);
    const b = new TaskStore(file);

    const first = a.create("From A", "d");
    const second = b.create("From B", "d");

    expect(first.id).toBe("1");
    expect(second.id).toBe("2");
    expect(new TaskStore(file).list().map(t => t.subject)).toEqual(["From A", "From B"]);
  });

  it("does not lose the other session's writes when both mutate the same task", () => {
    const a = new TaskStore(file);
    const b = new TaskStore(file);
    a.create("Original", "d");

    a.update("1", { status: "in_progress" });
    b.update("1", { subject: "Renamed by B" });

    const [task] = new TaskStore(file).list();
    expect(task.status).toBe("in_progress");
    expect(task.subject).toBe("Renamed by B");
  });

  it("sees another session's new tasks without being reconstructed", () => {
    const a = new TaskStore(file);
    const b = new TaskStore(file);
    a.create("From A", "d");

    expect(b.list().map(t => t.subject)).toEqual(["From A"]);
    expect(b.get("1")?.subject).toBe("From A");
  });

  it("sees another session's deletions", () => {
    const a = new TaskStore(file);
    const b = new TaskStore(file);
    a.create("Doomed", "d");
    a.delete("1");

    expect(b.list()).toEqual([]);
    expect(b.get("1")).toBeUndefined();
  });

  it("claims a pending task only once across shared store instances", () => {
    const first = new TaskStore(file);
    const second = new TaskStore(file);
    first.create("Claim me", "d");

    expect(first.claimPending("1")?.status).toBe("in_progress");
    expect(second.claimPending("1")).toBeUndefined();
    expect(new TaskStore(file).get("1")?.status).toBe("in_progress");
  });

  it("atomically updates an unbound claim but refuses after that claim binds", () => {
    const owner = new TaskStore(file);
    const concurrent = new TaskStore(file);
    owner.create("Starting", "original");
    const claim = owner.claimPending("1", {
      kind: "workflow",
      taskAttemptId: "task-attempt",
      attemptId: "workflow-attempt",
    })!.execution!;

    const cancelled = concurrent.update("1", {
      status: "pending",
      subject: "Cancelled before bind",
    }, claim);
    expect(cancelled.casMatched).toBe(true);
    expect(owner.get("1")).toMatchObject({
      status: "pending",
      subject: "Cancelled before bind",
      execution: undefined,
    });

    const replacementClaim = owner.claimPending("1", {
      kind: "agent",
      taskAttemptId: "replacement-task-attempt",
      attemptId: "replacement-agent-attempt",
    })!.execution!;
    const replacementRef = concurrent.bindExecution(replacementClaim, "replacement-agent")!;

    const stale = owner.update("1", {
      status: "completed",
      subject: "Must not overwrite replacement",
    }, replacementClaim);
    expect(stale.casMatched).toBe(false);
    expect(owner.get("1")).toMatchObject({
      status: "in_progress",
      subject: "Cancelled before bind",
      execution: replacementRef,
    });
  });

  it("claims, binds, and settles one executor with attempt-aware CAS", () => {
    const first = new TaskStore(file);
    const second = new TaskStore(file);
    first.create("Execute once", "d");

    const claimed = first.claimPending("1", {
      kind: "agent",
      taskAttemptId: "task-attempt-1",
      attemptId: "child-attempt-1",
    });
    const claim = claimed?.execution;
    expect(claim).toBeDefined();
    expect(second.claimPending("1")).toBeUndefined();

    const ref = second.bindExecution(claim!, "agent-1");
    expect(ref).toMatchObject({
      taskId: "1",
      taskAttemptId: "task-attempt-1",
      attemptId: "child-attempt-1",
      kind: "agent",
      executorId: "agent-1",
    });
    expect(first.bindExecution(claim!, "agent-2")).toBeUndefined();
    expect(first.settleExecution({ ...ref!, executorId: "agent-2" }, {
      status: "completed",
      result: "forged",
    })).toBe(false);
    expect(second.settleExecution(ref!, { status: "completed", result: "done" })).toBe(true);
    expect(first.get("1")).toMatchObject({ status: "completed", metadata: { result: "done" } });
    expect(first.settleExecution(ref!, { status: "pending", error: "late" })).toBe(false);
  });

  it("rejects old attempt settlement and stopped output after reset and reclaim", () => {
    const store = new TaskStore(file);
    store.create("Retry", "d");
    const oldClaim = store.claimPending("1", {
      kind: "agent",
      taskAttemptId: "task-attempt-old",
      attemptId: "child-attempt-old",
    })!.execution!;
    const oldRef = store.bindExecution(oldClaim, "agent-old")!;

    const stopToken = store.prepareExecutionStop(oldRef, "pending")!;
    expect(store.finalizeExecutionStop(oldRef, stopToken, { status: "pending" }).casMatched).toBe(true);
    const newClaim = store.claimPending("1", {
      kind: "agent",
      taskAttemptId: "task-attempt-new",
      attemptId: "child-attempt-new",
    })!.execution!;
    const newRef = store.bindExecution(newClaim, "agent-new")!;

    expect(store.settleExecution(oldRef, { status: "completed", result: "late success" })).toBe(false);
    expect(store.settleExecution(oldRef, { status: "pending", error: "late failure" })).toBe(false);
    expect(store.recordSettledExecutionResult(oldRef, "late stopped output")).toBe(false);
    expect(store.get("1")).toMatchObject({
      status: "in_progress",
      execution: newRef,
    });
    expect(store.settleExecution(newRef, { status: "completed", result: "current" })).toBe(true);
    expect(store.get("1")?.metadata.result).toBe("current");
  });

  it("keeps a terminal stop reserved until its token owner finalizes", () => {
    const owner = new TaskStore(file);
    const concurrent = new TaskStore(file);
    owner.create("Reserved", "original", undefined, { keep: "original" });
    const claim = owner.claimPending("1", {
      kind: "workflow",
      taskAttemptId: "task-attempt",
      attemptId: "workflow-attempt",
    })!.execution!;
    const ref = owner.bindExecution(claim, "wf_controller")!;
    const token = owner.prepareExecutionStop(ref, "pending")!;

    expect(concurrent.update("1", { status: "completed" }).casMatched).toBe(false);
    expect(concurrent.update("1", {
      subject: "concurrent subject",
      metadata: { concurrent: true },
    }).casMatched).toBe(false);
    expect(concurrent.updateExecution(ref, { status: "completed" })).toBe(false);
    expect(concurrent.finalizeExecutionStop(ref, "wrong-token", { status: "pending" }).casMatched).toBe(false);
    expect(concurrent.delete("1")).toBe(false);
    expect(concurrent.clearAll()).toBe(0);
    expect(concurrent.claimPending("1", { kind: "agent" })).toBeUndefined();
    expect(concurrent.get("1")).toMatchObject({
      status: "pending",
      subject: "Reserved",
      execution: ref,
      executionStop: { token, status: "pending" },
      metadata: { keep: "original" },
    });

    const finalized = owner.finalizeExecutionStop(ref, token, {
      status: "pending",
      subject: "owner subject",
      description: "owner description",
      metadata: { owner: true },
    });
    expect(finalized.casMatched).toBe(true);
    expect(owner.get("1")).toMatchObject({
      status: "pending",
      subject: "owner subject",
      description: "owner description",
      execution: undefined,
      executionStop: undefined,
      metadata: { keep: "original", owner: true },
    });
    expect(concurrent.claimPending("1", { kind: "agent" })).toBeDefined();
  });

  it("does not clear a completed stop reservation", () => {
    const owner = new TaskStore(file);
    const concurrent = new TaskStore(file);
    owner.create("Reserved completed", "d");
    const claim = owner.claimPending("1", { kind: "agent" })!.execution!;
    const ref = owner.bindExecution(claim, "agent-1")!;
    const token = owner.prepareExecutionStop(ref, "completed")!;

    expect(concurrent.clearCompleted()).toBe(0);
    expect(concurrent.get("1")).toMatchObject({
      status: "completed",
      execution: ref,
      executionStop: { token },
    });
    expect(owner.finalizeExecutionStop(ref, token, { status: "completed" }).casMatched).toBe(true);
    expect(concurrent.clearCompleted()).toBe(1);
  });

  it("rejects malformed and cross-store execution refs", () => {
    const first = new TaskStore(file);
    first.create("Protected", "d");
    const claim = first.claimPending("1", { kind: "workflow" })!.execution!;
    const ref = first.bindExecution(claim, "wf_controller")!;

    const otherFile = join(dir, "other.json");
    const other = new TaskStore(otherFile);
    other.create("Other", "d");
    expect(other.settleExecution(ref, { status: "completed" })).toBe(false);
    expect(first.settleExecution({ ...ref, attemptId: "" }, { status: "completed" })).toBe(false);
    expect(first.settleExecution({ ...ref, kind: "invalid" } as never, { status: "completed" })).toBe(false);
    expect(first.get("1")?.status).toBe("in_progress");
  });

  it("does not delete tasks another instance wrote after this one became empty", () => {
    const stale = new TaskStore(file);
    const writer = new TaskStore(file);
    stale.create("Old", "d");
    stale.clearAll();
    writer.create("New", "d");

    expect(stale.deleteFileIfEmpty()).toBe(false);
    expect(new TaskStore(file).list().map(task => task.subject)).toEqual(["New"]);
  });

  it("reclaims a lock left behind by a dead process", () => {
    // A crashed session leaves its lock file on disk. Without stale-lock detection
    // every later mutation would block for the full retry budget and then throw.
    const dead = spawnSync(process.execPath, ["-e", ""]);
    expect(dead.pid).toBeGreaterThan(0);
    writeFileSync(`${file}.lock`, String(dead.pid));

    const store = new TaskStore(file);
    expect(() => store.create("After crash", "d")).not.toThrow();
    expect(new TaskStore(file).list().map(t => t.subject)).toEqual(["After crash"]);
  });

  it("reclaims a lock file that never got a PID written to it", () => {
    // acquireLock creates the lock file and then writes its PID. A crash in between
    // leaves an empty lock naming nobody — which used to be unrecoverable: every
    // later mutation burned the full retry budget and threw, permanently, until
    // someone deleted the file by hand.
    writeFileSync(`${file}.lock`, "");

    const store = new TaskStore(file);
    expect(() => store.create("After crash", "d")).not.toThrow();
    expect(new TaskStore(file).list().map(t => t.subject)).toEqual(["After crash"]);
  });

  it("reclaims a lock file holding garbage", () => {
    writeFileSync(`${file}.lock`, "not-a-pid");

    const store = new TaskStore(file);
    expect(() => store.create("After garbage lock", "d")).not.toThrow();
  });

  it("still reads the PID out of a lock written in the pid:token format", () => {
    // The lock token carries a unique suffix so a holder can recognise its own
    // lock. Staleness detection reads the PID off the front of that token — if the
    // format ever stops leading with the PID, every crashed lock silently becomes
    // unrecoverable-for-five-seconds again.
    const dead = spawnSync(process.execPath, ["-e", ""]);
    writeFileSync(`${file}.lock`, `${dead.pid}:11111111-2222-3333-4444-555555555555`);

    const store = new TaskStore(file);
    const started = Date.now();
    expect(() => store.create("After crash", "d")).not.toThrow();
    // Reclaimed on the first poll, not after the full retry budget (5s) expired.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("does not delete a lock that a successor now holds", () => {
    // A lock can be reclaimed out from under a live holder: isProcessRunning reads
    // the local process table, so a session in another PID namespace (a container,
    // or a list shared over NFS) reads our PID as dead. Releasing must then be a
    // no-op instead of deleting the successor's lock and letting two sessions write.
    const store = new TaskStore(file);
    const successor = `${process.pid}:00000000-0000-0000-0000-000000000000`;

    // renameSync is the last thing save() does, so this fires inside the critical
    // section — after our lock was written, before it is released.
    renameHook.current = () => { writeFileSync(`${file}.lock`, successor); };
    try {
      store.create("Task", "d");
    } finally {
      renameHook.current = null;
    }

    expect(readFileSync(`${file}.lock`, "utf-8")).toBe(successor);
  });

  it("removes its own lock even after reclaiming a stale one", () => {
    const dead = spawnSync(process.execPath, ["-e", ""]);
    writeFileSync(`${file}.lock`, String(dead.pid));

    new TaskStore(file).create("Task", "d");

    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("leaves no lock or temp file behind after a mutation", () => {
    const store = new TaskStore(file);
    store.create("Task", "d");
    store.update("1", { status: "completed" });
    store.clearCompleted();

    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(readdirSync(dir).filter(f => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("TaskStore — snapshot and seed", () => {
  it("snapshots the latest state written by another session", () => {
    const a = new TaskStore(file);
    const b = new TaskStore(file);
    a.create("Written by A", "d");

    expect(b.snapshot().tasks.map(t => t.subject)).toEqual(["Written by A"]);
  });

  it("seeds an empty store and carries the ID counter over", () => {
    const parent = new TaskStore(file);
    parent.create("One", "d");
    parent.create("Two", "d");
    const snapshot = parent.snapshot();

    const childFile = join(dir, "child.json");
    const child = new TaskStore(childFile);
    child.seed(snapshot);

    expect(child.list().map(t => t.subject)).toEqual(["One", "Two"]);
    // Continues from the parent's counter rather than colliding on "1".
    expect(child.create("Three", "d").id).toBe("3");
  });

  it("does not overwrite tasks written after a stale instance observed an empty store", () => {
    const parent = new TaskStore(file);
    parent.create("Parent seed", "d");
    const snapshot = parent.snapshot();

    const childFile = join(dir, "child.json");
    const staleEmpty = new TaskStore(childFile);
    new TaskStore(childFile).create("Concurrent child task", "d");
    staleEmpty.seed(snapshot);

    expect(new TaskStore(childFile).list().map(task => task.subject))
      .toEqual(["Concurrent child task"]);
  });

  it("deep-clones records so child mutations cannot change an in-memory parent", () => {
    const parent = new TaskStore();
    parent.create("Shared", "d", undefined, { nested: { value: "parent" } });
    const child = new TaskStore();
    child.seed(parent.snapshot());

    const childNested = child.get("1")?.metadata.nested as { value: string };
    childNested.value = "child";

    expect((parent.get("1")?.metadata.nested as { value: string }).value).toBe("parent");
  });

  it("is a no-op on a store that already has tasks, so re-seeding never duplicates", () => {
    const parent = new TaskStore(file);
    parent.create("One", "d");
    const snapshot = parent.snapshot();

    const childFile = join(dir, "child.json");
    new TaskStore(childFile).seed(snapshot);
    // Re-pointing at the already-seeded file and seeding again must change nothing.
    const reopened = new TaskStore(childFile);
    reopened.seed(snapshot);

    expect(reopened.list().map(t => t.subject)).toEqual(["One"]);
  });

  it("does not write the parent's file when the seeded copy is mutated", () => {
    const parent = new TaskStore(file);
    parent.create("Shared", "d");

    const childFile = join(dir, "child.json");
    const child = new TaskStore(childFile);
    child.seed(parent.snapshot());
    child.create("Child only", "d");

    expect(new TaskStore(file).list().map(t => t.subject)).toEqual(["Shared"]);
  });
});
