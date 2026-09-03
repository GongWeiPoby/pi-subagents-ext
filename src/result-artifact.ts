import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { assertSafeInternalId, sessionTaskDir } from "./output-file.js";
import type { TaskExecutionRef } from "./tasks/execution-contract.js";
import type { ResultArtifactStatus } from "./types.js";
import type { LifetimeUsage } from "./usage.js";
import {
  aggregateWorkflowCoverage,
  createWorkflowChildAttempt,
  type WorkflowChildAttempt,
  type WorkflowCoverageAggregate,
} from "./workflow/attempt.js";

export const RESULT_ARTIFACT_SCHEMA_VERSION = 1;
export const WORKFLOW_AGGREGATE_ARTIFACT_SCHEMA_VERSION = 1;
export const WORKFLOW_AGGREGATE_ERROR_DISABLED = "Workflow failed; output persistence disabled.";

const UNSAFE_RESULT_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/g;
const SAFE_ERROR_MAX_LENGTH = 512;
const SAFE_ERROR_CODE_MAX_LENGTH = 64;
const WORKFLOW_MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
const RESULT_MANIFEST_MAX_BYTES = 128 * 1024;
const RESULT_BODY_MAX_BYTES = 8 * 1024 * 1024;
const RUN_STATUSES = ["completed", "steered", "aborted", "stopped", "error"] as const;
const ARTIFACT_STATUSES = ["complete", "metadata-only", "failed"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isOneOf<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function safeErrorSummary(value: string): string | undefined {
  const summary = sanitizeArtifactText(value).split("\n", 1)[0].trim();
  if (!summary) return undefined;
  return summary.length > SAFE_ERROR_MAX_LENGTH
    ? `${summary.slice(0, SAFE_ERROR_MAX_LENGTH - 3)}...`
    : summary;
}

function safeErrorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "unknown")
    : "unknown";
  const safe = code.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, SAFE_ERROR_CODE_MAX_LENGTH);
  return safe || "unknown";
}

export function formatArtifactWriteError(prefix: string, error: unknown): string {
  return `${prefix} (${safeErrorCode(error)})`;
}

function ensureExistingDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`invalid ${label}`);
  if (process.platform !== "win32" && process.getuid && stat.uid !== process.getuid()) {
    throw new Error(`invalid ${label} owner`);
  }
  try {
    chmodSync(path, 0o700);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

function ensureRegularFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`invalid ${label}`);
}

export interface ResultArtifactManifest {
  schemaVersion: typeof RESULT_ARTIFACT_SCHEMA_VERSION;
  artifactId: string;
  agentId: string;
  status: "completed" | "steered" | "aborted" | "stopped" | "error";
  startedAt: string;
  completedAt: string;
  producer: {
    kind: "agent";
    scope: "top-level";
    invocation: "spawn" | "resume" | "retry";
  };
  usage: {
    turns: number;
    toolCalls: number;
    tokens: LifetimeUsage;
  };
  model?: {
    id?: string;
    thinking?: string;
  };
  sourceAttemptId?: string;
  resume?: {
    sourceAgentId: string;
  };
  resultBodyPath?: string;
  resultDigest?: string;
  artifactStatus: Exclude<ResultArtifactStatus, "pending" | "skipped">;
  error?: string;
  artifactError?: string;
}

export interface WriteResultArtifactInput {
  taskDir: string;
  artifactId: string;
  agentId: string;
  status: ResultArtifactManifest["status"];
  startedAt: number;
  completedAt: number;
  invocation: ResultArtifactManifest["producer"]["invocation"];
  usage: ResultArtifactManifest["usage"];
  modelId?: string;
  thinking?: string;
  sourceAttemptId?: string;
  sourceAgentId?: string;
  result?: string;
  error?: string;
  includeBody: boolean;
}

export interface WriteResultArtifactResult {
  manifestPath: string;
  bodyPath?: string;
  status: Exclude<ResultArtifactStatus, "pending" | "skipped">;
  error?: string;
}

export interface WorkflowAggregateArtifactManifest {
  schemaVersion: typeof WORKFLOW_AGGREGATE_ARTIFACT_SCHEMA_VERSION;
  artifactId: string;
  workflowId: string;
  workflowName?: string;
  status: "completed" | "failed" | "killed";
  startedAt: string;
  completedAt: string;
  coverage: WorkflowCoverageAggregate;
  /** True when the bounded killed-run child drain did not fully settle. */
  evidenceIncomplete?: boolean;
  childAttempts: WorkflowChildAttempt[];
  resultSummary: string;
  resultBodyPath?: string;
  resultDigest?: string;
  taskBinding?: TaskExecutionRef;
  artifactStatus: Exclude<ResultArtifactStatus, "pending" | "skipped">;
  error?: string;
  artifactError?: string;
}

