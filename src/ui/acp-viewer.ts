/**
 * acp-viewer.ts — Overlay for one ACP attempt.
 *
 * ACP has no Pi AgentSession, so ConversationViewer cannot open. This shows the
 * attempt's live result text, activity, stop, and a queued follow-up composer.
 */

import { type Component, Input, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderAgentName } from "../agent-color.js";
import type { AgentRecord } from "../types.js";
import type { Theme } from "./agent-widget.js";
import { type AgentActivity, describeActivity, fgPreservingNestedStyles, formatDuration } from "./agent-widget.js";
import { VIEWPORT_HEIGHT_PCT } from "./conversation-viewer.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

const CHROME_LINES = 6;
const MIN_VIEWPORT = 3;
const RESULT_MAX_CHARS = 16_000;

export class AcpAttemptViewer implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private lastInnerW = 0;
  private closed = false;
  private stopArmed = false;
  private composer: Input | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private keys: ViewerKeys;

  constructor(
    private tui: TUI,
    private record: AgentRecord,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
    private onStop?: () => void,
    keybindings?: ViewerKeybindings,
    private onFollowUp?: (message: string) => void,
  ) {
    this.keys = createViewerKeys(keybindings);
    this.timer = setInterval(() => {
      if (!this.closed) this.tui.requestRender();
    }, 200);
    this.timer.unref?.();
  }

  handleInput(data: string): void {
    if (this.composer) {
      this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.close();
      return;
    }
    if (matchesKey(data, "enter") && this.canFollowUp()) {
      this.stopArmed = false;
      this.openComposer();
      return;
    }
    if (matchesKey(data, "x")) {
      if (this.isStoppable()) {
        if (this.stopArmed) {
          this.stopArmed = false;
          this.onStop?.();
        } else {
          this.stopArmed = true;
        }
        this.tui.requestRender();
      }
      return;
    }
    if (this.stopArmed) this.stopArmed = false;

    const totalLines = this.buildContentLines(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);
    if (this.keys.scrollUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.scrollDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.pageUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (this.keys.pageDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  render(width: number): string[] {
    if (width < 6) return [];
    const th = this.theme;
    const innerW = width - 4;
    this.lastInnerW = innerW;
    const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const row = (content: string) =>
      th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW, "...", true) + " " + th.fg("border", "│");
    const lines = [th.fg("border", `╭${"─".repeat(width - 2)}╮`)];

    const statusIcon = this.record.status === "running"
      ? th.fg("accent", "●")
      : this.record.status === "queued"
        ? th.fg("muted", "◦")
        : this.record.status === "completed"
          ? th.fg("success", "✓")
          : this.record.status === "error"
            ? th.fg("error", "✗")
            : th.fg("dim", "○");
    const handle = this.record.conversationHandle ?? this.record.type;
    const duration = formatDuration(this.record.startedAt, this.record.completedAt);
    const parts = [duration];
    if (this.record.toolUses > 0) parts.unshift(`${this.record.toolUses} tool${this.record.toolUses === 1 ? "" : "s"}`);
    lines.push(row(
      `${statusIcon} ${renderAgentName(handle, th, { bold: true })}  ${th.fg("muted", this.record.description)} ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", parts.join(" · "))}`,
    ));
    lines.push(row(th.fg("dim", "─".repeat(innerW))));

    const contentLines = this.buildContentLines(innerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);
    if (this.autoScroll) this.scrollOffset = maxScroll;
    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    for (let i = 0; i < viewportHeight; i++) lines.push(row(contentLines[visibleStart + i] ?? ""));

    lines.push(row(th.fg("dim", "─".repeat(innerW))));
    if (this.composer) {
      lines.push(row(this.composer.render(innerW)[0] ?? ""));
      const left = th.fg("accent", "✎ follow-up");
      const hint = th.fg("dim", "Enter send · Esc cancel");
      lines.push(row(left + " ".repeat(Math.max(1, innerW - visibleWidth(left) - visibleWidth(hint))) + hint));
    } else {
      const actions: string[] = [];
      if (this.canFollowUp()) actions.push(th.fg("dim", "Enter follow-up"));
      if (this.isStoppable()) {
        actions.push(this.stopArmed ? th.fg("error", "x again to STOP") : th.fg("dim", "x stop"));
      }
      const footerLeft = actions.join(th.fg("dim", " · "));
      const footerRight = th.fg("dim", "↑↓ scroll · Esc close");
      lines.push(row(footerLeft + " ".repeat(Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight))) + footerRight));
    }
    lines.push(th.fg("border", `╰${"─".repeat(width - 2)}╯`));
    return lines;
  }

  invalidate(): void {}

  dispose(): void {
    this.close(false);
  }

  private close(finish = true): void {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (finish) this.done(undefined);
  }

  private isStoppable(): boolean {
    return !!this.onStop && (this.record.status === "running" || this.record.status === "queued");
  }

  private canFollowUp(): boolean {
    return !!this.onFollowUp && (this.record.status === "running" || this.record.status === "queued");
  }

  private openComposer(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value: string) => {
      const message = value.trim();
      this.composer = undefined;
      if (message) this.onFollowUp?.(message);
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = undefined;
      this.tui.requestRender();
    };
    this.composer = input;
    this.tui.requestRender();
  }

  private viewportHeight(): number {
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - CHROME_LINES - (this.composer ? 1 : 0));
  }

  private buildContentLines(width: number): string[] {
    const th = this.theme;
    const activity = this.activity;
    const lines: string[] = [];
    if (this.record.status === "queued") {
      lines.push(th.fg("muted", "Queued — waiting for the current ACP turn and a background slot."));
      lines.push("");
    } else if (activity && (this.record.status === "running")) {
      const live = describeActivity(activity.activeTools, activity.responseText);
      if (live) {
        lines.push(th.fg("dim", live));
        lines.push("");
      }
    }
    const text = this.record.error?.trim() || this.record.result?.trim() || "";
    if (!text) {
      lines.push(th.fg("dim", this.record.status === "running" ? "Waiting for ACP output…" : "No output."));
      return lines;
    }
    const clipped = text.length > RESULT_MAX_CHARS
      ? `${text.slice(0, RESULT_MAX_CHARS)}\n... (truncated)`
      : text;
    lines.push(...wrapTextWithAnsi(this.record.error ? th.fg("error", clipped) : clipped, width));
    return lines;
  }
}
