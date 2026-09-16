import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.js";
import { handleBase } from "../mention.js";
import type { AgentRecord } from "../types.js";
import type { ApprovedAcpAgent } from "./registry.js";
import { type AcpRuntimeStartOptions, AcpSessionRuntime, type AcpTurnHooks, type AcpTurnResult } from "./runtime.js";

function isAcpHandle(value: string): boolean {
  return /^acp-[a-z0-9_-]{1,60}$/.test(value);
}

export interface AcpRuntime {
  readonly info: AcpSessionRuntime["info"];
  readonly isClosed: boolean;
  readonly prompting?: boolean;
  run(prompt: string, hooks?: AcpTurnHooks, signal?: AbortSignal): Promise<AcpTurnResult>;
  close(): Promise<void>;
}

/** Codeg-compatible idle disconnect: 3 minutes, 0 disables. */
export const ACP_IDLE_TIMEOUT_MS = idleTimeoutMs();
export const ACP_IDLE_SWEEP_MS = 60_000;

function idleTimeoutMs(): number {
  const raw = process.env.PI_SUBAGENTS_ACP_IDLE_TIMEOUT_SECS;
  if (raw === "0") return 0;
  const seconds = raw === undefined ? 180 : Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 180_000;
}

export interface AcpAttemptHooks {
  onActivity?: (activity: string) => void;
  onText?: (fullText: string) => void;
  onStarted?: (record: AgentRecord) => void;
  onQueued?: (record: AgentRecord, ahead: number) => void;
}

export interface AcpStartInput {
  registryId: string;
  prompt: string;
  description: string;
  cwd?: string;
}

export interface AcpContinueInput {
  ref: string;
  prompt: string;
  description: string;
}

export interface PersistedAcpConversation {
  rootSessionId: string;
  conversationId: string;
  handle: string;
  registryId: string;
  displayName: string;
  cwd: string;
  sessionId: string;
  resumeMode: "resume" | "load" | "none";
  latestAttemptId?: string;
  completedAt?: number;
}

export interface AcpConversation {
  id: string;
  handle: string;
  registryId: string;
  displayName: string;
  cwd: string;
  rootSessionId: string;
  sessionId?: string;
  resumeMode: "resume" | "load" | "none";
  runtime?: AcpRuntime;
  activeAttemptId?: string;
  latestAttemptId?: string;
  closed: boolean;
  unavailableReason?: string;
  lastActivityAt: number;
}

export class AcpConversationManager {
  private conversations = new Map<string, AcpConversation>();

  constructor(
    private readonly manager: AgentManager,
    private readonly ctx: ExtensionContext,
    private readonly approvals: () => ApprovedAcpAgent[],
    private readonly resultBodyEnabled: () => boolean,
    private readonly startRuntime: (options: AcpRuntimeStartOptions) => Promise<AcpRuntime> = AcpSessionRuntime.start,
    private readonly persist: (ref: PersistedAcpConversation) => void = () => {},
    private readonly now: () => number = Date.now,
    private readonly idleTimeoutMs: number = 0,
  ) {
    if (this.idleTimeoutMs > 0) {
      this.sweepTimer = setInterval(() => { void this.sweepIdle(); }, ACP_IDLE_SWEEP_MS);
      this.sweepTimer.unref?.();
    }
  }

  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  list(): AcpConversation[] {
    return [...this.conversations.values()];
  }