export interface ReadWorkflowAggregateArtifactInput {
  cwd: string;
  sessionId: string;
  workflowId: string;
  taskBinding?: TaskExecutionRef;
}

export type ReadWorkflowAggregateArtifactResult =
  | { manifest: WorkflowAggregateArtifactManifest; manifestPath: string }
  | { error: string; manifestPath: string };

export interface ReadResultArtifactBodyInput {
  cwd: string;
  sessionId: string;
  agentId: string;
  artifactId: string;
  offset?: number;
  limit?: number;
}

export interface ResultArtifactBodySlice {
  body: string;
  offset: number;
  limit: number;
  totalLength: number;
  hasMore: boolean;
}

export type ReadResultArtifactBodyResult =
  | { manifest: ResultArtifactManifest; manifestPath: string; slice: ResultArtifactBodySlice }
  | { error: string; manifestPath: string };

export interface ReadWorkflowAggregateArtifactBodyInput extends ReadWorkflowAggregateArtifactInput {
  offset?: number;
  limit?: number;
}

export type ReadWorkflowAggregateArtifactBodyResult =
  | { manifest: WorkflowAggregateArtifactManifest; manifestPath: string; slice: ResultArtifactBodySlice }
  | { error: string; manifestPath: string };

export interface WriteWorkflowAggregateArtifactInput {
  taskDir: string;
  artifactId: string;
  workflowId: string;
  workflowName?: string;
  status: WorkflowAggregateArtifactManifest["status"];
  startedAt: number;
  completedAt: number;
  coverage: WorkflowCoverageAggregate;
  childAttempts: readonly WorkflowChildAttempt[];
  evidenceIncomplete?: boolean;
  resultSummary: string;
  result?: string;
  includeBody: boolean;
  taskBinding?: TaskExecutionRef;
  error?: string;
}

export interface WriteWorkflowAggregateArtifactResult {
  manifestPath: string;
  bodyPath?: string;
  status: Exclude<ResultArtifactStatus, "pending" | "skipped">;
  error?: string;
}

