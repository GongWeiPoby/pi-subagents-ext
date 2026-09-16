import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { handleBase } from "../mention.js";

export const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const APPROVALS_VERSION = 1;
const REGISTRY_CACHE_VERSION = 1;
const MAX_REGISTRY_BYTES = 5 * 1024 * 1024;
const REGISTRY_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export interface ApprovedAcpAgent {
  registryId: string;
  displayName: string;
  handle: string;
  registryVersion: string;
  sourceUrl: string;
  command: string;
  args: string[];
  staticEnv: Record<string, string>;
  approvedAt: string;
  enabled: boolean;
}

export interface AcpApprovalsStore {
  version: 1;
  agents: ApprovedAcpAgent[];
}

export interface AcpRegistryNpxDistribution {
  package: string;
  args: string[];
  env: Record<string, string>;
}

export interface AcpRegistryUvxDistribution {
  package: string;
  args: string[];
  env: Record<string, string>;
}

export interface AcpRegistryBinaryTarget {
  archive: string;
  cmd: string;
  args: string[];
  env: Record<string, string>;
  sha256?: string;
}

export interface AcpRegistryAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  repository?: string;
  website?: string;
  distribution: {
    npx?: AcpRegistryNpxDistribution;
    uvx?: AcpRegistryUvxDistribution;
    binary?: Record<string, AcpRegistryBinaryTarget>;
  };
}

export interface AcpRegistryIndex {
  version: string;
  agents: AcpRegistryAgent[];
}

interface AcpRegistryCache {
  version: 1;
  fetchedAt: string;
  registry: AcpRegistryIndex;
}

export interface AcpLaunchCandidate {
  registryId: string;
  displayName: string;
  registryVersion: string;
  description: string;
  sourceUrl: string;
  distribution: "npx" | "uvx" | "binary";
  command: string;
  args: string[];
  staticEnv: Record<string, string>;
  archive?: string;
  sha256?: string;
  requiresInstalledBinary: boolean;
}

function approvalsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "acp-agents.json");
}

