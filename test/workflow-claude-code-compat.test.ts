/**
 * workflow-claude-code-compat.test.ts — a Claude Code script, run in the
 * text-only compatibility subset.
 *
 * Every other suite tests one seam. This one tests the claim the README makes:
 * that a script written for Claude Code's `Workflow` tool runs here. It is the
 * canonical orchestration shape — `pipeline`, `parallel`, `phase`,
 * template-literal labels and `.then` chaining inside a stage, all at once.
 *
 * If a future change breaks compatibility, this is the test that should say so
 * before anyone finds out from a ported script.
 */

import { describe, expect, it } from "vitest";
import { runWorkflow, type WorkflowHost } from "../src/workflow/runtime.js";

/** Claude Code's canonical review-changes orchestration, with text handoffs. */
const CC_SCRIPT = `export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}
const DIMENSIONS = [{key: 'bugs', prompt: 'find bugs'}, {key: 'perf', prompt: 'find perf issues'}]
const reviews = await pipeline(
  DIMENSIONS,
  d => agent(\`\${d.prompt}\\nReturn one finding per line.\`, {label: \`review:\${d.key}\`, phase: 'Review'})
)
const findings = reviews.flatMap((review, dimensionIndex) =>
  review.split('\\n').filter(line => line.trim()).map(finding => DIMENSIONS[dimensionIndex].key + '\\t' + finding)
)
phase('Verify')
const verdicts = await parallel(findings.map((finding, index) => () =>
  agent(\`Adversarially verify finding \${index}: \${finding}\`, {label: \`verify:\${index}\`, phase: 'Verify'})
))
const confirmed = verdicts.filter(verdict => verdict.trim() === 'REAL')
return { confirmed: confirmed.length, total: verdicts.length }
`;

describe("a Claude Code script, text-only compatibility", () => {
  it("runs the canonical review-changes orchestration", async () => {
    const host: WorkflowHost = {
      async spawnAgent(request) {
        const text = request.label?.includes("verify:")
          ? (request.prompt.includes("a.ts") ? "REAL" : "NOT REAL")
          : "finding a.ts\nfinding b.ts";
        return { ok: true, text, outputTokens: 10 };
      },
      abortAgent() {},
    };

    const result = await runWorkflow({ script: CC_SCRIPT, host });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
    // 2 dimensions x 2 findings verified, of which the a.ts ones are real.
    expect(result.value).toEqual({ confirmed: 2, total: 4 });
    expect(result.agentCount).toBe(6);
  });

  it("rejects a schema-bearing call with a migration error before host spawn", async () => {
    const calls: string[] = [];
    const host: WorkflowHost = {
      async spawnAgent(request) {
        calls.push(request.prompt);
        return { ok: true, text: "should not run", outputTokens: 10 };
      },
      abortAgent() {},
    };
    const result = await runWorkflow({
      script: 'export const meta = { name: "legacy", description: "legacy" };\nreturn await agent("inspect", { schema: { type: "object" } });',
      host,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toBe("agent() opts.schema is no longer supported; workflow children return text/Markdown.");
    expect(calls).toEqual([]);
  });
});

describe("the other Claude Code globals", () => {
  const host: WorkflowHost = {
    async spawnAgent() { return { ok: true, text: "ok", outputTokens: 25 }; },
    abortAgent() {},
    loadWorkflow: () => ({
      ok: true,
      script: 'export const meta = { name: "sub", description: "d" };\nreturn args.n * 2;\n',
    }),
  };

  it("runs the loop-until-budget and static-scaling patterns as written", async () => {
    const script = [
      "export const meta = { name: 'b', description: 'd' };",
      "const found = [];",
      "while (budget.total && budget.remaining() > 50_000) { found.push(await agent('find')); }",
      "const FLEET = budget.total ? Math.floor(budget.total / 100_000) : 5;",
      "return JSON.stringify([found.length, FLEET, budget.spent()]);",
    ].join("\n");

    const result = await runWorkflow({ script, host });
    // No target, so the loop never runs and the fallback fleet size is used —
    // which is exactly what those guards were written to do.
    expect(JSON.parse(result.value as string)).toEqual([0, 5, 0]);
  });

  it("composes a saved workflow through workflow()", async () => {
    const script = [
      "export const meta = { name: 'c', description: 'd' };",
      "const doubled = await workflow('sub', { n: 21 });",
      "return doubled;",
    ].join("\n");

    expect((await runWorkflow({ script, host })).value).toBe(42);
  });
});
