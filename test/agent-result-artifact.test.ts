import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_AGENTS } from "./helpers/agents.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { getOutputTranscriptDefault, sessionTaskDir, setOutputTranscriptDefault } from "../src/output-file.js";
import { type ResultArtifactManifest, writeResultArtifact } from "../src/result-artifact.js";
import type { AgentConfig } from "../src/types.js";

const mockPi = {} as never;

function session() {
  return { dispose: vi.fn(), messages: [] } as never;
}

function manifest(record: { resultArtifactPath?: string }): ResultArtifactManifest {
  if (!record.resultArtifactPath) throw new Error("record has no result artifact");
  return JSON.parse(readFileSync(record.resultArtifactPath, "utf-8")) as ResultArtifactManifest;
}

describe("AgentManager result artifacts", () => {
  let cwd: string;
  let sessionId: string;
  let taskDir: string;
  let manager: AgentManager | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-agent-artifact-cwd-"));
    sessionId = `artifact-session-${process.pid}-${Date.now()}-${Math.random()}`;
    taskDir = sessionTaskDir(cwd, sessionId);
  });

  afterEach(async () => {
    await manager?.dispose();
    manager = undefined;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(dirname(taskDir), { recursive: true, force: true });
    vi.clearAllMocks();
    registerAgents(TEST_AGENTS);
    setOutputTranscriptDefault(true);
  });

  function ctx(persisted = true) {
    return {
      cwd,
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => persisted ? join(cwd, "parent.jsonl") : undefined,
      },
    } as never;
  }

  it("automatically captures a completed attempt without adding a model turn", async () => {
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onTurnEnd?.(1);
      options.onToolActivity?.({ type: "end", toolName: "read" });
      options.onAssistantUsage?.({ input: 10, output: 4, cacheWrite: 2, cacheRead: 3, cost: 0.01 });
      return { responseText: "done", session: session(), aborted: false, steered: false };
    });
    manager = new AgentManager();

    const id = manager.spawn(mockPi, ctx(), "Explorer", "secret prompt", {
      description: "caller label must not become a path",
      isBackground: true,
      invocation: { modelId: "provider/model", thinking: "high" },
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(runAgent).toHaveBeenCalledOnce();
    expect(record.turnCount).toBe(1);
    expect(record.artifactStatus).toBe("complete");
    expect(record.resultArtifactPath).toContain(record.artifactId);
    expect(record.resultArtifactPath).not.toContain("caller label");
    const data = manifest(record);
    expect(data).toMatchObject({
      artifactId: record.artifactId,
      agentId: id,
      status: "completed",
      producer: { kind: "agent", scope: "top-level", invocation: "spawn" },
      model: { id: "provider/model", thinking: "high" },
      usage: {
        turns: 1,
        toolCalls: 1,
        tokens: { input: 10, output: 4, cacheWrite: 2, cacheRead: 3, cost: 0.01 },
      },
    });
    expect(JSON.stringify(data)).not.toContain("secret prompt");
    expect(JSON.stringify(data)).not.toContain(cwd);
  });

  it.each([
    { expected: "error", outcome: "reject" },
    { expected: "aborted", outcome: "abort" },
    { expected: "stopped", outcome: "stop" },
  ] as const)("writes a $expected manifest", async ({ expected, outcome }) => {
    let finish: ((value: unknown) => void) | undefined;
    if (outcome === "reject") {
      vi.mocked(runAgent).mockRejectedValue(new Error(`failed in ${cwd}`));
    } else if (outcome === "abort") {
      vi.mocked(runAgent).mockResolvedValue({
        responseText: "partial aborted result",
        session: session(),
        aborted: true,
        steered: false,
      });
    } else {
      vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    }
    manager = new AgentManager();
    const id = manager.spawn(mockPi, ctx(), "Explorer", "go", {
      description: "terminal case",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    if (outcome === "stop") {
      expect(manager.abort(id)).toBe(true);
      finish?.({ responseText: "partial stopped result", session: session(), aborted: false, steered: false });
    }
    await record.promise;

    expect(record.status).toBe(expected);
    expect(manifest(record).status).toBe(expected);
    expect(JSON.stringify(manifest(record))).not.toContain(cwd);
  });

  it("retains running and queued attempt contexts across shutdown disposal without waiting for settlement", async () => {
    const finishes = new Map<string, (value: any) => void>();
    vi.mocked(runAgent).mockImplementation((_ctx, _type, prompt) =>
      new Promise(resolve => { finishes.set(prompt, resolve); }));
    manager = new AgentManager(undefined, 1);

    const runningId = manager.spawn(mockPi, ctx(), "Explorer", "running", {
      description: "running at shutdown",
      isBackground: true,
    });
    const queuedId = manager.spawn(mockPi, ctx(), "Explorer", "queued", {
      description: "queued at shutdown",
      isBackground: true,
    });
    const running = manager.getRecord(runningId)!;
    const queued = manager.getRecord(queuedId)!;
    expect(running.status).toBe("running");
    expect(queued.status).toBe("queued");

    // This is the exact AgentManager sequence used by index.ts session_shutdown.
    expect(manager.abortAll()).toBe(2);
    let disposed = false;
    const shutdown = manager.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(disposed).toBe(true);
    await shutdown;

    // A cooperative provider may settle only after shutdown has already cleared
    // the live record map. Its original artifact context must still be available.
    finishes.get("running")!({
      responseText: "partial stopped result",
      session: session(),
      aborted: false,
      steered: false,
    });
    await running.promise;

    expect(running.status).toBe("stopped");
    expect(running.result).toBe("partial stopped result");
    expect(running.artifactStatus).not.toBe("skipped");
    expect(manifest(running).status).toBe("stopped");
    expect(queued.status).toBe("stopped");
    expect(queued.artifactStatus).not.toBe("skipped");
    expect(manifest(queued).status).toBe("stopped");
  });

  it("resolves omitted body policy from agent frontmatter and project default", async () => {
    registerAgents(new Map([["private", { outputTranscript: false } as AgentConfig]]));
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "frontmatter-hidden",
      session: session(),
      aborted: false,
      steered: false,
    });
    manager = new AgentManager();

    const id = manager.spawn(mockPi, ctx(), "private", "go", {
      description: "frontmatter policy",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.artifactStatus).toBe("metadata-only");
    expect(readFileSync(record.resultArtifactPath!, "utf-8")).not.toContain("frontmatter-hidden");

    registerAgents(TEST_AGENTS);
    setOutputTranscriptDefault(false);
    const defaultId = manager.spawn(mockPi, ctx(), "no-config", "go", {
      description: "project policy",
      isBackground: true,
    });
    const defaultRecord = manager.getRecord(defaultId)!;
    await defaultRecord.promise;

    expect(defaultRecord.artifactStatus).toBe("metadata-only");
    expect(getOutputTranscriptDefault()).toBe(false);
  });

  it("does not let a changed config or resume options override the record's body policy", async () => {
    registerAgents(new Map([["private", { outputTranscript: false } as AgentConfig]]));
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first private result",
      session: session(),
      aborted: false,
      steered: false,
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed private result" } as never);
    manager = new AgentManager();
    const id = manager.spawn(mockPi, ctx(), "private", "go", {
      description: "private policy",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;
    expect(record.resultBodyEnabled).toBe(false);

    registerAgents(new Map([["private", { outputTranscript: true } as AgentConfig]]));
    await manager.resume(id, "continue", undefined, { resultBodyEnabled: true } as never);

    expect(record.resultBodyEnabled).toBe(false);
    expect(record.artifactStatus).toBe("metadata-only");
    expect(record.resultBodyPath).toBeUndefined();
    expect(readFileSync(record.resultArtifactPath!, "utf-8")).not.toContain("resumed private result");
  });

  it("derives the policy once for a legacy record with no historical snapshot", async () => {
    registerAgents(new Map([["legacy", { outputTranscript: true } as AgentConfig]]));
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "legacy first result",
      session: session(),
      aborted: false,
      steered: false,
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "legacy resumed result" } as never);
    manager = new AgentManager();
    const id = manager.spawn(mockPi, ctx(), "legacy", "go", {
      description: "legacy policy",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    // Simulate a live record created before the snapshot field and attempt
    // policy existed. The manager must fall back only when both are absent.
    record.resultBodyEnabled = undefined;
    const internals = manager as unknown as {
      artifactAttempts: Map<string, { includeBody?: boolean }>;
    };
    internals.artifactAttempts.get(id)!.includeBody = undefined;
    registerAgents(new Map([["legacy", { outputTranscript: false } as AgentConfig]]));

    await manager.resume(id, "continue");
    expect(record.resultBodyEnabled).toBe(false);
    expect(record.artifactStatus).toBe("metadata-only");

    registerAgents(new Map([["legacy", { outputTranscript: true } as AgentConfig]]));
    await manager.resume(id, "continue again");
    expect(record.resultBodyEnabled).toBe(false);
    expect(record.artifactStatus).toBe("metadata-only");
    expect(record.resultBodyPath).toBeUndefined();
  });

  it("keeps a foreground resume stopped after manager.abort and writes a partial manifest", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first",
      session: session(),
      aborted: false,
      steered: false,
    });
    let resolveResume!: (value: { text: string }) => void;
    let resumeSignal: AbortSignal | undefined;
    vi.mocked(resumeAgent).mockImplementation(async (_session, _prompt, options: any) => {
      resumeSignal = options.signal;
      return new Promise(resolve => { resolveResume = resolve; });
    });
    manager = new AgentManager();
    const id = manager.spawn(mockPi, ctx(), "Explorer", "first", {
      description: "resume stop",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    const pending = manager.resume(id, "continue");
    await Promise.resolve();
    expect(record.status).toBe("running");
    expect(manager.abort(id)).toBe(true);
    expect(resumeSignal?.aborted).toBe(true);

    resolveResume({ text: "partial resume" });
    await pending;

    expect(record.status).toBe("stopped");
    expect(record.result).toBe("partial resume");
    expect(manifest(record).status).toBe("stopped");
  });

  it("keeps a foreground resume stopped when its caller signal aborts", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first",
      session: session(),
      aborted: false,
      steered: false,
    });
    let resolveResume!: (value: { text: string }) => void;
    let resumeSignal: AbortSignal | undefined;
    vi.mocked(resumeAgent).mockImplementation(async (_session, _prompt, options: any) => {
      resumeSignal = options.signal;
      return new Promise(resolve => { resolveResume = resolve; });
    });
    manager = new AgentManager();
    const id = manager.spawn(mockPi, ctx(), "Explorer", "first", {
      description: "resume signal",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    const caller = new AbortController();
    const pending = manager.resume(id, "continue", caller.signal);
    await Promise.resolve();
    caller.abort();
    expect(record.status).toBe("stopped");
    expect(resumeSignal?.aborted).toBe(true);

    resolveResume({ text: "partial signal" });
    await pending;

    expect(record.status).toBe("stopped");
    expect(record.result).toBe("partial signal");
    expect(manifest(record).status).toBe("stopped");
  });

  it.each(["running", "queued"] as const)(
    "rejects a foreground resume while a background record is %s without changing its attempt",
    async (state) => {
      vi.mocked(runAgent).mockResolvedValue({
        responseText: "first",
        session: session(),
        aborted: false,
        steered: false,
      });
      manager = new AgentManager(undefined, 1);
      const id = manager.spawn(mockPi, ctx(), "Explorer", "first", {
        description: "resume guard",
        isBackground: true,
      });
      const record = manager.getRecord(id)!;
      await record.promise;

      let finishBlocker: ((value: any) => void) | undefined;
      let blockerId: string | undefined;
      if (state === "queued") {
        vi.mocked(runAgent).mockImplementation(() =>
          new Promise(resolve => { finishBlocker = resolve; }));
        blockerId = manager.spawn(mockPi, ctx(), "Explorer", "blocker", {
          description: "pool blocker",
          isBackground: true,
        });
      }

      let finishResume: ((value: { text: string }) => void) | undefined;
      vi.mocked(resumeAgent).mockImplementation(() =>
        new Promise(resolve => { finishResume = resolve; }));
      vi.mocked(resumeAgent).mockClear();
      const active = await manager.resume(id, "background", undefined, { isBackground: true });
      expect(active?.status).toBe(state);

      const internals = manager as unknown as {
        artifactAttempts: Map<string, unknown>;
      };
      const attempt = internals.artifactAttempts.get(id);
      const attemptCount = internals.artifactAttempts.size;
      const snapshot = { ...record };

      expect(await manager.resume(id, "foreground")).toBeUndefined();

      expect(record).toEqual(snapshot);
      expect(internals.artifactAttempts.get(id)).toBe(attempt);
      expect(internals.artifactAttempts.size).toBe(attemptCount);
      expect(resumeAgent).toHaveBeenCalledTimes(state === "running" ? 1 : 0);

      manager.abortAll();
      if (state === "running") {
        finishResume!({ text: "partial" });
        await active!.promise;
      } else {
        finishBlocker!({ responseText: "partial", session: session(), aborted: false, steered: false });
        await manager.getRecord(blockerId!)!.promise;
      }
    },
  );

  it("creates a new resume attempt and records source lineage with attempt-local usage", async () => {
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onAssistantUsage?.({ input: 8, output: 3, cacheWrite: 0 });
      return { responseText: "first", session: session(), aborted: false, steered: false };
    });
    vi.mocked(resumeAgent).mockImplementation(async (_session, _prompt, options: any) => {
      options.onTurnEnd?.(1);
      options.onToolActivity?.({ type: "end", toolName: "grep" });
      options.onAssistantUsage?.({ input: 5, output: 2, cacheWrite: 1 });
      return { text: "second" };
    });
    manager = new AgentManager();
    const id = manager.spawn(mockPi, ctx(), "Explorer", "first", {
      description: "first",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;
    const firstAttemptId = record.artifactId;
    const firstManifestPath = record.resultArtifactPath!;

    await manager.resume(id, "continue");

    expect(record.artifactId).not.toBe(firstAttemptId);
    expect(record.sourceAttemptId).toBe(firstAttemptId);
    expect(readFileSync(firstManifestPath, "utf-8")).toContain(firstAttemptId);
    expect(manifest(record)).toMatchObject({
      artifactId: record.artifactId,
      sourceAttemptId: firstAttemptId,
      producer: { invocation: "resume" },
      resume: { sourceAgentId: id },
      usage: {
        turns: 1,
        toolCalls: 1,
        tokens: { input: 5, output: 2, cacheWrite: 1 },
      },
    });
  });

  it("links a new Task retry to the preceding task attempt", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "result",
      session: session(),
      aborted: false,
      steered: false,
    });
    manager = new AgentManager();
    const taskExecution = (attempt: string) => ({
      storeId: "store-1",
      taskId: "10",
      taskAttemptId: `task-${attempt}`,
      attemptId: `agent-${attempt}`,
      kind: "agent" as const,
    });

    const firstId = manager.spawn(mockPi, ctx(), "Explorer", "first", {
      description: "first",
      isBackground: true,
      taskExecution: taskExecution("one"),
    });
    await manager.getRecord(firstId)!.promise;
    const firstAttemptId = manager.getRecord(firstId)!.artifactId;

    const retryId = manager.spawn(mockPi, ctx(), "Explorer", "retry", {
      description: "retry",
      isBackground: true,
      taskExecution: taskExecution("two"),
    });
    const retry = manager.getRecord(retryId)!;
    await retry.promise;

    expect(retry.sourceAttemptId).toBe(firstAttemptId);
    expect(manifest(retry).producer.invocation).toBe("retry");
    expect(manifest(retry).sourceAttemptId).toBe(firstAttemptId);
  });

  it("writes only a manifest when result-body persistence is disabled", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "sensitive result",
      session: session(),
      aborted: false,
      steered: false,
    });
    manager = new AgentManager();
    const id = manager.spawn(mockPi, ctx(), "sensitive", "go", {
      description: "sensitive",
      isBackground: true,
      resultBodyEnabled: false,
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.artifactStatus).toBe("metadata-only");
    expect(record.resultBodyPath).toBeUndefined();
    expect(readFileSync(record.resultArtifactPath!, "utf-8")).not.toContain("sensitive result");
  });

  it("does not write in a no-session context", async () => {
    const writer = vi.fn(writeResultArtifact);
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: session(),
      aborted: false,
      steered: false,
    });
    manager = new AgentManager(undefined, undefined, undefined, undefined, undefined, writer);
    const id = manager.spawn(mockPi, ctx(false), "Explorer", "go", {
      description: "ephemeral",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.artifactStatus).toBe("skipped");
    expect(record.resultArtifactPath).toBeUndefined();
    expect(writer).not.toHaveBeenCalled();
  });

  it("keeps the Agent result settled when the artifact writer fails", async () => {
    const onComplete = vi.fn();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "still available",
      session: session(),
      aborted: false,
      steered: false,
    });
    manager = new AgentManager(
      onComplete,
      undefined,
      undefined,
      undefined,
      undefined,
      () => { throw Object.assign(new Error("disk unavailable"), { code: "EIO" }); },
    );
    const id = manager.spawn(mockPi, ctx(), "Explorer", "go", {
      description: "writer failure",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    await expect(record.promise).resolves.toBe("still available");
    expect(record.status).toBe("completed");
    expect(record.result).toBe("still available");
    expect(record.artifactStatus).toBe("failed");
    expect(record.artifactError).toBe("result artifact write failed (EIO)");
    expect(onComplete).toHaveBeenCalledWith(record);
  });
});
