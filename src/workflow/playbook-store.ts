import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isSymlink, isUnsafeName } from "../memory.js";
import { hasUnsafeControlDeep } from "./approval.js";
import {
  loadWorkflowPlaybookDirectory,
  WORKFLOW_PLAYBOOK_LIMITS,
  type WorkflowApprovalMode,
  type WorkflowPlaybook,
  type WorkflowPlaybookSource,
} from "./playbook.js";

const LOCK_OWNER_FILE = "owner.json";
const INCOMPLETE_LOCK_GRACE_MS = 30_000;

export type WorkflowPlaybookSaveScope = "global" | "project";

export interface WorkflowPlaybookDraft {
  approval?: WorkflowApprovalMode;
  body: string;
  description: string;
  domains?: string[];
  example: string;
  inputs?: Record<string, unknown>;
  name: string;
  prompts?: Record<string, string>;
  sideEffects?: string;
}

export interface WorkflowPlaybookSaveOptions {
  cwd: string;
  draft: WorkflowPlaybookDraft;
  expectedRevision?: string;
  overwrite?: boolean;
  scope: WorkflowPlaybookSaveScope;
}

export type WorkflowPlaybookSaveResult =
  | {
      created: boolean;
      ok: true;
      playbook: WorkflowPlaybook;
      target: string;
    }
  | {
      code: "conflict" | "invalid" | "io-error" | "locked" | "stale";
      message: string;
      ok: false;
    };

export interface WorkflowPlaybookPreview {
  files: Record<string, string>;
  root: string;
  target: string;
}

export type WorkflowPlaybookSaveFailure = Extract<WorkflowPlaybookSaveResult, { ok: false }>;
type WorkflowPlaybookLockResult = { ok: true; token: string } | WorkflowPlaybookSaveFailure;

interface LockPayload {
  pid: number;
  token: string;
}

export function workflowPlaybookSaveRoot(cwd: string, scope: WorkflowPlaybookSaveScope): string {
  return scope === "project" ? join(cwd, ".pi", "workflows") : join(getAgentDir(), "workflows");
}

export function workflowPlaybookLockPath(target: string): string {
  const digest = createHash("sha256").update(resolve(target)).digest("hex");
  return join(getAgentDir(), ".locks", "workflow-playbooks", digest);
}

export function previewWorkflowPlaybookSave(
  cwd: string,
  scope: WorkflowPlaybookSaveScope,
  draft: WorkflowPlaybookDraft,
): WorkflowPlaybookPreview | WorkflowPlaybookSaveFailure {
  const validation = validateDraft(draft);
  if (!validation.ok) return validation;
  const root = workflowPlaybookSaveRoot(cwd, scope);
  const target = join(root, draft.name);
  return { files: serializeDraft(draft), root, target };
}