/** Remove terminal, C0/C1, and bidi controls while retaining ordinary tabs/newlines. */
export function sanitizeArtifactText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(UNSAFE_RESULT_CONTROLS, "");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function writeAtomic(path: string, content: string): void {
  const parent = join(path, "..");
  ensureExistingDirectory(parent, "artifact directory");
  const tempPath = join(
    parent,
    `.${basename(path)}.${randomUUID().replaceAll("-", "")}.tmp`,
  );
  try {
    writeFileSync(tempPath, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
    ensureRegularFile(tempPath, "temporary artifact file");
    try {
      chmodSync(tempPath, 0o600);
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }

    try {
      // Publishing a hard link is atomic and fails with EEXIST instead of
      // replacing a file another process created after our temporary write.
      linkSync(tempPath, path);
    } catch (error) {
      const code = safeErrorCode(error);
      const hardLinksUnavailable = code === "EPERM"
        || code === "ENOSYS"
        || code === "ENOTSUP"
        || code === "EOPNOTSUPP"
        || code === "EXDEV";
      if (process.platform !== "win32" || !hardLinksUnavailable) throw error;
      // Some Windows filesystems do not support hard links. COPYFILE_EXCL is
      // the strongest Node-compatible fallback: it may copy rather than link,
      // but it still refuses an existing destination and never clobbers it.
      copyFileSync(tempPath, path, constants.COPYFILE_EXCL);
    }
    ensureRegularFile(path, "result artifact file");
    rmSync(tempPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function corruptArtifact(manifestPath: string, reason: string): WriteResultArtifactResult {
  return {
    manifestPath,
    status: "failed",
    error: `result artifact corrupt: ${safeErrorSummary(reason) ?? "invalid manifest"}`,
  };
}

function validateManifest(value: unknown, artifactId: string): value is ResultArtifactManifest {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== RESULT_ARTIFACT_SCHEMA_VERSION
    || value.artifactId !== artifactId
    || typeof value.agentId !== "string") return false;
  try {
    assertSafeInternalId(value.artifactId, "artifact id");
    assertSafeInternalId(value.agentId, "agent id");
  } catch { return false; }
  if (!isOneOf(RUN_STATUSES, value.status)
    || !isIsoTimestamp(value.startedAt)
    || !isIsoTimestamp(value.completedAt)
    || !isRecord(value.producer)
    || value.producer.kind !== "agent"
    || value.producer.scope !== "top-level"
    || !isOneOf(["spawn", "resume", "retry"] as const, value.producer.invocation)
    || !isRecord(value.usage)
    || !isFiniteNonNegative(value.usage.turns)
    || !isFiniteNonNegative(value.usage.toolCalls)
    || !isRecord(value.usage.tokens)
    || !isFiniteNonNegative(value.usage.tokens.input)
    || !isFiniteNonNegative(value.usage.tokens.output)
    || !isFiniteNonNegative(value.usage.tokens.cacheWrite)
    || (value.usage.tokens.cacheRead !== undefined && !isFiniteNonNegative(value.usage.tokens.cacheRead))
    || (value.usage.tokens.cost !== undefined && !isFiniteNonNegative(value.usage.tokens.cost))
    || (value.sourceAttemptId !== undefined && !isSafeInternalIdValue(value.sourceAttemptId))
    || (value.resume !== undefined
      && (!isRecord(value.resume) || !isSafeInternalIdValue(value.resume.sourceAgentId)))
    || (value.resultBodyPath !== undefined
      && value.resultBodyPath !== `${artifactId}.md`)
    || (value.resultDigest !== undefined
      && (typeof value.resultDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.resultDigest)))
    || (value.model !== undefined
      && (!isRecord(value.model)
        || (value.model.id !== undefined && (typeof value.model.id !== "string" || safeErrorSummary(value.model.id) !== value.model.id))
        || (value.model.thinking !== undefined && (typeof value.model.thinking !== "string" || safeErrorSummary(value.model.thinking) !== value.model.thinking))))
    || !isOneOf(ARTIFACT_STATUSES, value.artifactStatus)
    || (value.error !== undefined && (typeof value.error !== "string" || safeErrorSummary(value.error) !== value.error))
    || (value.artifactError !== undefined
      && (typeof value.artifactError !== "string" || safeErrorSummary(value.artifactError) !== value.artifactError))) return false;
  return true;
}

function isSafeInternalIdValue(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    assertSafeInternalId(value, "internal id");
    return true;
  } catch { return false; }
}

function readExisting(
  manifestPath: string,
  artifactId: string,
  bodyPath: string,
): WriteResultArtifactResult {
  try {
    ensureRegularFile(manifestPath, "result manifest");
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (!validateManifest(parsed, artifactId)) return corruptArtifact(manifestPath, "invalid manifest");
    const manifest = parsed as ResultArtifactManifest;

    if (manifest.artifactStatus === "complete") {
      if (manifest.resultBodyPath !== basename(bodyPath)
        || typeof manifest.resultDigest !== "string"
        || !/^sha256:[0-9a-f]{64}$/.test(manifest.resultDigest)) {
        return corruptArtifact(manifestPath, "complete manifest has invalid body metadata");
      }
      try {
        ensureRegularFile(bodyPath, "result body");
        const digest = `sha256:${createHash("sha256").update(readFileSync(bodyPath)).digest("hex")}`;
        if (digest !== manifest.resultDigest) return corruptArtifact(manifestPath, "body digest mismatch");
      } catch (error) {
        return corruptArtifact(manifestPath, safeErrorCode(error) === "ENOENT" ? "complete body is missing" : "body is unreadable");
      }
      return { manifestPath, bodyPath, status: "complete" };
    }

    return {
      manifestPath,
      status: manifest.artifactStatus,
      ...(manifest.artifactError !== undefined
        ? { error: safeErrorSummary(manifest.artifactError) }
        : {}),
    };
  } catch (error) {
    return corruptArtifact(manifestPath, safeErrorCode(error) === "ENOENT" ? "manifest is missing" : "invalid manifest");
  }
}

function isSafeTaskDir(path: string): boolean {
  return isAbsolute(path) && !/[\u0000-\u001F\u007F-\u009F]/.test(path);
}

/**
 * `taskDir` is produced by sessionTaskDir, which checks every managed parent
 * with lstat before returning it. The writer repeats checks as it descends into
 * results and the attempt directory. Node does not expose directory-fd/openat
 * relative operations, so a same-UID process can still swap a checked directory
 * between checks; that process is outside this extension's trust boundary. The
 * private owner-only root is the protection intended for other local users.
 */
export function writeResultArtifact(input: WriteResultArtifactInput): WriteResultArtifactResult {
  assertSafeInternalId(input.artifactId, "artifact id");
  assertSafeInternalId(input.agentId, "agent id");
  if (input.sourceAttemptId !== undefined) assertSafeInternalId(input.sourceAttemptId, "source attempt id");
  if (input.sourceAgentId !== undefined) assertSafeInternalId(input.sourceAgentId, "source agent id");
  if (!isOneOf(RUN_STATUSES, input.status)
    || !isOneOf(["spawn", "resume", "retry"] as const, input.invocation)
    || !Number.isFinite(input.startedAt)
    || !Number.isFinite(input.completedAt)
    || !isSafeTaskDir(input.taskDir)) {
    throw new Error("invalid result artifact input");
  }
  if (!isRecord(input.usage)
    || !isFiniteNonNegative(input.usage.turns)
    || !isFiniteNonNegative(input.usage.toolCalls)
    || !isRecord(input.usage.tokens)
    || !isFiniteNonNegative(input.usage.tokens.input)
    || !isFiniteNonNegative(input.usage.tokens.output)
    || !isFiniteNonNegative(input.usage.tokens.cacheWrite)) {
    throw new Error("invalid result artifact usage");
  }

  ensureExistingDirectory(input.taskDir, "task directory");
  const resultsDir = join(input.taskDir, "results");
  try {
    mkdirSync(resultsDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  ensureExistingDirectory(resultsDir, "results directory");

  const artifactDir = join(resultsDir, input.artifactId);
  const manifestPath = join(artifactDir, `${input.artifactId}.json`);
  const bodyPath = join(artifactDir, `${input.artifactId}.md`);
  try {
    mkdirSync(artifactDir, { mode: 0o700 });
  } catch (error) {
    ensureExistingDirectory(artifactDir, "artifact directory");
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readExisting(manifestPath, input.artifactId, bodyPath);
  }
  ensureExistingDirectory(artifactDir, "artifact directory");

  let artifactStatus: ResultArtifactManifest["artifactStatus"] = "metadata-only";
  let artifactError: string | undefined;
  let resultBodyPath: string | undefined;
  let resultDigest: string | undefined;

  if (input.includeBody && input.result) {
    const body = `${sanitizeArtifactText(input.result).replace(/\n*$/, "")}\n`;
    try {
      writeAtomic(bodyPath, body);
      artifactStatus = "complete";
      resultBodyPath = basename(bodyPath);
      resultDigest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    } catch (error) {
      artifactStatus = "failed";
      artifactError = formatArtifactWriteError("result body write failed", error);
    }
  }

  const modelId = input.modelId ? safeErrorSummary(input.modelId) : undefined;
  const thinking = input.thinking ? safeErrorSummary(input.thinking) : undefined;
  const manifest: ResultArtifactManifest = {
    schemaVersion: RESULT_ARTIFACT_SCHEMA_VERSION,
    artifactId: input.artifactId,
    agentId: input.agentId,
    status: input.status,
    startedAt: new Date(input.startedAt).toISOString(),
    completedAt: new Date(input.completedAt).toISOString(),
    producer: {
      kind: "agent",
      scope: "top-level",
      invocation: input.invocation,
    },
    usage: input.usage,
    ...(modelId || thinking ? { model: { id: modelId, thinking } } : {}),
    ...(input.sourceAttemptId !== undefined
      ? { sourceAttemptId: sanitizeArtifactText(input.sourceAttemptId) }
      : {}),
    ...(input.invocation === "resume" && input.sourceAgentId !== undefined
      ? { resume: { sourceAgentId: sanitizeArtifactText(input.sourceAgentId) } }
      : {}),
    ...(resultBodyPath !== undefined ? { resultBodyPath } : {}),
    ...(resultDigest !== undefined ? { resultDigest } : {}),
    artifactStatus,
    ...(input.error !== undefined
      ? (() => {
          const error = safeErrorSummary(input.error);
          return error !== undefined ? { error } : {};
        })()
      : {}),
    ...(artifactError !== undefined ? { artifactError } : {}),
  };

  writeAtomic(manifestPath, canonicalJson(manifest));
  return {
    manifestPath,
    ...(resultBodyPath !== undefined ? { bodyPath } : {}),
    status: artifactStatus,
    ...(artifactError !== undefined ? { error: artifactError } : {}),
  };
}

function isSafeWorkflowTaskBinding(value: unknown, workflowId: string): value is TaskExecutionRef {
  if (!isRecord(value)) return false;
  const required = ["storeId", "taskId", "taskAttemptId", "attemptId", "executorId"] as const;
  return required.every(field => isSafeInternalIdValue(value[field]))
    && value.kind === "workflow"
    && value.executorId === workflowId;
}

function isWorkflowAggregateStatus(value: unknown): value is WorkflowAggregateArtifactManifest["status"] {
  return value === "completed" || value === "failed" || value === "killed";
}

function validateWorkflowAggregateManifest(
  value: unknown,
  artifactId: string,
): value is WorkflowAggregateArtifactManifest {
  if (!isRecord(value)
    || value.schemaVersion !== WORKFLOW_AGGREGATE_ARTIFACT_SCHEMA_VERSION
    || value.artifactId !== artifactId
    || !isSafeInternalIdValue(value.workflowId)
    || !isWorkflowAggregateStatus(value.status)
    || !isIsoTimestamp(value.startedAt)
    || !isIsoTimestamp(value.completedAt)
    || (value.workflowName !== undefined
      && (typeof value.workflowName !== "string" || safeErrorSummary(value.workflowName) !== value.workflowName))
    || !Array.isArray(value.childAttempts)
    || !isRecord(value.coverage)
    || (value.evidenceIncomplete !== undefined && typeof value.evidenceIncomplete !== "boolean")
    || typeof value.resultSummary !== "string"
    || safeErrorSummary(value.resultSummary) !== value.resultSummary
    || (value.taskBinding !== undefined && !isSafeWorkflowTaskBinding(value.taskBinding, value.workflowId))
    || !isOneOf(ARTIFACT_STATUSES, value.artifactStatus)
    || (value.error !== undefined && (typeof value.error !== "string" || safeErrorSummary(value.error) !== value.error))
    || (value.artifactError !== undefined
      && (typeof value.artifactError !== "string" || safeErrorSummary(value.artifactError) !== value.artifactError))) {
    return false;
  }

  try {
    const attempts = value.childAttempts.map(item => createWorkflowChildAttempt(item as WorkflowChildAttempt));
    if (canonicalJson(attempts) !== canonicalJson(value.childAttempts)) return false;
    const coverage = aggregateWorkflowCoverage(attempts);
    if (canonicalJson(coverage) !== canonicalJson(value.coverage)) return false;
  } catch {
    return false;
  }

  if (value.resultBodyPath !== undefined
    && value.resultBodyPath !== `${artifactId}.md`) return false;
  if (value.resultDigest !== undefined
    && (typeof value.resultDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.resultDigest))) return false;
  if (value.artifactStatus === "complete"
    && (value.resultBodyPath === undefined || value.resultDigest === undefined)) return false;
  if (value.artifactStatus !== "complete"
    && (value.resultBodyPath !== undefined || value.resultDigest !== undefined)) return false;
  return true;
}

function sameWorkflowTaskBinding(left: TaskExecutionRef, right: TaskExecutionRef): boolean {
  return left.storeId === right.storeId
    && left.taskId === right.taskId
    && left.taskAttemptId === right.taskAttemptId
    && left.attemptId === right.attemptId
    && left.kind === right.kind
    && left.executorId === right.executorId;
}

/**
 * Read only a workflow aggregate manifest from its fixed session-owned location.
 * The caller supplies identities, never a path; result bodies are intentionally
 * outside this API.
 */
export function readWorkflowAggregateArtifactManifest(
  input: ReadWorkflowAggregateArtifactInput,
): ReadWorkflowAggregateArtifactResult {
  assertSafeInternalId(input.sessionId, "session id");
  assertSafeInternalId(input.workflowId, "workflow id");
  const artifactId = `workflow-${input.workflowId}`;
  assertSafeInternalId(artifactId, "workflow aggregate artifact id");
  const taskDir = sessionTaskDir(input.cwd, input.sessionId);
  const resultsDir = join(taskDir, "results");
  const artifactDir = join(resultsDir, artifactId);
  const manifestPath = join(artifactDir, `${artifactId}.json`);

  try {
    ensureExistingDirectory(taskDir, "task directory");
    ensureExistingDirectory(resultsDir, "results directory");
    ensureExistingDirectory(artifactDir, "workflow aggregate artifact directory");
    const stat = lstatSync(manifestPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { manifestPath, error: "workflow aggregate manifest is not a regular file" };
    }
    if (stat.size > WORKFLOW_MANIFEST_MAX_BYTES) {
      return { manifestPath, error: "workflow aggregate manifest exceeds the read limit" };
    }
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (!validateWorkflowAggregateManifest(parsed, artifactId)) {
      return { manifestPath, error: "workflow aggregate manifest is invalid" };
    }
    const manifest = parsed as WorkflowAggregateArtifactManifest;
    if (manifest.workflowId !== input.workflowId) {
      return { manifestPath, error: "workflow aggregate identity does not match" };
    }
    if (input.taskBinding !== undefined
      && (manifest.taskBinding === undefined
        || !sameWorkflowTaskBinding(manifest.taskBinding, input.taskBinding))) {
      return { manifestPath, error: "workflow aggregate task binding does not match" };
    }
    return { manifestPath, manifest };
  } catch (error) {
    return {
      manifestPath,
      error: safeErrorCode(error) === "ENOENT"
        ? "workflow aggregate manifest is missing"
        : "workflow aggregate manifest could not be read",
    };
  }
}

function bodySlice(body: string, offset = 0, limit = 20_000): ResultArtifactBodySlice {
  if (!Number.isInteger(offset) || offset < 0 || offset > RESULT_BODY_MAX_BYTES) {
    throw new Error("invalid result body offset");
  }
  if (!Number.isInteger(limit) || limit < 0 || limit > RESULT_BODY_MAX_BYTES) {
    throw new Error("invalid result body limit");
  }
  const end = Math.min(body.length, offset + limit);
  return {
    body: body.slice(offset, end),
    offset,
    limit,
    totalLength: body.length,
    hasMore: end < body.length,
  };
}

function readBodySlice(
  bodyPath: string,
  digest: string | undefined,
  label: string,
  offset?: number,
  limit?: number,
): ResultArtifactBodySlice | string {
  try {
    ensureRegularFile(bodyPath, label);
    const stat = lstatSync(bodyPath);
    if (stat.size > RESULT_BODY_MAX_BYTES) return `${label} exceeds the read limit`;
    const body = readFileSync(bodyPath, "utf-8");
    const actualDigest = `sha256:${createHash("sha256").update(Buffer.from(body, "utf-8")).digest("hex")}`;
    if (actualDigest !== digest) return `${label} digest mismatch`;
    return bodySlice(body, offset, limit);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("invalid result body")) return error.message;
    return safeErrorCode(error) === "ENOENT" ? `${label} is missing` : `${label} is unreadable`;
  }
}

function resultArtifactPaths(cwd: string, sessionId: string, artifactId: string): {
  taskDir: string;
  resultsDir: string;
  artifactDir: string;
  manifestPath: string;
  bodyPath: string;
} {
  assertSafeInternalId(sessionId, "session id");
  assertSafeInternalId(artifactId, "artifact id");
  const taskDir = sessionTaskDir(cwd, sessionId);
  const resultsDir = join(taskDir, "results");
  const artifactDir = join(resultsDir, artifactId);
  return {
    taskDir,
    resultsDir,
    artifactDir,
    manifestPath: join(artifactDir, `${artifactId}.json`),
    bodyPath: join(artifactDir, `${artifactId}.md`),
  };
}

/** Read one current-session-owned Agent result body after validating its manifest and digest. */
export function readResultArtifactBody(
  input: ReadResultArtifactBodyInput,
): ReadResultArtifactBodyResult {
  assertSafeInternalId(input.agentId, "agent id");
  const paths = resultArtifactPaths(input.cwd, input.sessionId, input.artifactId);
  try {
    ensureExistingDirectory(paths.taskDir, "task directory");
    ensureExistingDirectory(paths.resultsDir, "results directory");
    ensureExistingDirectory(paths.artifactDir, "artifact directory");
    const manifestStat = lstatSync(paths.manifestPath);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
      return { manifestPath: paths.manifestPath, error: "result manifest is not a regular file" };
    }
    if (manifestStat.size > RESULT_MANIFEST_MAX_BYTES) {
      return { manifestPath: paths.manifestPath, error: "result manifest exceeds the read limit" };
    }
    const parsed: unknown = JSON.parse(readFileSync(paths.manifestPath, "utf-8"));
    if (!validateManifest(parsed, input.artifactId)) {
      return { manifestPath: paths.manifestPath, error: "result manifest is invalid" };
    }
    const manifest = parsed as ResultArtifactManifest;
    if (manifest.agentId !== input.agentId) {
      return { manifestPath: paths.manifestPath, error: "result agent identity does not match" };
    }
    if (manifest.artifactStatus !== "complete") {
      return { manifestPath: paths.manifestPath, error: "result body is unavailable" };
    }
    const slice = readBodySlice(
      paths.bodyPath,
      manifest.resultDigest,
      "result body",
      input.offset,
      input.limit,
    );
    return typeof slice === "string"
      ? { manifestPath: paths.manifestPath, error: slice }
      : { manifestPath: paths.manifestPath, manifest, slice };
  } catch (error) {
    return {
      manifestPath: paths.manifestPath,
      error: safeErrorCode(error) === "ENOENT" ? "result manifest is missing" : "result manifest could not be read",
    };
  }
}

