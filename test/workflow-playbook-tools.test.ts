import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_TOOL_NAMES } from "../src/agent-runner.js";
import { registerWorkflowPlaybookTools } from "../src/workflow/playbook-tools.js";

interface ToolContext {
  cwd: string;
  isProjectTrusted(): boolean;
}

interface CapturedTool {
  description?: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ToolContext,
  ): Promise<{ content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }>;
  name: string;
  parameters: unknown;
  promptGuidelines?: string[];
  promptSnippet?: string;
}

let cwd: string;
let agentDir: string;
let previousAgentDir: string | undefined;
let tools: Map<string, CapturedTool>;
let registerEntryRenderer: ReturnType<typeof vi.fn>;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-playbook-tools-"));
  agentDir = mkdtempSync(join(tmpdir(), "pi-playbook-tools-agent-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  tools = new Map();
  registerEntryRenderer = vi.fn();
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  vi.restoreAllMocks();
});

function installTools(): void {
  const pi = {
    registerTool(tool: CapturedTool) {
      tools.set(tool.name, tool);
    },
    registerEntryRenderer,
  };
  registerWorkflowPlaybookTools(pi as unknown as ExtensionAPI);
}

function writeExample(): void {
  const directory = join(cwd, ".pi", "workflows", "review");
  mkdirSync(join(directory, "prompts"), { recursive: true });
  writeFileSync(
    join(directory, "WORKFLOW.md"),
    [
      "---",
      "name: review",
      "description: Review a change adaptively",
      "domains: software, review",
      "---",
      "Choose the smallest adequate review strategy.",
    ].join("\n"),
  );
  writeFileSync(join(directory, "prompts", "verify.md"), "Verify {{finding}}", "utf-8");
}

async function execute(
  params: Record<string, unknown>,
  context: ToolContext = { cwd, isProjectTrusted: () => true },
) {
  const tool = tools.get(SUBAGENT_TOOL_NAMES.PLAYBOOK);
  if (!tool) throw new Error("WorkflowPlaybook was not registered");
  return tool.execute("call-1", params, undefined, undefined, context);
}

describe("WorkflowPlaybook", () => {
  it("keeps the catalogue contract bounded and teaches dynamic coordination", () => {
    installTools();
    const tool = tools.get(SUBAGENT_TOOL_NAMES.PLAYBOOK);
    const contract = JSON.stringify({
      name: tool?.name,
      description: tool?.description,
      promptSnippet: tool?.promptSnippet,
      promptGuidelines: tool?.promptGuidelines,
      parameters: tool?.parameters,
    });
    const guidelines = tool?.promptGuidelines?.join("\n") ?? "";

    expect([...tools.keys()]).toEqual([SUBAGENT_TOOL_NAMES.PLAYBOOK]);
    expect(contract.length).toBeLessThan(4_000);
    expect(guidelines).toContain("main coordinator");
    expect(guidelines).toContain("dynamically");
    expect(guidelines).toContain("Agent");
    expect(guidelines).toContain("ordinary tools");
    expect(guidelines).toContain("skills");
    expect(guidelines).not.toMatch(/DAG|generated JavaScript|planRef/);
    expect(registerEntryRenderer).not.toHaveBeenCalled();
  });

  it("bounds catalogue result count and reports hidden Playbooks", async () => {
    for (let index = 0; index < 105; index++) {
      const name = `playbook-${String(index).padStart(3, "0")}`;
      const directory = join(cwd, ".pi", "workflows", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "WORKFLOW.md"),
        `---\nname: ${name}\ndescription: ${name}\n---\nGuidance`,
        "utf-8",
      );
    }
    installTools();

    const result = await execute({ action: "list" });
    const details = result.details as { playbooks?: unknown[]; total?: number; truncated?: boolean };

    expect(details.playbooks).toHaveLength(100);
    expect(details.total).toBe(105);
    expect(details.truncated).toBe(true);
    expect(result.content[0].text).toContain("5 more playbooks not shown");
  });

  it("lists and reads Playbook prompt resources", async () => {
    writeExample();
    installTools();

    const listing = await execute({ action: "list" });
    const read = await execute({ action: "read", name: "review" });

    expect(listing.content[0].text).toContain("review [project/adaptive]");
    expect(read.content[0].text).toContain("Choose the smallest adequate review strategy");
    expect(read.content[0].text).toContain("Prompt Resource: verify");
    expect(read.details?.playbook).toMatchObject({ name: "review", source: "project" });
  });

  it("reads an exact source revision when a project Playbook shadows global", async () => {
    writeExample();
    const globalDirectory = join(agentDir, "workflows", "review");
    mkdirSync(globalDirectory, { recursive: true });
    writeFileSync(
      join(globalDirectory, "WORKFLOW.md"),
      "---\nname: review\ndescription: Global review\n---\nGlobal guidance",
      "utf-8",
    );
    installTools();

    const normal = await execute({ action: "read", name: "review" });
    const global = await execute({ action: "read", name: "review", source: "global" });

    expect(normal.details?.playbook).toMatchObject({ source: "project" });
    expect(global.details?.playbook).toMatchObject({ source: "global" });
    expect(global.content[0].text).toContain("Global guidance");
  });

  it("does not expose project Playbooks when the project is untrusted", async () => {
    writeExample();
    const globalDirectory = join(agentDir, "workflows", "global-review");
    mkdirSync(globalDirectory, { recursive: true });
    writeFileSync(
      join(globalDirectory, "WORKFLOW.md"),
      "---\nname: global-review\ndescription: Global review\n---\nGlobal guidance",
      "utf-8",
    );
    installTools();
    const context = { cwd, isProjectTrusted: () => false };

    const listing = await execute({ action: "list" }, context);
    const projectRead = await execute({ action: "read", name: "review", source: "project" }, context);

    expect(listing.content[0].text).toContain("global-review [global/adaptive]");
    expect(listing.content[0].text).not.toContain("review [project/adaptive]");
    expect(projectRead.details?.error).toBe("untrusted-project-source");
  });

  it("requires a name for read", async () => {
    installTools();

    await expect(execute({ action: "read" })).rejects.toThrow("requires name");
  });
});
