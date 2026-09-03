/**
 * output-file.ts — Streaming JSONL output file for agent transcripts.
 *
 * Creates a per-agent output file that streams conversation turns as JSONL,
 * matching Claude Code's task output file format.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const INTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CWD_HASH_LENGTH = 64;
const CWD_PREFIX_MAX_LENGTH = 128 - CWD_HASH_LENGTH - 1;

/** Validate a single component used in an internal session/result path. */
export function assertSafeInternalId(value: string, label: string): void {
  if (typeof value !== "string"
    || !INTERNAL_ID_PATTERN.test(value)
    || value.includes("..")) {
    throw new Error(`invalid ${label}`);
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function ensureDirectory(path: string, label: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }

  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`invalid ${label}`);
  // On POSIX, a predictable root must not be adopted from another user. This
  // also keeps a root process from making an attacker-owned directory private
  // while the attacker remains its owner.
  if (process.platform !== "win32" && process.getuid && stat.uid !== process.getuid()) {
    throw new Error(`invalid ${label} owner`);
  }
  try {
    chmodSync(path, 0o700);
  } catch (error) {
    // chmod is a no-op on Windows and throws on some Windows filesystems.
    if (process.platform !== "win32") throw error;
  }
}

/**
 * Project/global default for writing subagent `.output` transcripts and optional
 * Agent/workflow result bodies; custom `output_transcript` overrides Agents only.
 */
let outputTranscriptDefault = true;

export function getOutputTranscriptDefault(): boolean { return outputTranscriptDefault; }
export function setOutputTranscriptDefault(b: boolean): void { outputTranscriptDefault = b; }

/**
 * Encode the resolved cwd as a readable, collision-resistant internal ID.
 * The full SHA-256 suffix is the project identity; the bounded path suffix is
 * only for humans inspecting the private temp root.
 */
export function encodeCwd(cwd: string): string {
  const canonicalCwd = resolve(cwd);
  const readable = canonicalCwd
    .replace(/[/\\]+/g, "-")
    .replace(/^[A-Za-z]:-/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-+$/, "");
  const prefix = readable
    .slice(-CWD_PREFIX_MAX_LENGTH)
    .replace(/^[^A-Za-z0-9]+/, "") || "root";
  const hash = createHash("sha256").update(canonicalCwd).digest("hex");
  return `${prefix}-${hash}`;
}

/**
 * The per-session scratch directory, created if missing.
 * Layout: /tmp/{prefix}-{uid}/{readable-cwd-prefix}-{sha256}/{sessionId}/tasks
 *
 * The hashed resolved cwd keeps equal session IDs isolated between projects.
 * Older unhashed directory names are intentionally never consulted.
 *
 * Shared with the workflow tool, which persists each invocation's script here so
 * iterating on one is edit-file-then-rerun — the same convention, one directory.
 */
