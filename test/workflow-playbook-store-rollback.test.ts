import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ mode: "none" as "corrupt" | "none" | "throw", target: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown> & {
    renameSync(from: string, to: string): void;
    writeFileSync(path: string, data: string, encoding: "utf-8"): void;
  };
  return {
    ...actual,
    renameSync(from: string, to: string) {
      const installing = to === fault.target && basename(from).startsWith(".adaptive-review.tmp-");
      if (!installing || fault.mode === "none") return actual.renameSync(from, to);
      const mode = fault.mode;
      fault.mode = "none";
      if (mode === "throw") throw new Error("injected install rename failure");
      actual.renameSync(from, to);
      actual.writeFileSync(join(to, "WORKFLOW.md"), "---\nname: wrong-name\n---\ninvalid", "utf-8");
    },
  };
});

import { loadWorkflowPlaybookDirectory } from "../src/workflow/playbook.js";
import {
  saveWorkflowPlaybook,
  type WorkflowPlaybookDraft,
  workflowPlaybookLockPath,
  workflowPlaybookSaveRoot,
} from "../src/workflow/playbook-store.js";

let cwd: string;
let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-playbook-rollback-project-"));
  agentDir = mkdtempSync(join(tmpdir(), "pi-playbook-rollback-agent-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  fault.mode = "none";
  fault.target = "";
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function draft(body: string): WorkflowPlaybookDraft {
  return {
    name: "adaptive-review",
    description: "Adaptively review a change",
    body,
    example: "Review the current diff",
    prompts: { review: "Review {{target}}" },
  };
}

function assertRestored(target: string): void {
  expect(loadWorkflowPlaybookDirectory(target, "project")?.body).toBe("original");
  const rootEntries = readdirSync(workflowPlaybookSaveRoot(cwd, "project"));
  expect(rootEntries.some((entry) => entry.startsWith(".adaptive-review.tmp-"))).toBe(false);
  expect(rootEntries).not.toContain(".adaptive-review.backup");
  expect(existsSync(workflowPlaybookLockPath(target))).toBe(false);
}

describe("Workflow Playbook replacement rollback", () => {
  it.each(["throw", "corrupt"] as const)("restores the previous directory after %s install failure", (mode) => {
    const created = saveWorkflowPlaybook({ cwd, scope: "project", draft: draft("original") });
    if (!created.ok) throw new Error(created.message);
    fault.target = created.target;
    fault.mode = mode;

    const result = saveWorkflowPlaybook({
      cwd,
      scope: "project",
      draft: draft("replacement"),
      overwrite: true,
      expectedRevision: created.playbook.revision,
    });

    expect(result).toMatchObject({ ok: false, code: "io-error" });
    assertRestored(created.target);
  });
});
