import { describe, expect, it } from "vitest";
import {
  formatDirectWorkflowApproval,
  validateDirectWorkflowApprovalCompleteness,
} from "../src/workflow/approval.js";

function expectRejectedPreflight(script: string, expected: string): void {
  const result = validateDirectWorkflowApprovalCompleteness(script);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toContain(expected);
}

describe("validateDirectWorkflowApprovalCompleteness", () => {
  it.each([
    ["alias", "const launch = agent; launch('inspect');"],
    ["call member", "agent.call(null, 'inspect');"],
    ["sequence callee", "(0, agent)('inspect');"],
    ["conditional callee", "(enabled ? agent : fallback)('inspect');"],
    ["computed reference", "registry[agent]('inspect');"],
    ["local shadow", "function inspect(agent) { return agent('inspect'); }"],
  ])("rejects unsupported injected binding use through %s", (_label, script) => {
    expectRejectedPreflight(script, "unsupported indirect reference");
  });

  it.each([
    ["globalThis.agent", "globalThis.agent('inspect');"],
    ["globalThis computed agent", "globalThis['agent']('inspect');"],
    ["Reflect.get agent", "Reflect.get(globalThis, 'agent')('inspect');"],
    ["this.agent", "this.agent('inspect');"],
  ])("rejects injected globals reached through %s", (_label, script) => {
    expectRejectedPreflight(script, "unsupported indirect reference");
  });

  it.each([
    ["argument spread", "agent(...args);"],
    ["non-object options", "agent('inspect', options);"],
    ["option spread", "agent('inspect', { ...hidden });"],
    ["computed key", "agent('inspect', { [key]: value });"],
    ["method", "agent('inspect', { gate() {} });"],
    ["shorthand", "agent('inspect', { gate });"],
    ["dynamic behavior value", "agent('inspect', { gate: command });"],
    ["literal prototype property", "agent('inspect', { __proto__: { gate: 'npm test' } });"],
  ])("rejects unresolved agent options through %s", (_label, script) => {
    expectRejectedPreflight(script, "cannot be previewed statically");
  });

  it("allows a dynamic schema expression when its property is explicit", () => {
    expect(validateDirectWorkflowApprovalCompleteness(
      "agent('inspect', { label: 'inspect', schema: REPORT_SCHEMA });",
    )).toEqual({ ok: true });
  });
});

