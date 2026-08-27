import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_TOOL_NAMES } from "../src/agent-runner.js";
import { readWorkflowPlaybook, readWorkflowPlaybookFromSource } from "../src/workflow/playbook.js";
import { registerWorkflowPlaybookSaveTool } from "../src/workflow/playbook-save-tool.js";

interface SaveContext {
  cwd: string;
  hasUI: boolean;
  isProjectTrusted(): boolean;
  ui: { confirm(title: string, message: string): Promise<boolean> };
}

interface CapturedTool {
  description?: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: SaveContext,
  ): Promise<{ content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }>;
  name: string;
  parameters?: unknown;
  promptGuidelines?: string[];
}

let cwd: string;
let agentDir: string;
let previousAgentDir: string | undefined;
let tool: CapturedTool;
let entries: Array<{ customType: string; data: unknown }>;
let confirm: ReturnType<typeof vi.fn>;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-playbook-save-tool-project-"));
  agentDir = mkdtempSync(join(tmpdir(), "pi-playbook-save-tool-agent-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  entries = [];
  confirm = vi.fn(async () => true);
  const pi = {
    registerTool(definition: CapturedTool) {
      tool = definition;
    },
    registerEntryRenderer: vi.fn(),
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
  };
  registerWorkflowPlaybookSaveTool(pi as unknown as ExtensionAPI);
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function params(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "adaptive-review",
    scope: "project",
    description: "Adaptively review a change",
    body: "Choose review depth from the actual change. Do not require fixed stages.",
    domains: ["software", "review"],
    approval: "adaptive",
    sideEffects: "read-only",
    inputs: { target: { type: "string" } },
    example: "Review the current diff",
    prompts: { review: "Review {{target}} through {{lens}}." },
    ...overrides,
  };
}

function context(overrides: Partial<SaveContext> = {}): SaveContext {
  return {
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    ui: { confirm },
    ...overrides,
  };
}

async function execute(input: Record<string, unknown>, ctx = context()) {
  return tool.execute("call-1", input, undefined, undefined, ctx);
}

describe("WorkflowPlaybookSave", () => {
  it("keeps the promotion contract bounded", () => {
    const contract = JSON.stringify({
      description: tool.description,
      parameters: tool.parameters,
      promptGuidelines: tool.promptGuidelines,
    });

    expect(contract.length).toBeLessThan(12_000);
    expect(contract).toContain('"expectedRevision"');
    expect(contract).toContain('"overwrite"');
    expect(contract).toContain('"project"');
    expect(contract).toContain('"global"');
    expect(contract).toContain("requires direct user confirmation");
    expect(contract).toContain("never saves generated JavaScript");
  });

  it("previews and saves a generalized project Playbook after confirmation", async () => {
    const result = await execute(params());

    expect(tool.name).toBe(SUBAGENT_TOOL_NAMES.PLAYBOOK_SAVE);
    expect(confirm).toHaveBeenCalledWith(
      "Save workflow Playbook?",
      expect.stringContaining("--- WORKFLOW.md ---"),
    );
    const approval = String(confirm.mock.calls[0]?.[1]);
    expect(approval).toContain("Action: create");
    expect(approval).toContain("Scope: project");
    expect(approval).toContain(join(cwd, ".pi", "workflows", "adaptive-review"));
    expect(approval).toContain("Invocation example: Review the current diff");
    expect(approval).toContain("Choose review depth from the actual change. Do not require fixed stages.");
    expect(approval).toContain("Review {{target}} through {{lens}}.");
    expect(approval).toContain("--- prompts/review.md ---");
    expect(result.details).toMatchObject({ status: "saved", scope: "project", created: true });
    const path = join(cwd, ".pi", "workflows", "adaptive-review");
    expect(readWorkflowPlaybook(cwd, "adaptive-review")?.body).toContain("Choose review depth");
    expect(existsSync(join(path, "workflow.js"))).toBe(false);
    expect(entries).toEqual([
      expect.objectContaining({
        customType: "workflow-playbook-saved",
        data: expect.objectContaining({ name: "adaptive-review", scope: "project" }),
      }),
    ]);
  });

  it("saves to the global agent directory when that scope is confirmed", async () => {
    const result = await execute(params({ name: "global-review", scope: "global" }));

    expect(result.details).toMatchObject({ status: "saved", scope: "global" });
    expect(readWorkflowPlaybook(cwd, "global-review")?.source).toBe("global");
    expect(result.details?.path).toBe(join(agentDir, "workflows", "global-review"));
  });

  it("cancels without writing when the user declines", async () => {
    confirm.mockResolvedValue(false);

    const result = await execute(params());

    expect(result.details?.status).toBe("cancelled");
    expect(readWorkflowPlaybook(cwd, "adaptive-review")).toBeUndefined();
    expect(entries).toEqual([]);
  });

  it("fails closed without UI and for untrusted project scope", async () => {
    const headless = await execute(params(), context({ hasUI: false }));
    const untrusted = await execute(params(), context({ isProjectTrusted: () => false }));

    expect(headless.details).toMatchObject({ status: "error", code: "approval-required" });
    expect(untrusted.details).toMatchObject({ status: "error", code: "invalid" });
    expect(confirm).not.toHaveBeenCalled();
    expect(readWorkflowPlaybook(cwd, "adaptive-review")).toBeUndefined();
  });

  it("requires the current revision before overwriting", async () => {
    const created = await execute(params());
    const revision = String(created.details?.revision);
    confirm.mockClear();

    const conflict = await execute(params({ body: "changed" }));
    const stale = await execute(params({ body: "changed", overwrite: true, expectedRevision: "0".repeat(64) }));
    const updated = await execute(params({ body: "changed", overwrite: true, expectedRevision: revision }));

    expect(conflict.details).toMatchObject({ status: "error", code: "conflict" });
    expect(stale.details).toMatchObject({ status: "error", code: "stale" });
    expect(updated.details).toMatchObject({ status: "saved", created: false });
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith("Overwrite workflow Playbook?", expect.any(String));
    expect(readWorkflowPlaybook(cwd, "adaptive-review")?.body).toBe("changed");
  });

  it("updates a shadowed global Playbook using its exact source revision", async () => {
    await execute(params({ scope: "global", body: "global original" }));
    await execute(params({ scope: "project", body: "project shadow" }));
    const global = readWorkflowPlaybookFromSource(cwd, "adaptive-review", "global");
    if (!global) throw new Error("missing global Playbook");

    const updated = await execute(params({
      scope: "global",
      body: "global updated",
      overwrite: true,
      expectedRevision: global.revision,
    }));

    expect(updated.details).toMatchObject({ status: "saved", scope: "global", created: false });
    expect(readWorkflowPlaybook(cwd, "adaptive-review")?.body).toBe("project shadow");
    expect(readWorkflowPlaybookFromSource(cwd, "adaptive-review", "global")?.body).toBe("global updated");
  });

  it("rejects non-generalized and terminal-spoofing proposals before confirmation", async () => {
    const missingExample = await execute(params({ example: "" }));
    const terminalControl = await execute(params({ example: "Review\u001b[2Jhidden target" }));
    const nestedInputValue = await execute(params({
      inputs: { target: { description: "Visible\u202ehidden" } },
    }));
    const nestedInputKey = await execute(params({
      inputs: { target: { "description\u001b[2J": "hidden" } },
    }));

    expect(missingExample.details).toMatchObject({ status: "error", code: "invalid" });
    expect(terminalControl.details).toMatchObject({ status: "error", code: "invalid" });
    expect(nestedInputValue.details).toMatchObject({ status: "error", code: "invalid" });
    expect(nestedInputKey.details).toMatchObject({ status: "error", code: "invalid" });
    expect(nestedInputValue.content[0].text).toContain("inputs contain terminal control characters");
    expect(confirm).not.toHaveBeenCalled();
  });
});
