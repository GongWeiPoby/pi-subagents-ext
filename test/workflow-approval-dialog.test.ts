import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  confirmWorkflowApproval,
  WorkflowApprovalDialog,
  workflowApprovalSections,
} from "../src/ui/workflow-approval-dialog.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const longApproval = [
  "Technical details",
  ...Array.from({ length: 80 }, (_, index) => `Technical ${index + 1}`),
  "Approval summary",
  "Goal",
  "  Review the change",
  "",
  "Flow",
  "  START",
  ...Array.from({ length: 20 }, (_, index) => `    -> Step ${index + 1}`),
  "  END",
  "",
  "Impact",
  "  No external effects declared.",
].join("\n");

function dialog(done = vi.fn()) {
  const tui = { requestRender: vi.fn() };
  return {
    component: new WorkflowApprovalDialog(
      tui,
      "Run workflow?",
      workflowApprovalSections(longApproval),
      theme,
      done,
    ),
    done,
    tui,
  };
}

describe("WorkflowApprovalDialog", () => {
  it("splits the human summary from the complete technical appendix", () => {
    const sections = workflowApprovalSections(longApproval);

    expect(sections.technical).toContain("Technical 80");
    expect(sections.technical).not.toContain("Approval summary");
    expect(sections.summary.startsWith("Goal\n  Review the change\n\nFlow\n")).toBe(true);
    expect(sections.summary).toContain("Impact\n  No external effects declared.");
  });

  it("keeps summary and decision controls visible with a long approval", () => {
    const { component } = dialog();
    const lines = component.render(40);
    const text = lines.join("\n");

    expect(lines).toHaveLength(17);
    expect(lines[0]).toMatch(/^╭─+╮$/);
    expect(lines.at(-1)).toMatch(/^╰─+╯$/);
    expect(text).toContain("Run workflow?");
    expect(text).toContain("Summary  d: technical details");
    expect(text).toContain("Goal");
    expect(text).toContain("Review the change");
    expect(text).toContain("[ Cancel ]");
    expect(text).toContain("Approve");
    expect(text).not.toContain("Technical 1");
    for (const line of lines) expect(visibleWidth(line)).toBe(40);

    const narrow = component.render(32);
    expect(narrow).toHaveLength(17);
    expect(narrow.join("\n")).toContain("Approve");
    expect(narrow.join("\n")).toContain("[ Cancel ]");
    for (const line of narrow) expect(visibleWidth(line)).toBe(32);
  });

  it("switches to independently scrollable technical details without hiding controls", () => {
    const { component, tui } = dialog();

    component.handleInput("d");
    let text = component.render(60).join("\n");
    expect(text).toContain("Technical details  d: summary");
    expect(text).toContain("Technical 1");
    expect(text).toContain("[ Cancel ]");

    component.handleInput("\u001b[B");
    text = component.render(60).join("\n");
    expect(text).toContain("Technical 4");
    expect(tui.requestRender).toHaveBeenCalledTimes(2);
  });

  it("supports explicit approve and cancel keys", () => {
    const immediateEnter = dialog();
    immediateEnter.component.handleInput("\r");
    expect(immediateEnter.done).toHaveBeenCalledWith(false);

    const approve = dialog();
    approve.component.handleInput("y");
    expect(approve.done).toHaveBeenCalledWith(true);

    const cancel = dialog();
    cancel.component.handleInput("n");
    expect(cancel.done).toHaveBeenCalledWith(false);
  });
});

describe("confirmWorkflowApproval", () => {
  it("falls back to the stock confirmation when custom UI is unavailable", async () => {
    const confirm = vi.fn(async () => true);

    const approved = await confirmWorkflowApproval({ confirm }, "Run workflow?", longApproval);

    expect(approved).toBe(true);
    expect(confirm).toHaveBeenCalledWith("Run workflow?", longApproval);
  });

  it("uses the fixed-height custom UI when the host supports it", async () => {
    const confirm = vi.fn(async () => false);
    const custom = vi.fn(async (factory: (...args: unknown[]) => WorkflowApprovalDialog) => {
      return new Promise<boolean>((resolve) => {
        const component = factory({ requestRender: vi.fn() }, theme, {}, resolve);
        component.handleInput("y");
      });
    });

    const approved = await confirmWorkflowApproval(
      { confirm, custom: custom as never },
      "Run workflow?",
      longApproval,
    );

    expect(approved).toBe(true);
    expect(custom).toHaveBeenCalledOnce();
    expect(custom.mock.calls[0]?.[1]).toMatchObject({
      overlay: true,
      overlayOptions: {
        width: "90%",
        minWidth: 48,
        maxHeight: "90%",
      },
    });
    expect(confirm).not.toHaveBeenCalled();
  });
});
