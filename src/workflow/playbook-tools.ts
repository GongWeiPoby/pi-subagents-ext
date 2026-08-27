import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { SUBAGENT_TOOL_NAMES } from "../agent-runner.js";
import {
  compileWorkflowPlan,
  formatWorkflowPlanApproval,
  formatWorkflowPlanYaml,
  type NormalizedWorkflowPlan,
} from "./plan.js";
import {
  listWorkflowPlaybooks,
  readWorkflowPlaybook,
  readWorkflowPlaybookFromSource,
  type WorkflowPlaybook,
  type WorkflowPlaybookSource,
} from "./playbook.js";

const MAX_TOOL_TEXT_CHARS = 48_000;
const MAX_LISTED_PLAYBOOKS = 100;
const MAX_APPROVAL_TEXT_CHARS = 16_000;

const actionSchema = Type.Unsafe<"list" | "read">({
  type: "string",
  enum: ["list", "read"],
  description: "list discovers available playbooks; read returns one playbook and its prompt resources.",
});

const approvalSchema = Type.Unsafe<"adaptive" | "none" | "required">({
  type: "string",
  enum: ["adaptive", "none", "required"],
});

const sideEffectsSchema = Type.Unsafe<"external" | "none" | "read" | "write">({
  type: "string",
  enum: ["external", "none", "read", "write"],
});

const effortSchema = Type.Unsafe<"minimal" | "low" | "medium" | "high" | "xhigh" | "max">({
  type: "string",
  enum: ["minimal", "low", "medium", "high", "xhigh", "max"],
});

const playbookSourceSchema = Type.Unsafe<WorkflowPlaybookSource>({
  type: "string",
  enum: ["project", "workspace", "global"],
  description: "Optional exact source for action=read; omit for normal precedence.",
});

const playbookToolSchema = Type.Object({
  action: actionSchema,
  name: Type.Optional(Type.String({ description: "Playbook name. Required for action=read." })),
  query: Type.Optional(Type.String({ description: "Optional case-insensitive filter for action=list." })),
  source: Type.Optional(playbookSourceSchema),
});

const workflowPlanSchema = Type.Object({
  objective: Type.String({ minLength: 1, maxLength: 2000 }),
  playbook: Type.Optional(Type.String({ maxLength: 128 })),
  personas: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String({ minLength: 1, maxLength: 128 }),
        role: Type.String({ minLength: 1, maxLength: 256 }),
        instructions: Type.Optional(Type.String({ maxLength: 2000 })),
      }),
      { maxItems: 8 },
    ),
  ),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  evidence: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 32 })),
  nodes: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 64 }),
      title: Type.String({ minLength: 1, maxLength: 256 }),
      capability: Type.String({ minLength: 1, maxLength: 256 }),
      prompt: Type.String({ minLength: 1, maxLength: 8000 }),
      agentType: Type.Optional(Type.String({ maxLength: 128 })),
      model: Type.Optional(Type.String({ maxLength: 256 })),
      effort: Type.Optional(effortSchema),
      isolation: Type.Optional(Type.Literal("worktree")),
      gate: Type.Optional(Type.String({ maxLength: 4000 })),
      phase: Type.Optional(Type.String({ maxLength: 256 })),
      dependsOn: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 64 })),
      approval: Type.Optional(approvalSchema),
      sideEffects: Type.Optional(sideEffectsSchema),
      skills: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 32 })),
      schema: Type.Optional(
        Type.Unsafe<Record<string, unknown>>({
          type: "object",
          additionalProperties: true,
        }),
      ),
    }),
    { minItems: 1, maxItems: 64 },
  ),
  omitted: Type.Optional(
    Type.Array(
      Type.Object({
        capability: Type.String({ minLength: 1, maxLength: 256 }),
        reason: Type.String({ minLength: 1, maxLength: 2000 }),
      }),
      { maxItems: 64 },
    ),
  ),
});

interface WorkflowPlanToolDetails {
  errors?: string[];
  objective?: string;
  plan?: NormalizedWorkflowPlan;
  planRef?: string;
  planYaml?: string;
  status: "awaiting_approval" | "invalid" | "ready";
}

