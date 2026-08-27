import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { isSymlink, isUnsafeName, safeReadFile } from "../memory.js";

const PLAYBOOK_FILE = "WORKFLOW.md";
const PROMPTS_DIR = "prompts";

export const WORKFLOW_PLAYBOOK_LIMITS = {
  maxPlaybookBytes: 128 * 1024,
  maxDescriptionChars: 1000,
  maxPlaybooksPerRoot: 128,
  maxPromptBytes: 64 * 1024,
  maxPromptsPerPlaybook: 32,
  maxAggregatePromptBytes: 256 * 1024,
} as const;

export type WorkflowPlaybookSource = "project" | "workspace" | "global";
export type WorkflowExecutionMode = "adaptive" | "deterministic";
export type WorkflowApprovalMode = "adaptive" | "required" | "none";

export interface WorkflowPromptResource {
  content: string;
  name: string;
  path: string;
}

export interface WorkflowPlaybook {
  approval: WorkflowApprovalMode;
  body: string;
  description: string;
  directory: string;
  domains: string[];
  example?: string;
  execution: WorkflowExecutionMode;
  inputs?: Record<string, unknown>;
  name: string;
  path: string;
  prompts: Record<string, WorkflowPromptResource>;
  revision: string;
  sideEffects: string;
  source: WorkflowPlaybookSource;
}

export interface WorkflowPlaybookRoot {
  path: string;
  source: WorkflowPlaybookSource;
}

export function workflowPlaybookRoots(cwd: string): WorkflowPlaybookRoot[] {
  return [
    { path: join(cwd, ".pi", "workflows"), source: "project" },
    { path: join(cwd, ".agents", "workflows"), source: "workspace" },
    { path: join(getAgentDir(), "workflows"), source: "global" },
  ];
}

export interface WorkflowPlaybookLoadOptions {
  includeProject?: boolean;
}

export function loadWorkflowPlaybooks(
  cwd: string,
  options: WorkflowPlaybookLoadOptions = {},
): Map<string, WorkflowPlaybook> {
  const playbooks = new Map<string, WorkflowPlaybook>();
  const includeProject = options.includeProject ?? true;
  // Lowest precedence first; later roots replace a same-named playbook.
  for (const root of [...workflowPlaybookRoots(cwd)].reverse()) {
    if (!includeProject && root.source !== "global") continue;
    for (const playbook of loadRoot(root)) playbooks.set(playbook.name, playbook);
  }
  return playbooks;
}

