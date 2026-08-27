import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_TOOL_NAMES } from "../src/agent-runner.js";
import { registerWorkflowPlaybookTools } from "../src/workflow/playbook-tools.js";

interface ToolContext {
  cwd: string;
  hasUI: boolean;
  isProjectTrusted(): boolean;
  ui: {
    confirm(title: string, message: string): Promise<boolean>;
  };
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
let entries: Array<{ customType: string; data: unknown }>;
let confirm: ReturnType<typeof vi.fn>;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-playbook-tools-"));
  agentDir = mkdtempSync(join(tmpdir(), "pi-playbook-tools-agent-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  tools = new Map();
  entries = [];
  confirm = vi.fn(async () => true);
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  vi.restoreAllMocks();
});

function installTools(worktreeAllowed = true): void {
  const pi = {
    registerTool(tool: CapturedTool) {
      tools.set(tool.name, tool);
    },
    registerEntryRenderer: vi.fn(),
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
  };
  registerWorkflowPlaybookTools(pi as unknown as ExtensionAPI, { worktreeAllowed });
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
  name: string,
  params: Record<string, unknown>,
  context: ToolContext = { cwd, hasUI: true, isProjectTrusted: () => true, ui: { confirm } },
) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool.execute("call-1", params, undefined, undefined, context);
}