export function sessionTaskDir(cwd: string, sessionId: string): string {
  assertSafeInternalId(sessionId, "session id");
  const encoded = encodeCwd(cwd);
  assertSafeInternalId(encoded, "encoded cwd");
  const root = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`);
  ensureDirectory(root, "session root");
  const cwdDir = join(root, encoded);
  ensureDirectory(cwdDir, "cwd directory");
  const sessionDir = join(cwdDir, sessionId);
  ensureDirectory(sessionDir, "session directory");
  const dir = join(sessionDir, "tasks");
  ensureDirectory(dir, "task directory");
  return dir;
}

/** Create the output file path, ensuring the directory exists. */
export function createOutputFilePath(cwd: string, agentId: string, sessionId: string): string {
  assertSafeInternalId(agentId, "agent id");
  assertSafeInternalId(sessionId, "session id");
  return join(sessionTaskDir(cwd, sessionId), `${agentId}.output`);
}

/** Recheck the final parent before every transcript open. */
function ensureOutputParent(path: string): void {
  const parent = join(path, "..");
  const stat = lstatSync(parent);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("invalid output directory");
}

/** Open an existing transcript for append without following a final symlink. */
function openExistingForAppend(path: string): number {
  ensureOutputParent(path);
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  if (noFollow !== 0) {
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | noFollow);
    try {
      if (!fstatSync(fd).isFile()) throw new Error("invalid output file");
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  // Node does not expose FILE_FLAG_OPEN_REPARSE_POINT on Windows. Pin the
  // opened handle and verify that the path still names the same regular file
  // before writing. A replacement after this check cannot redirect the fd.
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("invalid output file");
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND);
  try {
    const opened = fstatSync(fd);
    const after = lstatSync(path);
    if (!opened.isFile()
      || after.isSymbolicLink()
      || !after.isFile()
      || before.dev !== opened.dev
      || before.ino !== opened.ino
      || after.dev !== opened.dev
      || after.ino !== opened.ino) {
      throw new Error("output file changed while opening");
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Create a transcript exclusively, so an existing file or symlink always wins. */
function createForAppend(path: string): number {
  ensureOutputParent(path);
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  return openSync(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600,
  );
}

function openForAppend(path: string): number {
  try {
    return openExistingForAppend(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return createForAppend(path);
  }
}

function appendSecurely(path: string, content: string): void {
  const fd = openForAppend(path);
  try {
    if (content) writeFileSync(fd, content, "utf-8");
  } finally {
    closeSync(fd);
  }
}

function createSecurely(path: string, content: string): void {
  const fd = createForAppend(path);
  try {
    writeFileSync(fd, content, "utf-8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Ensure a transcript file exists without disturbing what is already in it.
 *
 * A resume reuses the agent's existing transcript (same deterministic path), so
 * it must never call `writeInitialEntry` — that truncates, discarding turns the
 * completion notification still points the user at, and any history the session
 * has since compacted away is gone for good. Opening an append fd creates the
 * file exclusively when absent and verifies the final file when it exists.
 */
export function ensureOutputFile(path: string): void {
  try {
    appendSecurely(path, "");
  } catch { /* ignore — streaming writes are best-effort too */ }
}

/** Write the initial user prompt entry. */
export function writeInitialEntry(path: string, agentId: string, prompt: string, cwd: string): void {
  const entry = {
    isSidechain: true,
    agentId,
    type: "user",
    message: { role: "user", content: prompt },
    timestamp: new Date().toISOString(),
    cwd,
  };
  createSecurely(path, JSON.stringify(entry) + "\n");
}

/**
 * Subscribe to session events and flush new messages to the output file on each turn_end.
 * Returns a cleanup function that does a final flush and unsubscribes.
 */
export function streamToOutputFile(
  session: AgentSession,
  path: string,
  agentId: string,
  cwd: string,
  startIndex?: number,
): () => void {
  // Index of the first message this stream is responsible for. A spawn writes
  // messages[0] as the initial prompt entry, so it starts at 1. A resume hands
  // in the session's length as of just before the run: the session already
  // holds every prior turn, and re-emitting those would duplicate history that
  // is already in the file.
  let writtenCount = startIndex ?? 1;

  const flush = () => {
    const messages = session.messages;
    while (writtenCount < messages.length) {
      const msg = messages[writtenCount];
      const entry = {
        isSidechain: true,
        agentId,
        type: msg.role === "assistant" ? "assistant" : msg.role === "user" ? "user" : "toolResult",
        message: msg,
        timestamp: new Date().toISOString(),
        cwd,
      };
      try {
        appendSecurely(path, JSON.stringify(entry) + "\n");
      } catch { /* ignore write errors */ }
      writtenCount++;
    }
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") flush();
    // Compaction replaces session.messages with a shorter, summarized array,
    // leaving writtenCount past the new end — without re-anchoring, the flush
    // loop would never match again and streaming would halt for good (#145).
    // Flush before it runs so any not-yet-flushed tail still reaches the file,
    // then re-anchor to the rebuilt array once it lands. The re-anchor is
    // deferred a microtask because on the overflow-retry path pi trims the
    // trailing error assistant message AFTER emitting compaction_end —
    // anchoring synchronously would sit one past the trimmed array and skip
    // the first post-compaction message. Aborted/failed compactions leave
    // session.messages untouched, so only successful ones re-anchor.
    if (event.type === "compaction_start") flush();
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      queueMicrotask(() => { writtenCount = session.messages.length; });
    }
  });

  return () => {
    flush();
    unsubscribe();
  };
}
