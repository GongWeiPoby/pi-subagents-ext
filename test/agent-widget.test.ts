import { describe, expect, it, vi } from "vitest";
import { renderRunningAgentStatus } from "../src/index.js";
import type { WidgetMode } from "../src/types.js";
import {
  type AgentActivity,
  AgentWidget,
  executionActivityText,
  executionStatParts,
  fgPreservingNestedStyles,
  formatCost,
  formatSessionTokens,
  SPINNER,
  SPINNER_INTERVAL_MS,
  type Theme,
  type UICtx,
} from "../src/ui/agent-widget.js";
import type { FleetWorkflow } from "../src/workflow/fleet.js";

describe("shared execution formatters", () => {
  it("keeps equivalent ordinary and workflow stat snapshots in parity", () => {
    const ordinary = executionStatParts({
      modelName: "haiku",
      thinking: "thinking: high",
      turnCount: 2,
      maxTurns: 10,
      toolUses: 3,
      tokenText: "1.2k token",
      costText: "~$0.0042",
      elapsed: "5.0s",
    });
    const workflow = executionStatParts({
      modelName: "haiku",
      thinking: "thinking: high",
      turnCount: 2,
      maxTurns: 10,
      toolUses: 3,
      tokenText: "1.2k token",
      costText: "~$0.0042",
      elapsed: "5.0s",
    });

    expect(workflow).toEqual(ordinary);
    expect(workflow).toEqual([
      "haiku",
      "thinking: high",
      "↻2≤10",
      "3 tool uses",
      "1.2k token",
      "~$0.0042",
      "5.0s",
    ]);
  });

  it("uses ordinary tool/output activity wording for workflow snapshots", () => {
    expect(executionActivityText({ activity: "tool: read" })).toBe(
      executionActivityText({ activeTools: new Map([["call", "read"]]) }),
    );
    expect(executionActivityText({ outputPreview: "partial response" })).toBe(
      executionActivityText({ activeTools: new Map(), responseText: "partial response" }),
    );
  });
});

describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };
  const ansiTheme = {
    fg: (c: string, s: string) => {
      const codes: Record<string, string> = { dim: "2", warning: "33", accent: "35" };
      return `\u001b[${codes[c] ?? "31"}m${s}\u001b[39m`;
    },
    bold: (s: string) => s,
  };

  it("applies threshold colors (<70 dim, 70–85 warning, ≥85 error)", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k token");
    expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k token (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k token (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k token (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k token (<error>85%</error>)");
    expect(formatSessionTokens(1234, 99, theme)).toBe("1.2k token (<error>99%</error>)");
  });

  it("annotates compaction count alongside percent", () => {
    // compactions only (e.g. immediately post-compaction, percent null)
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k token (<dim>⇊1</dim>)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe("1.2k token (<dim>⇊3</dim>)");
    // percent + compactions, joined with ` · `
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe("1.2k token (<dim>45%</dim> · <dim>⇊2</dim>)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe("1.2k token (<error>88%</error> · <dim>⇊4</dim>)");
    // compactions=0 omitted
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k token (<dim>45%</dim>)");
  });

  it("preserves the outer style after nested annotation styles reset", () => {
    const tokenText = formatSessionTokens(1234, 70, ansiTheme);

    expect(fgPreservingNestedStyles(ansiTheme, "accent", tokenText)).toBe(
      "\u001b[35m1.2k token (\u001b[33m70%\u001b[39m\u001b[35m)\u001b[39m",
    );
  });
});

describe("renderRunningAgentStatus", () => {
  it("renders running status as separate component lines", () => {
    const theme = { fg: (_c: string, s: string) => s };
    const component = renderRunningAgentStatus("⠋", "thinking: xhigh · 4 tool uses", "thinking…", theme);

    expect(component.render(120).map((line) => line.trimEnd())).toEqual([
      "⠋ thinking: xhigh · 4 tool uses",
      "  ⎿  thinking…",
    ]);
  });
});

describe("AgentWidget", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
  const taggedTheme = {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => text,
  };
  type WidgetFactory = Exclude<Parameters<UICtx["setWidget"]>[1], undefined>;

  function makeActivity(): AgentActivity {
    return {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "",
      turnCount: 1,
    };
  }

  function makeRecord(
    id: string,
    opts: { isBackground?: boolean; parentAgentId?: string; workflowId?: string } = {},
  ) {
    return {
      id,
      type: "Worker",
      description: `${id} description`,
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0,
      invocation: { modelName: "sonnet 4.6", modelId: "anthropic/claude-sonnet-4-6", thinking: "high" },
      isBackground: opts.isBackground,
      parentAgentId: opts.parentAgentId,
      workflowId: opts.workflowId,
    };
  }

  function renderLines(
    manager: unknown,
    activityId: string,
    mode?: () => WidgetMode,
    showModel = false,
    workflows?: () => readonly FleetWorkflow[],
    renderTheme: Theme = theme,
  ): string {
    const widget = new AgentWidget(
      manager as any,
      new Map([[activityId, makeActivity()]]),
      mode,
      () => false,
      () => showModel,
    );
    if (workflows) widget.setWorkflowSource(workflows);
    let factory: any;
    widget.setUICtx({
      setStatus: () => {},
      setWidget: (_key, content) => { factory = content; },
    });
    widget.update();
    if (!factory) return "";
    return factory({ terminal: { columns: 120 }, requestRender: () => {} }, renderTheme)
      .render()
      .join("\n");
  }

  function makeWorkflow(overrides: Partial<FleetWorkflow> = {}): FleetWorkflow {
    return {
      id: "wf_audit",
      name: "Audit workflow",
      status: "running",
      doneCount: 1,
      totalCount: 3,
      startedAt: Date.now() - 12_000,
      tokens: 1200,
      phases: [{
        id: "phase:inspect",
        title: "Inspect",
        doneCount: 1,
        totalCount: 3,
        agents: [
          { index: 0, label: "queued child", state: "queued", agentType: "Explorer", tokens: 0 },
          {
            index: 1,
            label: "running child",
            state: "running",
            agentType: "Explorer",
            activity: "responding",
            outputPreview: "partial response",
            turnCount: 2,
            tokens: 500,
            startedAt: Date.now() - 5000,
          },
          { index: 2, label: "failed child", state: "failed", agentType: "Explorer", tokens: 700, startedAt: Date.now() - 8000, completedAt: Date.now() - 1000 },
        ],
      }],
      ...overrides,
    };
  }

  // "all" (and the no-policy constructor default) shows every agent.
  it("shows foreground agents in 'all' mode (and by default)", () => {
    const manager = { listAgents: () => [makeRecord("foreground", { isBackground: false })] };
    expect(renderLines(manager, "foreground")).toContain("foreground description");
    expect(renderLines(manager, "foreground", () => "all")).toContain("foreground description");
  });

  it("hides nested children in every coordinator widget mode", () => {
    const manager = {
      listAgents: () => [makeRecord("nested", { isBackground: true, parentAgentId: "parent" })],
    };
    expect(renderLines(manager, "nested", () => "all")).toBe("");
    expect(renderLines(manager, "nested", () => "background")).toBe("");
  });

  it("hides a workflow's agents in every coordinator widget mode", () => {
    // They belong to the run, which reports for them through its own card and
    // its own row in the fleet list.
    const manager = {
      listAgents: () => [makeRecord("child", { isBackground: true, workflowId: "wf_abc" })],
    };
    expect(renderLines(manager, "child", () => "all")).toBe("");
    expect(renderLines(manager, "child", () => "background")).toBe("");
  });

  it("excludes foreground agents in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("foreground", { isBackground: false })] };
    expect(renderLines(manager, "foreground", () => "background")).toBe("");
  });

  // Also covers scheduler-spawned agents (isBackground=true, no `invocation`
  // snapshot): if the filter still keyed off `invocation.runInBackground` —
  // #118's original approach — this would wrongly vanish.
  it("renders background agents in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("background", { isBackground: true })] };
    const lines = renderLines(manager, "background", () => "background");
    expect(lines).toContain("Agents");
    expect(lines).toContain("background description");
  });

  // 'background' excludes only agents *known* to be foreground; one with no
  // isBackground flag (e.g. a cross-extension RPC spawn) is kept, not hidden.
  it("keeps agents with no isBackground flag in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("unflagged", {})] };
    expect(renderLines(manager, "unflagged", () => "background")).toContain("unflagged description");
  });

  // The model is opt-in: the row is already dense, and the same pair is on the
  // tool result and in the conversation viewer either way.
  it("names the model and thinking on a running row under showModel", () => {
    const manager = { listAgents: () => [makeRecord("bg", { isBackground: true })] };

    expect(renderLines(manager, "bg", () => "background", true))
      .toContain("sonnet 4.6 · thinking: high");
  });

  it("renders the row exactly as before when showModel is off", () => {
    const manager = { listAgents: () => [makeRecord("bg", { isBackground: true })] };

    const off = renderLines(manager, "bg", () => "background");
    expect(off).toContain("bg description");
    expect(off).not.toContain("sonnet 4.6");
    expect(off).not.toContain("thinking:");
  });

  it("carries the short label, never the canonical id, onto the row", () => {
    const manager = { listAgents: () => [makeRecord("bg", { isBackground: true })] };

    expect(renderLines(manager, "bg", () => "background", true))
      .not.toContain("anthropic/claude-sonnet-4-6");
  });

  it("discloses a level the run did not honor", () => {
    const record = makeRecord("bg", { isBackground: true });
    record.invocation = { modelName: "haiku 4.5", thinking: "high", requestedThinking: "max" };
    const manager = { listAgents: () => [record] };

    expect(renderLines(manager, "bg", () => "background", true))
      .toContain("haiku 4.5 · thinking: high (asked max)");
  });

  // Queued agents stay a one-line count. A fan-out of ten would otherwise eat
  // the whole widget and push every finished agent out of it.
  it("keeps queued agents on one summary line and finished agents visible", () => {
    const records = [
      ...[1, 2, 3].map(i => ({ ...makeRecord(`run${i}`, { isBackground: true }), status: "running" })),
      ...[1, 2, 3, 4, 5, 6, 7].map(i => ({ ...makeRecord(`q${i}`, { isBackground: true }), status: "queued" })),
      ...[1, 2, 3].map(i => ({
        ...makeRecord(`fin${i}`, { isBackground: true }),
        status: "completed",
        completedAt: Date.now(),
      })),
    ];
    const widget = new AgentWidget(
      { listAgents: () => records } as any,
      new Map(),
      () => "background",
      () => false,
      () => true,
    );
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_key, content) => { factory = content; } });
    for (const r of records) if (r.status === "completed") widget.markFinished(r.id);
    widget.update();
    const lines = factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");

    expect(lines).toContain("7 queued");
    expect(lines).not.toContain("q1 description");
    for (const i of [1, 2, 3]) expect(lines).toContain(`fin${i} description`);
    expect(lines).not.toContain("more (");
  });

  it("renders equivalent ordinary and workflow records with the same stats and activity wording", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const ordinary = makeRecord("ordinary", { isBackground: true }) as any;
    const child = makeRecord("child", { isBackground: true, workflowId: "wf_audit" }) as any;
    for (const record of [ordinary, child]) {
      record.startedAt = 5_000;
      record.toolUses = 3;
      record.turnCount = 2;
      record.lifetimeUsage = { input: 800, output: 300, cacheRead: 0, cacheWrite: 100 };
      record.invocation = {
        modelName: "sonnet 4.6",
        modelId: "anthropic/claude-sonnet-4-6",
        thinking: "high",
        maxTurns: 10,
      };
    }
    const activities = new Map<string, AgentActivity>([[ordinary.id, {
      activeTools: new Map(),
      toolUses: 3,
      responseText: "partial response",
      turnCount: 2,
      maxTurns: 10,
    }]]);
    const workflow = makeWorkflow({
      phases: [{
        id: "phase:inspect",
        title: "Inspect",
        doneCount: 0,
        totalCount: 1,
        agents: [{
          index: 0,
          recordId: child.id,
          label: "child description",
          state: "running",
          agentType: child.type,
          activity: "responding",
          outputPreview: "partial response",
          turnCount: 2,
          toolUses: 3,
          tokens: 1_200,
          startedAt: 5_000,
        }],
      }],
    });
    const manager = {
      listAgents: () => [ordinary, child],
      getRecord: (id: string) => id === child.id ? child : ordinary,
    };
    const widget = new AgentWidget(manager as any, activities, () => "all", () => false, () => true);
    widget.setWorkflowSource(() => [workflow]);
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_key, content) => { factory = content; } });
    widget.update();
    const rendered = factory({ terminal: { columns: 160 }, requestRender: () => {} }, theme).render().join("\n");
    const lines = rendered.split("\n");
    const expected = "sonnet 4.6 · thinking: high · ↻2≤10 · 3 tool uses · 1.2k token · 5.0s";

    expect(lines.find(line => line.includes("ordinary description"))).toContain(expected);
    expect(lines.find(line => line.includes("child description"))).toContain(expected);
    expect(lines.filter(line => line.includes("partial response"))).toHaveLength(2);
    vi.useRealTimers();
  });

  it("renders a workflow root before its phase and child hierarchy", () => {
    const workflow = makeWorkflow();
    const manager = { listAgents: () => [] };
    const lines = renderLines(manager, "unused", () => "background", false, () => [workflow]).split("\n");

    expect(lines[0]).toContain("Agents");
    expect(lines[1]).toContain("Audit workflow");
    expect(lines[2]).toContain("Inspect");
    expect(lines[3]).toContain("queued child");
    expect(lines[4]).toContain("running child");
    expect(lines[4]).toContain("running · ↻2");
    expect(lines[5]).toContain("partial response");
    expect(lines[6]).toContain("failed child");
    expect(lines[1]).toMatch(/1\/3 agents so far/);
    expect(lines[1]).not.toContain("↻");
    expect(lines[2]).not.toContain("↻");
  });

  it("marks active workflow totals as discovered so far, but not settled totals", () => {
    const manager = { listAgents: () => [] };
    const running = renderLines(manager, "unused", () => "all", false, () => [makeWorkflow()]);
    const paused = renderLines(
      manager,
      "unused",
      () => "all",
      false,
      () => [makeWorkflow({ status: "paused" })],
    );
    const settled = renderLines(
      manager,
      "unused",
      () => "all",
      false,
      () => [makeWorkflow({ status: "completed", completedAt: Date.now() })],
    );

    expect(running).toContain("agents so far");
    expect(paused).toContain("agents so far");
    expect(settled).not.toContain("so far");
  });

  it("renders each workflow root immediately before its own hierarchy", () => {
    const workflowA = makeWorkflow({
      id: "wf_a",
      name: "Workflow A",
      phases: [{
        id: "phase:a",
        title: "Phase A",
        doneCount: 0,
        totalCount: 5,
        agents: Array.from({ length: 5 }, (_, index) => ({
          index,
          label: `A child ${index}`,
          state: "done" as const,
          agentType: "Explorer",
          tokens: 0,
          startedAt: Date.now(),
          completedAt: Date.now(),
        })),
      }],
    });
    const workflowB = makeWorkflow({
      id: "wf_b",
      name: "Workflow B",
      phases: [{
        id: "phase:b",
        title: "Phase B",
        doneCount: 0,
        totalCount: 1,
        agents: [{
          index: 0,
          label: "B child",
          state: "queued",
          agentType: "Explorer",
          tokens: 0,
        }],
      }],
    });
    const ordinary = makeRecord("ordinary", { isBackground: true });
    const lines = renderLines(
      { listAgents: () => [ordinary] },
      ordinary.id,
      () => "all",
      false,
      () => [workflowA, workflowB],
    ).split("\n");
    const indexOf = (text: string) => lines.findIndex(line => line.includes(text));

    expect(lines).toHaveLength(12);
    expect(indexOf("Workflow A")).toBeLessThan(indexOf("Phase A"));
    expect(indexOf("Phase A")).toBeLessThan(indexOf("A child 0"));
    expect(indexOf("A child 4")).toBeLessThan(indexOf("Workflow B"));
    expect(indexOf("Workflow B")).toBeLessThan(indexOf("Phase B"));
    expect(indexOf("Phase B")).toBeLessThan(indexOf("B child"));
    expect(lines.join("\n")).toContain("hidden: 1 agent");
  });

  it("reserves later active workflow roots before spending descendant budget", () => {
    const workflowA = makeWorkflow({
      id: "wf_a",
      name: "Oversized A",
      phases: [{
        id: "phase:a",
        title: "A descendants",
        doneCount: 0,
        totalCount: 20,
        agents: Array.from({ length: 20 }, (_, index) => ({
          index,
          label: `large child ${index}`,
          state: "running" as const,
          agentType: "Explorer",
          tokens: 0,
          startedAt: Date.now(),
        })),
      }],
    });
    const workflowB = makeWorkflow({ id: "wf_b", name: "Retained B" });
    const lines = renderLines(
      { listAgents: () => [] },
      "unused",
      () => "all",
      false,
      () => [workflowA, workflowB],
    ).split("\n");

    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines.findIndex(line => line.includes("Oversized A")))
      .toBeLessThan(lines.findIndex(line => line.includes("Retained B")));
    expect(lines.join("\n")).toContain("Retained B");
    expect(lines.join("\n")).toMatch(/hidden: \d+ workflow nodes?/);
  });

  it.each([
    ["running", "accent", SPINNER[0]],
    ["paused", "warning", "‖"],
    ["completed", "success", "✓"],
    ["failed", "error", "✗"],
    ["killed", "dim", "■"],
  ] as const)("renders the %s workflow root marker", (status, color, marker) => {
    const terminal = status === "completed" || status === "failed" || status === "killed";
    const workflow = makeWorkflow({
      status,
      ...(terminal ? { completedAt: Date.now() } : {}),
      phases: [],
    });
    const root = renderLines(
      { listAgents: () => [] },
      "unused",
      () => "all",
      false,
      () => [workflow],
      taggedTheme,
    ).split("\n")[1];

    expect(root).toContain(`<${color}>${marker}</${color}>`);
    expect(root).toContain(status);
    expect(root).toContain("<dim>└─</dim>");
  });

  it.each([
    ["running", "accent", SPINNER[0]],
    ["done", "success", "✓"],
    ["failed", "error", "✗"],
    ["blocked", "error", "✗"],
    ["queued", "accent", "○"],
    ["interrupted", "dim", "■"],
    ["skipped", "dim", "■"],
  ] as const)("derives and renders %s phase/child semantics", (state, color, marker) => {
    const workflow = makeWorkflow({
      phases: [{
        id: `phase:${state}`,
        title: `Phase ${state}`,
        doneCount: state === "done" ? 1 : 0,
        totalCount: 1,
        agents: [{ index: 0, label: `${state} child`, state, agentType: "Explorer", tokens: 0 }],
      }],
    });
    const lines = renderLines(
      { listAgents: () => [] },
      "unused",
      () => "all",
      false,
      () => [workflow],
      taggedTheme,
    ).split("\n");
    const phase = lines.find(line => line.includes(`Phase ${state}`));
    const child = lines.find(line => line.includes(`${state} child`));

    expect(phase).toContain(`<${color}>${marker}</${color}>`);
    expect(child).toContain(`<${color}>${marker}</${color}>`);
  });

  it("omits elapsed tails for queued and never-started interrupted children", () => {
    const workflow = makeWorkflow({
      phases: [{
        id: "phase:tails",
        title: "Tails",
        doneCount: 0,
        totalCount: 2,
        agents: [
          { index: 0, label: "queued child", state: "queued", agentType: "Explorer", tokens: 0 },
          { index: 1, label: "interrupted child", state: "interrupted", agentType: "Explorer", tokens: 0 },
        ],
      }],
    });
    const lines = renderLines(
      { listAgents: () => [] },
      "unused",
      () => "all",
      false,
      () => [workflow],
    ).split("\n");
    const queued = lines.find(line => line.includes("queued child"));
    const interrupted = lines.find(line => line.includes("interrupted child"));

    expect(queued).toMatch(/queued child · queued$/);
    expect(queued).not.toContain("queued · queued");
    expect(interrupted).toMatch(/interrupted child · interrupted$/);
    expect(interrupted).not.toContain("interrupted · queued");
  });

  it("uses branch connectors for child siblings and closes the last branch", () => {
    const lines = renderLines(
      { listAgents: () => [] },
      "unused",
      () => "all",
      false,
      () => [makeWorkflow()],
    ).split("\n");

    expect(lines[1]).toContain("└─");
    expect(lines[2]).toContain("└─");
    const childLines = lines.filter(line => line.includes(" child"));
    expect(childLines[0]).toContain("├─");
    expect(childLines[1]).toContain("├─");
    expect(childLines[2]).toContain("└─");
  });

  it("marks a declared phase with no agents as not-started", () => {
    const workflow = makeWorkflow({
      phases: [{ id: "phase:later", title: "Later", doneCount: 0, totalCount: 0, agents: [] }],
    });
    const lines = renderLines({ listAgents: () => [] }, "unused", () => "all", false, () => [workflow]);

    expect(lines).toContain("○ phase Later  not-started · 0/0");
  });

  it("does not duplicate workflow children as ordinary agent rows", () => {
    const child = makeRecord("child", { isBackground: true, workflowId: "wf_audit" });
    const ordinary = makeRecord("ordinary", { isBackground: true });
    const lines = renderLines(
      { listAgents: () => [child, ordinary] },
      "ordinary",
      () => "all",
      false,
      () => [makeWorkflow()],
    );

    expect(lines).toContain("Audit workflow");
    expect(lines).toContain("ordinary description");
    expect(lines).not.toContain("child description");
  });

  it("shows no workflow or agent content when widget mode is off", () => {
    const lines = renderLines(
      { listAgents: () => [makeRecord("ordinary", { isBackground: true })] },
      "ordinary",
      () => "off",
      false,
      () => [makeWorkflow()],
    );
    expect(lines).toBe("");
  });

  it("shows a settled workflow for four seconds and then removes it", () => {
    vi.useFakeTimers();
    const workflow = makeWorkflow({ status: "completed", completedAt: Date.now() });
    const manager = { listAgents: () => [] };
    const widget = new AgentWidget(
      manager as unknown as ConstructorParameters<typeof AgentWidget>[0],
      new Map(),
      () => "all",
    );
    widget.setWorkflowSource(() => [workflow]);
    let factory: WidgetFactory | undefined;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_key, content) => { factory = content; } });

    widget.update();
    const render = () => {
      if (!factory) return "";
      return factory({ terminal: { columns: 120 }, requestRender: () => {} }, theme).render().join("\n");
    };
    expect(render()).toContain("Audit workflow");
    vi.advanceTimersByTime(3999);
    widget.update();
    expect(render()).toContain("Audit workflow");
    vi.advanceTimersByTime(1);
    widget.update();
    expect(factory).toBeUndefined();
    widget.dispose();
    vi.useRealTimers();
  });

  it("subtracts resumed pause duration from workflow elapsed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const workflow = makeWorkflow({ startedAt: 1_000, totalPausedMs: 4_000, phases: [] });

    const lines = renderLines(
      { listAgents: () => [] },
      "unused",
      () => "all",
      false,
      () => [workflow],
    );

    expect(lines).toContain("5.0s");
    expect(lines).not.toContain("9.0s");
    vi.useRealTimers();
  });

  it("caps mixed workflow and ordinary content with typed hidden counts", () => {
    const workflowA = makeWorkflow({
      id: "wf_a",
      name: "Workflow A",
      phases: Array.from({ length: 2 }, (_, phaseIndex) => ({
        id: `phase:a:${phaseIndex}`,
        title: `A phase ${phaseIndex}`,
        doneCount: 0,
        totalCount: 2,
        agents: Array.from({ length: 2 }, (_, index) => ({
          index: phaseIndex * 2 + index,
          label: `A child ${phaseIndex}-${index}`,
          state: "running" as const,
          agentType: "Explorer",
          tokens: 0,
          startedAt: Date.now(),
        })),
      })),
    });
    const workflowB = makeWorkflow({
      id: "wf_b",
      name: "Workflow B",
      phases: [{
        id: "phase:b",
        title: "B phase",
        doneCount: 0,
        totalCount: 2,
        agents: Array.from({ length: 2 }, (_, index) => ({
          index,
          label: `B child ${index}`,
          state: "queued" as const,
          agentType: "Explorer",
          tokens: 0,
        })),
      }],
    });
    const running = makeRecord("ordinary-running", { isBackground: true });
    const queued = { ...makeRecord("ordinary-queued", { isBackground: true }), status: "queued" };
    const finished = {
      ...makeRecord("ordinary-finished", { isBackground: true }),
      status: "completed",
      completedAt: Date.now(),
    };
    const lines = renderLines(
      { listAgents: () => [running, queued, finished] },
      running.id,
      () => "all",
      false,
      () => [workflowA, workflowB],
    ).split("\n");
    const rendered = lines.join("\n");

    expect(lines.length).toBeLessThanOrEqual(12);
    expect(rendered).toContain("1 queued");
    expect(rendered).not.toContain("ordinary-finished description");
    expect(rendered).toContain("hidden: 4 workflow nodes, 2 agents");
  });

  it("singularizes mixed workflow and agent hidden counts", () => {
    const workflow = makeWorkflow({
      phases: [{
        id: "phase:large",
        title: "Large phase",
        doneCount: 0,
        totalCount: 9,
        agents: Array.from({ length: 9 }, (_, index) => ({
          index,
          label: `child ${index}`,
          state: "running" as const,
          agentType: "Explorer",
          tokens: 0,
          startedAt: Date.now(),
        })),
      }],
    });
    const ordinary = makeRecord("ordinary", { isBackground: true });
    const rendered = renderLines(
      { listAgents: () => [ordinary] },
      ordinary.id,
      () => "all",
      false,
      () => [workflow],
    );

    expect(rendered).toContain("hidden: 5 workflow nodes, 1 agent");
  });

  it("shows a workflow even when there are no ordinary agents", () => {
    expect(renderLines({ listAgents: () => [] }, "unused", () => "background", false, () => [makeWorkflow()]))
      .toContain("Audit workflow");
  });

  it("advances the shared spinner only on timer ticks, not event updates", () => {
    vi.useFakeTimers();
    const record = makeRecord("running", { isBackground: true });
    const widget = new AgentWidget(
      { listAgents: () => [record] } as unknown as ConstructorParameters<typeof AgentWidget>[0],
      new Map(),
      () => "all",
    );
    let factory: WidgetFactory | undefined;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_key, content) => { factory = content; } });
    widget.update();
    const render = () => {
      if (!factory) throw new Error("widget factory was not registered");
      return factory({ terminal: { columns: 120 }, requestRender: () => {} }, theme).render().join("\n");
    };
    const frame = () => render().split("\n")[1].trim().split(" ")[1];
    const first = frame();
    for (let i = 0; i < 5; i++) widget.update();
    expect(frame()).toBe(first);
    vi.advanceTimersByTime(SPINNER_INTERVAL_MS);
    expect(frame()).not.toBe(first);
    expect(SPINNER).toContain(frame());
    widget.dispose();
    vi.useRealTimers();
  });

  it("stops advancing frames after a running workflow settles", () => {
    vi.useFakeTimers();
    const workflow = makeWorkflow();
    const widget = new AgentWidget(
      { listAgents: () => [] } as unknown as ConstructorParameters<typeof AgentWidget>[0],
      new Map(),
      () => "all",
    );
    widget.setWorkflowSource(() => [workflow]);
    let factory: WidgetFactory | undefined;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_key, content) => { factory = content; } });
    widget.update();
    const frame = () => {
      if (!factory) throw new Error("widget factory was not registered");
      return factory({ terminal: { columns: 120 }, requestRender: () => {} }, theme)
        .render()[1].trim().split(" ")[1];
    };

    vi.advanceTimersByTime(SPINNER_INTERVAL_MS);
    const settledFrame = frame();
    workflow.status = "completed";
    workflow.completedAt = Date.now();
    widget.update();
    vi.advanceTimersByTime(SPINNER_INTERVAL_MS * 3);
    workflow.status = "running";
    workflow.completedAt = undefined;
    widget.update();

    expect(frame()).toBe(settledFrame);
    vi.advanceTimersByTime(SPINNER_INTERVAL_MS);
    expect(frame()).not.toBe(settledFrame);
    widget.dispose();
    vi.useRealTimers();
  });

  it("does not keep the animation interval alive for a paused workflow", () => {
    vi.useFakeTimers();
    const workflow = makeWorkflow({ status: "paused" });
    const widget = new AgentWidget(
      { listAgents: () => [] } as unknown as ConstructorParameters<typeof AgentWidget>[0],
      new Map(),
      () => "all",
    );
    widget.setWorkflowSource(() => [workflow]);
    let factory: WidgetFactory | undefined;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_key, content) => { factory = content; } });
    widget.update();

    expect(vi.getTimerCount()).toBe(0);
    if (!factory) throw new Error("widget factory was not registered");
    const before = factory({ terminal: { columns: 120 }, requestRender: () => {} }, theme).render()[1];
    vi.advanceTimersByTime(SPINNER_INTERVAL_MS * 3);
    const after = factory({ terminal: { columns: 120 }, requestRender: () => {} }, theme).render()[1];
    expect(before).toContain("‖");
    expect(after).toContain("‖");
    widget.dispose();
    vi.useRealTimers();
  });

  // "off" hides the widget entirely — even a background agent renders nothing.
  it("renders nothing in 'off' mode", () => {
    const manager = { listAgents: () => [makeRecord("background", { isBackground: true })] };
    expect(renderLines(manager, "background", () => "off")).toBe("");
  });
});