describe("workflow Playbook tools", () => {
  it("keeps the combined Playbook planning tool contract bounded", () => {
    installTools();
    const contract = [...tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      promptGuidelines: tool.promptGuidelines,
      parameters: tool.parameters,
    }));

    expect(JSON.stringify(contract).length).toBeLessThan(8_000);
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

    const result = await execute(SUBAGENT_TOOL_NAMES.PLAYBOOK, { action: "list" });
    const details = result.details as { playbooks?: unknown[]; total?: number; truncated?: boolean };

    expect(details.playbooks).toHaveLength(100);
    expect(details.total).toBe(105);
    expect(details.truncated).toBe(true);
    expect(result.content[0].text).toContain("5 more playbooks not shown");
  });

  it("registers both tools and lists/reads Playbook prompts", async () => {
    writeExample();
    installTools();

    const listing = await execute(SUBAGENT_TOOL_NAMES.PLAYBOOK, { action: "list" });
    const read = await execute(SUBAGENT_TOOL_NAMES.PLAYBOOK, { action: "read", name: "review" });

    expect([...tools.keys()]).toEqual([SUBAGENT_TOOL_NAMES.PLAYBOOK, SUBAGENT_TOOL_NAMES.PLAN]);
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

    const normal = await execute(SUBAGENT_TOOL_NAMES.PLAYBOOK, { action: "read", name: "review" });
    const global = await execute(
      SUBAGENT_TOOL_NAMES.PLAYBOOK,
      { action: "read", name: "review", source: "global" },
    );

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

    const listing = await execute(
      SUBAGENT_TOOL_NAMES.PLAYBOOK,
      { action: "list" },
      { cwd, hasUI: true, isProjectTrusted: () => false, ui: { confirm } },
    );
    const projectRead = await execute(
      SUBAGENT_TOOL_NAMES.PLAYBOOK,
      { action: "read", name: "review", source: "project" },
      { cwd, hasUI: true, isProjectTrusted: () => false, ui: { confirm } },
    );

    expect(listing.content[0].text).toContain("global-review [global/adaptive]");
    expect(listing.content[0].text).not.toContain("review [project/adaptive]");
    expect(projectRead.details?.error).toBe("untrusted-project-source");
  });

  it("requires a name for read", async () => {
    installTools();

    await expect(execute(SUBAGENT_TOOL_NAMES.PLAYBOOK, { action: "read" }))
      .rejects.toThrow("requires name");
  });

  it("returns validation errors without creating a plan entry", async () => {
    installTools();

    const result = await execute(SUBAGENT_TOOL_NAMES.PLAN, {
      objective: "Bad plan",
      nodes: [
        { id: "same", title: "One", capability: "review", prompt: "one" },
        { id: "same", title: "Two", capability: "review", prompt: "two" },
      ],
    });

    expect(result.content[0].text).toContain("duplicate node id");
    expect(result.details?.status).toBe("invalid");
    expect(entries).toEqual([]);
  });

  it("rejects worktree nodes when project isolation is disabled", async () => {
    installTools(false);

    const result = await execute(SUBAGENT_TOOL_NAMES.PLAN, {
      objective: "Edit in parallel",
      nodes: [
        {
          id: "edit",
          title: "Edit",
          capability: "implementation",
          prompt: "Edit the code",
          isolation: "worktree",
        },
      ],
    });

    expect(result.details?.status).toBe("invalid");
    expect(result.content[0].text).toContain("worktree isolation is disabled");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("keeps a declined high-impact plan non-executable and records it", async () => {
    installTools();
    confirm.mockResolvedValue(false);

    const result = await execute(SUBAGENT_TOOL_NAMES.PLAN, {
      objective: "Deploy production",
      nodes: [
        {
          id: "deploy",
          title: "Deploy",
          capability: "deploy",
          prompt: "Deploy the build",
          gate: "./deploy.sh --production",
          sideEffects: "external",
        },
      ],
    });

    expect(confirm).toHaveBeenCalledWith(
      "Approve workflow plan?",
      expect.stringContaining("Gate: ./deploy.sh --production"),
    );
    expect(confirm.mock.calls[0]?.[1]).toContain("Task: Deploy the build");
    expect(result.details?.status).toBe("awaiting_approval");
    expect(result.details?.script).toBeUndefined();
    expect(result.content[0].text).toContain("was not approved");
    expect(entries).toEqual([
      expect.objectContaining({
        customType: "workflow-plan",
        data: expect.objectContaining({
          objective: "Deploy production",
          status: "awaiting_approval",
          plan: expect.objectContaining({
            nodes: [expect.objectContaining({ id: "deploy", gate: "./deploy.sh --production" })],
          }),
        }),
      }),
    ]);
  });

  it("compiles the exact high-impact plan only after direct UI approval", async () => {
    installTools();
    confirm.mockResolvedValue(true);

    const result = await execute(SUBAGENT_TOOL_NAMES.PLAN, {
      objective: "Publish content",
      nodes: [
        {
          id: "publish",
          title: "Publish",
          capability: "publish",
          prompt: "Publish the approved article",
          sideEffects: "external",
        },
      ],
    });

    expect(confirm).toHaveBeenCalledOnce();
    expect(result.details?.status).toBe("ready");
    expect(result.details?.script).toContain("export const meta");
  });

  it("fails closed for a low-risk Plan without an approval UI", async () => {
    installTools();

    const result = await execute(
      SUBAGENT_TOOL_NAMES.PLAN,
      {
        objective: "Inspect the change",
        nodes: [
          {
            id: "inspect",
            title: "Inspect",
            capability: "review",
            prompt: "Inspect the diff",
            sideEffects: "read",
          },
        ],
      },
      { cwd, hasUI: false, isProjectTrusted: () => true, ui: { confirm } },
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(result.details?.status).toBe("awaiting_approval");
    expect(result.details?.script).toBeUndefined();
  });

  it.each(["required", "none"] as const)(
    "treats selected Playbook approval=%s as advisory and still confirms the Plan exactly once",
    async (approval) => {
      const directory = join(cwd, ".pi", "workflows", "release");
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "WORKFLOW.md"),
        `---\nname: release\ndescription: Release safely\napproval: ${approval}\n---\nCoordinate release`,
        "utf-8",
      );
      installTools();
      confirm.mockResolvedValue(true);

      const result = await execute(SUBAGENT_TOOL_NAMES.PLAN, {
        objective: "Prepare release",
        playbook: "release",
        nodes: [
          {
            id: "prepare",
            title: "Prepare",
            capability: "release-preparation",
            prompt: "Prepare release notes",
          },
        ],
      });

      expect(confirm).toHaveBeenCalledOnce();
      expect(result.details?.status).toBe("ready");
      expect((result.details?.plan as { approved?: boolean } | undefined)?.approved).toBe(true);
      expect(result.details?.script).toContain("export const meta");
    },
  );

  it("returns a temporary script for a ready plan and records the structured plan", async () => {
    installTools();

    const result = await execute(SUBAGENT_TOOL_NAMES.PLAN, {
      objective: "Review code",
      personas: [{ name: "work-backend", role: "backend engineer" }],
      confidence: 0.95,
      evidence: ["backend repository"],
      nodes: [
        {
          id: "review",
          title: "Review",
          capability: "code-review",
          prompt: "Review the current diff",
          agentType: "code-reviewer",
        },
      ],
      omitted: [{ capability: "ui-review", reason: "No UI changed" }],
    });

    expect(result.details?.status).toBe("ready");
    expect(result.details?.script).toContain("export const meta");
    expect(result.content[0].text).toContain("compiled script from tool details");
    expect(entries).toEqual([
      expect.objectContaining({
        customType: "workflow-plan",
        data: expect.objectContaining({
          objective: "Review code",
          status: "ready",
          plan: expect.objectContaining({
            confidence: 0.95,
            evidence: ["backend repository"],
            personas: [expect.objectContaining({ name: "work-backend" })],
            omitted: [{ capability: "ui-review", reason: "No UI changed" }],
            nodes: [expect.objectContaining({ id: "review", agentType: "code-reviewer" })],
          }),
        }),
      }),
    ]);
  });
});
