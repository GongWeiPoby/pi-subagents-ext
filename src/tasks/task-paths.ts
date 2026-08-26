/**
 * task-paths.ts — Where session task files live.
 *
 * `session` scope keeps them in the workspace, as it always has. `session-global`
 * keeps them under pi's agent directory instead, beside pi's own per-workspace
 * session logs, for people who would rather their repositories stayed clean.
 *
 * The choice only ever decides where a *new* file is created. A session already
 * holding a file in the workspace or under the pre-hash global directory keeps
 * using it, so opting in and upgrading move nothing.
 */

import { createHash } from "node:crypto";
import { existsSync, rmdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TasksConfig } from "./tasks-config.js";

type TaskScope = NonNullable<TasksConfig["taskScope"]>;

/**
 * Directory name standing for one workspace.
 *
 * Starts with pi's readable workspace encoding and appends a stable hash. The
 * readable encoding alone aliases paths such as `a-b/c` and `a/b-c`; the suffix
 * keeps unrelated workspaces isolated while retaining a recognizable name.
 */
function legacyProjectKey(cwd: string): string {
  return `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function projectKey(cwd: string): string {
  const resolved = resolve(cwd);
  const readable = legacyProjectKey(resolved).slice(0, -2);
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return `${readable}-${hash}--`;
}

/** Where `session-global` collects one workspace's session files.
 *  Resolved per call, never captured: `getAgentDir()` reads the environment. */
export function globalSessionTasksDir(cwd: string): string {
  return join(getAgentDir(), "tasks", "sessions", projectKey(cwd));
}

function legacyGlobalSessionTasksDir(cwd: string): string {
  return join(getAgentDir(), "tasks", "sessions", legacyProjectKey(cwd));
}

/** The compatibility path used by releases before collision-resistant keys. */
function legacyGlobalSessionTaskFile(cwd: string, sessionId: string): string {
  return join(legacyGlobalSessionTasksDir(cwd), `tasks-${sessionId}.json`);
}

/** The in-workspace location, unchanged since session scope was introduced. */
export function workspaceSessionTaskFile(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", "tasks", `tasks-${sessionId}.json`);
}

/**
 * File backing one persisted session.
 *
 * Under `session-global` the workspace is still consulted first: a session that
 * already has a file there is still that file's session, and reading it is the
 * whole reason no migration is needed.
 */
export function sessionTaskFile(cwd: string, sessionId: string, scope: TaskScope): string {
  const inWorkspace = workspaceSessionTaskFile(cwd, sessionId);
  if (scope !== "session-global") return inWorkspace;
  if (existsSync(inWorkspace)) return inWorkspace;
  const legacy = legacyGlobalSessionTaskFile(cwd, sessionId);
  return existsSync(legacy) ? legacy : join(globalSessionTasksDir(cwd), `tasks-${sessionId}.json`);
}

/**
 * Remove a workspace's global session directory once it holds nothing.
 *
 * Only the global tree is ever reclaimed. `<workspace>/.pi/tasks/` is left alone
 * even when it empties, because that is what every release so far has done and
 * `.pi/` holds project config that is not ours.
 */
export function reclaimGlobalSessionTasksDir(cwd: string): void {
  for (const directory of [globalSessionTasksDir(cwd), legacyGlobalSessionTasksDir(cwd)]) {
    try { rmdirSync(directory); } catch { /* other sessions still stored */ }
  }
}