/** Read one current-session-owned Workflow aggregate body after validating its manifest and digest. */
export function readWorkflowAggregateArtifactBody(
  input: ReadWorkflowAggregateArtifactBodyInput,
): ReadWorkflowAggregateArtifactBodyResult {
  const loaded = readWorkflowAggregateArtifactManifest(input);
  if ("error" in loaded) return loaded;
  const paths = resultArtifactPaths(input.cwd, input.sessionId, loaded.manifest.artifactId);
  try {
    ensureExistingDirectory(paths.taskDir, "task directory");
    ensureExistingDirectory(paths.resultsDir, "results directory");
    ensureExistingDirectory(paths.artifactDir, "workflow aggregate artifact directory");
  } catch (error) {
    return {
      manifestPath: loaded.manifestPath,
      error: safeErrorCode(error) === "ENOENT"
        ? "workflow aggregate body is missing"
        : "workflow aggregate body is unreadable",
    };
  }
  if (paths.manifestPath !== loaded.manifestPath) {
    return { manifestPath: loaded.manifestPath, error: "workflow aggregate manifest path does not match" };
  }
  if (loaded.manifest.artifactStatus !== "complete") {
    return { manifestPath: loaded.manifestPath, error: "workflow aggregate body is unavailable" };
  }
  const slice = readBodySlice(
    paths.bodyPath,
    loaded.manifest.resultDigest,
    "workflow aggregate body",
    input.offset,
    input.limit,
  );
  return typeof slice === "string"
    ? { manifestPath: loaded.manifestPath, error: slice }
    : { manifestPath: loaded.manifestPath, manifest: loaded.manifest, slice };
}

