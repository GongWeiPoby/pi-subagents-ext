import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { SUBAGENT_TOOL_NAMES } from "../agent-runner.js";
import { loadWorkflowPlaybookDirectory, type WorkflowApprovalMode } from "./playbook.js";
import {
  previewWorkflowPlaybookSave,
  saveWorkflowPlaybook,
  type WorkflowPlaybookDraft,
  type WorkflowPlaybookSaveScope,
} from "./playbook-store.js";

const MAX_SAVE_APPROVAL_CHARS = 32_000;

const scopeSchema = Type.Unsafe<WorkflowPlaybookSaveScope>({
  type: "string",
  enum: ["project", "global"],
  description: "project saves under .pi/workflows; global saves under the configured agent directory.",
});

const approvalSchema = Type.Unsafe<WorkflowApprovalMode>({
  type: "string",
  enum: ["adaptive", "required", "none"],
});

const saveSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 128 }),
  scope: scopeSchema,
  description: Type.String({ minLength: 1, maxLength: 1000 }),
  body: Type.String({
    minLength: 1,
    maxLength: 120_000,
    description: "Generalized Markdown coordinator prompt. Remove task-specific literals and fixed DAG requirements.",
  }),
  domains: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 32 })),
  approval: Type.Optional(approvalSchema),
  sideEffects: Type.Optional(Type.String({ maxLength: 128 })),
  inputs: Type.Optional(
    Type.Unsafe<Record<string, unknown>>({
      type: "object",
      additionalProperties: true,
    }),
  ),
  example: Type.String({
    minLength: 1,
    maxLength: 4000,
    description: "A generalized natural-language invocation example using the proposed inputs.",
  }),
  prompts: Type.Optional(
    Type.Record(
      Type.String(),
      Type.String({ minLength: 1, maxLength: 65_536 }),
      { description: "Named prompt resources written to prompts/<name>.md." },
    ),
  ),
  overwrite: Type.Optional(Type.Boolean()),
  expectedRevision: Type.Optional(
    Type.String({
      pattern: "^[a-f0-9]{64}$",
      description: "Current revision returned by WorkflowPlaybook read. Required when overwriting.",
    }),
  ),
});

interface WorkflowPlaybookSaveDetails {
  code?: string;
  created?: boolean;
  message?: string;
  path?: string;
  revision?: string;
  scope: WorkflowPlaybookSaveScope;
  status: "cancelled" | "error" | "saved";
}

interface WorkflowPlaybookSavedEntry {
  created: boolean;
  name: string;
  path: string;
  revision: string;
  scope: WorkflowPlaybookSaveScope;
}

