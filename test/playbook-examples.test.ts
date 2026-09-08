/**
 * playbook-examples.test.ts — the shipped example Playbooks, actually loaded.
 *
 * `docs/playbooks.md` describes the Playbook catalogue, and the examples under
 * `examples/playbooks/` are the reference shapes a project author copies. A
 * broken example is documentation that lies: a bad frontmatter value makes the
 * store skip the whole Playbook with a warning (silently, from the author's
 * point of view), and a prompt resource that trips a size bound never reaches
 * the coordinator. Nothing else guards these files — this suite is it.
 *
 * Glob-driven, so a newly added example Playbook is covered the moment it
 * lands, same policy as workflow-examples.test.ts.
 */

import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listWorkflowPlaybooks, readWorkflowPlaybook } from "../src/workflow/playbook.js";

const EXAMPLES_DIR = fileURLToPath(new URL("../examples/playbooks", import.meta.url));

/** Every Playbook directory — one that ships without WORKFLOW.md is a bug. */
const playbookDirs = readdirSync(EXAMPLES_DIR).filter(name => {
  const stat = statSync(join(EXAMPLES_DIR, name));
  return stat.isDirectory();
});

let cwd: string;
let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-playbook-examples-"));
  agentDir = mkdtempSync(join(tmpdir(), "pi-playbook-examples-agent-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
});

/** Install the examples into a temp project's `.pi/workflows` and read them back. */
function installExamples(): void {
  const target = join(cwd, ".pi", "workflows");
  cpSync(EXAMPLES_DIR, target, { recursive: true });
}

describe("shipped example Playbooks", () => {
  it("ships the expected set", () => {
    expect(new Set(playbookDirs)).toEqual(
      new Set(["code-review", "deep-research", "adversarial-review", "multi-perspective", "codebase-audit"]),
    );
  });

  it.each(playbookDirs)("%s loads through the store", directory => {
    installExamples();
    const playbook = readWorkflowPlaybook(cwd, directory);
    expect(playbook).toBeDefined();
    expect(playbook?.name).toBe(directory);
    expect(playbook?.description.trim().length ?? 0).toBeGreaterThan(0);
    // The store skips — rather than errors on — a bad `execution` value, so a
    // loaded playbook with the wrong execution would silently never appear.
    expect(playbook?.execution).toBe("adaptive");
  });

  it.each(playbookDirs)("%s appears in the catalogue list", directory => {
    installExamples();
    expect(listWorkflowPlaybooks(cwd).map(p => p.name)).toContain(directory);
  });

  it.each(playbookDirs)("%s prompts parse as resources", directory => {
    const promptsDir = join(EXAMPLES_DIR, directory, "prompts");
    let entries: string[] = [];
    try {
      entries = readdirSync(promptsDir).filter(name => name.endsWith(".md"));
    } catch {
      return; // a Playbook without prompt resources is valid
    }
    installExamples();
    const playbook = readWorkflowPlaybook(cwd, directory);
    for (const entry of entries) {
      const name = entry.slice(0, -3);
      expect(playbook?.prompts[name]).toBeDefined();
      // The shipped file and the loaded resource must not drift apart,
      // modulo the store's trailing-newline normalization.
      const file = readFileSync(join(promptsDir, entry), "utf-8").replace(/\n+$/, "");
      expect(playbook?.prompts[name]?.content).toBe(file);
    }
  });
});
