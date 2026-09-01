import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { SUBAGENT_TOOL_NAMES } from "../agent-runner.js";
import {
  listWorkflowPlaybooks,
  readWorkflowPlaybook,
  readWorkflowPlaybookFromSource,
  type WorkflowPlaybook,
  type WorkflowPlaybookSource,
} from "./playbook.js";

const MAX_TOOL_TEXT_CHARS = 48_000;
const MAX_LISTED_PLAYBOOKS = 100;

const actionSchema = Type.Unsafe<"list" | "read">({
  type: "string",
  enum: ["list", "read"],
  description: "list discovers available playbooks; read returns one playbook and its prompt resources.",
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

export function registerWorkflowPlaybookTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: SUBAGENT_TOOL_NAMES.PLAYBOOK,
    label: "Workflow Playbook",
    description:
      "Discover and read adaptive Markdown WORKFLOW.md playbooks. A playbook is coordinator guidance; it does not execute agents or impose mandatory stages.",
    promptSnippet: "Discover adaptive Markdown workflow guidance and prompt resources",
    promptGuidelines: [
      "Use WorkflowPlaybook to discover reusable coordination guidance when a substantive task may match a saved playbook; skip it for trivial or direct one-step work.",
      "Treat WorkflowPlaybook content as adaptable guidance, not a fixed checklist. The main coordinator reads the Markdown, then dynamically invokes Agent, ordinary tools, and skills according to the actual objective and project context.",
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