function registryCachePath(agentDir = getAgentDir()): string {
  return join(agentDir, "acp-registry-cache.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) return undefined;
  return [...value];
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {};
  if (!isPlainObject(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([, item]) => typeof item === "string")) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

export function deriveAcpHandle(registryId: string): string {
  const base = registryId.toLowerCase().endsWith("-acp")
    ? registryId.slice(0, -4)
    : registryId;
  return handleBase(`acp-${base}`);
}

const CODEG_SOURCE = "https://docs.codeg.app";

function npxAgent(
  id: string,
  name: string,
  version: string,
  description: string,
  pkg: string,
  args: string[] = [],
  env: Record<string, string> = {},
): AcpRegistryAgent {
  return {
    id,
    name,
    version,
    description,
    website: CODEG_SOURCE,
    distribution: { npx: { package: pkg, args, env } },
  };
}

function binaryAgent(
  id: string,
  name: string,
  version: string,
  description: string,
  binary: Record<string, AcpRegistryBinaryTarget>,
): AcpRegistryAgent {
  return {
    id,
    name,
    version,
    description,
    website: CODEG_SOURCE,
    distribution: { binary },
  };
}

function archive(url: string, cmd: string, args: string[]): AcpRegistryBinaryTarget {
  return { archive: url, cmd, args, env: {} };
}

/** Codeg `get_agent_meta` pins. Official ACP Registry is not the catalog. */
const CODEG_BUILTINS: AcpRegistryAgent[] = [
  npxAgent("claude-acp", "Claude Code", "0.75.1", "ACP wrapper for Anthropic's Claude", "@agentclientprotocol/claude-agent-acp@0.75.1"),
  npxAgent("codex-acp", "Codex CLI", "1.10.0", "ACP adapter for OpenAI's coding assistant", "@agentclientprotocol/codex-acp@1.10.0"),
  npxAgent("gemini", "Gemini CLI", "0.59.0", "Google's official CLI for Gemini", "@google/gemini-cli@0.59.0", ["--acp", "--skip-trust"]),
  npxAgent("openclaw-acp", "OpenClaw", "2026.9.3", "OpenClaw personal AI assistant", "openclaw@2026.9.3", ["acp"]),
  binaryAgent("opencode", "OpenCode", "1.18.30", "The open source coding agent", {
    "darwin-aarch64": archive("https://github.com/anomalyco/opencode/releases/download/v1.18.30/opencode-darwin-arm64.zip", "opencode", ["acp"]),
    "darwin-x86_64": archive("https://github.com/anomalyco/opencode/releases/download/v1.18.30/opencode-darwin-x64.zip", "opencode", ["acp"]),
    "linux-aarch64": archive("https://github.com/anomalyco/opencode/releases/download/v1.18.30/opencode-linux-arm64.tar.gz", "opencode", ["acp"]),
    "linux-x86_64": archive("https://github.com/anomalyco/opencode/releases/download/v1.18.30/opencode-linux-x64.tar.gz", "opencode", ["acp"]),
    "windows-aarch64": archive("https://github.com/anomalyco/opencode/releases/download/v1.18.30/opencode-windows-arm64.zip", "opencode", ["acp"]),
    "windows-x86_64": archive("https://github.com/anomalyco/opencode/releases/download/v1.18.30/opencode-windows-x64.zip", "opencode", ["acp"]),
  }),
  npxAgent("cline", "Cline", "3.0.61", "Autonomous coding agent CLI", "cline@3.0.61", ["--acp"]),
  npxAgent("hermes", "Hermes Agent", "0.21.1", "Nous Research's self-improving agent", "hermes-agent@0.21.1", ["acp"]),
  npxAgent("codebuddy-code", "CodeBuddy", "2.149.0", "Tencent Cloud's official AI coding assistant", "@tencent-ai/codebuddy-code@2.149.0", ["--acp"]),
  npxAgent("kimi-code", "Kimi Code", "0.42.0", "Moonshot AI's official CLI coding assistant", "@moonshot-ai/kimi-code@0.42.0", ["acp"]),
  npxAgent("pi-acp", "Pi", "0.0.33", "Self-extensible coding agent", "pi-acp@0.0.33", [], { PI_ACP_ENABLE_EMBEDDED_CONTEXT: "true" }),
  npxAgent("grok-build", "Grok", "1.0.25", "xAI's official coding agent", "@xai-official/grok@1.0.25", ["agent", "stdio"]),
  binaryAgent("cursor", "Cursor", "2026.09.02-c22c1a3", "Cursor's coding agent", {
    "darwin-aarch64": archive("https://downloads.cursor.com/lab/2026.09.02-c22c1a3/darwin/arm64/agent-cli-package.tar.gz", "dist-package/cursor-agent", ["acp"]),
    "darwin-x86_64": archive("https://downloads.cursor.com/lab/2026.09.02-c22c1a3/darwin/x64/agent-cli-package.tar.gz", "dist-package/cursor-agent", ["acp"]),
    "linux-aarch64": archive("https://downloads.cursor.com/lab/2026.09.02-c22c1a3/linux/arm64/agent-cli-package.tar.gz", "dist-package/cursor-agent", ["acp"]),
    "linux-x86_64": archive("https://downloads.cursor.com/lab/2026.09.02-c22c1a3/linux/x64/agent-cli-package.tar.gz", "dist-package/cursor-agent", ["acp"]),
    "windows-aarch64": archive("https://downloads.cursor.com/lab/2026.09.02-c22c1a3/windows/arm64/agent-cli-package.zip", "dist-package/cursor-agent.cmd", ["acp"]),
    "windows-x86_64": archive("https://downloads.cursor.com/lab/2026.09.02-c22c1a3/windows/x64/agent-cli-package.zip", "dist-package/cursor-agent.cmd", ["acp"]),
  }),
  npxAgent("deepseek-acp", "DeepSeek Harness", "0.9.0", "Editor-facing DeepSeek Harness agent", "deepseek-acp@0.9.0"),
  npxAgent("qoder-cli", "Qoder", "1.1.49", "Alibaba's Qoder coding agent CLI", "@qoder-ai/qodercli@1.1.49", ["--acp"]),
  binaryAgent("antigravity-acp", "Google Antigravity", "1.1.1", "Google's AI coding agent", {
    "darwin-aarch64": archive("https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_1.1.1-darwin-arm64.zip", "agy_acp_server.par", []),
    "linux-aarch64": archive("https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-arm64.zip", "agy_acp_server.par", ["--uid="]),
    "linux-x86_64": archive("https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-x86_64.zip", "agy_acp_server.par", ["--uid="]),
    "windows-aarch64": archive("https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-arm64.zip", "agy_acp_server.exe", []),
    "windows-x86_64": archive("https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-x86_64.zip", "agy_acp_server.exe", []),
  }),
];

export function catalogAcpAgents(): AcpRegistryAgent[] {
  return CODEG_BUILTINS;
}

function parseApprovedAgent(value: unknown): ApprovedAcpAgent | undefined {
  if (!isPlainObject(value)) return undefined;
  const args = stringArray(value.args);
  const staticEnv = stringMap(value.staticEnv);
  if (
    typeof value.registryId !== "string"
    || typeof value.displayName !== "string"
    || typeof value.handle !== "string"
    || typeof value.registryVersion !== "string"
    || typeof value.sourceUrl !== "string"
    || typeof value.command !== "string"
    || typeof value.approvedAt !== "string"
    || typeof value.enabled !== "boolean"
    || !args
    || !staticEnv
  ) return undefined;
  const handle = handleBase(value.handle);
  if (!handle.startsWith("acp-") || !value.registryId.trim() || !value.command.trim()) return undefined;
  return {
    registryId: value.registryId.trim(),
    displayName: value.displayName.trim() || value.registryId.trim(),
    handle,
    registryVersion: value.registryVersion.trim(),
    sourceUrl: value.sourceUrl.trim(),
    command: value.command.trim(),
    args,
    staticEnv,
    approvedAt: value.approvedAt,
    enabled: value.enabled,
  };
}

export function loadAcpApprovals(agentDir = getAgentDir()): AcpApprovalsStore {
  const path = approvalsPath(agentDir);
  if (!existsSync(path)) return { version: APPROVALS_VERSION, agents: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (!isPlainObject(raw) || raw.version !== APPROVALS_VERSION || !Array.isArray(raw.agents)) {
      throw new Error("unsupported approvals schema");
    }
    const agents = raw.agents.map(parseApprovedAgent).filter((agent): agent is ApprovedAcpAgent => agent !== undefined);
    const ids = new Set<string>();
    const handles = new Set<string>();
    return {
      version: APPROVALS_VERSION,
      agents: agents.filter(agent => {
        const id = agent.registryId.toLowerCase();
        const handle = agent.handle.toLowerCase();
        if (ids.has(id) || handles.has(handle)) return false;
        ids.add(id);
        handles.add(handle);
        return true;
      }),
    };
  } catch (error) {
    console.warn(`[pi-subagents] Ignoring malformed ACP approvals at ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return { version: APPROVALS_VERSION, agents: [] };
  }
}

function atomicWrite(path: string, value: unknown): boolean {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(temp, path);
    return true;
  } catch {
    try { rmSync(temp, { force: true }); } catch { /* ignore */ }
    return false;
  }
}

export function saveAcpApprovals(store: AcpApprovalsStore, agentDir = getAgentDir()): boolean {
  return atomicWrite(approvalsPath(agentDir), store);
}

export function upsertAcpApproval(
  approval: ApprovedAcpAgent,
  agentDir = getAgentDir(),
): { ok: true; store: AcpApprovalsStore } | { ok: false; error: string } {
  const store = loadAcpApprovals(agentDir);
  const normalized = parseApprovedAgent(approval);
  if (!normalized) return { ok: false, error: "Invalid ACP approval." };
  const conflict = store.agents.find(agent =>
    agent.registryId.toLowerCase() !== normalized.registryId.toLowerCase()
    && agent.handle.toLowerCase() === normalized.handle.toLowerCase(),
  );
  if (conflict) return { ok: false, error: `Handle @${normalized.handle} is already approved for ${conflict.registryId}.` };
  const next: AcpApprovalsStore = {
    version: APPROVALS_VERSION,
    agents: [
      ...store.agents.filter(agent => agent.registryId.toLowerCase() !== normalized.registryId.toLowerCase()),
      normalized,
    ].sort((left, right) => left.displayName.localeCompare(right.displayName)),
  };
  if (!saveAcpApprovals(next, agentDir)) return { ok: false, error: "Could not persist ACP approval." };
  return { ok: true, store: next };
}

export function removeAcpApproval(registryId: string, agentDir = getAgentDir()): boolean {
  const store = loadAcpApprovals(agentDir);
  const next = store.agents.filter(agent => agent.registryId.toLowerCase() !== registryId.toLowerCase());
  if (next.length === store.agents.length) return true;
  return saveAcpApprovals({ version: APPROVALS_VERSION, agents: next }, agentDir);
}

function parseDistribution(value: unknown): AcpRegistryAgent["distribution"] | undefined {
  if (!isPlainObject(value)) return undefined;
  const distribution: AcpRegistryAgent["distribution"] = {};
  if (isPlainObject(value.npx)) {
    const args = stringArray(value.npx.args ?? []);
    const env = stringMap(value.npx.env);
    if (typeof value.npx.package === "string" && args && env) {
      distribution.npx = { package: value.npx.package, args, env };
    }
  }
  if (isPlainObject(value.uvx)) {
    const args = stringArray(value.uvx.args ?? []);
    const env = stringMap(value.uvx.env);
    if (typeof value.uvx.package === "string" && args && env) {
      distribution.uvx = { package: value.uvx.package, args, env };
    }
  }
  if (isPlainObject(value.binary)) {
    const binary: Record<string, AcpRegistryBinaryTarget> = {};
    for (const [platform, rawTarget] of Object.entries(value.binary)) {
      if (!isPlainObject(rawTarget)) continue;
      const args = stringArray(rawTarget.args ?? []);
      const env = stringMap(rawTarget.env);
      const sha256 = rawTarget.sha256;
      if (
        typeof rawTarget.archive !== "string"
        || typeof rawTarget.cmd !== "string"
        || !args
        || !env
        || (sha256 !== undefined && (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(sha256)))
      ) continue;
      binary[platform] = {
        archive: rawTarget.archive,
        cmd: rawTarget.cmd,
        args,
        env,
        ...(typeof sha256 === "string" ? { sha256: sha256.toLowerCase() } : {}),
      };
    }
    if (Object.keys(binary).length > 0) distribution.binary = binary;
  }
  return distribution.npx || distribution.uvx || distribution.binary ? distribution : undefined;
}

function parseRegistryAgent(value: unknown): AcpRegistryAgent | undefined {
  if (!isPlainObject(value)) return undefined;
  const distribution = parseDistribution(value.distribution);
  if (
    typeof value.id !== "string"
    || !REGISTRY_ID.test(value.id)
    || typeof value.name !== "string"
    || typeof value.version !== "string"
    || typeof value.description !== "string"
    || !distribution
  ) return undefined;
  return {
    id: value.id,
    name: value.name,
    version: value.version,
    description: value.description,
    ...(typeof value.repository === "string" ? { repository: value.repository } : {}),
    ...(typeof value.website === "string" ? { website: value.website } : {}),
    distribution,
  };
}

export function parseAcpRegistry(value: unknown): AcpRegistryIndex {
  if (!isPlainObject(value) || typeof value.version !== "string" || !Array.isArray(value.agents)) {
    throw new Error("Invalid ACP registry index.");
  }
  const agents = value.agents.map(parseRegistryAgent).filter((agent): agent is AcpRegistryAgent => agent !== undefined);
  return { version: value.version, agents };
}

export async function fetchAcpRegistry(signal?: AbortSignal): Promise<AcpRegistryIndex> {
  const response = await fetch(ACP_REGISTRY_URL, { signal });
  if (!response.ok) throw new Error(`ACP registry request failed: HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REGISTRY_BYTES) {
    throw new Error(`ACP registry response exceeds ${MAX_REGISTRY_BYTES} bytes.`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_REGISTRY_BYTES) {
    throw new Error(`ACP registry response exceeds ${MAX_REGISTRY_BYTES} bytes.`);
  }
  return parseAcpRegistry(JSON.parse(text));
}

export function saveAcpRegistryCache(
  registry: AcpRegistryIndex,
  agentDir = getAgentDir(),
  fetchedAt = new Date().toISOString(),
): boolean {
  const cache: AcpRegistryCache = { version: REGISTRY_CACHE_VERSION, fetchedAt, registry };
  return atomicWrite(registryCachePath(agentDir), cache);
}

export function loadAcpRegistryCache(agentDir = getAgentDir()): AcpRegistryCache | undefined {
  const path = registryCachePath(agentDir);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (!isPlainObject(raw) || raw.version !== REGISTRY_CACHE_VERSION || typeof raw.fetchedAt !== "string") {
      return undefined;
    }
    return { version: REGISTRY_CACHE_VERSION, fetchedAt: raw.fetchedAt, registry: parseAcpRegistry(raw.registry) };
  } catch {
    return undefined;
  }
}

function registryPlatform(): string | undefined {
  const os = process.platform === "darwin" ? "darwin"
    : process.platform === "linux" ? "linux"
      : process.platform === "win32" ? "windows"
        : undefined;
  const arch = process.arch === "arm64" ? "aarch64"
    : process.arch === "x64" ? "x86_64"
      : undefined;
  return os && arch ? `${os}-${arch}` : undefined;
}

export function launchCandidateFor(
  agent: AcpRegistryAgent,
  agentDir = getAgentDir(),
): AcpLaunchCandidate | undefined {
  const sourceUrl = agent.repository ?? agent.website ?? ACP_REGISTRY_URL;
  if (agent.distribution.npx) {
    return {
      registryId: agent.id,
      displayName: agent.name,
      registryVersion: agent.version,
      description: agent.description,
      sourceUrl,
      distribution: "npx",
      command: process.platform === "win32" ? "npx.cmd" : "npx",
      args: ["--prefix", agentDir, "-y", agent.distribution.npx.package, ...agent.distribution.npx.args],
      staticEnv: agent.distribution.npx.env,
      requiresInstalledBinary: false,
    };
  }
  if (agent.distribution.uvx) {
    return {
      registryId: agent.id,
      displayName: agent.name,
      registryVersion: agent.version,
      description: agent.description,
      sourceUrl,
      distribution: "uvx",
      command: process.platform === "win32" ? "uvx.exe" : "uvx",
      args: [agent.distribution.uvx.package, ...agent.distribution.uvx.args],
      staticEnv: agent.distribution.uvx.env,
      requiresInstalledBinary: false,
    };
  }
  const platform = registryPlatform();
  const target = platform ? agent.distribution.binary?.[platform] : undefined;
  if (!target) return undefined;
  return {
    registryId: agent.id,
    displayName: agent.name,
    registryVersion: agent.version,
    description: agent.description,
    sourceUrl,
    distribution: "binary",
    command: target.cmd,
    args: target.args,
    staticEnv: target.env,
    archive: target.archive,
    sha256: target.sha256,
    requiresInstalledBinary: true,
  };
}