export function registerWorkflowPlaybookSaveTool(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<WorkflowPlaybookSavedEntry>("workflow-playbook-saved", (entry, _options, theme) => {
    const data = entry.data;
    if (!data) return undefined;
    return new Text(
      `${theme.fg("success", "✓")} ${theme.bold(data.name)} ${theme.fg("dim", `${data.scope} · ${data.revision.slice(0, 8)}`)}`,
      0,
      0,
    );
  });

  pi.registerTool({
    name: SUBAGENT_TOOL_NAMES.PLAYBOOK_SAVE,
    label: "Save Workflow Playbook",
    description:
      "Preview and save a generalized adaptive WORKFLOW.md Playbook to the current project or global agent directory. The tool requires direct user confirmation and never saves generated JavaScript.",
    promptSnippet: "Promote a successful workflow into a generalized project/global Markdown Playbook",
    promptGuidelines: [
      "Use WorkflowPlaybookSave only when the user asks to save or promote a workflow. The user chooses project or global scope through the confirmation preview.",
      "Before WorkflowPlaybookSave, generalize task-specific paths, names, platforms, and environments into inputs; include a reusable invocation example and keep stable judgment in Markdown rather than encoding a fixed DAG.",
      "Never include secrets, credentials, session IDs, run IDs, temporary paths, or machine-specific absolute paths in a saved Playbook or prompt resource.",
      "When overwriting, first read the existing Playbook from the exact project/global source and pass its revision with overwrite=true. A stale revision must be re-read, never guessed.",
    ],
    parameters: saveSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: WorkflowPlaybookSaveDetails;
    }> {
      if (params.scope === "project" && !ctx.isProjectTrusted()) {
        return errorResult(params.scope, "invalid", "Project Playbooks cannot be saved until the project is trusted");
      }

      const draft: WorkflowPlaybookDraft = {
        name: params.name,
        description: params.description,
        body: params.body,
        example: params.example,
        ...(params.domains ? { domains: params.domains } : {}),
        ...(params.approval ? { approval: params.approval } : {}),
        ...(params.sideEffects ? { sideEffects: params.sideEffects } : {}),
        ...(params.inputs ? { inputs: params.inputs } : {}),
        ...(params.prompts ? { prompts: params.prompts } : {}),
      };
      const preview = previewWorkflowPlaybookSave(ctx.cwd, params.scope, draft);
      if ("ok" in preview) return errorResult(params.scope, preview.code, preview.message);

      const source = params.scope === "project" ? "project" : "global";
      const existing = existsSync(preview.target)
        ? loadWorkflowPlaybookDirectory(preview.target, source)
        : undefined;
      if (existsSync(preview.target) && !existing) {
        return errorResult(params.scope, "invalid", `Existing Playbook at ${preview.target} is unreadable or invalid`);
      }
      if (existing && !params.overwrite) {
        return errorResult(
          params.scope,
          "conflict",
          `Playbook already exists. Read revision ${existing.revision} and resubmit with overwrite=true.`,
        );
      }
      if (existing && params.expectedRevision !== existing.revision) {
        return errorResult(
          params.scope,
          "stale",
          `Playbook changed. Read it again and use revision ${existing.revision}.`,
        );
      }

      const approvalText = formatSavePreview(preview.target, params.scope, preview.files, params.example, !!existing);
      if (approvalText.length > MAX_SAVE_APPROVAL_CHARS) {
        return errorResult(
          params.scope,
          "invalid",
          `Save preview exceeds ${MAX_SAVE_APPROVAL_CHARS} characters; split prompt resources before saving.`,
        );
      }
      if (!ctx.hasUI) {
        return errorResult(params.scope, "approval-required", "Saving a Playbook requires an interactive/RPC approval UI");
      }
      const confirmed = await ctx.ui.confirm(
        existing ? "Overwrite workflow Playbook?" : "Save workflow Playbook?",
        approvalText,
      );
      if (!confirmed) {
        return {
          content: [{ type: "text", text: "Workflow Playbook save was cancelled. No files were written." }],
          details: { status: "cancelled", scope: params.scope },
        };
      }

      const saved = saveWorkflowPlaybook({
        cwd: ctx.cwd,
        scope: params.scope,
        draft,
        overwrite: params.overwrite,
        expectedRevision: params.expectedRevision,
      });
      if (!saved.ok) return errorResult(params.scope, saved.code, saved.message);

      const entry: WorkflowPlaybookSavedEntry = {
        created: saved.created,
        name: saved.playbook.name,
        path: saved.target,
        revision: saved.playbook.revision,
        scope: params.scope,
      };
      pi.appendEntry("workflow-playbook-saved", entry);
      const action = saved.created ? "created" : "updated";
      return {
        content: [{
          type: "text",
          text:
            `Workflow Playbook ${action}: ${saved.playbook.name}\n` +
            `Scope: ${params.scope}\nPath: ${saved.target}\nRevision: ${saved.playbook.revision}\n` +
            "No JavaScript workflow was saved.",
        }],
        details: {
          status: "saved",
          scope: params.scope,
          created: saved.created,
          path: saved.target,
          revision: saved.playbook.revision,
        },
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", `▸ WorkflowPlaybookSave  ${args.name ?? ""}`), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as WorkflowPlaybookSaveDetails | undefined;
      const color = details?.status === "saved" ? "success" : details?.status === "cancelled" ? "warning" : "error";
      return new Text(theme.fg(color, details?.status ?? "playbook save"), 0, 0);
    },
  });
}

function formatSavePreview(
  target: string,
  scope: WorkflowPlaybookSaveScope,
  files: Record<string, string>,
  example: string,
  overwrite: boolean,
): string {
  const lines = [
    `Action: ${overwrite ? "overwrite" : "create"}`,
    `Scope: ${scope}`,
    `Target: ${target}`,
    `Invocation example: ${example}`,
    "",
    "Files to write:",
  ];
  for (const [path, content] of Object.entries(files)) {
    lines.push("", `--- ${path} ---`, content);
  }
  return lines.join("\n");
}

function errorResult(
  scope: WorkflowPlaybookSaveScope,
  code: string,
  message: string,
): {
  content: Array<{ type: "text"; text: string }>;
  details: WorkflowPlaybookSaveDetails;
} {
  return {
    content: [{ type: "text", text: `Workflow Playbook was not saved: ${message}` }],
    details: { status: "error", scope, code, message },
  };
}
