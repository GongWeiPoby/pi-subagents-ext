import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkflowPlaybookDirectory } from "../src/workflow/playbook.js";
import {
  previewWorkflowPlaybookSave,
  saveWorkflowPlaybook,
  type WorkflowPlaybookDraft,
  workflowPlaybookLockPath,
  workflowPlaybookSaveRoot,
} from "../src/workflow/playbook-store.js";

let cwd: string;
let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-playbook-store-project-"));
  agentDir = mkdtempSync(join(tmpdir(), "pi-playbook-store-agent-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
});

function draft(overrides: Partial<WorkflowPlaybookDraft> = {}): WorkflowPlaybookDraft {
  return {
    name: "adaptive-review",
    description: "Adaptively review a change",
    body: "# Outcome\n\nReview the requested change according to its actual risk.",
    domains: ["software", "review"],
    approval: "adaptive",
    sideEffects: "read-only",
    inputs: { target: { type: "string", description: "Review target" } },
    example: 'Review the current diff with target="HEAD"',
    prompts: {
      review: "Review {{target}} through the {{lens}} lens.",
      verify: "Try to refute {{finding}}.",
    },
    ...overrides,
  };
}

describe("Workflow Playbook persistence", () => {
  it("previews and atomically creates a loader-compatible project Playbook", () => {
    const proposal = draft();
    const preview = previewWorkflowPlaybookSave(cwd, "project", proposal);
    if ("ok" in preview) throw new Error(preview.message);

    expect(preview.target).toBe(join(cwd, ".pi", "workflows", "adaptive-review"));
    expect(preview.files["WORKFLOW.md"]).toContain('example: "Review the current diff');
    expect(preview.files).not.toHaveProperty("workflow.js");

    const saved = saveWorkflowPlaybook({ cwd, scope: "project", draft: proposal });

    expect(saved).toMatchObject({ ok: true, created: true });
    if (!saved.ok) return;
    expect(saved.playbook.source).toBe("project");
    expect(saved.playbook.example).toContain("Review the current diff");
    expect(Object.keys(saved.playbook.prompts)).toEqual(["review", "verify"]);
    expect(saved.playbook.inputs).toEqual({ target: { type: "string", description: "Review target" } });
    expect(existsSync(join(saved.target, "workflow.js"))).toBe(false);
  });

  it("writes global Playbooks under the configured agent directory", () => {
    const saved = saveWorkflowPlaybook({ cwd, scope: "global", draft: draft({ name: "global-review" }) });

    expect(saved).toMatchObject({ ok: true, created: true });
    if (!saved.ok) return;
    expect(saved.target).toBe(join(agentDir, "workflows", "global-review"));
    expect(saved.playbook.source).toBe("global");
  });

  it("requires overwrite and the exact current revision", () => {
    const created = saveWorkflowPlaybook({ cwd, scope: "project", draft: draft() });
    if (!created.ok) throw new Error(created.message);

    const conflict = saveWorkflowPlaybook({ cwd, scope: "project", draft: draft({ body: "changed" }) });
    const stale = saveWorkflowPlaybook({
      cwd,
      scope: "project",
      draft: draft({ body: "changed" }),
      overwrite: true,
      expectedRevision: "0".repeat(64),
    });
    const updated = saveWorkflowPlaybook({
      cwd,
      scope: "project",
      draft: draft({ body: "changed", prompts: { replacement: "new prompt" } }),
      overwrite: true,
      expectedRevision: created.playbook.revision,
    });

    expect(conflict).toMatchObject({ ok: false, code: "conflict" });
    expect(stale).toMatchObject({ ok: false, code: "stale" });
    expect(updated).toMatchObject({ ok: true, created: false });
    if (!updated.ok) return;
    expect(updated.playbook.body).toBe("changed");
    expect(Object.keys(updated.playbook.prompts)).toEqual(["replacement"]);
    expect(existsSync(join(updated.target, "prompts", "review.md"))).toBe(false);
  });

  it("does not alter the current Playbook after a stale update", () => {
    const created = saveWorkflowPlaybook({ cwd, scope: "project", draft: draft() });
    if (!created.ok) throw new Error(created.message);

    saveWorkflowPlaybook({
      cwd,
      scope: "project",
      draft: draft({ body: "first update" }),
      overwrite: true,
      expectedRevision: created.playbook.revision,
    });
    const stale = saveWorkflowPlaybook({
      cwd,
      scope: "project",
      draft: draft({ body: "stale update" }),
      overwrite: true,
      expectedRevision: created.playbook.revision,
    });

    expect(stale).toMatchObject({ ok: false, code: "stale" });
    const current = loadWorkflowPlaybookDirectory(
      join(cwd, ".pi", "workflows", "adaptive-review"),
      "project",
    );
    expect(current?.body).toBe("first update");
  });

  it("treats a prompt-only change as a stale revision without altering files", () => {
    const created = saveWorkflowPlaybook({ cwd, scope: "project", draft: draft() });
    if (!created.ok) throw new Error(created.message);
    const promptPath = join(created.target, "prompts", "review.md");
    writeFileSync(promptPath, "changed outside the save tool\n", "utf-8");
    const changed = loadWorkflowPlaybookDirectory(created.target, "project");
    if (!changed) throw new Error("changed Playbook did not load");

    const stale = saveWorkflowPlaybook({
      cwd,
      scope: "project",
      draft: draft({ body: "stale update" }),
      overwrite: true,
      expectedRevision: created.playbook.revision,
    });

    expect(changed.revision).not.toBe(created.playbook.revision);
    expect(stale).toMatchObject({ ok: false, code: "stale" });
    expect(loadWorkflowPlaybookDirectory(created.target, "project")?.prompts.review.content)
      .toBe("changed outside the save tool");
  });

  it("refuses a live lock and reclaims a dead process lock", () => {
    const root = workflowPlaybookSaveRoot(cwd, "project");
    const target = join(root, "adaptive-review");
    const lock = workflowPlaybookLockPath(target);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token: "live" }), "utf-8");

    const locked = saveWorkflowPlaybook({ cwd, scope: "project", draft: draft() });
    expect(locked).toMatchObject({ ok: false, code: "locked" });

    const dead = spawnSync(process.execPath, ["-e", ""]);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: dead.pid, token: "dead" }), "utf-8");
    const recovered = saveWorkflowPlaybook({ cwd, scope: "project", draft: draft() });
    expect(recovered).toMatchObject({ ok: true });
    expect(existsSync(lock)).toBe(false);
  });

  it("does not trust repository-controlled lock files", () => {
    const root = workflowPlaybookSaveRoot(cwd, "project");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, ".adaptive-review.lock"),
      JSON.stringify({ pid: process.pid, token: "repository" }),
      "utf-8",
    );

    expect(saveWorkflowPlaybook({ cwd, scope: "project", draft: draft() }))
      .toMatchObject({ ok: true });
  });

  it("does not reclaim an incomplete lock during its publication grace period", () => {
    const target = join(workflowPlaybookSaveRoot(cwd, "project"), "adaptive-review");
    const lock = workflowPlaybookLockPath(target);
    mkdirSync(lock, { recursive: true });

    expect(saveWorkflowPlaybook({ cwd, scope: "project", draft: draft() }))
      .toMatchObject({ ok: false, code: "locked" });
    expect(existsSync(lock)).toBe(true);
  });

  it("recovers an interrupted backup before applying conflict checks", () => {
    const created = saveWorkflowPlaybook({ cwd, scope: "project", draft: draft() });
    if (!created.ok) throw new Error(created.message);
    const backup = join(dirname(created.target), ".adaptive-review.backup");
    renameSync(created.target, backup);

    const result = saveWorkflowPlaybook({ cwd, scope: "project", draft: draft({ body: "new" }) });

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(existsSync(created.target)).toBe(true);
    expect(loadWorkflowPlaybookDirectory(created.target, "project")?.body).toContain("Review the requested change");
  });

  it("rejects symlinked project roots and unsafe prompt names", () => {
    const outside = join(cwd, "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(cwd, ".pi"), "dir");

    const symlinked = saveWorkflowPlaybook({ cwd, scope: "project", draft: draft() });
    const unsafe = previewWorkflowPlaybookSave(cwd, "global", draft({ prompts: { "../escape": "bad" } }));

    expect(symlinked).toMatchObject({ ok: false, code: "invalid" });
    expect(unsafe).toMatchObject({ ok: false, code: "invalid" });
  });

  it("rejects non-generalized or non-serializable proposals", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(previewWorkflowPlaybookSave(cwd, "project", draft({ example: "" })))
      .toMatchObject({ ok: false, code: "invalid" });
    expect(previewWorkflowPlaybookSave(cwd, "project", draft({ inputs: cyclic })))
      .toMatchObject({ ok: false, code: "invalid" });
    expect(previewWorkflowPlaybookSave(cwd, "project", draft({ body: "Safe\u202ehidden" })))
      .toMatchObject({ ok: false, code: "invalid" });
    expect(previewWorkflowPlaybookSave(cwd, "project", draft({ body: "Safe\r\nCRLF" })))
      .not.toHaveProperty("ok");
  });
});