function corruptWorkflowAggregate(
  manifestPath: string,
  reason: string,
): WriteWorkflowAggregateArtifactResult {
  return {
    manifestPath,
    status: "failed",
    error: `workflow aggregate artifact corrupt: ${safeErrorSummary(reason) ?? "invalid manifest"}`,
  };
}

function readExistingWorkflowAggregate(
  manifestPath: string,
  artifactId: string,
  bodyPath: string,
): WriteWorkflowAggregateArtifactResult {
  try {
    ensureRegularFile(manifestPath, "workflow aggregate manifest");
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (!validateWorkflowAggregateManifest(parsed, artifactId)) {
      return corruptWorkflowAggregate(manifestPath, "invalid manifest");
    }
    const manifest = parsed as WorkflowAggregateArtifactManifest;
    if (manifest.artifactStatus === "complete") {
      try {
        ensureRegularFile(bodyPath, "workflow aggregate body");
        const digest = `sha256:${createHash("sha256").update(readFileSync(bodyPath)).digest("hex")}`;
        if (digest !== manifest.resultDigest) {
          return corruptWorkflowAggregate(manifestPath, "body digest mismatch");
        }
      } catch (error) {
        return corruptWorkflowAggregate(
          manifestPath,
          safeErrorCode(error) === "ENOENT" ? "complete body is missing" : "body is unreadable",
        );
      }
      return { manifestPath, bodyPath, status: "complete" };
    }
    return {
      manifestPath,
      status: manifest.artifactStatus,
      ...(manifest.artifactError !== undefined ? { error: safeErrorSummary(manifest.artifactError) } : {}),
    };
  } catch (error) {
    return corruptWorkflowAggregate(
      manifestPath,
      safeErrorCode(error) === "ENOENT" ? "manifest is missing" : "invalid manifest",
    );
  }
}