// The widget caps itself at MAX_WIDGET_LINES (12) and, past that, hands out a
// line budget in priority order: running pairs, then the queued summary, then
// finished lines. Running and finished increment `hiddenRunning`/`hiddenFinished`
// when they don't fit; the queued line is dropped with NO counter at all, so the
// footer under-reports and — worse — the queue vanishes from the UI entirely.
// That happens exactly when the concurrency limit is saturated, i.e. when the
// queue is the thing the user most needs to see.
describe("formatCost", () => {
  it("keeps the precision that distinguishes one run from another", () => {
    // Rounding to cents would print the same figure for a run that cost four
    // times another — the band most single subagent runs fall in.
    expect(formatCost(0.0042)).toBe("~$0.0042");
    expect(formatCost(0.0123)).toBe("~$0.0123");
    expect(formatCost(1.239)).toBe("~$1.24");
  });

  it("never pads a round figure with noise, nor cuts it below cents", () => {
    expect(formatCost(0.05)).toBe("~$0.05");    // not ~$0.0500
    expect(formatCost(0.4)).toBe("~$0.40");     // not ~$0.4
    expect(formatCost(12)).toBe("~$12.00");
  });

  it("shows nothing when there is nothing to show", () => {
    // Zero is what a model with no pricing data reports, so `$0.00` would claim
    // a measurement that was never made.
    expect(formatCost(0)).toBe("");
    expect(formatCost(Number.NaN)).toBe("");
    expect(formatCost(-1)).toBe("");
  });

  it("says a real but tiny cost is tiny, not zero", () => {
    // The distinction the whole helper turns on: "measured, below what four
    // decimals can show" must not render the same as "never measured".
    expect(formatCost(0.00002)).toBe("<$0.0001");
    expect(formatCost(0)).toBe("");
  });

  it("marks the figure as an estimate", () => {
    // The tilde is the whole disclaimer — it sits beside exact token counts.
    expect(formatCost(0.5).startsWith("~")).toBe(true);
  });
});

