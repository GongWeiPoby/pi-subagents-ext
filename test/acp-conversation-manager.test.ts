import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AcpConversationManager,
  type AcpRuntime,
  type PersistedAcpConversation,
} from "../src/acp/conversation-manager.js";
import type { ApprovedAcpAgent } from "../src/acp/registry.js";
import type { AcpTurnResult } from "../src/acp/runtime.js";
import { AgentManager } from "../src/agent-manager.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function turn(text: string): AcpTurnResult {
  return { text, stopReason: "end_turn", response: { stopReason: "end_turn" } };
}

const approval: ApprovedAcpAgent = {
  registryId: "fixture-acp",
  displayName: "Fixture",
  handle: "acp-fixture",
  registryVersion: "1.0.0",
  sourceUrl: "file://fixture",
  command: "fixture",
  args: [],
  staticEnv: {},
  approvedAt: "2026-09-15T00:00:00.000Z",
  enabled: true,
};

describe("AcpConversationManager", () => {
  const managers: AgentManager[] = [];
  let projectCwd: string;
  let ctx: ExtensionContext;

  beforeEach(() => {
    projectCwd = mkdtempSync(join(tmpdir(), "pi-acp-conv-"));
    ctx = {
      cwd: projectCwd,
      sessionManager: {
        getSessionId: () => "root-session",
        getSessionFile: () => undefined,
      },
    } as unknown as ExtensionContext;
  });

  afterEach(async () => {
    await Promise.all(managers.map(manager => manager.dispose()));
    managers.length = 0;
    rmSync(projectCwd, { recursive: true, force: true });
  });

  it("keeps a stable conversation handle while each prompt gets an immutable attempt", async () => {
    const completed = vi.fn();
    const manager = new AgentManager(completed, 10);
    managers.push(manager);
    const runs = [deferred<AcpTurnResult>(), deferred<AcpTurnResult>()];
    let runIndex = 0;
    const runtime: AcpRuntime = {
      info: {
        capabilities: { sessionCapabilities: { resume: {} } },
        sessionId: "session-1",
        resumeMode: "none",
      },
      isClosed: false,
      run: vi.fn(() => runs[runIndex++].promise),
      close: vi.fn(async () => {}),
    };
    const conversations = new AcpConversationManager(
      manager,
      ctx,
      () => [approval],
      () => false,
      async () => runtime,
    );

    const first = conversations.start({
      registryId: approval.registryId,
      prompt: "first",
      description: "First attempt",
    });
    await manager.awaitStartup(first.record.id);
    expect(first.record.status).toBe("running");

    const second = conversations.continue({
      ref: first.conversation.handle,
      prompt: "second",
      description: "Second attempt",
    });
    expect(second.conversation.id).toBe(first.conversation.id);
    expect(second.record.id).not.toBe(first.record.id);
    expect(second.record.status).toBe("queued");

    runs[0].resolve(turn("one"));
    await first.record.promise;
    await vi.waitFor(() => expect(second.record.status).toBe("running"));
    runs[1].resolve(turn("two"));
    await manager.waitForAll();

    expect(first.record).toMatchObject({ status: "completed", result: "one" });
    expect(second.record).toMatchObject({ status: "completed", result: "two" });
    expect(completed).toHaveBeenCalledTimes(2);
    expect(conversations.resolveAttempt(first.record.id)).toBe(first.record);
    expect(conversations.resolveAttempt(first.conversation.handle)).toBe(second.record);
  });

  it("treats an empty end_turn as an error instead of a completed no-output attempt", async () => {
    const manager = new AgentManager(undefined, 10);
    managers.push(manager);
    const runtime: AcpRuntime = {
      info: {
        capabilities: { sessionCapabilities: { resume: {} } },
        sessionId: "session-empty",
        resumeMode: "none",
      },
      isClosed: false,
      run: vi.fn(async () => turn("")),
      close: vi.fn(async () => {}),
    };
    const conversations = new AcpConversationManager(
      manager,
      ctx,
      () => [approval],
      () => false,
      async () => runtime,
    );

    const attempt = conversations.start({
      registryId: approval.registryId,
      prompt: "return something",
      description: "Empty attempt",
    });
    await manager.awaitStartup(attempt.record.id);
    await attempt.record.promise;
    expect(attempt.record).toMatchObject({
      status: "error",
      result: "",
      error: "ACP agent ended without producing output.",
    });
  });

  it("releases the conversation slot when runtime startup fails", async () => {
    const manager = new AgentManager(undefined, 10);
    managers.push(manager);
    const secondRun = deferred<AcpTurnResult>();
    const runtime: AcpRuntime = {
      info: {
        capabilities: { sessionCapabilities: { resume: {} } },
        sessionId: "session-2",
        resumeMode: "none",
      },
      isClosed: false,
      run: vi.fn(() => secondRun.promise),
      close: vi.fn(async () => {}),
    };
    const startRuntime = vi.fn()
      .mockRejectedValueOnce(new Error("ACP startup failed during session/new: Authentication required"))
      .mockResolvedValueOnce(runtime);
    const conversations = new AcpConversationManager(
      manager,
      ctx,
      () => [approval],
      () => false,
      startRuntime,
    );

    const first = conversations.start({
      registryId: approval.registryId,
      prompt: "first",
      description: "First attempt",
    });
    await expect(manager.awaitStartup(first.record.id)).rejects.toThrow("Authentication required");
    await first.record.promise;
    expect(first.conversation.activeAttemptId).toBeUndefined();

    const second = conversations.continue({
      ref: first.conversation.handle,
      prompt: "second",
      description: "Second attempt",
    });
    await manager.awaitStartup(second.record.id);
    expect(second.record.status).toBe("running");
    secondRun.resolve(turn("recovered"));
    await second.record.promise;
    expect(second.record).toMatchObject({ status: "completed", result: "recovered" });
  });

  it("occupies the conversation slot before returning so a same-tick follow-up queues", async () => {
    const manager = new AgentManager(undefined, 10);
    managers.push(manager);
    const firstRun = deferred<AcpTurnResult>();
    const secondRun = deferred<AcpTurnResult>();
    let runIndex = 0;
    const runtime: AcpRuntime = {
      info: {
        capabilities: { sessionCapabilities: { resume: {} } },
        sessionId: "session-1",
        resumeMode: "none",
      },
      isClosed: false,
      run: vi.fn(() => (runIndex++ === 0 ? firstRun.promise : secondRun.promise)),
      close: vi.fn(async () => {}),
    };
    const conversations = new AcpConversationManager(
      manager,
      ctx,
      () => [approval],
      () => false,
      async () => runtime,
    );

    const first = conversations.start({
      registryId: approval.registryId,
      prompt: "first",
      description: "First attempt",
    });
    expect(first.record.status).toBe("running");
    const second = conversations.continue({
      ref: first.conversation.handle,
      prompt: "second",
      description: "Second attempt",
    });
    expect(second.record.status).toBe("queued");
    expect(second.record.id).not.toBe(first.record.id);

    firstRun.resolve(turn("one"));
    await first.record.promise;
    await vi.waitFor(() => expect(second.record.status).toBe("running"));
    secondRun.resolve(turn("two"));
    await manager.waitForAll();
    expect(runtime.run).toHaveBeenCalledTimes(2);
  });

  it("starts a second conversation for the same agent instead of reusing the first", async () => {
    const manager = new AgentManager(undefined, 10);
    managers.push(manager);
    manager.reserveExternalHandle(approval.handle);
    const runtime: AcpRuntime = {
      info: {
        capabilities: { sessionCapabilities: { resume: {} } },
        sessionId: "session-1",
        resumeMode: "none",
      },
      isClosed: false,
      run: vi.fn(async prompt => turn(prompt)),
      close: vi.fn(async () => {}),
    };
    const conversations = new AcpConversationManager(
      manager,
      ctx,
      () => [approval],
      () => false,
      async () => runtime,
    );
    const first = conversations.start({
      registryId: approval.registryId,
      prompt: "first",
      description: "First",
    });
    const second = conversations.start({
      registryId: approval.registryId,
      prompt: "second",
      description: "Second",
    });
    expect(second.conversation.id).not.toBe(first.conversation.id);
    expect(first.conversation.handle).toBe("acp-fixture");
    expect(second.conversation.handle).toBe("acp-fixture-2");
    await manager.waitForAll();
  });

  it("restores a persisted conversation only for its owning Pi session", async () => {
    const firstManager = new AgentManager(undefined, 10);
    managers.push(firstManager);
    firstManager.reserveExternalHandle(approval.handle);
    const persisted: PersistedAcpConversation[] = [];
    const firstRuntime: AcpRuntime = {
      info: {
        capabilities: { sessionCapabilities: { resume: {} } },
        sessionId: "session-persisted",
        resumeMode: "none",
      },
      isClosed: false,
      run: async prompt => turn(prompt),
      close: async () => {},
    };
    const first = new AcpConversationManager(
      firstManager,
      ctx,
      () => [approval],
      () => false,
      async () => firstRuntime,
      ref => persisted.push(ref),
    );
    first.start({ registryId: approval.registryId, prompt: "one", description: "One" });
    await firstManager.waitForAll();
    expect(persisted.at(-1)).toMatchObject({
      rootSessionId: "root-session",
      sessionId: "session-persisted",
      resumeMode: "resume",
    });

    const restoredManager = new AgentManager(undefined, 10);
    managers.push(restoredManager);
    restoredManager.reserveExternalHandle(approval.handle);
    const startRuntime = vi.fn(async options => ({
      ...firstRuntime,
      info: { ...firstRuntime.info, sessionId: options.resume?.sessionId ?? "new" },
    }));
    const restored = new AcpConversationManager(
      restoredManager,
      ctx,
      () => [approval],
      () => false,
      startRuntime,
    );
    restored.restore([{ ...persisted.at(-1)!, displayName: "Stale persisted name" }]);
    expect(restored.resolve(approval.handle)?.displayName).toBe(approval.displayName);
    const resumed = restored.continue({ ref: approval.handle, prompt: "two", description: "Two" });
    await restoredManager.waitForAll();
    expect(resumed.record.result).toBe("two");
    expect(startRuntime).toHaveBeenCalledWith(expect.objectContaining({
      resume: { sessionId: "session-persisted", mode: "resume" },
    }));

    const foreignCtx = {
      cwd: projectCwd,
      sessionManager: { getSessionId: () => "other-session", getSessionFile: () => undefined },
    } as unknown as ExtensionContext;
    const foreign = new AcpConversationManager(
      restoredManager,
      foreignCtx,
      () => [approval],
      () => false,
      startRuntime,
    );
    foreign.restore([persisted.at(-1)!]);
    expect(foreign.resolve(approval.handle)).toBeUndefined();
  });

  it("fails queued attempts when their approval is disabled before start", async () => {
    const completed = vi.fn();
    const manager = new AgentManager(completed, 10);
    managers.push(manager);
    let enabled = true;
    const firstRun = deferred<AcpTurnResult>();
    const runtime: AcpRuntime = {
      info: { capabilities: {}, sessionId: "session-1", resumeMode: "none" },
      isClosed: false,
      run: vi.fn(() => firstRun.promise),
      close: async () => {},
    };
    const conversations = new AcpConversationManager(
      manager,
      ctx,
      () => enabled ? [approval] : [],
      () => false,
      async () => runtime,
    );
    const first = conversations.start({ registryId: approval.registryId, prompt: "one", description: "One" });
    await manager.awaitStartup(first.record.id);
    const second = conversations.continue({ ref: first.conversation.handle, prompt: "two", description: "Two" });
    expect(second.record.status).toBe("queued");

    enabled = false;
    conversations.reconcileApprovals();
    expect(second.record).toMatchObject({ status: "error", error: expect.stringContaining("disabled or removed") });
    firstRun.resolve(turn("one"));
    await first.record.promise;
    expect(runtime.run).toHaveBeenCalledTimes(1);
  });

  it("rejects a relative or missing explicit cwd before spawning", () => {
    const manager = new AgentManager(undefined, 10);
    managers.push(manager);
    const startRuntime = vi.fn();
    const conversations = new AcpConversationManager(
      manager,
      ctx,
      () => [approval],
      () => false,
      startRuntime,
    );

    expect(() => conversations.start({
      registryId: approval.registryId,
      prompt: "one",
      description: "One",
      cwd: "relative/path",
    })).toThrow(/absolute existing directory/);
    expect(() => conversations.start({
      registryId: approval.registryId,
      prompt: "one",
      description: "One",
      cwd: "/path/that/does/not/exist",
    })).toThrow(/not an existing directory/);
    expect(() => new AcpConversationManager(
      manager,
      { ...ctx, cwd: join(projectCwd, "gone") } as ExtensionContext,
      () => [approval],
      () => false,
      startRuntime,
    ).start({
      registryId: approval.registryId,
      prompt: "one",
      description: "One",
    })).toThrow(/not an existing directory/);
    expect(startRuntime).not.toHaveBeenCalled();
  });

  it("skips restore when the persisted cwd is missing", () => {
    const manager = new AgentManager(undefined, 10);
    managers.push(manager);
    manager.reserveExternalHandle(approval.handle);
    const conversations = new AcpConversationManager(manager, ctx, () => [approval], () => false);
    conversations.restore([{
      rootSessionId: "root-session",
      conversationId: "acp-conv-missing-cwd",
      handle: approval.handle,
      registryId: approval.registryId,
      displayName: approval.displayName,
      cwd: join(projectCwd, "missing-restore"),
      sessionId: "session-old",
      resumeMode: "resume",
    }]);
    expect(conversations.resolve(approval.handle)).toBeUndefined();
  });

  it("preserves a non-resumable conversation as an explicit unavailable target", () => {
    const manager = new AgentManager(undefined, 10);
    managers.push(manager);
    manager.reserveExternalHandle(approval.handle);
    const conversations = new AcpConversationManager(manager, ctx, () => [approval], () => false);
    conversations.restore([{
      rootSessionId: "root-session",
      conversationId: "acp-conv-unavailable",
      handle: approval.handle,
      registryId: approval.registryId,
      displayName: approval.displayName,
      cwd: projectCwd,
      sessionId: "session-old",
      resumeMode: "none",
    }]);
    expect(conversations.resolve(approval.handle)?.unavailableReason).toContain("cannot be restored");
    expect(() => conversations.continue({ ref: approval.handle, prompt: "again", description: "Again" }))
      .toThrow(/cannot be restored/);
  });

  it("rejects malformed persisted handles", () => {
    const manager = new AgentManager(undefined, 10);
    managers.push(manager);
    const conversations = new AcpConversationManager(manager, ctx, () => [approval], () => false);
    conversations.restore([{
      rootSessionId: "root-session",
      conversationId: "acp-conv-forged",
      handle: "explorer",
      registryId: approval.registryId,
      displayName: approval.displayName,
      cwd: projectCwd,
      sessionId: "session-old",
      resumeMode: "resume",
    }]);
    expect(conversations.resolve("explorer")).toBeUndefined();

    conversations.restore([{
      rootSessionId: "root-session",
      conversationId: "acp-conv-bad-mode",
      handle: approval.handle,
      registryId: approval.registryId,
      displayName: "Forged",
      cwd: projectCwd,
      sessionId: "session-old",
      resumeMode: "bogus" as PersistedAcpConversation["resumeMode"],
    }]);
    expect(conversations.resolve("acp-conv-bad-mode")).toBeUndefined();
  });

  it("maps unsolicited ACP cancellation to error", async () => {
    const manager = new AgentManager(undefined, 10);
    managers.push(manager);
    const runtime: AcpRuntime = {
      info: { capabilities: {}, sessionId: "session-1", resumeMode: "none" },
      isClosed: false,
      run: async () => ({ text: "partial", stopReason: "cancelled", response: { stopReason: "cancelled" } }),
      close: async () => {},
    };
    const conversations = new AcpConversationManager(manager, ctx, () => [approval], () => false, async () => runtime);
    const attempt = conversations.start({ registryId: approval.registryId, prompt: "one", description: "One" });
    await manager.waitForAll();
    expect(attempt.record).toMatchObject({ status: "error", result: "partial", error: "ACP turn stopped: cancelled" });
  });

  it("allocates numbered handles for parallel conversations of one registry agent", async () => {
    const manager = new AgentManager(undefined, 10);
    managers.push(manager);
    const runtime = (): AcpRuntime => ({
      info: { capabilities: {}, sessionId: crypto.randomUUID(), resumeMode: "none" },
      isClosed: false,
      run: async prompt => turn(prompt),
      close: async () => {},
    });
    const conversations = new AcpConversationManager(
      manager,
      ctx,
      () => [approval],
      () => false,
      async () => runtime(),
    );
    const first = conversations.start({ registryId: approval.registryId, prompt: "one", description: "One" });
    const second = conversations.start({ registryId: approval.registryId, prompt: "two", description: "Two" });
    expect(first.conversation.handle).toBe("acp-fixture");
    expect(second.conversation.handle).toBe("acp-fixture-2");
    await manager.waitForAll();
  });

  it("disconnects an idle runtime after the timeout but keeps the conversation", async () => {
    const manager = new AgentManager(undefined, 10);
    managers.push(manager);
    const clock = { now: 1_000 };
    let closed = false;
    const runtime: AcpRuntime = {
      info: {
        capabilities: { sessionCapabilities: { resume: {} } },
        sessionId: "session-idle",
        resumeMode: "none",
      },
      get isClosed() { return closed; },
      prompting: false,
      run: vi.fn(async prompt => turn(prompt)),
      close: vi.fn(async () => { closed = true; }),
    };
    const conversations = new AcpConversationManager(
      manager,
      ctx,
      () => [approval],
      () => false,
      async () => runtime,
      () => {},
      () => clock.now,
      1_000,
    );
    const first = conversations.start({
      registryId: approval.registryId,
      prompt: "one",
      description: "One",
    });
    await manager.waitForAll();
    expect(runtime.close).not.toHaveBeenCalled();
    clock.now += 1_000;
    expect(await conversations.sweepIdle()).toBe(1);
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(conversations.resolve(first.conversation.handle)?.runtime).toBeUndefined();
    expect(conversations.resolve(first.conversation.handle)?.id).toBe(first.conversation.id);
    await conversations.closeAll();
  });

  it("does not sweep a conversation that is still prompting", async () => {
    const manager = new AgentManager(undefined, 10);
    managers.push(manager);
    const clock = { now: 1_000 };
    const run = deferred<AcpTurnResult>();
    const runtime: AcpRuntime = {
      info: { capabilities: {}, sessionId: "session-prompting", resumeMode: "none" },
      isClosed: false,
      prompting: true,
      run: vi.fn(() => run.promise),
      close: vi.fn(async () => {}),
    };
    const conversations = new AcpConversationManager(
      manager,
      ctx,
      () => [approval],
      () => false,
      async () => runtime,
      () => {},
      () => clock.now,
      1_000,
    );
    const first = conversations.start({
      registryId: approval.registryId,
      prompt: "one",
      description: "One",
    });
    await manager.awaitStartup(first.record.id);
    clock.now += 10_000;
    expect(await conversations.sweepIdle()).toBe(0);
    expect(runtime.close).not.toHaveBeenCalled();
    run.resolve(turn("done"));
    await manager.waitForAll();
    await conversations.closeAll();
  });
});