/** Persist the final, internal aggregate for one settled workflow run. */
export function writeWorkflowAggregateArtifact(
  input: WriteWorkflowAggregateArtifactInput,
): WriteWorkflowAggregateArtifactResult {
  assertSafeInternalId(input.artifactId, "workflow aggregate artifact id");
  assertSafeInternalId(input.workflowId, "workflow id");
  if (!isWorkflowAggregateStatus(input.status)
    || !Number.isFinite(input.startedAt)
    || !Number.isFinite(input.completedAt)
    || !isSafeTaskDir(input.taskDir)
    || (input.workflowName !== undefined && typeof input.workflowName !== "string")
    || (input.taskBinding !== undefined && !isSafeWorkflowTaskBinding(input.taskBinding, input.workflowId))) {
    throw new Error("invalid workflow aggregate artifact input");
  }

  const attempts = input.childAttempts.map(attempt => {
    const safeAttempt = createWorkflowChildAttempt(attempt);
    if (input.includeBody) return safeAttempt;
    const { error: _error, ...withoutError } = safeAttempt;
    return withoutError;
  });
  const coverage = aggregateWorkflowCoverage(attempts);
  if (canonicalJson(coverage) !== canonicalJson(input.coverage)) {
    throw new Error("invalid workflow aggregate coverage");
  }
  const resultSummary = input.includeBody
    ? safeErrorSummary(input.resultSummary) ?? "No output."
    : "Output persistence disabled.";
  const workflowName = input.workflowName === undefined ? undefined : safeErrorSummary(input.workflowName);
  const taskBinding = input.taskBinding === undefined ? undefined : { ...input.taskBinding };

  ensureExistingDirectory(input.taskDir, "task directory");
  const resultsDir = join(input.taskDir, "results");
  try {
    mkdirSync(resultsDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  ensureExistingDirectory(resultsDir, "results directory");

  const artifactDir = join(resultsDir, input.artifactId);
  const manifestPath = join(artifactDir, `${input.artifactId}.json`);
  const bodyPath = join(artifactDir, `${input.artifactId}.md`);
  try {
    mkdirSync(artifactDir, { mode: 0o700 });
  } catch (error) {
    ensureExistingDirectory(artifactDir, "workflow aggregate artifact directory");
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readExistingWorkflowAggregate(manifestPath, input.artifactId, bodyPath);
  }
  ensureExistingDirectory(artifactDir, "workflow aggregate artifact directory");

  let artifactStatus: WorkflowAggregateArtifactManifest["artifactStatus"] = "metadata-only";
  let artifactError: string | undefined;
  let resultBodyPath: string | undefined;
  let resultDigest: string | undefined;
  if (input.includeBody && input.result !== undefined) {
    const body = `${sanitizeArtifactText(input.result).replace(/\n*$/, "")}\n`;
    try {
      writeAtomic(bodyPath, body);
      artifactStatus = "complete";
      resultBodyPath = basename(bodyPath);
      resultDigest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    } catch (error) {
      artifactStatus = "failed";
      artifactError = formatArtifactWriteError("workflow aggregate body write failed", error);
    }
  }

  const manifest: WorkflowAggregateArtifactManifest = {
    schemaVersion: WORKFLOW_AGGREGATE_ARTIFACT_SCHEMA_VERSION,
    artifactId: input.artifactId,
    workflowId: input.workflowId,
    ...(workflowName !== undefined ? { workflowName } : {}),
    status: input.status,
    startedAt: new Date(input.startedAt).toISOString(),
    completedAt: new Date(input.completedAt).toISOString(),
    coverage,
    childAttempts: attempts,
    ...(input.evidenceIncomplete ? { evidenceIncomplete: true } : {}),
    resultSummary,
    ...(resultBodyPath !== undefined ? { resultBodyPath } : {}),
    ...(resultDigest !== undefined ? { resultDigest } : {}),
    ...(taskBinding !== undefined ? { taskBinding } : {}),
    artifactStatus,
    ...(input.error !== undefined
      ? (() => {
          const error = input.includeBody
            ? safeErrorSummary(input.error)
            : WORKFLOW_AGGREGATE_ERROR_DISABLED;
          return error !== undefined ? { error } : {};
        })()
      : {}),
    ...(artifactError !== undefined ? { artifactError } : {}),
  };

  writeAtomic(manifestPath, canonicalJson(manifest));
  return {
    manifestPath,
    ...(resultBodyPath !== undefined ? { bodyPath } : {}),
    status: artifactStatus,
    ...(artifactError !== undefined ? { error: artifactError } : {}),
  };
}
