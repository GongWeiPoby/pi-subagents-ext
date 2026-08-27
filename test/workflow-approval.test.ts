import { describe, expect, it } from "vitest";
import { formatDirectWorkflowApproval } from "../src/workflow/approval.js";

describe("formatDirectWorkflowApproval", () => {
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
