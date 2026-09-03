/**
 * agent-widget.ts — Persistent widget showing running/completed agents above the editor.
 *
 * Displays a tree of agents with animated spinners, live stats, and activity descriptions.
 * Uses the callback form of setWidget for themed rendering.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { renderAgentName } from "../agent-color.js";
import { type AgentManager, isTopLevelAgent } from "../agent-manager.js";
import { getConfig } from "../agent-types.js";
import type { AgentInvocation, SubagentType, WidgetMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent, type LifetimeUsage, type SessionLike } from "../usage.js";
import {
  type FleetWorkflow,
  type FleetWorkflowAgent,
  type FleetWorkflowPhase,
  fleetWorkflowElapsed,
} from "../workflow/fleet.js";
import { BRAILLE_SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "./spinner.js";

// ---- Constants ----

/** Maximum number of rendered lines before overflow collapse kicks in. */
const MAX_WIDGET_LINES = 12;

export { BRAILLE_SPINNER_FRAMES as SPINNER, SPINNER_INTERVAL_MS } from "./spinner.js";

/** Statuses that indicate an error/non-success outcome (used for linger behavior and icon rendering). */
export const ERROR_STATUSES = new Set(["error", "aborted", "steered", "stopped"]);

/** Tool name → human-readable action for activity descriptions. */
const TOOL_DISPLAY: Record<string, string> = {
  read: "reading",
  bash: "running command",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding files",
  ls: "listing",
};

const WORKFLOW_LINGER_MS = 4000;

export type WorkflowState = FleetWorkflowAgent["state"];

export function workflowPhaseState(phase: FleetWorkflowPhase): WorkflowState | "not-started" {
  if (phase.agents.length === 0) return "not-started";
  if (phase.agents.some(agent => agent.state === "failed")) return "failed";
  if (phase.agents.some(agent => agent.state === "blocked")) return "blocked";
  if (phase.agents.some(agent => agent.state === "running")) return "running";
  if (phase.agents.some(agent => agent.state === "queued")) return "queued";
  if (phase.agents.some(agent => agent.state === "interrupted")) return "interrupted";
  if (phase.agents.some(agent => agent.state === "skipped")) return "skipped";
  return "done";
}

export function workflowStateGlyph(state: WorkflowState | "not-started", frame: string, theme: Theme): string {
  switch (state) {
    case "running": return theme.fg("accent", frame);
    case "done": return theme.fg("success", "✓");
    case "failed":
    case "blocked": return theme.fg("error", "✗");
    case "interrupted":
    case "skipped": return theme.fg("dim", "■");
    case "queued": return theme.fg("accent", "○");
    case "not-started": return theme.fg("dim", "○");
  }
}

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

/** Per-agent live activity state. */
export interface AgentActivity {
  activeTools: Map<string, string>;
  toolUses: number;
  responseText: string;
  session?: SessionLike;
  /** Current turn count. */
  turnCount: number;
  /** Effective max turns for this agent (undefined = unlimited). */
  maxTurns?: number;
}

/** Metadata attached to Agent tool results for custom rendering. */
export interface AgentDetails {
  displayName: string;
  description: string;
  subagentType: string;
  toolUses: number;
  tokens: string;
  durationMs: number;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error" | "background";
  /** Human-readable description of what the agent is currently doing. */
  activity?: string;
  /** Current spinner frame index (for animated running indicator). */
  spinnerFrame?: number;
  /** Short label for the model the run used, e.g. "haiku 4.5". */
  modelName?: string;
  /** Notable config tags (e.g. ["thinking: high", "isolated"]). */
  tags?: string[];
  /** Current turn count. */
  turnCount?: number;
  /** Effective max turns (undefined = unlimited). */
  maxTurns?: number;
  /** Estimated cost in USD; 0 when the model has no pricing data. */
  cost?: number;
  agentId?: string;
  error?: string;
}

// ---- Formatting helpers ----