export function saveWorkflowPlaybook(options: WorkflowPlaybookSaveOptions): WorkflowPlaybookSaveResult {
  const preview = previewWorkflowPlaybookSave(options.cwd, options.scope, options.draft);
  if ("ok" in preview) return preview;

  const safeRoot = ensureSafeRoot(preview.root);
  if (!safeRoot.ok) return safeRoot;
  if (existsSync(preview.target) && isSymlink(preview.target)) {
    return { ok: false, code: "invalid", message: `Refusing to replace symlinked Playbook directory ${preview.target}` };
  }

  const lockPath = workflowPlaybookLockPath(preview.target);
  const lock = acquireLock(lockPath);
  if (!lock.ok) return lock;
  const temporary = join(preview.root, `.${options.draft.name}.tmp-${lock.token.split(":").at(-1)}`);
  const backup = join(preview.root, `.${options.draft.name}.backup`);
  let backupMoved = false;

  try {
    recoverInterruptedReplacement(
      preview.target,
      backup,
      sourceFor(options.scope),
      options.draft.name,
    );
    if (existsSync(preview.target) && isSymlink(preview.target)) {
      return { ok: false, code: "invalid", message: `Refusing to replace symlinked Playbook directory ${preview.target}` };
    }
    const existing = existsSync(preview.target)
      ? loadWorkflowPlaybookDirectory(preview.target, sourceFor(options.scope))
      : undefined;

    if (existsSync(preview.target) && !existing) {
      return { ok: false, code: "invalid", message: `Existing Playbook at ${preview.target} is unreadable or invalid` };
    }
    if (existing && !options.overwrite) {
      return {
        ok: false,
        code: "conflict",
        message: `Playbook "${options.draft.name}" already exists at ${preview.target}; set overwrite with its revision`,
      };
    }
    if (existing) {
      if (!options.expectedRevision || options.expectedRevision !== existing.revision) {
        return {
          ok: false,
          code: "stale",
          message: `Playbook "${options.draft.name}" changed; read it again and use revision ${existing.revision}`,
        };
      }
    } else if (options.expectedRevision) {
      return { ok: false, code: "stale", message: `Playbook "${options.draft.name}" no longer exists` };
    }

    rmSync(temporary, { recursive: true, force: true });
    mkdirSync(temporary, { recursive: true });
    writeFiles(temporary, preview.files);
    const verified = loadWorkflowPlaybookDirectory(
      temporary,
      sourceFor(options.scope),
      options.draft.name,
    );
    if (!verified || verified.name !== options.draft.name) {
      return { ok: false, code: "invalid", message: "Serialized Playbook did not pass read-back validation" };
    }

    if (existing) {
      rmSync(backup, { recursive: true, force: true });
      renameSync(preview.target, backup);
      backupMoved = true;
    }
    try {
      renameSync(temporary, preview.target);
    } catch (error) {
      if (backupMoved && !existsSync(preview.target) && existsSync(backup)) {
        renameSync(backup, preview.target);
        backupMoved = false;
      }
      throw error;
    }
    const playbook = loadWorkflowPlaybookDirectory(preview.target, sourceFor(options.scope));
    if (!playbook) {
      rmSync(preview.target, { recursive: true, force: true });
      if (backupMoved && existsSync(backup)) {
        renameSync(backup, preview.target);
        backupMoved = false;
      }
      return { ok: false, code: "io-error", message: "Saved Playbook could not be read back" };
    }
    if (backupMoved) {
      rmSync(backup, { recursive: true, force: true });
      backupMoved = false;
    }
    return { ok: true, created: !existing, playbook, target: preview.target };
  } catch (error) {
    if (backupMoved && !existsSync(preview.target) && existsSync(backup)) {
      try { renameSync(backup, preview.target); } catch { /* preserve original error */ }
    }
    return {
      ok: false,
      code: "io-error",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try { rmSync(temporary, { recursive: true, force: true }); } catch { /* cleaned on the next locked save */ }
    releaseLock(lockPath, lock.token);
  }
}

function validateDraft(draft: WorkflowPlaybookDraft): WorkflowPlaybookSaveFailure | { ok: true } {
  if (!draft || typeof draft !== "object") return invalid("Playbook draft is required");
  if (isUnsafeName(draft.name)) return invalid(`Playbook name "${draft.name}" is not path-safe`);
  if (!draft.description?.trim()) return invalid("Playbook description is required");
  if (hasUnsafeControl(draft.description)) return invalid("Playbook description contains terminal control characters");
  if (draft.description.length > WORKFLOW_PLAYBOOK_LIMITS.maxDescriptionChars) {
    return invalid(`Playbook description exceeds ${WORKFLOW_PLAYBOOK_LIMITS.maxDescriptionChars} characters`);
  }
  if (!draft.body?.trim()) return invalid("Playbook coordinator prompt is required");
  if (hasUnsafeControl(draft.body)) return invalid("Playbook coordinator prompt contains terminal control characters");
  if (!draft.example?.trim()) return invalid("A generalized invocation example is required before saving");
  if (hasUnsafeControl(draft.example)) return invalid("Playbook invocation example contains terminal control characters");
  if (draft.approval && !["adaptive", "required", "none"].includes(draft.approval)) {
    return invalid("Playbook approval must be adaptive, required, or none");
  }
  if (draft.sideEffects && draft.sideEffects.length > 128) return invalid("sideEffects exceeds 128 characters");
  if (draft.sideEffects && hasUnsafeControl(draft.sideEffects)) {
    return invalid("sideEffects contains terminal control characters");
  }

  const domains = uniqueStrings(draft.domains);
  if (domains.some(hasUnsafeControl)) return invalid("Playbook domains contain terminal control characters");
  if (domains.length > 32) return invalid("Playbook domains exceeds 32 entries");
  const prompts = draft.prompts ?? {};
  const promptEntries = Object.entries(prompts);
  if (promptEntries.length > WORKFLOW_PLAYBOOK_LIMITS.maxPromptsPerPlaybook) {
    return invalid(`Playbook prompts exceeds ${WORKFLOW_PLAYBOOK_LIMITS.maxPromptsPerPlaybook} files`);
  }
  let aggregatePromptBytes = 0;
  for (const [name, content] of promptEntries) {
    if (isUnsafeName(name) || name.toLowerCase().endsWith(".md")) {
      return invalid(`Prompt name "${name}" must be path-safe and omit the .md extension`);
    }
    if (typeof content !== "string" || !content.trim()) return invalid(`Prompt "${name}" must be non-empty`);
    if (hasUnsafeControl(content)) return invalid(`Prompt "${name}" contains terminal control characters`);
    const bytes = Buffer.byteLength(content, "utf-8");
    if (bytes > WORKFLOW_PLAYBOOK_LIMITS.maxPromptBytes) {
      return invalid(`Prompt "${name}" exceeds ${WORKFLOW_PLAYBOOK_LIMITS.maxPromptBytes} bytes`);
    }
    aggregatePromptBytes += bytes;
  }
  if (aggregatePromptBytes > WORKFLOW_PLAYBOOK_LIMITS.maxAggregatePromptBytes) {
    return invalid(`Prompt resources exceed ${WORKFLOW_PLAYBOOK_LIMITS.maxAggregatePromptBytes} aggregate bytes`);
  }

  try {
    if (draft.inputs) {
      if (hasUnsafeControlDeep(draft.inputs)) {
        return invalid("Playbook inputs contain terminal control characters");
      }
      JSON.stringify(draft.inputs);
    }
  } catch (error) {
    return invalid(`Playbook inputs must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const files = serializeDraft({ ...draft, domains });
  const workflowBytes = Buffer.byteLength(files["WORKFLOW.md"] ?? "", "utf-8");
  if (workflowBytes > WORKFLOW_PLAYBOOK_LIMITS.maxPlaybookBytes) {
    return invalid(`WORKFLOW.md exceeds ${WORKFLOW_PLAYBOOK_LIMITS.maxPlaybookBytes} bytes`);
  }
  return { ok: true };
}

function serializeDraft(draft: WorkflowPlaybookDraft): Record<string, string> {
  const lines = [
    "---",
    `name: ${yamlScalar(draft.name)}`,
    `description: ${yamlScalar(draft.description.trim())}`,
    "execution: adaptive",
  ];
  const domains = uniqueStrings(draft.domains);
  if (domains.length > 0) {
    lines.push("domains:");
    for (const domain of domains) lines.push(`  - ${yamlScalar(domain)}`);
  }
  lines.push(`approval: ${draft.approval ?? "adaptive"}`);
  lines.push(`side_effects: ${yamlScalar(draft.sideEffects?.trim() || "unknown")}`);
  if (draft.inputs && Object.keys(draft.inputs).length > 0) {
    lines.push(`inputs: ${JSON.stringify(draft.inputs)}`);
  }
  lines.push(`example: ${yamlScalar(draft.example.trim())}`);
  lines.push("---", "", draft.body.trim(), "");

  const files: Record<string, string> = { "WORKFLOW.md": lines.join("\n") };
  for (const [name, content] of Object.entries(draft.prompts ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    files[join("prompts", `${name}.md`)] = `${content.trim()}\n`;
  }
  return files;
}

function writeFiles(directory: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(directory, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf-8");
  }
}

function ensureSafeRoot(root: string): WorkflowPlaybookSaveResult | { ok: true } {
  const parent = dirname(root);
  if ((existsSync(parent) && isSymlink(parent)) || (existsSync(root) && isSymlink(root))) {
    return invalid(`Refusing to save through symlinked workflow root ${root}`);
  }
  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      code: "io-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { ok: true };
}

function recoverInterruptedReplacement(
  target: string,
  backup: string,
  source: WorkflowPlaybookSource,
  name: string,
): void {
  if (!existsSync(target) && existsSync(backup)) {
    renameSync(backup, target);
    return;
  }
  if (!existsSync(target) || !existsSync(backup)) return;
  const installed = loadWorkflowPlaybookDirectory(target, source, name);
  if (installed) {
    rmSync(backup, { recursive: true, force: true });
    return;
  }
  rmSync(target, { recursive: true, force: true });
  renameSync(backup, target);
}

function acquireLock(path: string): WorkflowPlaybookLockResult {
  const token = `${process.pid}:${randomUUID()}`;
  const root = dirname(path);
  try {
    if ((existsSync(dirname(root)) && isSymlink(dirname(root))) || (existsSync(root) && isSymlink(root))) {
      return { ok: false, code: "io-error", message: `Refusing symlinked Playbook lock root ${root}` };
    }
    mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch (error) {
    return { ok: false, code: "io-error", message: error instanceof Error ? error.message : String(error) };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      mkdirSync(path, { mode: 0o700 });
      try {
        writeFileSync(join(path, LOCK_OWNER_FILE), JSON.stringify({ pid: process.pid, token }), {
          encoding: "utf-8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        rmSync(path, { recursive: true, force: true });
        return { ok: false, code: "io-error", message: error instanceof Error ? error.message : String(error) };
      }
      return { ok: true, token };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") {
        return { ok: false, code: "io-error", message: error instanceof Error ? error.message : String(error) };
      }
      if (isSymlink(path)) return { ok: false, code: "locked", message: "Refusing symlinked Playbook lock" };
      const existing = readLock(path);
      if (existing && processIsAlive(existing.pid)) {
        return { ok: false, code: "locked", message: `Playbook is being modified by process ${existing.pid}` };
      }
      if (!existing && lockAgeMs(path) < INCOMPLETE_LOCK_GRACE_MS) {
        return { ok: false, code: "locked", message: "Playbook lock owner is still being published" };
      }

      const observed = lockIdentity(path);
      const quarantine = `${path}.stale-${randomUUID()}`;
      try {
        renameSync(path, quarantine);
      } catch {
        continue;
      }
      const moved = lockIdentity(quarantine);
      if (!observed || !moved || observed.dev !== moved.dev || observed.ino !== moved.ino) {
        try {
          if (!existsSync(path)) renameSync(quarantine, path);
        } catch { /* preserve the quarantined lock for manual recovery */ }
        return { ok: false, code: "locked", message: "Playbook lock changed while reclaiming it" };
      }
      rmSync(quarantine, { recursive: true, force: true });
    }
  }
  return { ok: false, code: "locked", message: "Could not acquire Playbook lock" };
}

function readLock(path: string): LockPayload | undefined {
  try {
    const value = JSON.parse(readFileSync(join(path, LOCK_OWNER_FILE), "utf-8")) as Partial<LockPayload>;
    return typeof value.pid === "number" && typeof value.token === "string"
      ? { pid: value.pid, token: value.token }
      : undefined;
  } catch {
    return undefined;
  }
}

function releaseLock(path: string, token: string): void {
  try {
    if (readLock(path)?.token === token) rmSync(path, { recursive: true, force: true });
  } catch { /* already removed */ }
}

function lockAgeMs(path: string): number {
  try {
    return Math.max(0, Date.now() - statSync(path).mtimeMs);
  } catch {
    return 0;
  }
}

function lockIdentity(path: string): { dev: number; ino: number } | undefined {
  try {
    const stats = statSync(path);
    return { dev: stats.dev, ino: stats.ino };
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function sourceFor(scope: WorkflowPlaybookSaveScope): WorkflowPlaybookSource {
  return scope === "project" ? "project" : "global";
}

function uniqueStrings(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function hasUnsafeControl(value: string): boolean {
  const normalized = value.replace(/\r\n/g, "\n");
  return /[\u0000-\u0008\u000B\u000C\u000D\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/.test(normalized);
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function invalid(message: string): WorkflowPlaybookSaveFailure {
  return { ok: false, code: "invalid", message };
}