describe("AgentWidget cost display", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function render(showCost: boolean, cost: number): string {
    const agent = {
      id: "a1",
      type: "Worker",
      description: "spending agent",
      status: "running",
      toolUses: 1,
      startedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost },
      compactionCount: 0,
    };
    // Carries figures of its own, in the shape the tracker used to have: spend
    // is read from the record now, so these must not reach the line. Only the
    // record accumulates a nested child's spend, and only it outlives the run.
    const activity = new Map([["a1", {
      activeTools: new Map(),
      toolUses: 1,
      responseText: "",
      turnCount: 1,
      lifetimeUsage: { input: 9, output: 9, cacheWrite: 0, cost: 0.9 },
    } as unknown as AgentActivity]]);
    const widget = new AgentWidget(
      { listAgents: () => [agent] } as any,
      activity,
      () => "all",
      () => showCost,
    );
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    return factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");
  }

  it("shows the cost beside the token count when enabled", () => {
    const line = render(true, 0.0042);
    expect(line).toContain("1.2k token");
    expect(line).toContain("~$0.0042");
  });

  it("shows no cost when disabled", () => {
    const line = render(false, 0.0042);
    expect(line).toContain("1.2k token");
    expect(line).not.toContain("$");
  });

  it("shows no cost for an unpriced model, even when enabled", () => {
    const line = render(true, 0);
    expect(line).toContain("1.2k token");
    expect(line).not.toContain("$");
  });

  it("keeps the cost visible after the agent finishes", () => {
    // The activity entry is deleted the moment an agent finishes, so a finished
    // line reading from it would drop the number precisely when the question
    // "what did that cost" gets asked.
    const finished = {
      id: "a1", type: "Worker", description: "done agent", status: "completed",
      toolUses: 2, startedAt: Date.now() - 1000, completedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost: 0.0042 },
      compactionCount: 0,
    };
    const widget = new AgentWidget(
      { listAgents: () => [finished] } as any, new Map(), () => "all", () => true,
    );
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    const out = factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");

    expect(out).toContain("done agent");
    expect(out).toContain("~$0.0042");
  });

  it("shows stats for an agent nobody is tracking live", () => {
    // A scheduled agent has no activity entry — it spawns through the manager
    // directly — and used to render with no tokens and no cost at all.
    const running = {
      id: "sched", type: "Worker", description: "scheduled agent", status: "running",
      toolUses: 1, startedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost: 0.0042 },
      compactionCount: 0,
    };
    const widget = new AgentWidget(
      { listAgents: () => [running] } as any, new Map(), () => "all", () => true,
    );
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    const out = factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");

    expect(out).toContain("1.2k token");
    expect(out).toContain("~$0.0042");
  });

  it("defaults to hiding it", () => {
    const agent = {
      id: "a1", type: "Worker", description: "d", status: "running",
      toolUses: 0, startedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost: 0.5 }, compactionCount: 0,
    };
    const activity = new Map([["a1", {
      activeTools: new Map(), toolUses: 0, responseText: "", turnCount: 1,
    } as AgentActivity]]);
    const widget = new AgentWidget({ listAgents: () => [agent] } as any, activity, () => "all");
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    expect(factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n"))
      .not.toContain("$");
  });
});