interface WorkflowPlanEntryData {
  objective: string;
  plan: NormalizedWorkflowPlan;
  status: "awaiting_approval" | "ready";
}

export interface WorkflowPlaybookToolOptions {
  authorizeScript?: (script: string) => string;
  worktreeAllowed?: boolean;
}

export function registerWorkflowPlaybookTools(
  pi: ExtensionAPI,
  options: WorkflowPlaybookToolOptions = {},
): void {
  const worktreeAllowed = options.worktreeAllowed ?? true;
  pi.registerEntryRenderer<WorkflowPlanEntryData>("workflow-plan", (entry, _options, theme) => {
    const data = entry.data;
    if (!data) return undefined;
    const icon = data.status === "ready" ? theme.fg("success", "✓") : theme.fg("warning", "◼");
    return new Text(`${icon} ${theme.bold("Workflow plan")} ${data.objective}\n${theme.fg("dim", data.status)}`, 0, 0);
  });

  pi.registerTool({
    name: SUBAGENT_TOOL_NAMES.PLAYBOOK,
    label: "Workflow Playbook",
    description:
      "Discover and read adaptive Markdown WORKFLOW.md playbooks. A playbook is coordinator guidance for planning; it does not execute agents or impose mandatory stages.",
    promptSnippet: "Discover adaptive Markdown workflow guidance and prompt resources",
    promptGuidelines: [
      "Use WorkflowPlaybook to discover reusable planning guidance when a substantive task may match a saved playbook; skip it for trivial or direct one-step work.",
      "Treat WorkflowPlaybook content as adaptable guidance, not a fixed checklist. Select, omit, reorder, or create nodes according to the actual objective and project context.",
      "After adapting a playbook, use WorkflowPlan to validate the structured execution graph before starting a multi-node workflow.",
      "When preparing an overwrite with WorkflowPlaybookSave, read the exact project or global source so the revision cannot come from a shadowing Playbook.",
    ],
    parameters: playbookToolSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const includeProject = ctx.isProjectTrusted();
      if (params.action === "list") {
        const playbooks = listWorkflowPlaybooks(ctx.cwd, params.query, { includeProject });
        const visible = playbooks.slice(0, MAX_LISTED_PLAYBOOKS);
        const hidden = playbooks.length - visible.length;
        const listText = visible.length === 0
          ? "No adaptive WORKFLOW.md playbooks found."
          : visible.map(formatPlaybookSummary).join("\n")
            + (hidden > 0 ? `\n... ${hidden} more playbooks not shown; narrow the query.` : "");
        const text = truncateToolText(listText, "the Playbook catalogue");
        return {
          content: [{ type: "text" as const, text }],
          details: {
            action: "list",
            playbooks: visible.map((playbook) => ({
              name: playbook.name,
              description: playbook.description,
              source: playbook.source,
              path: playbook.path,
              execution: playbook.execution,
              prompts: Object.keys(playbook.prompts),
            })),
            total: playbooks.length,
            truncated: hidden > 0,
          },
        };
      }

      const name = params.name?.trim();
      if (!name) throw new Error("WorkflowPlaybook action=read requires name");
      const selectedSource = params.source as WorkflowPlaybookSource | undefined;
      if (selectedSource && selectedSource !== "global" && !includeProject) {
        return {
          content: [{ type: "text" as const, text: "Project/workspace Playbooks are unavailable until the project is trusted." }],
          details: { action: "read", error: "untrusted-project-source" },
        };
      }
      const playbook = selectedSource
        ? readWorkflowPlaybookFromSource(ctx.cwd, name, selectedSource)
        : readWorkflowPlaybook(ctx.cwd, name, { includeProject });
      if (!playbook) throw new Error(`No adaptive workflow playbook named "${name}"`);
      return {
        content: [{ type: "text" as const, text: truncateToolText(formatPlaybook(playbook), playbook.path) }],
        details: {
          action: "read",
          playbook: {
            name: playbook.name,
            description: playbook.description,
            source: playbook.source,
            path: playbook.path,
            revision: playbook.revision,
            execution: playbook.execution,
            prompts: Object.keys(playbook.prompts),
          },
        },
      };
    },
    renderCall(args, theme) {
      const suffix = args.action === "read" && args.name ? ` ${args.name}` : "";
      return new Text(theme.fg("toolTitle", `▸ WorkflowPlaybook${suffix}`), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as { action?: string; playbook?: WorkflowPlaybook; playbooks?: unknown[] } | undefined;
      if (details?.action === "read" && details.playbook) {
        return new Text(
          `${theme.fg("success", "✓")} ${details.playbook.name} ${theme.fg("dim", details.playbook.source)}`,
          0,
          0,
        );
      }
      const count = details?.playbooks?.length ?? 0;
      return new Text(theme.fg("dim", `${count} workflow playbook${count === 1 ? "" : "s"}`), 0, 0);
    },
  });

  pi.registerTool({
    name: SUBAGENT_TOOL_NAMES.PLAN,
    label: "Workflow Plan",
    description:
      "Validate an adaptive structured workflow plan and compile it into temporary JavaScript for SubagentWorkflow. The plan is the inspectable run source; the generated JavaScript is ephemeral and is never saved as a reusable workflow.",
    promptSnippet: "Validate an adaptive workflow DAG and compile a temporary SubagentWorkflow script",
    promptGuidelines: [
      "Use WorkflowPlan only after understanding the objective, relevant personas, project facts, and any selected WorkflowPlaybook. Include only useful nodes and explain material omissions.",
      "When persona or task interpretation is low-confidence, ask the user one focused question before calling WorkflowPlan. Personas bias planning but never force fixed stages.",
      "WorkflowPlan always shows the normalized plan and asks the user directly before compiling. External/gate/required metadata is highlighted but model-supplied metadata is never the authorization boundary.",
      "When WorkflowPlan returns status=ready, call SubagentWorkflow with the exact planRef on the next turn; do not rewrite or save generated execution code.",
    ],
    parameters: workflowPlanSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: WorkflowPlanToolDetails;
    }> {
      if (!worktreeAllowed && params.nodes.some((node) => node.isolation === "worktree")) {
        return invalidPlanResult([
          "worktree isolation is disabled for this project; remove node isolation or enable worktreeIsolation",
        ]);
      }
      let compilation = compileWorkflowPlan(params);
      if (!compilation.ok) {
        return invalidPlanResult(compilation.errors);
      }

      const namedPlaybook = params.playbook?.trim();
      const playbook = namedPlaybook
        ? readWorkflowPlaybook(ctx.cwd, namedPlaybook, { includeProject: ctx.isProjectTrusted() })
        : undefined;
      if (namedPlaybook && !playbook) {
        return invalidPlanResult([`playbook "${namedPlaybook}" was not found in the trusted catalogue`]);
      }
      // Adaptive plans can select agents with broad tools, so model-supplied
      // side-effect metadata is never the authorization boundary. Every Plan
      // is shown and confirmed; metadata changes emphasis, not whether the
      // confirmation exists.
      {
        const approvalText = formatWorkflowPlanApproval(compilation.plan);
        if (approvalText.length > MAX_APPROVAL_TEXT_CHARS) {
          return invalidPlanResult([
            `approval view exceeds ${MAX_APPROVAL_TEXT_CHARS} characters; split the high-impact plan before requesting approval`,
          ]);
        }
        if (!ctx.hasUI) {
          const planYaml = formatWorkflowPlanYaml(compilation.plan);
          const entry: WorkflowPlanEntryData = {
            objective: compilation.plan.objective,
            plan: compilation.plan,
            status: "awaiting_approval",
          };
          pi.appendEntry("workflow-plan", entry);
          return {
            content: [{
              type: "text" as const,
              text:
                "Workflow plan requires direct user approval, but this session has no approval UI. " +
                "No script was produced. Run the plan from an interactive/RPC session.\n\n" +
                `\`\`\`yaml\n${planYaml}\n\`\`\``,
            }],
            details: { ...entry, planYaml },
          };
        }

        const approved = await ctx.ui.confirm(
          "Approve workflow plan?",
          approvalText,
        );
        if (!approved) {
          const planYaml = formatWorkflowPlanYaml(compilation.plan);
          const entry: WorkflowPlanEntryData = {
            objective: compilation.plan.objective,
            plan: compilation.plan,
            status: "awaiting_approval",
          };
          pi.appendEntry("workflow-plan", entry);
          return {
            content: [{
              type: "text" as const,
              text: `Workflow plan was not approved. No script was produced.\n\n\`\`\`yaml\n${planYaml}\n\`\`\``,
            }],
            details: { ...entry, planYaml },
          };
        }

        compilation = compileWorkflowPlan(params, { approved: true });
        if (!compilation.ok) return invalidPlanResult(compilation.errors);
        if (compilation.status !== "ready") {
          return invalidPlanResult(["approved plan did not transition to ready"]);
        }
      }

      const planYaml = formatWorkflowPlanYaml(compilation.plan);
      const planRef = options.authorizeScript?.(compilation.script);
      const entry: WorkflowPlanEntryData = {
        objective: compilation.plan.objective,
        plan: compilation.plan,
        status: "ready",
      };
      pi.appendEntry("workflow-plan", entry);
      return {
        content: [{
          type: "text" as const,
          text:
            `Workflow plan validated and compiled. ${planRef
              ? `Call SubagentWorkflow with planRef: ${planRef}.`
              : "The host did not provide an opaque execution reference; use the compiled script from tool details."}\n\n` +
            `\`\`\`yaml\n${planYaml}${planRef ? `\nexecution_ref: ${JSON.stringify(planRef)}` : ""}\n\`\`\``,
        }],
        details: {
          ...entry,
          planYaml,
          ...(planRef !== undefined ? { planRef } : { script: compilation.script }),
        },
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", `▸ WorkflowPlan  ${args.objective ?? ""}`), 0, 0);
    },
    renderResult(result, _options, theme) {
      const status = (result.details as { status?: string } | undefined)?.status;
      const color = status === "ready" ? "success" : status === "invalid" ? "error" : "warning";
      return new Text(theme.fg(color, status ?? "workflow plan"), 0, 0);
    },
  });
}