  restore(refs: readonly PersistedAcpConversation[]): void {
    for (const ref of refs) {
      if (
        ref.rootSessionId !== this.ctx.sessionManager.getSessionId()
        || typeof ref.conversationId !== "string"
        || !ref.conversationId.startsWith("acp-conv-")
        || !isAcpHandle(ref.handle)
        || !isAbsolute(ref.cwd)
        || typeof ref.sessionId !== "string"
        || !ref.sessionId
        || !["resume", "load", "none"].includes(ref.resumeMode)
      ) continue;
      const approval = this.approvals().find(agent => agent.enabled && agent.registryId === ref.registryId);
      if (!approval || this.conversations.has(ref.conversationId)) continue;
      if (ref.handle !== approval.handle && !this.manager.reserveExternalHandle(ref.handle)) continue;
      this.conversations.set(ref.conversationId, {
        id: ref.conversationId,
        handle: ref.handle,
        registryId: ref.registryId,
        displayName: approval.displayName,
        cwd: ref.cwd,
        rootSessionId: ref.rootSessionId,
        sessionId: ref.sessionId,
        resumeMode: ref.resumeMode,
        latestAttemptId: ref.latestAttemptId,
        closed: false,
        lastActivityAt: this.now(),
        ...(ref.resumeMode === "none"
          ? { unavailableReason: `ACP conversation @${ref.handle} cannot be restored because the agent supports neither session/resume nor session/load.` }
          : {}),
      });
    }
  }

  resolve(ref: string): AcpConversation | undefined {
    const wanted = ref.toLowerCase();
    for (const conversation of this.conversations.values()) {
      if (
        conversation.id === ref
        || conversation.handle.toLowerCase() === wanted
      ) return conversation;
    }
    const record = this.manager.getRecord(ref);
    return record?.conversationId ? this.conversations.get(record.conversationId) : undefined;
  }

  resolveAttempt(ref: string): AgentRecord | undefined {
    const direct = this.manager.getRecord(ref);
    if (direct?.runtime === "acp") return direct;
    const conversation = this.resolve(ref);
    if (!conversation) return undefined;
    const records = this.manager.listAgents()
      .filter(record => record.runtime === "acp" && record.conversationId === conversation.id);
    return records.find(record => record.status === "running")
      ?? records.filter(record => record.status === "queued").sort((left, right) => left.startedAt - right.startedAt)[0]
      ?? records.sort((left, right) => right.startedAt - left.startedAt)[0];
  }

  reconcileApprovals(): void {
    const enabled = new Set(this.approvals().filter(agent => agent.enabled).map(agent => agent.registryId));
    for (const record of this.manager.listAgents()) {
      if (record.runtime !== "acp" || record.status !== "queued" || !record.conversationId) continue;
      const conversation = this.conversations.get(record.conversationId);
      if (conversation && !enabled.has(conversation.registryId)) {
        this.manager.failQueuedExternal(record.id, `ACP approval disabled or removed: ${conversation.registryId}`);
      }
    }
    this.manager.notifyExternalReady();
  }

  start(input: AcpStartInput, hooks: AcpAttemptHooks = {}): { conversation: AcpConversation; record: AgentRecord } {
    const approval = this.approval(input.registryId);
    if (input.cwd !== undefined) {
      if (!isAbsolute(input.cwd)) throw new Error("ACP `cwd` must be an absolute existing directory.");
      try {
        if (!statSync(input.cwd).isDirectory()) throw new Error();
      } catch {
        throw new Error(`ACP cwd is not an existing directory: "${input.cwd}".`);
      }
    }
    const baseInUse = [...this.conversations.values()].some(conversation => conversation.handle === approval.handle);
    let handle: string;
    if (baseInUse) {
      handle = this.allocateHandle(approval.handle);
    } else if (this.manager.hasExternalHandle(approval.handle)) {
      handle = approval.handle;
    } else if (this.manager.reserveExternalHandle(approval.handle)) {
      handle = approval.handle;
    } else {
      handle = this.allocateHandle(approval.handle);
    }
    const conversation: AcpConversation = {
      id: `acp-conv-${randomUUID()}`,
      handle,
      registryId: approval.registryId,
      displayName: approval.displayName,
      cwd: input.cwd ?? this.ctx.cwd,
      rootSessionId: this.ctx.sessionManager.getSessionId(),
      resumeMode: "none",
      closed: false,
      lastActivityAt: this.now(),
    };
    this.conversations.set(conversation.id, conversation);
    try {
      const record = this.createAttempt(conversation, input.prompt, input.description, hooks);
      return { conversation, record };
    } catch (error) {
      this.releaseConversation(conversation);
      throw error;
    }
  }

