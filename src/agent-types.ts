/**
 * agent-types.ts — Unified agent type registry.
 *
 * Registers user-defined agents from project, workspace, and global agent files.
 * Disabled agents are kept but excluded from spawning. No implicit agents exist.
 */

import { createCodingTools, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./types.js";

/**
 * All known built-in tool names, derived from pi's own tool factories rather
 * than hardcoded so the set tracks pi-mono if it adds/renames a built-in.
 * `createCodingTools` → read/bash/edit/write; `createReadOnlyTools` →
 * read/grep/find/ls; their de-duplicated union is the 7 built-ins
 * (read, bash, edit, write, grep, find, ls). The `cwd` only binds tool
 * operations we never invoke here — we read each tool's `.name` and discard it.
 */
export const BUILTIN_TOOL_NAMES: string[] = [
  ...new Set([...createCodingTools("."), ...createReadOnlyTools(".")].map((t) => t.name)),
];

/** Runtime registry of user-defined agents. */
const agents = new Map<string, AgentConfig>();

/** Explicit user choice for workflow calls that omit agentType. */
let defaultAgent: string | undefined;

export function getDefaultAgent(): string | undefined { return defaultAgent; }
export function setDefaultAgent(value: string | undefined): void { defaultAgent = value?.trim() || undefined; }

/**
 * Build an independent registry from user definitions only.
 * Pure — callers that must not disturb the process-wide registry (nested
 * delegation resolving agents from its own config root) build their own map.
 */
export function buildAgentRegistry(userAgents: Map<string, AgentConfig>): Map<string, AgentConfig> {
  return new Map(userAgents);
}

/**
 * Register agents into the unified registry.
 * Disabled agents (enabled === false) are kept in the registry but excluded from spawning.
 */
export function registerAgents(userAgents: Map<string, AgentConfig>): void {
  agents.clear();
  for (const [name, config] of buildAgentRegistry(userAgents)) {
    agents.set(name, config);
  }
}

/** Case-insensitive key resolution within a registry. */
function resolveKeyIn(registry: Map<string, AgentConfig>, name: string): string | undefined {
  if (registry.has(name)) return name;
  const lower = name.toLowerCase();
  for (const key of registry.keys()) {
    if (key.toLowerCase() === lower) return key;
  }
  return undefined;
}

/** Case-insensitive key resolution. */
function resolveKey(name: string): string | undefined {
  return resolveKeyIn(agents, name);
}

/** Resolve a type name case-insensitively in a registry. Returns the canonical key or undefined. */
export function resolveTypeIn(registry: Map<string, AgentConfig>, name: string): string | undefined {
  return resolveKeyIn(registry, name);
}

/** Get the agent config for a type (case-insensitive) from a registry. */
export function getAgentConfigIn(registry: Map<string, AgentConfig>, name: string): AgentConfig | undefined {
  const key = resolveKeyIn(registry, name);
  return key ? registry.get(key) : undefined;
}

/** Check if a type is valid and enabled (case-insensitive) in a registry. */
export function isValidTypeIn(registry: Map<string, AgentConfig>, type: string): boolean {
  const key = resolveKeyIn(registry, type);
  if (!key) return false;
  return registry.get(key)?.enabled !== false;
}

/** Get all enabled type names in a registry (for spawning and tool descriptions). */
export function getAvailableTypesIn(registry: Map<string, AgentConfig>): string[] {
  return [...registry.entries()]
    .filter(([_, config]) => config.enabled !== false)
    .map(([name]) => name);
}

/**
 * Case-insensitive resolution that refuses to guess. An exact match always wins;
 * otherwise the name must match exactly one key. Two agents differing only in
 * case are reachable (`loadCustomAgents` keys by filename across three
 * directories), and picking whichever came first would silently dispatch a
 * different agent, model and tool policy than the caller meant.
 */
function resolveUnambiguousKeyIn(registry: Map<string, AgentConfig>, name: string): string | undefined {
  if (registry.has(name)) return name;
  const lower = name.toLowerCase();
  const matches = [...registry.keys()].filter(key => key.toLowerCase() === lower);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The canonical key for a caller-supplied name that identifies exactly one
 * ENABLED agent, or undefined. Strict by construction: no fallback, no guessing
 * between case-variants. Nested delegation resolves with this directly, since
 * "unknown types are rejected rather than falling back" is its own contract.
 */
export function resolveEnabledTypeIn(
  registry: Map<string, AgentConfig>,
  requested: unknown,
): string | undefined {
  const raw = typeof requested === "string" ? requested.trim() : "";
  if (!raw) return undefined;
  const key = resolveUnambiguousKeyIn(registry, raw);
  return key !== undefined && registry.get(key)?.enabled !== false ? key : undefined;
}

/** Outcome of resolving a caller-supplied `subagent_type` into a spawnable type. */
export type SpawnTypeResolution =
  | { ok: true; type: string }
  /** Refuse the spawn and return this message to the caller. */
  | { ok: false; message: string };

/**
 * Resolve a caller-supplied type without substituting another agent.
 *
 * Unknown, disabled, and case-ambiguous names are all treated the same way:
 * the caller named something that doesn't identify exactly one enabled agent.
 *
 * Pure over `registry` — callers that need fresh agent files reload before
 * calling (the Agent tool already does, per spawn). Reloading here would mean
 * importing custom-agents.ts, which imports this module.
 */
export function resolveSpawnTypeIn(
  registry: Map<string, AgentConfig>,
  requested: unknown,
): SpawnTypeResolution {
  const raw = typeof requested === "string" ? requested.trim() : "";
  const available = () => getAvailableTypesIn(registry).join(", ") || "(none)";

  const key = resolveEnabledTypeIn(registry, raw);
  if (key !== undefined) return { ok: true, type: key };

  const reason = raw ? `Unknown or disabled agent type: "${raw}".` : "No agent type given.";
  return {
    ok: false,
    message: `${reason} Available: ${available()}. Define an agent in .pi/agents/, .agents/agents/, or your global agent directory; /agents can create one.`,
  };
}

/** Resolve a caller-supplied agent type against the process-wide registry. */
export function resolveSpawnType(requested: unknown): SpawnTypeResolution {
  return resolveSpawnTypeIn(agents, requested);
}

/** Resolve a type name case-insensitively. Returns the canonical key or undefined. */
export function resolveType(name: string): string | undefined {
  return resolveKey(name);
}

/** Get the agent config for a type (case-insensitive). */
export function getAgentConfig(name: string): AgentConfig | undefined {
  return getAgentConfigIn(agents, name);
}

/** Get all enabled type names (for spawning and tool descriptions). */
export function getAvailableTypes(): string[] {
  return getAvailableTypesIn(agents);
}

/** Get all type names including disabled (for UI listing). */
export function getAllTypes(): string[] {
  return [...agents.keys()];
}

/** Check if a type is valid and enabled (case-insensitive). */
export function isValidType(type: string): boolean {
  return isValidTypeIn(agents, type);
}

/** Tool names required for memory management. */
const MEMORY_TOOL_NAMES = ["read", "write", "edit"];

/**
 * Get memory tool names (read/write/edit) not already in the provided set.
 */
export function getMemoryToolNames(existingToolNames: Set<string>): string[] {
  return MEMORY_TOOL_NAMES.filter(n => !existingToolNames.has(n));
}

/** Tool names needed for read-only memory access. */
const READONLY_MEMORY_TOOL_NAMES = ["read"];

/**
 * Get read-only memory tool names not already in the provided set.
 */
export function getReadOnlyMemoryToolNames(existingToolNames: Set<string>): string[] {
  return READONLY_MEMORY_TOOL_NAMES.filter(n => !existingToolNames.has(n));
}

/** Get built-in tool names for a type (case-insensitive). */
export function getToolNamesForType(type: string): string[] {
  const dispatch = resolveSpawnType(type);
  if (!dispatch.ok) throw new Error(dispatch.message);
  const config = agents.get(dispatch.type)!;
  // `undefined` (definition omitted the field) → all built-ins; an explicit `[]`
  // (`tools: none` or a `tools:` with only `ext:` entries) → zero built-ins.
  return config.builtinToolNames ?? [...BUILTIN_TOOL_NAMES];
}

/** Display/config view. Missing definitions have no capabilities; execution rejects them. */
export function getConfig(type: string): {
  displayName: string;
  color?: string;
  description: string;
  builtinToolNames: string[];
  extensions: true | string[] | false;
  excludeExtensions?: string[];
  skills: AgentConfig["skills"];
  promptMode: "replace" | "append";
} {
  const key = resolveKey(type);
  const config = key ? agents.get(key) : undefined;
  if (config && config.enabled !== false) {
    return {
      displayName: config.displayName ?? config.name,
      color: config.color,
      description: config.description,
      builtinToolNames: config.builtinToolNames ?? BUILTIN_TOOL_NAMES,
      extensions: config.extensions,
      excludeExtensions: config.excludeExtensions,
      skills: config.skills,
      promptMode: config.promptMode,
    };
  }

  return {
    displayName: type,
    description: "Agent definition unavailable",
    builtinToolNames: [],
    extensions: false,
    skills: false,
    promptMode: "replace",
  };
}
