import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Theme } from "./agent-widget.js";

const APPROVAL_SUMMARY_MARKER = "Approval summary\n";
const BODY_ROWS = 10;

export interface WorkflowApprovalSections {
  summary: string;
  technical: string;
}

/** Split the formatter output into the default decision view and its audit appendix. */
export function workflowApprovalSections(text: string): WorkflowApprovalSections {
  const markerIndex = text.lastIndexOf(`\n${APPROVAL_SUMMARY_MARKER}`);
  if (markerIndex < 0) return { summary: text, technical: text };
  return {
    technical: text.slice(0, markerIndex),
    summary: text.slice(markerIndex + 1 + APPROVAL_SUMMARY_MARKER.length),
  };
}

/**
 * Fixed-height workflow approval UI.
 *
 * Pi's stock confirmation component clips long messages from the top and has no
 * internal scroll view. This component always keeps the decision controls on
 * screen, starts on the human summary, and lets `d` switch to the complete
 * technical appendix without changing the approval decision.
 */
export class WorkflowApprovalDialog implements Component {
  private view: "summary" | "details" = "summary";
  private summaryOffset = 0;
  private detailsOffset = 0;
  private approveSelected = false;

  constructor(
    private readonly tui: Pick<TUI, "requestRender">,
    private readonly title: string,
    private readonly sections: WorkflowApprovalSections,
    private readonly theme: Theme,
    private readonly done: (approved: boolean) => void,
  ) {}

  render(width: number): string[] {
    if (width < 2) return [truncateToWidth(this.title, width)];

    const innerWidth = width - 2;
    const body = this.currentLines();
    const maxOffset = Math.max(0, body.length - BODY_ROWS);
    const offset = Math.min(this.currentOffset(), maxOffset);
    const visible = body.slice(offset, offset + BODY_ROWS);
    const frameLine = (content: string): string => {
      const truncated = truncateToWidth(content, innerWidth, "...", true);
      const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
      return this.theme.fg("border", "│") + truncated + padding + this.theme.fg("border", "│");
    };
    const horizontal = "─".repeat(innerWidth);
    const lines = [
      this.theme.fg("border", `╭${horizontal}╮`),
      frameLine(this.theme.fg("accent", this.theme.bold(this.title))),
      frameLine(
        this.view === "summary"
          ? this.theme.fg("accent", "Summary") + this.theme.fg("dim", "  d: technical details")
          : this.theme.fg("warning", "Technical details") + this.theme.fg("dim", "  d: summary"),
      ),
    ];

    for (let index = 0; index < BODY_ROWS; index++) {
      const text = visible[index] ?? "";
      const styled = isSummaryHeading(text)
        ? this.theme.fg("accent", this.theme.bold(text))
        : this.theme.fg("text", text);
      lines.push(frameLine(`  ${styled}`));
    }

    const first = body.length === 0 ? 0 : offset + 1;
    const last = Math.min(offset + BODY_ROWS, body.length);
    lines.push(frameLine(this.theme.fg("dim", `  ${first}-${last}/${body.length}  ↑↓ scroll`)));
    const cancel = this.approveSelected
      ? this.theme.fg("dim", "  Cancel  ")
      : this.theme.fg("accent", this.theme.bold("[ Cancel ]"));
    const approve = this.approveSelected
      ? this.theme.fg("accent", this.theme.bold("[ Approve ]"))
      : this.theme.fg("dim", "  Approve  ");
    lines.push(frameLine(`${cancel}    ${approve}`));
    lines.push(frameLine(this.theme.fg("dim", "←→ select · enter confirm · y approve · n/esc cancel")));
    lines.push(this.theme.fg("border", `╰${horizontal}╯`));
    return lines;
  }

  handleInput(data: string): void {
    if (data === "d") {
      this.view = this.view === "summary" ? "details" : "summary";
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.setCurrentOffset(Math.max(0, this.currentOffset() - 1));
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.setCurrentOffset(Math.min(this.maxCurrentOffset(), this.currentOffset() + 1));
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.setCurrentOffset(0);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.setCurrentOffset(this.maxCurrentOffset());
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.approveSelected = !this.approveSelected;
      this.tui.requestRender();
      return;
    }
    if (data.toLowerCase() === "y") {
      this.done(true);
      return;
    }
    if (data.toLowerCase() === "n" || matchesKey(data, Key.escape)) {
      this.done(false);
      return;
    }
    if (matchesKey(data, Key.enter)) this.done(this.approveSelected);
  }

  invalidate(): void {}

  private currentLines(): string[] {
    return (this.view === "summary" ? this.sections.summary : this.sections.technical).split("\n");
  }

  private currentOffset(): number {
    return this.view === "summary" ? this.summaryOffset : this.detailsOffset;
  }

  private setCurrentOffset(value: number): void {
    if (this.view === "summary") this.summaryOffset = value;
    else this.detailsOffset = value;
  }

  private maxCurrentOffset(): number {
    return Math.max(0, this.currentLines().length - BODY_ROWS);
  }
}

function isSummaryHeading(text: string): boolean {
  return text === "Goal" || text === "Declared phases" || text === "Flow"
    || text === "Result handoff" || text === "Impact";
}

type WorkflowApprovalUI = {
  confirm(title: string, message: string): Promise<boolean>;
  custom?: ExtensionContext["ui"]["custom"];
};

/** Show the fixed-height dialog when available; old/non-TUI test hosts keep the stock fallback. */
export async function confirmWorkflowApproval(
  ui: WorkflowApprovalUI,
  title: string,
  text: string,
): Promise<boolean> {
  if (!ui.custom) return ui.confirm(title, text);
  const sections = workflowApprovalSections(text);
  return ui.custom<boolean>(
    (tui, theme, _keybindings, done) =>
      new WorkflowApprovalDialog(tui, title, sections, theme, done),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "90%",
        minWidth: 48,
        maxHeight: "90%",
        margin: 1,
      },
    },
  );
}