  continue(input: AcpContinueInput, hooks: AcpAttemptHooks = {}): { conversation: AcpConversation; record: AgentRecord } {
    const conversation = this.resolve(input.ref);
    if (!conversation || conversation.closed) throw new Error(`ACP conversation not found: "${input.ref}".`);
    if (conversation.unavailableReason) throw new Error(conversation.unavailableReason);
    this.approval(conversation.registryId);
    return {
      conversation,
      record: this.createAttempt(conversation, input.prompt, input.description, hooks),
    };
  }

  async sweepIdle(): Promise<number> {
    if (this.idleTimeoutMs <= 0) return 0;
    const now = this.now();
    const victims = [...this.conversations.values()].filter(conversation => {
      if (conversation.closed || !conversation.runtime || conversation.runtime.isClosed) return false;
      if (conversation.activeAttemptId || conversation.runtime.prompting) return false;
      if (this.manager.listAgents().some(record =>
        record.runtime === "acp"
        && record.conversationId === conversation.id
        && (record.status === "running" || record.status === "queued")
      )) return false;
      return now - conversation.lastActivityAt >= this.idleTimeoutMs;
    });
    await Promise.all(victims.map(async conversation => {
      const runtime = conversation.runtime;
      conversation.runtime = undefined;
      await runtime?.close();
    }));
    return victims.length;
  }

  async closeAll(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    const conversations = [...this.conversations.values()];
    const attempts = this.manager.listAgents().filter(record => record.runtime === "acp");
    for (const record of attempts) {
      if (record.status === "running" || record.status === "queued") this.manager.abort(record.id);
    }
    await Promise.all(conversations.map(async conversation => {
      conversation.closed = true;
      await conversation.runtime?.close();
      if (conversation.handle !== this.approvalHandle(conversation.registryId)) {
        this.manager.releaseExternalHandle(conversation.handle);
      }
    }));
    const runs = attempts.map(record => record.promise).filter((run): run is Promise<string> => run !== undefined);
    await Promise.race([
      Promise.allSettled(runs),
      new Promise<void>(resolve => setTimeout(resolve, 3_000)),
    ]);
    this.conversations.clear();
  }

  private createAttempt(
    conversation: AcpConversation,
    prompt: string,
    description: string,
    hooks: AcpAttemptHooks,
  ): AgentRecord {
    let attemptId = "";
    attemptId = this.manager.spawnExternal(
      this.ctx,
      {
        type: `ACP/${conversation.registryId}`,
        description,
        conversationId: conversation.id,
        conversationHandle: conversation.handle,
        registryId: conversation.registryId,
        rootSessionId: conversation.rootSessionId,
        resultBodyEnabled: this.resultBodyEnabled(),
        canStart: () => conversation.activeAttemptId === undefined
          && !conversation.closed
          && !conversation.unavailableReason
          && this.isApproved(conversation.registryId),
        onStarted: record => {
          conversation.activeAttemptId = record.id;
          conversation.latestAttemptId = record.id;
          conversation.lastActivityAt = this.now();
          hooks.onStarted?.(record);
        },
        onQueued: (id, ahead) => {
          conversation.lastActivityAt = this.now();
          const record = this.manager.getRecord(id);
          if (record) hooks.onQueued?.(record, ahead);
        },
      },
      (record, signal) => {
        const startup = this.ensureRuntime(conversation, signal);
        const result = (async () => {
          try {
            const runtime = await startup;
            const seenTools = new Set<string>();
            const turn = await runtime.run(prompt, {
              onText: (_delta, fullText) => {
                record.result = fullText;
                conversation.lastActivityAt = this.now();
                hooks.onText?.(fullText);
              },
              onActivity: activity => {
                conversation.lastActivityAt = this.now();
                hooks.onActivity?.(activity);
              },
              onToolCall: (toolCallId, title) => {
                conversation.lastActivityAt = this.now();
                if (!seenTools.has(toolCallId)) {
                  seenTools.add(toolCallId);
                  record.toolUses++;
                }
                hooks.onActivity?.(title);
              },
              onUsage: usage => {
                conversation.lastActivityAt = this.now();
                record.acpUsage = usage;
              },
            }, signal);
            const emptyEndTurn = turn.stopReason === "end_turn"
              && !turn.text.trim()
              && turn.hadAgentOutput !== true;
            const status = turn.stopReason === "end_turn" && !emptyEndTurn
              ? "completed" as const
              : turn.stopReason === "cancelled" && signal.aborted
                ? "stopped" as const
                : "error" as const;
            return {
              text: turn.text,
              status,
              ...(status === "error"
                ? { error: emptyEndTurn ? "ACP agent ended without producing output." : `ACP turn stopped: ${turn.stopReason}` }
                : {}),
            };
          } finally {
            if (conversation.activeAttemptId === record.id) conversation.activeAttemptId = undefined;
            conversation.latestAttemptId = record.id;
            conversation.lastActivityAt = this.now();
            this.persistConversation(conversation);
            this.manager.notifyExternalReady();
          }
        })();
        return { startup: startup.then(() => undefined), result };
      },
    );
    const record = this.manager.getRecord(attemptId);
    if (!record) throw new Error("ACP attempt record was not created.");
    return record;
  }