describe("AgentWidget overflow accounting", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function record(id: string, status: string) {
    return {
      id,
      type: "Worker",
      description: `${id} description`,
      status,
      toolUses: 0,
      startedAt: Date.now(),
      completedAt: status === "completed" ? Date.now() : undefined,
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0,
      isBackground: true,
    };
  }

  /** Render a whole fleet (mixed statuses) and return the produced lines. */
  function renderFleet(counts: { running: number; queued: number; finished: number }): string[] {
    const agents = [
      ...Array.from({ length: counts.running }, (_, i) => record(`run${i}`, "running")),
      ...Array.from({ length: counts.queued }, (_, i) => record(`q${i}`, "queued")),
      ...Array.from({ length: counts.finished }, (_, i) => record(`fin${i}`, "completed")),
    ];
    const activity = new Map(agents.map(a => [a.id, {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "",
      turnCount: 1,
    } as AgentActivity]));
    const widget = new AgentWidget({ listAgents: () => agents } as any, activity, () => "all");
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    if (!factory) return [];
    return factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render();
  }

  /** The typed hidden-count footer, if the widget overflowed. */
  const footer = (lines: string[]) => lines.find(l => l.includes("hidden:"));
  const hiddenAgentCount = (line: string | undefined) =>
    Number(/(\d+) agents?/.exec(line ?? "")?.[1] ?? 0);

  /** Every fleet shape worth rendering — swept, not sampled. */
  const SHAPES: { running: number; queued: number; finished: number }[] = [];
  for (let running = 0; running <= 8; running++)
    for (let queued = 0; queued <= 8; queued++)
      for (let finished = 0; finished <= 8; finished++) SHAPES.push({ running, queued, finished });

  // Swept rather than sampled: reserving the queued row moves `budget` around by
  // hand, and an off-by-one there overflows the cap only for specific shapes.
  it("never exceeds the line cap, for any fleet shape", () => {
    for (const counts of SHAPES) {
      expect(renderFleet(counts).length, JSON.stringify(counts)).toBeLessThanOrEqual(12);
    }
  });

  it("never prints a footer that miscounts what it hid, for any fleet shape", () => {
    for (const counts of SHAPES) {
      const f = footer(renderFleet(counts));
      if (!f) continue;
      const total = hiddenAgentCount(f);
      const where = `${JSON.stringify(counts)} → ${f}`;
      // A visible agents-only footer must name at least one hidden agent.
      expect(total, where).toBeGreaterThan(0);
      // Queued agents share one visible summary and are not counted as hidden
      // per-agent rows.
      expect(total, where).toBeLessThanOrEqual(counts.running + counts.finished);
    }
  });

  it("keeps the queued summary visible when the running agents fill the widget", () => {
    // 5 running (10 lines) consume the entire budget, so the queued line is
    // dropped — and with it, any sign that 3 agents are waiting to start.
    const lines = renderFleet({ running: 5, queued: 3, finished: 1 });
    expect(lines.join("\n")).toContain("3 queued");
  });

  it("counts everything it hid — the footer total matches what is missing", () => {
    // Computed rather than hardcoded, so this survives a scenario change but not
    // a change to what the footer counts.
    const counts = { running: 5, queued: 3, finished: 1 };
    const lines = renderFleet(counts);
    const body = lines.join("\n");

    const shownRunning = counts.running - [...Array(counts.running).keys()]
      .filter(i => !body.includes(`run${i} description`)).length;
    const shownFinished = counts.finished - [...Array(counts.finished).keys()]
      .filter(i => !body.includes(`fin${i} description`)).length;
    const actuallyHidden = (counts.running - shownRunning) + (counts.finished - shownFinished);

    const reported = hiddenAgentCount(footer(lines));
    expect(reported).toBe(actuallyHidden);
  });

  it("pluralizes multiple hidden ordinary agents", () => {
    expect(footer(renderFleet({ running: 6, queued: 1, finished: 1 }))).toMatch(/\d+ agents/);
  });

  it("gives the queued summary priority over finished lines", () => {
    const lines = renderFleet({ running: 4, queued: 2, finished: 3 });
    expect(lines.join("\n")).toContain("2 queued");
  });

  it("renders everything with no footer when the fleet fits", () => {
    const lines = renderFleet({ running: 2, queued: 1, finished: 1 });
    expect(lines.join("\n")).toContain("1 queued");
    expect(footer(lines)).toBeUndefined();
  });

  // A background resume runs an agent that already finished once. markFinished
  // only seeds an age it has not seen before, so without markRunning the agent
  // carries its previous run's age — already past the linger limit — and the
  // resumed run's ✓ line never renders: the agent just disappears.
  it("shows the completion line again after a finished agent is resumed", () => {
    const agent = record("resumed", "completed");
    const activity = new Map([[agent.id, {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "",
      turnCount: 1,
    } as AgentActivity]]);
    const widget = new AgentWidget({ listAgents: () => [agent] } as any, activity, () => "all");
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k: any, c: any) => { factory = c; } } as any);
    const render = () => {
      widget.update();
      return (factory?.({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render() ?? []).join("\n");
    };

    // First run finishes and ages out of the widget.
    widget.markFinished(agent.id);
    widget.onTurnStart();
    widget.onTurnStart();
    expect(render()).not.toContain("resumed description");

    // Background resume puts it back on the running list.
    agent.status = "running";
    widget.markRunning(agent.id);
    expect(render()).toContain("resumed description");

    // ...and its completion is visible when the resumed run settles.
    agent.status = "completed";
    widget.markFinished(agent.id);
    expect(render()).toContain("resumed description");
  });
});