export function listWorkflowPlaybooks(
  cwd: string,
  query?: string,
  options?: WorkflowPlaybookLoadOptions,
): WorkflowPlaybook[] {
  const normalizedQuery = query?.trim().toLowerCase();
  return [...loadWorkflowPlaybooks(cwd, options).values()]
    .filter((playbook) => {
      if (!normalizedQuery) return true;
      return [playbook.name, playbook.description, playbook.domains.join(" "), playbook.body]
        .join("\n")
        .toLowerCase()
        .includes(normalizedQuery);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readWorkflowPlaybook(
  cwd: string,
  name: string,
  options?: WorkflowPlaybookLoadOptions,
): WorkflowPlaybook | undefined {
  return loadWorkflowPlaybooks(cwd, options).get(name.trim());
}

export function readWorkflowPlaybookFromSource(
  cwd: string,
  name: string,
  source: WorkflowPlaybookSource,
): WorkflowPlaybook | undefined {
  const normalizedName = name.trim();
  if (isUnsafeName(normalizedName)) return undefined;
  const root = workflowPlaybookRoots(cwd).find(candidate => candidate.source === source);
  if (!root) return undefined;
  const target = join(root.path, normalizedName);
  const primary = loadWorkflowPlaybookDirectory(target, source);
  if (primary) return primary;
  return loadWorkflowPlaybookDirectory(join(root.path, `.${normalizedName}.backup`), source, normalizedName);
}

function loadRoot(root: WorkflowPlaybookRoot): WorkflowPlaybook[] {
  if (!existsSync(root.path) || isSymlink(root.path) || isSymlink(dirname(root.path))) return [];
  let entries: string[];
  try {
    entries = readdirSync(root.path).sort();
  } catch {
    return [];
  }

  const playbooks: WorkflowPlaybook[] = [];
  const loadedNames = new Set<string>();
  for (const entry of entries) {
    if (playbooks.length >= WORKFLOW_PLAYBOOK_LIMITS.maxPlaybooksPerRoot) break;
    if (isUnsafeName(entry)) continue;
    const directory = join(root.path, entry);
    if (!isDirectory(directory) || isSymlink(directory)) continue;
    const playbook = loadWorkflowPlaybookDirectory(directory, root.source);
    if (playbook) {
      playbooks.push(playbook);
      loadedNames.add(playbook.name);
    }
  }
  // During an atomic replacement the primary directory is briefly moved to a
  // hidden backup. Readers keep seeing the last validated version in that gap.
  let backupEntries: string[];
  try {
    backupEntries = readdirSync(root.path).sort();
  } catch {
    backupEntries = entries;
  }
  for (const entry of backupEntries) {
    if (playbooks.length >= WORKFLOW_PLAYBOOK_LIMITS.maxPlaybooksPerRoot) break;
    const match = /^\.([a-zA-Z0-9][a-zA-Z0-9._-]*)\.backup$/.exec(entry);
    const name = match?.[1];
    if (!name || isUnsafeName(name) || loadedNames.has(name)) continue;
    const backup = loadWorkflowPlaybookDirectory(join(root.path, entry), root.source, name);
    if (backup) {
      playbooks.push(backup);
      loadedNames.add(name);
    }
  }
  return playbooks;
}

export function loadWorkflowPlaybookDirectory(
  directory: string,
  source: WorkflowPlaybookSource,
  expectedName = basename(directory),
): WorkflowPlaybook | undefined {
  if (!isDirectory(directory) || isSymlink(directory)) return undefined;
  const directoryName = expectedName;
  const path = join(directory, PLAYBOOK_FILE);
  if (!isReadableRegularFile(path, WORKFLOW_PLAYBOOK_LIMITS.maxPlaybookBytes)) return undefined;
  const content = safeReadFile(path);
  if (content === undefined) return undefined;
  if (hasUnsafeControl(content)) {
    warn(`Skipping ${path}: playbook contains terminal control characters.`);
    return undefined;
  }
  const normalizedContent = content.replace(/\r\n/g, "\n");

  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(
      normalizedContent.startsWith("\uFEFF") ? normalizedContent.slice(1) : normalizedContent,
    );
  } catch (error) {
    warn(`Skipping ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }

  const declaredName = stringValue(parsed.frontmatter.name)?.trim();
  if (declaredName && declaredName !== directoryName) {
    warn(`Skipping ${path}: workflow name "${declaredName}" must match directory "${directoryName}".`);
    return undefined;
  }
  const name = directoryName;
  if (isUnsafeName(name)) {
    warn(`Skipping ${path}: workflow name "${name}" is not path-safe.`);
    return undefined;
  }

  const prompts = loadPromptResources(directory);
  const body = parsed.body.trim();
  if (!body && Object.keys(prompts).length === 0) {
    warn(`Skipping ${path}: playbook has no coordinator prompt or prompt resources.`);
    return undefined;
  }

  const rawDescription = stringValue(parsed.frontmatter.description)?.trim() || name;
  const description = rawDescription.length > WORKFLOW_PLAYBOOK_LIMITS.maxDescriptionChars
    ? `${rawDescription.slice(0, WORKFLOW_PLAYBOOK_LIMITS.maxDescriptionChars)}…`
    : rawDescription;
  const execution = executionValue(parsed.frontmatter.execution);
  if (!execution) {
    warn(`Skipping ${path}: execution must be adaptive or deterministic.`);
    return undefined;
  }
  const approval = approvalValue(parsed.frontmatter.approval);
  if (!approval) {
    warn(`Skipping ${path}: approval must be adaptive, required, or none.`);
    return undefined;
  }
  const sideEffects = stringValue(parsed.frontmatter.side_effects)?.trim() || "unknown";
  const domains = stringList(parsed.frontmatter.domains);
  const inputs = plainRecord(parsed.frontmatter.inputs);
  const example = stringValue(parsed.frontmatter.example)?.trim() || undefined;
  const revision = createHash("sha256")
    .update(content)
    .update(
      JSON.stringify(
        Object.values(prompts).map((prompt) => [prompt.name, prompt.content]),
      ),
    )
    .digest("hex");

  return {
    approval,
    body,
    description,
    directory,
    domains,
    ...(example ? { example } : {}),
    execution,
    ...(inputs ? { inputs } : {}),
    name,
    path,
    prompts,
    revision,
    sideEffects,
    source,
  };
}

function loadPromptResources(directory: string): Record<string, WorkflowPromptResource> {
  const promptsDir = join(directory, PROMPTS_DIR);
  if (!existsSync(promptsDir) || isSymlink(promptsDir)) return {};
  let files: string[];
  try {
    files = readdirSync(promptsDir).filter((file) => file.endsWith(".md")).sort();
  } catch {
    return {};
  }

  const prompts: Record<string, WorkflowPromptResource> = {};
  let aggregateBytes = 0;
  for (const file of files.slice(0, WORKFLOW_PLAYBOOK_LIMITS.maxPromptsPerPlaybook)) {
    const name = basename(file, ".md");
    if (isUnsafeName(name)) continue;
    const path = join(promptsDir, file);
    const size = regularFileSize(path, WORKFLOW_PLAYBOOK_LIMITS.maxPromptBytes);
    if (size === undefined) continue;
    if (aggregateBytes + size > WORKFLOW_PLAYBOOK_LIMITS.maxAggregatePromptBytes) break;
    const rawContent = safeReadFile(path);
    if (!rawContent || hasUnsafeControl(rawContent)) continue;
    const content = rawContent.replace(/\r\n/g, "\n").trim();
    if (!content) continue;
    aggregateBytes += size;
    prompts[name] = { content, name, path };
  }
  return prompts;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isReadableRegularFile(path: string, maxBytes: number): boolean {
  return regularFileSize(path, maxBytes) !== undefined;
}

function regularFileSize(path: string, maxBytes: number): number | undefined {
  if (isSymlink(path)) return undefined;
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size <= maxBytes ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value !== "string") return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function executionValue(value: unknown): WorkflowExecutionMode | undefined {
  if (value === undefined || value === null || value === "adaptive") return "adaptive";
  return value === "deterministic" ? "deterministic" : undefined;
}

function approvalValue(value: unknown): WorkflowApprovalMode | undefined {
  if (value === undefined || value === null || value === "adaptive") return "adaptive";
  return value === "required" || value === "none" ? value : undefined;
}

function hasUnsafeControl(value: string): boolean {
  const normalized = value.replace(/\r\n/g, "\n");
  return /[\u0000-\u0008\u000B\u000C\u000D\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/.test(normalized);
}

function warn(message: string): void {
  console.warn(`[pi-subagents:playbooks] ${message}`);
}