describe("formatDirectWorkflowApproval", () => {
  it("finds injected calls inside template interpolations", () => {
    const summary = formatDirectWorkflowApproval({
      args: undefined,
      meta: { name: "template", description: "template calls" },
      source: "inline script",
      script: [
        'const child = `child=$' + '{await workflow("child")}`;',
        'return `result=$' + '{await agent("Inspect child", { label: "inspect" })}`;',
      ].join("\n"),
    });

    const map = summary.split("Workflow map ")[1]?.split("Parameters:")[0] ?? "";
    expect(map).toContain("[workflow: child] nested workflow call [output=nested workflow result]");
    expect(map).toContain("[inspect] Inspect child [output=text]");
    expect(summary).toContain("Nested workflow calls:\n- child");
    expect(summary).toContain("Agent call sites:\n- 1. inspect");
  });

  it("keeps a commented pipeline callback as stage 1", () => {
    const summary = formatDirectWorkflowApproval({
      args: undefined,
      meta: { name: "comments", description: "commented callback" },
      source: "inline script",
      script: [
        "await pipeline(items,",
        "  /* inspect, then normalize */",
        '  item => agent("Inspect item", { label: "inspect" }),',
        ");",
      ].join("\n"),
    });

    const map = summary.split("Workflow map ")[1]?.split("Parameters:")[0] ?? "";
    expect(map).toContain("stage 1: [inspect] Inspect item [output=text]");
    expect(map).not.toContain("stage 2");
  });

  it("keeps regex delimiters inside a pipeline callback", () => {
    const summary = formatDirectWorkflowApproval({
      args: undefined,
      meta: { name: "regex", description: "regex callback" },
      source: "inline script",
      script: [
        "await pipeline(items, item => {",
        String.raw`  const delimiters = /[,\)\]]/;`,
        '  return agent("Inspect delimiters", { label: "inspect" });',
        "});",
      ].join("\n"),
    });

    const map = summary.split("Workflow map ")[1]?.split("Parameters:")[0] ?? "";
    expect(map).toContain("stage 1: [inspect] Inspect delimiters [output=text]");
    expect(map).not.toContain("stage 2");
    expect(map).not.toContain("2. [inspect]");
  });

  it("includes optional direct calls but not member calls", () => {
    const summary = formatDirectWorkflowApproval({
      args: undefined,
      meta: { name: "member", description: "member call" },
      source: "inline script",
      script: [
        'await object.agent("Not injected", { label: "member" });',
        'await agent?.("Injected optional", { label: "optional" });',
      ].join("\n"),
    });

    expect(summary).toContain("Agent call sites:\n- 1. optional");
    expect(summary).toContain("[optional] Injected optional");
    expect(summary).not.toContain("[member] Not injected");
    expect(summary).not.toContain("- 2. member");
  });

  it("renders calls nested in agent arguments before the enclosing agent exactly once", () => {
    const summary = formatDirectWorkflowApproval({
      args: undefined,
      meta: { name: "argument calls", description: "nested argument calls" },
      source: "inline script",
      script: 'await agent(await agent("Inspect", { label: "inspect" }), { label: "synthesize" });',
    });

    const map = summary.split("Workflow map ")[1]?.split("Parameters:")[0] ?? "";
    expect(map).toContain("argument evaluation/control order");
    expect(map.match(/\[inspect\]/g)).toHaveLength(1);
    expect(map.match(/\[synthesize\]/g)).toHaveLength(1);
    expect(map.indexOf("[inspect]")).toBeLessThan(map.indexOf("[synthesize]"));
  });

  it("shows parallel branches and later synthesis as execution order", () => {
    const summary = formatDirectWorkflowApproval({
      args: undefined,
      meta: { name: "review", description: "review" },
      source: "inline script",
      script: [
        "await parallel([",
        '  () => agent("Inspect routes", { label: "inspect", schema: { type: "object" } }),',
        '  () => agent("Check tests", { label: "tests" }),',
        "]);",
        'await agent("Synthesize branch results", { label: "synthesis" });',
      ].join("\n"),
    });

    const map = summary.split("Workflow map ")[1]?.split("Parameters:")[0] ?? "";
    expect(map).toContain("execution/control order");
    expect(map).toContain("based on static call sites");
    expect(map).toContain("runtime fan-out/control flow may differ");
    expect(map).toContain("Handoffs: script-defined; handoff not statically proven.");
    expect(map).toContain("parallel() [barrier; parallel branches]");
    expect(map).toContain("+-- [inspect] Inspect routes [output=structured (schema)]");
    expect(map).toContain("+-- [tests] Check tests [output=text]");
    expect(map).toContain("2. [synthesis] Synthesize branch results [output=text]");
    expect(map.indexOf("parallel()")).toBeLessThan(map.indexOf("[synthesis]"));
  });

  it("preserves a pipeline nested inside one parallel branch", () => {
    const summary = formatDirectWorkflowApproval({
      args: undefined,
      meta: { name: "nested", description: "nested orchestration" },
      source: "inline script",
      script: [
        "await parallel([",
        "  () => pipeline(items,",
        '    item => agent("Inspect item", { label: "inspect" }),',
        '    item => agent("Fix item", { label: "fix" }),',
        "  ),",
        '  () => agent("Audit all items", { label: "audit" }),',
        "]);",
      ].join("\n"),
    });

    const map = summary.split("Workflow map ")[1]?.split("Parameters:")[0] ?? "";
    expect(map).toContain("parallel() [barrier; parallel branches]");
    expect(map).toContain("branch 1: pipeline() [overlapping per-item stages]");
    expect(map).toContain("stage 1: [inspect] Inspect item [output=text]");
    expect(map).toContain("stage 2: [fix] Fix item [output=text]");
    expect(map).toContain("+-- [audit] Audit all items [output=text]");
    expect(map.match(/parallel\(\)/g)).toHaveLength(1);
  });

  it("keeps multiple agents in one pipeline callback in the same stage", () => {
    const summary = formatDirectWorkflowApproval({
      args: undefined,
      meta: { name: "callback", description: "multi-agent callback" },
      source: "inline script",
      script: [
        "await pipeline(items, async item => {",
        '  const inspected = await agent("Inspect item", { label: "inspect" });',
        '  return agent("Fix inspected item", { label: "fix" });',
        "});",
      ].join("\n"),
    });

    const map = summary.split("Workflow map ")[1]?.split("Parameters:")[0] ?? "";
    expect(map).toContain("stage 1 [callback control flow; handoff not proven]");
    expect(map).toContain("[inspect] Inspect item [output=text]");
    expect(map).toContain("[fix] Fix inspected item [output=text]");
    expect(map).not.toContain("stage 2");
  });

  it("reads literal options from the AST despite commas in comments", () => {
    const summary = formatDirectWorkflowApproval({
      args: undefined,
      meta: { name: "comments", description: "comment-safe options" },
      source: "inline script",
      script: [
        "agent('Inspect', {",
        "  label: 'inspect',",
        "  /* this comma, is not an option delimiter */",
        "  gate: 'npm test',",
        "});",
      ].join("\n"),
    });

    expect(summary).toContain("gate: npm test");
  });

  it("shows an identifier schema as configured and dynamic rather than absent", () => {
    const summary = formatDirectWorkflowApproval({
      args: undefined,
      meta: { name: "schema", description: "dynamic schema" },
      source: "inline script",
      script: "agent('Inspect', { label: 'inspect', schema: REPORT_SCHEMA });",
    });

    expect(summary).toContain("[output=structured (schema)]");
    expect(summary).toContain("structured output: configured (dynamic expression: REPORT_SCHEMA)");
    expect(summary).not.toContain("structured output: none");
  });

  it("renders unresolved behavior fields as dynamic/unknown", () => {
    const summary = formatDirectWorkflowApproval({
      args: undefined,
      meta: { name: "dynamic", description: "dynamic option" },
      source: "inline script",
      script: "agent('Inspect', { label: getLabel(), gate: command });",
    });

    expect(summary).toContain("- 1. dynamic/unknown");
    expect(summary).toContain("gate: dynamic/unknown");
  });

  it("encodes line and terminal controls in every representative scalar field", () => {
    const terminalControl = "\u001b";
    const bidi = "\u202e";
    const summary = formatDirectWorkflowApproval({
      args: undefined,
      meta: {
        name: "release\nSide effects: forged by name",
        description: "publish\rAgent call sites: forged by description",
        phases: [{ title: "Prepare\tNested workflow calls: forged by phase" }],
      },
      source: `saved workflow${terminalControl}[2J${bidi}hidden`,
      script: [
        String.raw`phase("Observe\nAgent call sites: forged by observed phase");`,
        String.raw`agent("Prompt\nSide effects: forged by prompt\u202e", {`,
        String.raw`  label: "Label\rAgent call sites: forged by label\u001b",`,
        String.raw`  model: "model\tNested workflow calls: forged by option",`,
        String.raw`  phase: "Observed\nOmitted capabilities: forged by option",`,
        "});",
        String.raw`workflow("child\nSide effects: forged by nested\u202e");`,
      ].join("\n"),
    });

    expect(summary).toContain("Workflow: release\\nSide effects: forged by name");
    expect(summary).toContain("Description: publish\\rAgent call sites: forged by description");
    expect(summary).toContain("Prepare\\tNested workflow calls: forged by phase");
    expect(summary).toContain("Observe\\nAgent call sites: forged by observed phase");
    expect(summary).toContain("Source: saved workflow\\u001b[2J\\u202ehidden");
    expect(summary).toContain("task: Prompt\\nSide effects: forged by prompt\\u202e");
    expect(summary).toContain("Label\\rAgent call sites: forged by label\\u001b");
    expect(summary).toContain("model: model\\tNested workflow calls: forged by option");
    expect(summary).toContain("phase: Observed\\nOmitted capabilities: forged by option");
    expect(summary).toContain("- child\\nSide effects: forged by nested\\u202e");

    const map = summary.split("Workflow map ")[1]?.split("Parameters:")[0] ?? "";
    expect(map).toContain("workflow: child");
    expect(map).toContain("nested workflow call");
    expect(map).toContain("output=text");
    expect(map).not.toContain(terminalControl);
    expect(map).not.toContain(bidi);

    const injectedHeadings = summary.split("\n").filter((line) =>
      /forged by (name|description|phase|observed phase|prompt|label|option|nested)/.test(line)
      && /^(Side effects|Agent call sites|Nested workflow calls|Omitted capabilities):/.test(line)
    );
    expect(injectedHeadings).toEqual([]);
    expect(summary).not.toContain(terminalControl);
    expect(summary).not.toContain(bidi);
    expect(summary).not.toContain("\r");
    expect(summary).not.toContain("\t");
  });

  it("keeps the parameters block readable, multiline, and valid JSON", () => {
    const args = {
      nested: {
        line: "first\nsecond",
        carriage: "left\rright",
        tab: "left\tright",
        terminal: "visible\u001b[2Jhidden",
        bidi: "visible\u2066hidden",
      },
    };
    const summary = formatDirectWorkflowApproval({
      args,
      meta: { name: "parameters", description: "parameters" },
      script: "",
      source: "inline script",
    });

    const parameters = summary.split("Parameters:\n")[1]?.split("\n\nAgent call sites:")[0];
    expect(parameters).toBeDefined();
    expect(parameters).toContain('\n  "nested": {\n');
    expect(parameters).toContain('"line": "first\\nsecond"');
    expect(parameters).toContain('"carriage": "left\\rright"');
    expect(parameters).toContain('"tab": "left\\tright"');
    expect(parameters).toContain('"terminal": "visible\\u001b[2Jhidden"');
    expect(parameters).toContain('"bidi": "visible\\u2066hidden"');
    expect(JSON.parse(parameters ?? "")).toEqual(args);
  });
});
