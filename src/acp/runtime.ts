import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  type AgentCapabilities,
  type AuthMethod,
  type ClientConnection,
  type ClientContext,
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
  type StopReason,
} from "@agentclientprotocol/sdk";
import { prepareKimiCodeAuth } from "./kimi-auth.js";
import { applyAdapterLaunchEnv, launchArgsFor } from "./launch-policy.js";
import type { ApprovedAcpAgent } from "./registry.js";
import { emptyTurnError } from "./turn-diagnostics.js";

const STDERR_LIMIT = 64 * 1024;
const OUTPUT_LIMIT = 256 * 1024;
const OUTPUT_TRUNCATED_MARKER = "\n\n[ACP output truncated at 256 KiB]";
const PROCESS_STOP_GRACE_MS = 1_500;
const STARTUP_TIMEOUT_MS = 120_000;

export interface AcpRuntimeStartOptions {
  approval: ApprovedAcpAgent;
  cwd: string;
  resume?: { sessionId: string; mode: "resume" | "load" };
  signal?: AbortSignal;
}

export interface AcpTurnHooks {
  onText?: (delta: string, fullText: string) => void;
  onActivity?: (activity: string) => void;
  onToolCall?: (toolCallId: string, title: string, status?: string | null) => void;
  onUsage?: (usage: { used: number; size: number; cost?: { amount: number; currency: string } }) => void;
}

export interface AcpTurnResult {
  text: string;
  stopReason: StopReason;
  response: PromptResponse;
  hadAgentOutput?: boolean;
}

export interface AcpRuntimeInfo {
  agentName?: string;
  agentVersion?: string;
  authMethods?: readonly AuthMethod[];
  capabilities: AgentCapabilities;
  sessionId: string;
  resumeMode: "resume" | "load" | "none";
}

function appendBounded(current: string, chunk: string, limit = STDERR_LIMIT): string {
  const next = current + chunk;
  return next.length <= limit ? next : next.slice(next.length - limit);
}

function nativeSettingsPath(registryId: string, env: NodeJS.ProcessEnv): string | undefined {
  if (registryId === "claude-acp") {
    return join(env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "settings.json");
  }
  if (registryId === "gemini") {
    return join(env.GEMINI_CLI_HOME?.trim() || homedir(), ".gemini", "settings.json");
  }
  if (registryId === "qwen-code") {
    return join(env.QWEN_HOME?.trim() || join(homedir(), ".qwen"), "settings.json");
  }
  return undefined;
}

function launchEnvironment(approval: ApprovedAcpAgent): NodeJS.ProcessEnv {
  const env = { ...process.env, ...approval.staticEnv };
  const settingsPath = nativeSettingsPath(approval.registryId, env);
  let merged = env;
  if (settingsPath) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { env?: Record<string, unknown> };
      const configured = Object.fromEntries(
        Object.entries(settings.env ?? {}).flatMap(([key, value]) =>
          typeof value === "string" && value.trim() ? [[key, value.trim()]] : []),
      );
      merged = { ...process.env, ...configured, ...approval.staticEnv };
    } catch {
      merged = env;
    }
  }
  return applyAdapterLaunchEnv(merged, approval);
}

function authMethodsHint(authMethods: readonly AuthMethod[]): string {
  if (authMethods.length === 0) return "";
  const labels = authMethods.map(method =>
    `${method.name} (${method.id}${"type" in method && method.type === "terminal" ? ", terminal" : ""})`);
  return `\nAdvertised authentication methods: ${labels.join(", ")}.`;
}

function permissionResponse(params: RequestPermissionRequest): RequestPermissionResponse {
  const selected = params.options.find(option => option.kind === "allow_always")
    ?? params.options.find(option => option.kind === "allow_once");
  if (!selected) throw new Error(`ACP permission request "${params.toolCall.title}" offered no allow option.`);
  return { outcome: { outcome: "selected", optionId: selected.optionId } };
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>(resolve => {
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
    return;
  }

  try { process.kill(-pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* ignore */ } }
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([
      new Promise<void>(resolve => child.once("exit", () => resolve())),
      new Promise<void>(resolve => setTimeout(resolve, PROCESS_STOP_GRACE_MS)),
    ]);
  }
  // The process group may still contain descendants after its original leader
  // exited, so always attempt the group kill instead of keying only on child.exitCode.
  try { process.kill(-pid, "SIGKILL"); } catch {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
  }
}