/** Apply foreground styling while restoring it after nested foreground/full ANSI resets. */
export function fgPreservingNestedStyles(theme: Theme, color: string, text: string): string {
  const styledEmpty = theme.fg(color, "");
  const styleStart = styledEmpty.replace(/\u001b\[(?:0|39)m/g, "");
  return theme.fg(color, text.replace(/\u001b\[(?:0|39)m/g, reset => `${reset}${styleStart}`));
}

/** Format a token count compactly: "33.8k token", "1.2M token". */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
  return `${count} token`;
}

/**
 * Format a cost as `~$0.0042`, or "" when there is nothing to show.
 *
 * The tilde is load-bearing: this is pi's own estimate from the model's listed
 * rates, not a billed figure, and the surfaces that print it sit next to token
 * counts that ARE exact.
 *
 * Nothing is printed for zero, which is also what a model with no pricing data
 * reports: `$0.00` beside a local model's tokens would claim its cost was
 * measured and found to be nothing, rather than never measured at all. For the
 * same reason a real cost too small for four decimals reads `<$0.0001` — it was
 * measured, and rounding it to `~$0.0000` would say the opposite.
 */
export function formatCost(cost: number): string {
  if (!(cost > 0)) return "";                     // also catches NaN
  if (cost < 0.0001) return "<$0.0001";
  if (cost >= 1) return `~$${cost.toFixed(2)}`;
  // Under a dollar: cents at minimum, four decimals at most, nothing trailing.
  // Most single runs land between a tenth of a cent and a dime, where rounding
  // to cents would collapse a 4x difference in spend into the same figure.
  const rounded = Number(cost.toFixed(4));
  const decimals = (String(rounded).split(".")[1] ?? "").length;
  return `~$${rounded.toFixed(Math.max(2, decimals))}`;
}

/**
 * Token count with optional context-fill % and compaction-count annotations.
 * Thresholds for percent: <70% dim, 70–85% warning, ≥85% error.
 * Compaction count rendered as `⇊N` in dim.
 *
 *   "12.3k token"               — no annotations
 *   "12.3k token (45%)"         — percent only
 *   "12.3k token (⇊2)"          — compactions only (e.g. right after compact)
 *   "12.3k token (45% · ⇊2)"    — both
 */
export function formatSessionTokens(
  tokens: number,
  percent: number | null,
  theme: Theme,
  compactions = 0,
): string {
  const tokenStr = formatTokens(tokens);
  const annot: string[] = [];
  if (percent !== null) {
    const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim";
    annot.push(theme.fg(color, `${Math.round(percent)}%`));
  }
  if (compactions > 0) {
    annot.push(theme.fg("dim", `⇊${compactions}`));
  }
  if (annot.length === 0) return tokenStr;
  return `${tokenStr} (${annot.join(" · ")})`;
}

/** Format turn count with optional max limit: "↻5≤30" or "↻5". */
export function formatTurns(turnCount: number, maxTurns?: number | null): string {
  return maxTurns != null ? `↻${turnCount}≤${maxTurns}` : `↻${turnCount}`;
}

/** Format milliseconds as human-readable duration. */
export function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Format duration from start/completed timestamps. */
export function formatDuration(startedAt: number, completedAt?: number): string {
  if (completedAt) return formatMs(completedAt - startedAt);
  return `${formatMs(Date.now() - startedAt)} (running)`;
}

/** Get display name for any agent type (built-in or custom). */
export function getDisplayName(type: SubagentType): string {
  return getConfig(type).displayName;
}

/** Short label for prompt mode: "twin" for append, nothing for replace (the default). */
export function getPromptModeLabel(type: SubagentType): string | undefined {
  const config = getConfig(type);
  return config.promptMode === "append" ? "twin" : undefined;
}

/**
 * Mode label is not included — callers add it where they want it.
 *
 * Both model forms come back so each surface can pick by width; the
 * "(asked X)" annotation is applied here rather than by callers, so a value the
 * spawn did not honor cannot be rendered as though it had been (#182).
 */
export function buildInvocationTags(
  invocation: AgentInvocation | undefined,
): { modelName?: string; modelId?: string; tags: string[] } {
  const tags: string[] = [];
  if (!invocation) return { tags };
  const asked = (value: string | undefined, requested: string | undefined): string | undefined =>
    value && requested && requested !== value ? `${value} (asked ${requested})` : value;
  const thinking = asked(invocation.thinking, invocation.requestedThinking);
  if (thinking) tags.push(`thinking: ${thinking}`);
  if (invocation.isolated) tags.push("isolated");
  if (invocation.isolation === "worktree") tags.push("worktree");
  if (invocation.inheritContext) tags.push("inherit context");
  if (invocation.runInBackground) tags.push("background");
  if (invocation.maxTurns != null) tags.push(`max turns: ${invocation.maxTurns}`);
  return {
    modelName: asked(invocation.modelName, invocation.requestedModel),
    modelId: asked(invocation.modelId, invocation.requestedModel),
    tags,
  };
}

/** Truncate text to a single line, max `len` chars. */
function truncateLine(text: string, len = 60): string {
  const line = text.split("\n").find(l => l.trim())?.trim() ?? "";
  if (line.length <= len) return line;
  return line.slice(0, len) + "…";
}

/** Build a human-readable activity string from currently-running tools or response text. */
export function describeActivity(activeTools: Map<string, string>, responseText?: string): string {
  if (activeTools.size > 0) {
    const groups = new Map<string, number>();
    for (const toolName of activeTools.values()) {
      const action = TOOL_DISPLAY[toolName] ?? toolName;
      groups.set(action, (groups.get(action) ?? 0) + 1);
    }

    const parts: string[] = [];
    for (const [action, count] of groups) {
      if (count > 1) {
        parts.push(`${action} ${count} ${action === "searching" ? "patterns" : "files"}`);
      } else {
        parts.push(action);
      }
    }
    return parts.join(", ") + "…";
  }

  // No tools active — show truncated response text if available
  if (responseText && responseText.trim().length > 0) {
    return truncateLine(responseText);
  }

  return "thinking…";
}

export interface ExecutionStatPartsInput {
  modelName?: string;
  thinking?: string;
  turnCount?: number;
  maxTurns?: number;
  toolUses?: number;
  tokenText?: string;
  costText?: string;
  elapsed?: string;
}

/** Shared execution-stat order for ordinary agents and workflow children. */
export function executionStatParts(input: ExecutionStatPartsInput): string[] {
  const parts: string[] = [];
  if (input.modelName) parts.push(input.modelName);
  if (input.thinking) parts.push(input.thinking);
  if ((input.turnCount ?? 0) > 0) parts.push(formatTurns(input.turnCount!, input.maxTurns));
  if ((input.toolUses ?? 0) > 0) {
    parts.push(`${input.toolUses} tool use${input.toolUses === 1 ? "" : "s"}`);
  }
  if (input.tokenText) parts.push(input.tokenText);
  if (input.costText) parts.push(input.costText);
  if (input.elapsed) parts.push(input.elapsed);
  return parts;
}

export interface ExecutionActivityInput {
  activeTools?: Map<string, string>;
  responseText?: string;
  activity?: string;
  outputPreview?: string;
}

/** Shared current-work wording for ordinary activity and workflow snapshots. */
export function executionActivityText(input: ExecutionActivityInput): string {
  if (input.activeTools !== undefined) {
    return describeActivity(input.activeTools, input.responseText);
  }
  if (input.activity?.startsWith("tool: ")) {
    const toolName = input.activity.slice("tool: ".length);
    return describeActivity(new Map([[toolName, toolName]]));
  }
  if (input.outputPreview) return describeActivity(new Map(), input.outputPreview);
  if (input.activity && input.activity !== "responding") return input.activity;
  return describeActivity(new Map(), input.responseText);
}

// ---- Widget manager ----

export class AgentWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** One-shot cleanup for the earliest terminal workflow's four-second linger. */
  private workflowLingerTimer: ReturnType<typeof setTimeout> | undefined;
  /** Tracks how many turns each finished agent has survived. Key: agent ID, Value: turns since finished. */
  private finishedTurnAge = new Map<string, number>();
  /** Cached workflow execution trees supplied by the extension. */
  private workflowSource: (() => readonly FleetWorkflow[]) | undefined;
  /** How many extra turns errors/aborted agents linger (completed agents clear after 1 turn). */
  private static readonly ERROR_LINGER_TURNS = 2;

  /** Whether the widget callback is currently registered with the TUI. */
  private widgetRegistered = false;
  /** Cached TUI reference from widget factory callback, used for requestRender(). */
  private tui: any | undefined;
  /** Last status bar text, used to avoid redundant setStatus calls. */
  private lastStatusText: string | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
    /**
     * Read live at render time. Selects which agents the widget shows — see
     * `WidgetMode`. Defaults to `"all"` when a caller supplies no policy; the
     * extension supplies one defaulting to `"background"`.
     */
    private mode: () => WidgetMode = () => "all",
    /**
     * Read live at render time, like `mode`. Whether running agents show an
     * estimated cost beside their token count. Defaults to off — the extension
     * supplies the user's `showCost` setting.
     */
    private showCost: () => boolean = () => false,
    /**
     * Read live at render time, like `mode`. Whether running agents name the
     * model driving them and the thinking level it is running at. Defaults to
     * off — the extension supplies the user's `showModel` setting — because the
     * row is already dense and the same pair is on the tool result and in the
     * conversation viewer unconditionally.
     */
    private showModel: () => boolean = () => false,
  ) {}

  /**
   * Agents eligible for the widget, per the current `WidgetMode`:
   *   - `off`: none (the widget's existing empty-state path hides it entirely).
   *   - `background`: drop only agents *known* to be foreground
   *     (`isBackground === false`); keep everything else — background, queued,
   *     scheduled, or RPC-spawned (`undefined`). Keying off the `isBackground`
   *     record flag rather than the UI-only `invocation` snapshot (which only the
   *     Agent-tool path sets), and excluding rather than allow-listing, means
   *     only proven-foreground runs drop out — nothing else silently vanishes.
   *   - `all`: every agent.
   */
  private widgetAgents() {
    const all = this.manager.listAgents().filter(isTopLevelAgent);
    switch (this.mode()) {
      case "off": return [];
      case "background": return all.filter(a => a.isBackground !== false);
      default: return all;
    }
  }

  /** Set the UI context (grabbed from first tool execution). */
  setUICtx(ctx: UICtx) {
    if (ctx !== this.uiCtx) {
      // UICtx changed — the widget registered on the old context is gone.
      // Force re-registration on next update().
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
      this.lastStatusText = undefined;
    }
  }

  /** Set or clear the cached workflow hierarchy source used by the combined widget. */
  setWorkflowSource(source: (() => readonly FleetWorkflow[]) | undefined): void {
    this.workflowSource = source;
    this.update();
  }

  /**
   * Called on each new turn (tool_execution_start).
   * Ages finished agents and clears those that have lingered long enough.
   */
  onTurnStart() {
    // Age all finished agents
    for (const [id, age] of this.finishedTurnAge) {
      this.finishedTurnAge.set(id, age + 1);
    }
    // Trigger a widget refresh (will filter out expired agents)
    this.update();
  }

  /** Ensure the widget update timer is running. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => {
        this.widgetFrame++;
        this.update();
      }, SPINNER_INTERVAL_MS);
      this.widgetInterval.unref?.();
    }
  }

  /** Stop the animation interval without affecting terminal-workflow linger cleanup. */
  private stopTimer(): void {
    if (!this.widgetInterval) return;
    clearInterval(this.widgetInterval);
    this.widgetInterval = undefined;
  }

  /** Re-arm cleanup for the first terminal workflow whose four-second linger expires. */
  private scheduleWorkflowLinger(workflows: readonly FleetWorkflow[]): void {
    if (this.workflowLingerTimer) {
      clearTimeout(this.workflowLingerTimer);
      this.workflowLingerTimer = undefined;
    }
    const now = Date.now();
    const remaining = workflows
      .filter(workflow => workflow.status !== "running" && workflow.status !== "paused")
      .map(workflow => WORKFLOW_LINGER_MS - (now - (workflow.completedAt ?? now)))
      .filter(delay => delay > 0);
    if (remaining.length === 0) return;
    this.workflowLingerTimer = setTimeout(() => {
      this.workflowLingerTimer = undefined;
      this.update();
    }, Math.min(...remaining));
    this.workflowLingerTimer.unref?.();
  }

  /** Check if a finished agent should still be shown in the widget. */
  private shouldShowFinished(agentId: string, status: string): boolean {
    const age = this.finishedTurnAge.get(agentId) ?? 0;
    const maxAge = ERROR_STATUSES.has(status) ? AgentWidget.ERROR_LINGER_TURNS : 1;
    return age < maxAge;
  }

  /** Record an agent as finished (call when agent completes). */
  markFinished(agentId: string) {
    if (!this.finishedTurnAge.has(agentId)) {
      this.finishedTurnAge.set(agentId, 0);
    }
  }

  /**
   * Drop an agent's finished-age (call when a settled agent starts running
   * again, i.e. a background resume). markFinished only seeds an age it has not
   * seen before, so a resumed agent would otherwise keep the age from its
   * previous run — already past the linger limit, hiding the new run's
   * completion line entirely.
   */
  markRunning(agentId: string) {
    this.finishedTurnAge.delete(agentId);
  }

  /** Render a finished agent line. */
  private renderFinishedLine(a: {
    id: string;
    type: SubagentType;
    status: string;
    description: string;
    toolUses: number;
    turnCount?: number;
    startedAt: number;
    completedAt?: number;
    error?: string;
    lifetimeUsage?: LifetimeUsage;
  }, theme: Theme): string {
    const modeLabel = getPromptModeLabel(a.type);
    const duration = formatMs((a.completedAt ?? Date.now()) - a.startedAt);

    let icon: string;
    let statusText: string;
    if (a.status === "completed") {
      icon = theme.fg("success", "✓");
      statusText = "";
    } else if (a.status === "steered") {
      icon = theme.fg("warning", "✓");
      statusText = theme.fg("warning", " (turn limit)");
    } else if (a.status === "stopped") {
      icon = theme.fg("dim", "■");
      statusText = theme.fg("dim", " stopped");
    } else if (a.status === "error") {
      icon = theme.fg("error", "✗");
      const errMsg = a.error ? `: ${a.error.slice(0, 60)}` : "";
      statusText = theme.fg("error", ` error${errMsg}`);
    } else {
      // aborted
      icon = theme.fg("error", "✗");
      statusText = theme.fg("warning", " aborted");
    }

    const activity = this.agentActivity.get(a.id);
    const costText = this.showCost() ? formatCost(getLifetimeCost(a.lifetimeUsage)) : "";
    const parts = executionStatParts({
      turnCount: activity?.turnCount ?? a.turnCount,
      maxTurns: activity?.maxTurns,
      toolUses: a.toolUses,
      costText,
      elapsed: duration,
    });

    const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
    return `${icon} ${renderAgentName(a.type, theme, { fallbackColor: "dim" })}${modeTag}  ${theme.fg("dim", a.description)} ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}${statusText}`;
  }

  /** Workflows visible under the same mode and four-second settled linger as FleetView. */
  private widgetWorkflows(): FleetWorkflow[] {
    if (this.mode() === "off" || !this.workflowSource) return [];
    const now = Date.now();
    return [...this.workflowSource()]
      .filter(workflow => workflow.status === "running"
        || workflow.status === "paused"
        || (workflow.completedAt !== undefined && now - workflow.completedAt < WORKFLOW_LINGER_MS))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Render the combined above-editor execution section. Workflow roots and their
   * cached descendants are assembled before ordinary agents so a large workflow
   * cannot make the widget grow beyond MAX_WIDGET_LINES.
   */
  private renderWidget(tui: any, theme: Theme): string[] {
    const agents = this.widgetAgents();
    const workflows = this.widgetWorkflows();
    const running = agents.filter(agent => agent.status === "running");
    const queued = agents.filter(agent => agent.status === "queued");
    const finished = agents.filter(agent =>
      agent.status !== "running" && agent.status !== "queued" && agent.completedAt
      && this.shouldShowFinished(agent.id, agent.status),
    );
    const hasActive = running.length > 0 || queued.length > 0 || workflows.some(workflow =>
      workflow.status === "running" || workflow.status === "paused");
    if (workflows.length === 0 && running.length === 0 && queued.length === 0 && finished.length === 0) return [];

    const width = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, width);
    const frame = BRAILLE_SPINNER_FRAMES[this.widgetFrame % BRAILLE_SPINNER_FRAMES.length];
    const lines: string[] = [
      truncate(theme.fg(hasActive ? "accent" : "dim", hasActive ? "●" : "○")
        + " " + theme.fg(hasActive ? "accent" : "dim", "Agents")),
    ];
    const activeWorkflows = workflows.filter(workflow =>
      workflow.status === "running" || workflow.status === "paused");
    const settledWorkflows = workflows.filter(workflow =>
      workflow.status !== "running" && workflow.status !== "paused");
    const orderedWorkflows = [...activeWorkflows, ...settledWorkflows];
    const workflowAgentRows = (agent: FleetWorkflowAgent) => agent.state === "running" ? 2 : 1;
    const workflowDescendantCount = (workflow: FleetWorkflow) =>
      workflow.phases.reduce((count, phase) => count + 1 + phase.agents.length, 0);
    const workflowRenderedRows = (workflow: FleetWorkflow) =>
      workflow.phases.reduce(
        (count, phase) => count + 1 + phase.agents.reduce((rows, agent) => rows + workflowAgentRows(agent), 0),
        0,
      );

    interface VisibleWorkflowPhase {
      phase: FleetWorkflowPhase;
      agents: FleetWorkflowAgent[];
      hiddenAgents: number;
      hasHiddenLaterPhase: boolean;
    }
    interface VisibleWorkflowTree {
      workflow: FleetWorkflow;
      phases: VisibleWorkflowPhase[];
    }

    const renderWorkflowRoot = (workflow: FleetWorkflow, hasLaterTopLevel: boolean): string => {
      const glyph = workflow.status === "running"
        ? theme.fg("accent", frame)
        : workflow.status === "paused"
          ? theme.fg("warning", "‖")
          : workflow.status === "completed"
            ? theme.fg("success", "✓")
            : workflow.status === "failed"
              ? theme.fg("error", "✗")
              : theme.fg("dim", "■");
      return truncate(
        `${theme.fg("dim", hasLaterTopLevel ? "├─" : "└─")} ${glyph} ${theme.bold(workflow.name)}`
        + `  ${theme.fg("dim", workflow.status)} · ${workflow.doneCount}/${workflow.totalCount} agents${
          workflow.status === "running" || workflow.status === "paused" ? " so far" : ""
        }`
        + ` · ${formatMs(fleetWorkflowElapsed(workflow, Date.now()))}`,
      );
    };
    const renderWorkflowPhase = (
      visible: VisibleWorkflowPhase,
      rootHasLaterTopLevel: boolean,
      phaseHasLaterSibling: boolean,
    ): string => {
      const state = workflowPhaseState(visible.phase);
      const rootRail = rootHasLaterTopLevel ? "│  " : "   ";
      return truncate(
        `${theme.fg("dim", `${rootRail}${phaseHasLaterSibling ? "├─" : "└─"}`)}`
        + ` ${workflowStateGlyph(state, frame, theme)} ${theme.fg("muted", "phase")}`
        + ` ${visible.phase.title}  ${theme.fg("dim", `${state} · ${visible.phase.doneCount}/${visible.phase.totalCount}`)}`,
      );
    };
    const renderWorkflowAgent = (
      agent: FleetWorkflowAgent,
      rootHasLaterTopLevel: boolean,
      phaseHasLaterSibling: boolean,
      childHasLaterSibling: boolean,
    ): string[] => {
      const record = agent.recordId !== undefined ? this.manager.getRecord(agent.recordId) : undefined;
      const type = record?.type ?? agent.agentType;
      const modeLabel = getPromptModeLabel(type);
      const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
      const elapsed = agent.startedAt === undefined
        ? undefined
        : formatMs(Math.max(0, (agent.completedAt ?? Date.now()) - agent.startedAt));
      const tokens = record ? getLifetimeTotal(record.lifetimeUsage) : agent.tokens;
      const tokenText = tokens > 0
        ? formatSessionTokens(
            tokens,
            getSessionContextPercent(record?.session),
            theme,
            record?.compactionCount ?? 0,
          )
        : "";
      const costText = this.showCost() && record
        ? formatCost(getLifetimeCost(record.lifetimeUsage))
        : "";
      const invocation = this.showModel() ? buildInvocationTags(record?.invocation) : undefined;
      const parts = executionStatParts({
        modelName: invocation?.modelName ?? (this.showModel() ? agent.model : undefined),
        thinking: invocation?.tags.find(tag => tag.startsWith("thinking: ")),
        turnCount: agent.turnCount ?? record?.turnCount,
        maxTurns: record?.invocation?.maxTurns,
        toolUses: record?.toolUses ?? agent.toolUses,
        tokenText,
        costText,
        elapsed,
      });
      const rootRail = rootHasLaterTopLevel ? "│  " : "   ";
      const phaseRail = phaseHasLaterSibling ? "│  " : "   ";
      const childBranch = childHasLaterSibling ? "├─" : "└─";
      const headerParts = [agent.state, ...parts];
      const header = truncate(
        `${theme.fg("dim", `${rootRail}${phaseRail}${childBranch}`)}`
        + ` ${workflowStateGlyph(agent.state, frame, theme)}`
        + ` ${renderAgentName(type, theme, { fallbackColor: "muted" })}${modeTag}  ${agent.label}`
        + ` ${theme.fg("dim", `· ${headerParts.join(" · ")}`)}`,
      );
      if (agent.state !== "running") return [header];
      const continuation = childHasLaterSibling ? "│  " : "   ";
      const activity = executionActivityText({
        activity: agent.activity,
        outputPreview: agent.outputPreview,
      });
      return [
        header,
        truncate(
          theme.fg("dim", `${rootRail}${phaseRail}${continuation}`)
          + theme.fg("dim", `   ⎿  ${activity}`),
        ),
      ];
    };

    const runningLines: string[][] = [];
    for (const agent of running) {
      const modeLabel = getPromptModeLabel(agent.type);
      const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
      const elapsed = formatMs(Date.now() - agent.startedAt);
      const activity = this.agentActivity.get(agent.id);
      const toolUses = activity?.toolUses ?? agent.toolUses;
      // Spend comes from the record, never from the activity tracker: the record
      // is the one that survives completion and folds in nested-child spend.
      const tokens = getLifetimeTotal(agent.lifetimeUsage);
      const contextPercent = getSessionContextPercent(activity?.session);
      const tokenText = tokens > 0
        ? formatSessionTokens(tokens, contextPercent, theme, agent.compactionCount)
        : "";
      const costText = this.showCost() ? formatCost(getLifetimeCost(agent.lifetimeUsage)) : "";
      const parts = executionStatParts({
        ...(this.showModel()
          ? (() => {
              const { modelName, tags } = buildInvocationTags(agent.invocation);
              return { modelName, thinking: tags.find(tag => tag.startsWith("thinking: ")) };
            })()
          : {}),
        turnCount: activity?.turnCount ?? agent.turnCount,
        maxTurns: activity?.maxTurns ?? agent.invocation?.maxTurns,
        toolUses,
        tokenText,
        costText,
        elapsed,
      });
      runningLines.push([
        truncate(
          theme.fg("dim", "├─")
          + ` ${theme.fg("accent", frame)} ${renderAgentName(agent.type, theme, { bold: true })}${modeTag}`
          + `  ${theme.fg("muted", agent.description)} ${theme.fg("dim", "·")}`
          + ` ${fgPreservingNestedStyles(theme, "dim", parts.join(" · "))}`,
        ),
        truncate(theme.fg("dim", "│  ") + theme.fg(
          "dim",
          `  ⎿  ${executionActivityText({
            activeTools: activity?.activeTools,
            responseText: activity?.responseText,
          })}`,
        )),
      ]);
    }
    const queuedLine = queued.length > 0
      ? truncate(theme.fg("dim", "├─") + ` ${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`)
      : undefined;
    const finishedLines = finished.map(agent =>
      truncate(theme.fg("dim", "├─") + " " + this.renderFinishedLine(agent, theme)));

    const workflowNodeCount = orderedWorkflows.reduce(
      (count, workflow) => count + 1 + workflowRenderedRows(workflow),
      0,
    );
    const bodyLimit = MAX_WIDGET_LINES - 1;
    const totalBody = workflowNodeCount + runningLines.length * 2
      + (queuedLine ? 1 : 0) + finishedLines.length;
    const overflowed = totalBody > bodyLimit;
    // A queue is most important when the pool is saturated, so reserve its one
    // summary row before sharing the remaining rows between trees and agents.
    const queuedReserve = overflowed && queuedLine ? 1 : 0;
    let budget = bodyLimit - (overflowed ? 1 : 0) - queuedReserve;
    let hiddenWorkflow = 0;
    let hiddenAgents = 0;
    type TopLevelSection =
      | { kind: "workflow"; tree: VisibleWorkflowTree }
      | { kind: "running"; pair: string[] }
      | { kind: "queued"; line: string }
      | { kind: "finished"; line: string }
      | { kind: "overflow"; line: string };
    const sections: TopLevelSection[] = [];

    const appendWorkflow = (workflow: FleetWorkflow, remainingActiveRoots: number): void => {
      if (budget < 1) {
        hiddenWorkflow += 1 + workflowDescendantCount(workflow);
        return;
      }

      const tree: VisibleWorkflowTree = { workflow, phases: [] };
      sections.push({ kind: "workflow", tree });
      budget--;
      // Descendants may use only rows that are not promised to later active
      // roots. This keeps every active controller visible under a tight cap.
      let descendantBudget = Math.max(0, budget - remainingActiveRoots);

      for (let phaseIndex = 0; phaseIndex < workflow.phases.length; phaseIndex++) {
        const phase = workflow.phases[phaseIndex];
        if (descendantBudget < 1) {
          hiddenWorkflow += workflow.phases.slice(phaseIndex)
            .reduce((count, hiddenPhase) => count + 1 + hiddenPhase.agents.length, 0);
          const lastVisible = tree.phases.at(-1);
          if (lastVisible) lastVisible.hasHiddenLaterPhase = true;
          break;
        }

        const visiblePhase: VisibleWorkflowPhase = {
          phase,
          agents: [],
          hiddenAgents: 0,
          hasHiddenLaterPhase: false,
        };
        tree.phases.push(visiblePhase);
        budget--;
        descendantBudget--;

        for (let agentIndex = 0; agentIndex < phase.agents.length; agentIndex++) {
          const rows = workflowAgentRows(phase.agents[agentIndex]);
          if (descendantBudget < rows) {
            visiblePhase.hiddenAgents = phase.agents.length - agentIndex;
            hiddenWorkflow += visiblePhase.hiddenAgents;
            break;
          }
          visiblePhase.agents.push(phase.agents[agentIndex]);
          budget -= rows;
          descendantBudget -= rows;
        }
      }
    };

    for (let index = 0; index < activeWorkflows.length; index++) {
      appendWorkflow(activeWorkflows[index], activeWorkflows.length - index - 1);
    }
    for (const workflow of settledWorkflows) appendWorkflow(workflow, 0);

    for (const pair of runningLines) {
      if (budget < 2) {
        hiddenAgents++;
        continue;
      }
      sections.push({ kind: "running", pair });
      budget -= 2;
    }
    if (queuedLine) {
      if (queuedReserve > 0) budget += queuedReserve;
      if (budget >= 1) {
        sections.push({ kind: "queued", line: queuedLine });
        budget--;
      }
    }
    for (const line of finishedLines) {
      if (budget < 1) {
        hiddenAgents++;
        continue;
      }
      sections.push({ kind: "finished", line });
      budget--;
    }

    const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
      `${count} ${count === 1 ? singular : pluralForm}`;
    if (hiddenWorkflow > 0 || hiddenAgents > 0) {
      const parts: string[] = [];
      if (hiddenWorkflow > 0) parts.push(plural(hiddenWorkflow, "workflow node"));
      if (hiddenAgents > 0) parts.push(plural(hiddenAgents, "agent"));
      sections.push({
        kind: "overflow",
        line: truncate(theme.fg("dim", "└─") + ` ${theme.fg("dim", `hidden: ${parts.join(", ")}`)}`),
      });
    }

    for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
      const section = sections[sectionIndex];
      const hasLaterTopLevel = sectionIndex < sections.length - 1;
      if (section.kind === "workflow") {
        lines.push(renderWorkflowRoot(section.tree.workflow, hasLaterTopLevel));
        for (let phaseIndex = 0; phaseIndex < section.tree.phases.length; phaseIndex++) {
          const visiblePhase = section.tree.phases[phaseIndex];
          const phaseHasLaterSibling = phaseIndex < section.tree.phases.length - 1
            || visiblePhase.hasHiddenLaterPhase;
          lines.push(renderWorkflowPhase(visiblePhase, hasLaterTopLevel, phaseHasLaterSibling));
          for (let agentIndex = 0; agentIndex < visiblePhase.agents.length; agentIndex++) {
            const childHasLaterSibling = agentIndex < visiblePhase.agents.length - 1
              || visiblePhase.hiddenAgents > 0;
            lines.push(...renderWorkflowAgent(
              visiblePhase.agents[agentIndex],
              hasLaterTopLevel,
              phaseHasLaterSibling,
              childHasLaterSibling,
            ));
          }
        }
      } else if (section.kind === "running") {
        const [header, activity] = section.pair;
        lines.push(hasLaterTopLevel ? header : header.replace("├─", "└─"));
        lines.push(hasLaterTopLevel ? activity : activity.replace("│  ", "   "));
      } else {
        lines.push(hasLaterTopLevel ? section.line : section.line.replace("├─", "└─"));
      }
    }
    return lines;
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx) return;
    const allAgents = this.widgetAgents();
    const workflows = this.widgetWorkflows();

    // Lightweight existence checks — full categorization happens in renderWidget()
    let runningCount = 0;
    let queuedCount = 0;
    let hasFinished = false;
    for (const a of allAgents) {
      if (a.status === "running") { runningCount++; }
      else if (a.status === "queued") { queuedCount++; }
      else if (a.completedAt && this.shouldShowFinished(a.id, a.status)) { hasFinished = true; }
    }
    const runningWorkflowCount = workflows.filter(workflow => workflow.status === "running").length;
    const pausedWorkflowCount = workflows.filter(workflow => workflow.status === "paused").length;
    const hasActiveWorkflow = runningWorkflowCount > 0 || pausedWorkflowCount > 0;
    const hasActive = runningCount > 0 || queuedCount > 0 || hasActiveWorkflow;
    const hasWorkflow = workflows.length > 0;
    this.scheduleWorkflowLinger(workflows);
    if (runningCount > 0 || runningWorkflowCount > 0) this.ensureTimer();
    else this.stopTimer();

    // Nothing to show — clear widget
    if (!hasActive && !hasFinished && !hasWorkflow) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("agents", undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.lastStatusText !== undefined) {
        this.uiCtx.setStatus("subagents", undefined);
        this.lastStatusText = undefined;
      }
      this.stopTimer();
      // Clean up stale entries
      for (const [id] of this.finishedTurnAge) {
        if (!allAgents.some(a => a.id === id)) this.finishedTurnAge.delete(id);
      }
      return;
    }

    // Status bar — only call setStatus when the text actually changes
    let newStatusText: string | undefined;
    if (hasActive) {
      const statusSections: string[] = [];
      const agentParts: string[] = [];
      if (runningCount > 0) agentParts.push(`${runningCount} running`);
      if (queuedCount > 0) agentParts.push(`${queuedCount} queued`);
      const agentTotal = runningCount + queuedCount;
      if (agentTotal > 0) {
        statusSections.push(`${agentParts.join(", ")} agent${agentTotal === 1 ? "" : "s"}`);
      }
      if (runningWorkflowCount > 0) {
        statusSections.push(`${runningWorkflowCount} running workflow${runningWorkflowCount === 1 ? "" : "s"}`);
      }
      if (pausedWorkflowCount > 0) {
        statusSections.push(`${pausedWorkflowCount} paused workflow${pausedWorkflowCount === 1 ? "" : "s"}`);
      }
      newStatusText = statusSections.join(" · ");
    }
    if (newStatusText !== this.lastStatusText) {
      this.uiCtx.setStatus("subagents", newStatusText);
      this.lastStatusText = newStatusText;
    }

    // Register widget callback once; subsequent updates use requestRender()
    // which re-invokes render() without replacing the component (avoids layout thrashing).
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("agents", (tui, theme) => {
        this.tui = tui;
        return {
          render: () => this.renderWidget(tui, theme),
          invalidate: () => {
            // Theme changed — force re-registration so factory captures fresh theme.
            this.widgetRegistered = false;
            this.tui = undefined;
          },
        };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else {
      // Widget already registered — just request a re-render of existing components.
      this.tui?.requestRender();
    }
  }

  dispose() {
    this.stopTimer();
    if (this.workflowLingerTimer) {
      clearTimeout(this.workflowLingerTimer);
      this.workflowLingerTimer = undefined;
    }
    this.workflowSource = undefined;
    if (this.uiCtx) {
      this.uiCtx.setWidget("agents", undefined);
      this.uiCtx.setStatus("subagents", undefined);
    }
    this.uiCtx = undefined;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastStatusText = undefined;
  }
}
