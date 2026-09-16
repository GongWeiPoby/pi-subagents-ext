import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApprovedAcpAgent } from "./registry.js";

const GROK_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "plan",
]);

function tomlString(source: string, key: string): string | undefined {
  const match = source.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`, "m"));
  return match?.[1];
}

function migrateGrokPermissionMode(value: string): string {
  if (value === "always-approve") return "bypassPermissions";
  if (value === "ask") return "default";
  return value;
}

export function grokPermissionModeFromToml(source: string): string | undefined {
  const ui = source.match(/\[ui\]([\s\S]*?)(?=\n\[|$)/);
  const raw = ui ? tomlString(ui[1], "permission_mode") : tomlString(source, "permission_mode");
  if (!raw) return undefined;
  const mode = migrateGrokPermissionMode(raw);
  if (mode === "default" || !GROK_PERMISSION_MODES.has(mode)) return undefined;
  return mode;
}

export function grokLaunchPermissionMode(home = homedir()): string | undefined {
  const path = join(home, ".grok", "config.toml");
  if (!existsSync(path)) return undefined;
  try {
    return grokPermissionModeFromToml(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function grokLaunchArgs(args: readonly string[], home = homedir()): string[] {
  const next = [...args];
  const agentIndex = next.indexOf("agent");
  const insertAt = agentIndex >= 0 ? agentIndex : 0;
  const mode = grokLaunchPermissionMode(home);
  if (mode && !next.includes("--permission-mode")) {
    next.splice(insertAt, 0, "--permission-mode", mode);
  }
  if (!next.includes("--no-auto-update")) {
    next.splice(insertAt, 0, "--no-auto-update");
  }
  return next;
}

export function cursorLaunchArgs(args: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const next = [...args];
  const force = env.CURSOR_FORCE?.trim();
  if (force && force !== "0" && force.toLowerCase() !== "false" && !next.includes("--force")) {
    next.unshift("--force");
  }
  const model = env.CURSOR_MODEL?.trim();
  if (model && !next.includes("--model")) {
    next.unshift("--model", model);
  }
  return next;
}

export function codexInitialAgentModeFromToml(source: string): string | undefined {
  if (/^\s*default_permissions\s*=/m.test(source)) return undefined;
  const sandbox = tomlString(source, "sandbox_mode");
  const approval = tomlString(source, "approval_policy");
  const never = approval === "never";
  if (sandbox === "read-only") return "read-only";
  if (sandbox === "workspace-write") return "agent";
  if (sandbox === "danger-full-access") return never ? "agent-full-access" : "agent";
  return undefined;
}

export function codexLaunchInitialAgentMode(home = homedir()): string | undefined {
  const path = join(home, ".codex", "config.toml");
  if (!existsSync(path)) return undefined;
  try {
    return codexInitialAgentModeFromToml(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function applyAdapterLaunchEnv(
  env: NodeJS.ProcessEnv,
  approval: ApprovedAcpAgent,
  home = homedir(),
): NodeJS.ProcessEnv {
  const next = { ...env };
  if (approval.staticEnv.npm_config_prefix === undefined) delete next.npm_config_prefix;
  if (approval.staticEnv.NPM_CONFIG_PREFIX === undefined) delete next.NPM_CONFIG_PREFIX;
  if (approval.registryId === "codex-acp") {
    next.DISABLE_MCP_CONFIG_FILTERING = "true";
    if (!next.INITIAL_AGENT_MODE?.trim()) {
      const mode = codexLaunchInitialAgentMode(home);
      if (mode) next.INITIAL_AGENT_MODE = mode;
    }
  }
  return next;
}

export function launchArgsFor(approval: ApprovedAcpAgent, env: NodeJS.ProcessEnv, home = homedir()): string[] {
  if (approval.registryId === "grok" || approval.registryId === "grok-build") {
    return grokLaunchArgs(approval.args, home);
  }
  if (approval.registryId === "cursor") return cursorLaunchArgs(approval.args, env);
  return [...approval.args];
}