export class AcpSessionRuntime {
  readonly info: AcpRuntimeInfo;
  private activeHooks: AcpTurnHooks | undefined;
  private responseText = "";
  private responseBytes = 0;
  private outputTruncated = false;
  private sawAgentOutput = false;
  private closed = false;
  private currentPromptAbort: AbortController | undefined;
  private stderrText = "";

  get prompting(): boolean {
    return this.currentPromptAbort !== undefined;
  }

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly connection: ClientConnection,
    private readonly context: ClientContext,
    private readonly registryId: string,
    private readonly diagnosticEnv: NodeJS.ProcessEnv,
    info: AcpRuntimeInfo,
  ) {
    this.info = info;
  }

  static async start(options: AcpRuntimeStartOptions): Promise<AcpSessionRuntime> {
    const env = launchEnvironment(options.approval);
    if (options.approval.registryId === "kimi-code") prepareKimiCodeAuth(env);
    const args = launchArgsFor(options.approval, env);
    const prefixIndex = args.indexOf("--prefix");
    const prefix = prefixIndex >= 0 ? args[prefixIndex + 1] : undefined;
    if (
      (options.approval.command === "npx" || options.approval.command === "npx.cmd")
      && prefix
    ) mkdirSync(prefix, { recursive: true, mode: 0o700 });
    const child = spawn(options.approval.command, args, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    let runtime: AcpSessionRuntime | undefined;
    let earlyStderr = "";
    let rejectProcessError!: (error: Error) => void;
    const processError = new Promise<never>((_resolve, reject) => {
      rejectProcessError = reject;
    });
    const onProcessError = (error: Error) => rejectProcessError(error);
    child.once("error", onProcessError);
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", chunk => {
      const text = String(chunk);
      if (runtime) runtime.stderrText = appendBounded(runtime.stderrText, text);
      else earlyStderr = appendBounded(earlyStderr, text);
    });

    const app = client({ name: "pi-subagents" })
      .onRequest(methods.client.session.requestPermission, ({ params }) => permissionResponse(params))
      .onNotification(methods.client.session.update, ({ params }) => runtime?.handleNotification(params));

    const output = Writable.toWeb(child.stdin);
    const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const connection = app.connect(ndJsonStream(output, input));
    const context = connection.agent;
    const timeoutSignal = AbortSignal.timeout(STARTUP_TIMEOUT_MS);
    const startupSignal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const onStartupAbort = () => {
      connection.close(startupSignal.reason);
      void terminateProcessTree(child);
    };
    if (startupSignal.aborted) onStartupAbort();
    else startupSignal.addEventListener("abort", onStartupAbort, { once: true });

    let startupPhase = "initialize";
    let advertisedAuthMethods: readonly AuthMethod[] = [];
    try {
      const initialized = await Promise.race([
        context.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        }),
        processError,
      ]);
      child.off("error", onProcessError);
      if (initialized.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`ACP protocol mismatch: agent selected v${initialized.protocolVersion}, client supports v${PROTOCOL_VERSION}.`);
      }

      const capabilities = initialized.agentCapabilities ?? {};
      advertisedAuthMethods = initialized.authMethods ?? [];
      startupPhase = options.resume?.mode === "resume"
        ? "session/resume"
        : options.resume?.mode === "load"
          ? "session/load"
          : "session/new";
      let sessionId: string;
      let resumeMode: AcpRuntimeInfo["resumeMode"] = "none";
      if (options.resume?.mode === "resume") {
        if (!capabilities.sessionCapabilities?.resume) throw new Error("ACP agent does not support session/resume.");
        await context.request(methods.agent.session.resume, {
          sessionId: options.resume.sessionId,
          cwd: options.cwd,
          mcpServers: [],
        });
        sessionId = options.resume.sessionId;
        resumeMode = "resume";
      } else if (options.resume?.mode === "load") {
        if (!capabilities.loadSession) throw new Error("ACP agent does not support session/load.");
        await context.request(methods.agent.session.load, {
          sessionId: options.resume.sessionId,
          cwd: options.cwd,
          mcpServers: [],
        });
        sessionId = options.resume.sessionId;
        resumeMode = "load";
      } else {
        const created = await context.request(methods.agent.session.new, { cwd: options.cwd, mcpServers: [] });
        sessionId = created.sessionId;
      }

      const createdRuntime = new AcpSessionRuntime(
        child,
        connection,
        context,
        options.approval.registryId,
        { KIMI_CODE_HOME: env.KIMI_CODE_HOME },
        {
          agentName: initialized.agentInfo?.title ?? initialized.agentInfo?.name,
          agentVersion: initialized.agentInfo?.version,
          authMethods: advertisedAuthMethods,
          capabilities,
          sessionId,
          resumeMode,
        },
      );
      runtime = createdRuntime;
      startupSignal.removeEventListener("abort", onStartupAbort);
      createdRuntime.stderrText = earlyStderr;
      child.once("error", error => {
        if (!createdRuntime.closed) createdRuntime.connection.close(error);
      });
      child.once("exit", (code, signal) => {
        if (!createdRuntime.closed) {
          createdRuntime.connection.close(new Error(`ACP process exited (${signal ?? code ?? "unknown"}).`));
        }
      });
      return createdRuntime;
    } catch (error) {
      startupSignal.removeEventListener("abort", onStartupAbort);
      connection.close(error);
      await terminateProcessTree(child);
      const stderr = earlyStderr.trim();
      const stderrSuffix = stderr ? `\nACP stderr:\n${stderr}` : "";
      const rawMessage = error instanceof Error ? error.message : String(error);
      const timeoutMessage = timeoutSignal.aborted
        ? `ACP startup timed out during ${startupPhase} after ${STARTUP_TIMEOUT_MS / 1000}s.`
        : `ACP startup failed during ${startupPhase}: ${rawMessage}`;
      const authHint = /auth|required|log.?in|credential|oauth|unauthorized|refresh[_ -]?token/i.test(`${rawMessage}\n${stderr}`)
        ? `\nAuthenticate ${options.approval.displayName} with its CLI/adapter in a terminal, then retry.${authMethodsHint(advertisedAuthMethods)}`
        : "";
      throw new Error(`${timeoutMessage}${authHint}${stderrSuffix}`);
    }
  }

  get stderr(): string {
    return this.stderrText;
  }

  get isClosed(): boolean {
    return this.closed || this.connection.signal.aborted;
  }

  async run(prompt: string, hooks: AcpTurnHooks = {}, signal?: AbortSignal): Promise<AcpTurnResult> {
    if (this.isClosed) throw new Error("ACP connection is closed.");
    if (this.currentPromptAbort) throw new Error("ACP session already has a prompt in progress.");

    this.activeHooks = hooks;
    this.responseText = "";
    this.responseBytes = 0;
    this.outputTruncated = false;
    this.sawAgentOutput = false;
    const stderrBefore = this.stderrText;
    const abortController = new AbortController();
    this.currentPromptAbort = abortController;
    let forceCloseTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      abortController.abort(signal?.reason);
      void this.context.notify(methods.agent.session.cancel, { sessionId: this.info.sessionId }).catch(() => {});
      forceCloseTimer ??= setTimeout(() => {
        if (this.currentPromptAbort === abortController) void this.close();
      }, PROCESS_STOP_GRACE_MS);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await this.context.request(
        methods.agent.session.prompt,
        { sessionId: this.info.sessionId, prompt: [{ type: "text", text: prompt }] },
        { cancellationSignal: abortController.signal },
      );
      const text = this.responseText.trim();
      if (response.stopReason === "end_turn" && !text && !this.sawAgentOutput) {
        throw new Error(emptyTurnError({
          registryId: this.registryId,
          agentName: this.info.agentName ?? this.registryId,
          sessionId: this.info.sessionId,
          response,
          stderrBefore,
          stderrAfter: this.stderrText,
          env: this.diagnosticEnv,
        }));
      }
      return { text, stopReason: response.stopReason, response, hadAgentOutput: this.sawAgentOutput };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/auth|required|log.?in|credential/i.test(message)) {
        throw new Error(`${message}\nThe ACP agent rejected the turn as unauthenticated. Verify ${this.info.agentName ?? "the adapter"} can complete a non-interactive prompt in the same environment, then sign in again if needed.${authMethodsHint(this.info.authMethods ?? [])}`);
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (forceCloseTimer) clearTimeout(forceCloseTimer);
      this.currentPromptAbort = undefined;
      this.activeHooks = undefined;
    }
  }

  async cancel(): Promise<void> {
    if (this.isClosed) return;
    this.currentPromptAbort?.abort();
    await this.context.notify(methods.agent.session.cancel, { sessionId: this.info.sessionId });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      const graceful = this.info.capabilities.sessionCapabilities?.close
        ? this.context.request(methods.agent.session.close, { sessionId: this.info.sessionId })
        : this.currentPromptAbort
          ? this.context.notify(methods.agent.session.cancel, { sessionId: this.info.sessionId })
          : Promise.resolve();
      await Promise.race([
        graceful,
        new Promise<void>(resolve => setTimeout(resolve, PROCESS_STOP_GRACE_MS)),
      ]);
    } catch { /* best effort */ }
    this.connection.close();
    try { this.child.stdin.end(); } catch { /* ignore */ }
    await terminateProcessTree(this.child);
  }

  private handleNotification(notification: SessionNotification): void {
    if (notification.sessionId !== this.info.sessionId) return;
    const hooks = this.activeHooks;
    if (!hooks) return;
    const update = notification.update;
    this.handleUpdate(update, hooks);
  }

  private handleUpdate(update: SessionUpdate, hooks: AcpTurnHooks): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.sawAgentOutput = true;
        if (update.content.type === "text" && !this.outputTruncated) {
          const chunk = update.content.text;
          const remaining = OUTPUT_LIMIT - this.responseBytes;
          const chunkBytes = Buffer.byteLength(chunk);
          if (chunkBytes <= remaining) {
            this.responseText += chunk;
            this.responseBytes += chunkBytes;
            hooks.onText?.(chunk, this.responseText);
          } else {
            const kept = Buffer.from(chunk).subarray(0, Math.max(0, remaining)).toString("utf-8").replace(/�+$/u, "");
            this.responseText += kept + OUTPUT_TRUNCATED_MARKER;
            this.responseBytes = OUTPUT_LIMIT;
            this.outputTruncated = true;
            hooks.onText?.(kept + OUTPUT_TRUNCATED_MARKER, this.responseText);
          }
        }
        break;
      case "agent_thought_chunk":
        this.sawAgentOutput = true;
        hooks.onActivity?.("thinking…");
        break;
      case "tool_call":
        this.sawAgentOutput = true;
        hooks.onToolCall?.(update.toolCallId, update.title, update.status);
        hooks.onActivity?.(update.title);
        break;
      case "tool_call_update":
        this.sawAgentOutput = true;
        hooks.onToolCall?.(update.toolCallId, update.title ?? update.toolCallId, update.status);
        if (update.title) hooks.onActivity?.(update.title);
        break;
      case "plan": {
        const active = update.entries.find(entry => entry.status === "in_progress") ?? update.entries[0];
        if (active) hooks.onActivity?.(active.content);
        break;
      }
      case "usage_update":
        hooks.onUsage?.({
          used: update.used,
          size: update.size,
          ...(update.cost ? { cost: update.cost } : {}),
        });
        break;
      default:
        break;
    }
  }
}