  private async ensureRuntime(conversation: AcpConversation, signal: AbortSignal): Promise<AcpRuntime> {
    const approval = this.approval(conversation.registryId);
    if (conversation.runtime && !conversation.runtime.isClosed) return conversation.runtime;
    if (conversation.sessionId && conversation.resumeMode === "none") {
      throw new Error(`ACP conversation @${conversation.handle} cannot be restored because the agent supports neither session/resume nor session/load.`);
    }
    const runtime = await this.startRuntime({
      approval,
      cwd: conversation.cwd,
      ...(conversation.sessionId && conversation.resumeMode !== "none"
        ? { resume: { sessionId: conversation.sessionId, mode: conversation.resumeMode } }
        : {}),
      signal,
    });
    conversation.runtime = runtime;
    conversation.sessionId = runtime.info.sessionId;
    conversation.resumeMode = runtime.info.capabilities.sessionCapabilities?.resume
      ? "resume"
      : runtime.info.capabilities.loadSession
        ? "load"
        : "none";
    this.persistConversation(conversation);
    return runtime;
  }

  private isApproved(registryId: string): boolean {
    return this.approvals().some(agent => agent.enabled && agent.registryId === registryId);
  }

  private approval(registryId: string): ApprovedAcpAgent {
    const approval = this.approvals().find(agent => agent.enabled && agent.registryId === registryId);
    if (!approval) throw new Error(`ACP agent is not approved or enabled: "${registryId}".`);
    return approval;
  }

  private persistConversation(conversation: AcpConversation): void {
    if (!conversation.sessionId) return;
    this.persist({
      rootSessionId: conversation.rootSessionId,
      conversationId: conversation.id,
      handle: conversation.handle,
      registryId: conversation.registryId,
      displayName: conversation.displayName,
      cwd: conversation.cwd,
      sessionId: conversation.sessionId,
      resumeMode: conversation.resumeMode,
      latestAttemptId: conversation.latestAttemptId,
      completedAt: Date.now(),
    });
  }

  private approvalHandle(registryId: string): string | undefined {
    return this.approvals().find(agent => agent.registryId === registryId)?.handle;
  }

  private allocateHandle(base: string): string {
    let candidate = handleBase(base);
    let index = 1;
    while (!this.manager.reserveExternalHandle(candidate)) {
      index++;
      candidate = `${handleBase(base)}-${index}`;
    }
    return candidate;
  }

  private releaseConversation(conversation: AcpConversation): void {
    this.conversations.delete(conversation.id);
    if (conversation.handle !== this.approvalHandle(conversation.registryId)) {
      this.manager.releaseExternalHandle(conversation.handle);
    }
  }
}