function invalidPlanResult(errors: string[]): {
  content: Array<{ type: "text"; text: string }>;
  details: WorkflowPlanToolDetails;
} {
  return {
    content: [{ type: "text", text: `Workflow plan is invalid:\n- ${errors.join("\n- ")}` }],
    details: { status: "invalid", errors },
  };
}

function formatPlaybookSummary(playbook: WorkflowPlaybook): string {
  const domains = playbook.domains.length > 0 ? ` domains=${playbook.domains.join(",")}` : "";
  const prompts = Object.keys(playbook.prompts);
  return `${playbook.name} [${playbook.source}/${playbook.execution}]${domains} prompts=${prompts.length} — ${playbook.description}`;
}

function formatPlaybook(playbook: WorkflowPlaybook): string {
  const metadata = {
    name: playbook.name,
    description: playbook.description,
    execution: playbook.execution,
    approval: playbook.approval,
    sideEffects: playbook.sideEffects,
    domains: playbook.domains,
    inputs: playbook.inputs ?? {},
    source: playbook.source,
    path: playbook.path,
    revision: playbook.revision,
  };
  const sections = [
    `# Workflow Playbook: ${playbook.name}`,
    "",
    `Metadata:\n${JSON.stringify(metadata, null, 2)}`,
    "",
    "## Coordinator Prompt",
    "",
    playbook.body || "(No inline coordinator prompt.)",
  ];
  for (const prompt of Object.values(playbook.prompts)) {
    sections.push("", `## Prompt Resource: ${prompt.name}`, "", prompt.content);
  }
  return sections.join("\n");
}

function truncateToolText(text: string, sourcePath: string): string {
  if (text.length <= MAX_TOOL_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_TEXT_CHARS)}\n\n[Playbook output truncated. Read ${sourcePath}]`;
}
