import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listWorkflowPlaybooks,
  loadWorkflowPlaybooks,
  readWorkflowPlaybook,
  readWorkflowPlaybookFromSource,
  workflowPlaybookRoots,
} from "../src/workflow/playbook.js";

let cwd: string;
let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-playbook-project-"));
  agentDir = mkdtempSync(join(tmpdir(), "pi-playbook-agent-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writePlaybook(
  root: string,
  directory: string,
  options: {
    body?: string;
    description?: string;
    execution?: string;
    name?: string;
    prompts?: Record<string, string>;
  } = {},
): string {
  const playbookDir = join(root, directory);
  mkdirSync(playbookDir, { recursive: true });
  const path = join(playbookDir, "WORKFLOW.md");
  writeFileSync(
    path,
    [
      "---",
      `name: ${options.name ?? directory}`,
      `description: ${options.description ?? `Playbook ${directory}`}`,
      `execution: ${options.execution ?? "adaptive"}`,
      "domains: software, review",
      "approval: adaptive",
      "side_effects: read-only",
      "inputs:",
      "  target:",
      "    type: string",
      "---",
      options.body ?? `Coordinate ${directory} adaptively.`,
      "",
    ].join("\n"),
    "utf-8",
  );
  for (const [name, content] of Object.entries(options.prompts ?? {})) {
    const promptPath = join(playbookDir, "prompts", `${name}.md`);
    mkdirSync(dirname(promptPath), { recursive: true });
    writeFileSync(promptPath, content, "utf-8");
  }
  return path;
}

describe("workflow Playbook discovery", () => {
  it("loads coordinator Markdown, YAML metadata, and sorted prompt resources", () => {
    const root = join(cwd, ".pi", "workflows");
    writePlaybook(root, "code-review", {
      body: "Choose reviewers from the actual diff.",
      execution: "adaptive",
      prompts: { verify: "Verify {{finding}}", discover: "Inspect {{target}}" },
    });

    const playbook = readWorkflowPlaybook(cwd, "code-review");

    expect(playbook).toMatchObject({
      name: "code-review",
      description: "Playbook code-review",
      execution: "adaptive",
      approval: "adaptive",
      sideEffects: "read-only",
      domains: ["software", "review"],
      source: "project",
      body: "Choose reviewers from the actual diff.",
    });
    expect(Object.keys(playbook?.prompts ?? {})).toEqual(["discover", "verify"]);
    expect(playbook?.inputs).toEqual({ target: { type: "string" } });
    expect(playbook?.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it("loads the shipped adaptive code-review example and all prompt resources", () => {
    const target = join(cwd, ".pi", "workflows", "code-review");
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(process.cwd(), "examples", "playbooks", "code-review"), target, { recursive: true });

    const playbook = readWorkflowPlaybook(cwd, "code-review");

    expect(playbook?.description).toContain("validated findings");
    expect(Object.keys(playbook?.prompts ?? {})).toEqual(["discover", "review", "synthesize", "verify"]);
    expect(playbook?.body).toContain("Do not create review work merely to fill categories");
  });

  it("uses project over workspace over global precedence", () => {
    const roots = workflowPlaybookRoots(cwd);
    writePlaybook(roots[2].path, "shared", { body: "global" });
    writePlaybook(roots[1].path, "shared", { body: "workspace" });
    writePlaybook(roots[0].path, "shared", { body: "project" });

    expect(readWorkflowPlaybook(cwd, "shared")?.body).toBe("project");

    rmSync(join(roots[0].path, "shared"), { recursive: true, force: true });
    expect(readWorkflowPlaybook(cwd, "shared")?.body).toBe("workspace");
  });

  it("reads an exact source even when a higher-precedence Playbook shadows it", () => {
    const roots = workflowPlaybookRoots(cwd);
    writePlaybook(roots[2].path, "shared", { body: "global" });
    writePlaybook(roots[0].path, "shared", { body: "project" });

    expect(readWorkflowPlaybook(cwd, "shared")?.body).toBe("project");
    expect(readWorkflowPlaybookFromSource(cwd, "shared", "global")?.body).toBe("global");
  });

  it("serves the last validated backup during a replacement window", () => {
    const root = join(cwd, ".pi", "workflows");
    writePlaybook(root, ".review.backup", { name: "review", body: "last validated" });

    expect(readWorkflowPlaybook(cwd, "review")?.body).toBe("last validated");
    expect(readWorkflowPlaybookFromSource(cwd, "review", "project")?.body).toBe("last validated");
  });

  it("rejects a frontmatter name that differs from its directory", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writePlaybook(join(cwd, ".pi", "workflows"), "wrong-directory", { name: "logical-name" });

    expect(readWorkflowPlaybook(cwd, "logical-name")).toBeUndefined();
    expect(readWorkflowPlaybook(cwd, "wrong-directory")).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("must match directory"));
  });

  it("filters the catalogue by name, description, domain, or body", () => {
    const root = join(cwd, ".pi", "workflows");
    writePlaybook(root, "review", { body: "Inspect a code change" });
    writePlaybook(root, "novel", { body: "Maintain character continuity", description: "Fiction editing" });

    expect(listWorkflowPlaybooks(cwd, "character").map((item) => item.name)).toEqual(["novel"]);
    expect(listWorkflowPlaybooks(cwd, "software").map((item) => item.name)).toEqual(["novel", "review"]);
  });

  it("bounds oversized descriptions before they reach catalogue output", () => {
    const root = join(cwd, ".pi", "workflows");
    writePlaybook(root, "verbose", { description: "x".repeat(5000) });

    expect(readWorkflowPlaybook(cwd, "verbose")?.description.length).toBe(1001);
  });

  it("caps prompt resources per Playbook", () => {
    const root = join(cwd, ".pi", "workflows");
    const prompts = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`prompt-${String(index).padStart(2, "0")}`, `Prompt ${index}`]),
    );
    writePlaybook(root, "bounded", { prompts });

    expect(Object.keys(readWorkflowPlaybook(cwd, "bounded")?.prompts ?? {})).toHaveLength(32);
  });

  it("ignores legacy JavaScript workflows instead of merging the two catalogues", () => {
    const root = join(cwd, ".pi", "workflows");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "legacy.js"), "export const meta = { name: 'legacy', description: 'legacy' }", "utf-8");

    expect(loadWorkflowPlaybooks(cwd).size).toBe(0);
  });

  it("rejects symlinked playbook directories and prompt resources", () => {
    const root = join(cwd, ".pi", "workflows");
    const real = join(cwd, "real-playbook");
    writePlaybook(cwd, "real-playbook", { prompts: { safe: "safe" } });
    mkdirSync(root, { recursive: true });
    symlinkSync(real, join(root, "linked"), "dir");

    writePlaybook(root, "safe", { prompts: { direct: "direct" } });
    const promptTarget = join(cwd, "outside.md");
    writeFileSync(promptTarget, "outside", "utf-8");
    symlinkSync(promptTarget, join(root, "safe", "prompts", "linked.md"));

    expect(readWorkflowPlaybook(cwd, "linked")).toBeUndefined();
    expect(Object.keys(readWorkflowPlaybook(cwd, "safe")?.prompts ?? {})).toEqual(["direct"]);
  });

  it("rejects a Playbook root reached through a symlinked ancestor", () => {
    const outside = join(cwd, "outside-pi");
    writePlaybook(join(outside, "workflows"), "escaped");
    symlinkSync(outside, join(cwd, ".pi"), "dir");

    expect(readWorkflowPlaybook(cwd, "escaped")).toBeUndefined();
  });

  it("rejects approval-spoofing controls while accepting ordinary CRLF", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = join(cwd, ".pi", "workflows");
    const spoofed = join(root, "spoofed");
    mkdirSync(spoofed, { recursive: true });
    writeFileSync(
      join(spoofed, "WORKFLOW.md"),
      "---\nname: spoofed\n---\nReview \u202ehidden text",
      "utf-8",
    );
    const crlf = join(root, "crlf");
    mkdirSync(crlf, { recursive: true });
    writeFileSync(
      join(crlf, "WORKFLOW.md"),
      "---\r\nname: crlf\r\n---\r\nSafe CRLF guidance\r\n",
      "utf-8",
    );

    expect(readWorkflowPlaybook(cwd, "spoofed")).toBeUndefined();
    expect(readWorkflowPlaybook(cwd, "crlf")?.body).toBe("Safe CRLF guidance");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("terminal control characters"));
  });

  it("skips malformed frontmatter and empty playbooks without failing discovery", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = join(cwd, ".pi", "workflows");
    const malformed = join(root, "malformed");
    mkdirSync(malformed, { recursive: true });
    writeFileSync(join(malformed, "WORKFLOW.md"), "---\nname: [\n---\nbody", "utf-8");
    const empty = join(root, "empty");
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, "WORKFLOW.md"), "---\nname: empty\n---\n", "utf-8");
    const invalid = join(root, "invalid-enum");
    mkdirSync(invalid, { recursive: true });
    writeFileSync(
      join(invalid, "WORKFLOW.md"),
      "---\nname: invalid-enum\nexecution: maybe\napproval: later\n---\nBody",
      "utf-8",
    );

    expect(loadWorkflowPlaybooks(cwd).size).toBe(0);
    expect(warn).toHaveBeenCalled();
  });
});
