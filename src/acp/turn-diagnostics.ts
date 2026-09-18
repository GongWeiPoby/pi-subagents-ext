import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { PromptResponse } from "@agentclientprotocol/sdk";

const DIAGNOSTIC_TAIL_BYTES = 64 * 1024;
const DISPLAY_STDERR_BYTES = 900;
const DISPLAY_STDERR_LINES = 12;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password)\s*[:=]\s*["']?)[^\s,"']+/gi, "$1[REDACTED]");
}

function boundedLines(value: string, maxLines: number, maxBytes: number): string {
  const lines = sanitizeDiagnostic(value).split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean);
  const picked: string[] = [];
  let bytes = 0;
  for (const line of lines.reverse()) {
    const lineBytes = Buffer.byteLength(line);
    if (picked.length >= maxLines || bytes + lineBytes > maxBytes) break;
    picked.push(line);
    bytes += lineBytes;
  }
  return picked.reverse().join("\n");
}

function stderrEvidence(before: string, after: string): string | undefined {
  const fresh = after.startsWith(before) ? after.slice(before.length) : "";
  const scoped = boundedLines(fresh, DISPLAY_STDERR_LINES, DISPLAY_STDERR_BYTES);
  if (scoped) return `stderr (this turn):\n${scoped}`;
  const recent = boundedLines(after, DISPLAY_STDERR_LINES, DISPLAY_STDERR_BYTES);
  return recent ? `stderr (recent):\n${recent}` : undefined;
}

function promptFailure(response: PromptResponse): string | undefined {
  const meta = object(response._meta);
  const jetbrains = object(meta?.jetbrains);
  const air = object(jetbrains?.air);
  const failure = object(air?.sessionFailure);
  let raw: string | undefined;
  if (failure) {
    const title = text(failure.title);
    const details = text(failure.details);
    if (title || details) raw = [title, details].filter(Boolean).join(": ");
  } else {
    const codex = object(meta?.codex);
    const codexError = object(codex?.error);
    raw = text(codexError?.message) ?? text(codexError?.error);
  }
  return raw ? sanitizeDiagnostic(raw) : undefined;
}

function readTail(path: string): string | undefined {
  try {
    const size = statSync(path).size;
    const length = Math.min(size, DIAGNOSTIC_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    return buffer.toString("utf8");
  } catch {
    return undefined;
  }
}

function kimiCodeFailure(sessionId: string, home: string): string | undefined {
  const sessionsRoot = resolve(home, "sessions");
  const index = readTail(join(home, "session_index.jsonl"));
  if (!index) return undefined;
  let sessionDir: string | undefined;
  for (const line of index.split(/\r?\n/)) {
    try {
      const entry = object(JSON.parse(line));
      if (entry?.sessionId === sessionId && typeof entry.sessionDir === "string") {
        sessionDir = entry.sessionDir;
      }
    } catch { /* partial or malformed index line */ }
  }
  if (!sessionDir || !isAbsolute(sessionDir)) return undefined;
  const resolvedDir = resolve(sessionDir);
  if (resolvedDir !== sessionsRoot && !resolvedDir.startsWith(`${sessionsRoot}${sep}`)) return undefined;
  const wire = readTail(join(resolvedDir, "agents", "main", "wire.jsonl"));
  if (!wire) return undefined;
  let failure: string | undefined;
  for (const line of wire.split(/\r?\n/)) {
    try {
      const event = object(JSON.parse(line));
      if (event?.type !== "turn.ended" || event.reason !== "failed") continue;
      const error = object(event.error);
      const message = text(error?.message);
      const name = text(error?.name);
      if (message) failure = name ? `${name}: ${message}` : message;
    } catch { /* partial or malformed wire line */ }
  }
  return failure ? sanitizeDiagnostic(failure) : undefined;
}

export interface EmptyTurnDiagnosticInput {
  registryId: string;
  agentName: string;
  sessionId: string;
  response: PromptResponse;
  stderrBefore: string;
  stderrAfter: string;
  env: NodeJS.ProcessEnv;
}

/** Diagnose ACP `end_turn` responses that carried no assistant text. */
export function emptyTurnError(input: EmptyTurnDiagnosticInput): string {
  const details = [
    promptFailure(input.response),
    stderrEvidence(input.stderrBefore, input.stderrAfter),
    input.registryId === "kimi-code"
      ? kimiCodeFailure(
          input.sessionId,
          input.env.KIMI_CODE_HOME?.trim() || join(homedir(), ".kimi-code"),
        )
      : undefined,
  ].filter((item): item is string => item !== undefined);
  const base = `${input.agentName} ended the turn without producing any response.`;
  return details.length > 0 ? `${base}\n${details.join("\n")}` : base;
}
