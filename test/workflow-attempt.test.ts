import { describe, expect, it } from "vitest";
import {
  aggregateWorkflowCoverage,
  cloneWorkflowChildAttempt,
  createWorkflowChildAttempt,
  snapshotWorkflowChildAttempt,
  type WorkflowChildAttempt,
} from "../src/workflow/attempt.js";

function attempt(overrides: Partial<WorkflowChildAttempt> = {}): WorkflowChildAttempt {
  return createWorkflowChildAttempt({
    logicalChildIndex: 0,
    logicalChildId: "child-0",
    physicalAttempt: 1,
    status: "completed",
    invocation: "spawn",
    usage: {
      turns: 1,
      toolCalls: 2,
      tokens: { input: 10, output: 20, cacheWrite: 3 },
    },
    ...overrides,
  });
}

describe("workflow child attempts", () => {
  it("keeps retries as separate physical attempts while coverage uses the latest one", () => {
    const first = attempt({ status: "failed", error: "first provider failure" });
    const retry = attempt({
      physicalAttempt: 2,
      invocation: "retry",
      status: "completed",
      sourceAttemptId: "artifact-1",
    });
    const coverage = aggregateWorkflowCoverage([first, retry]);

    expect(coverage.physicalAttemptCount).toBe(2);
    expect(coverage.physical).toMatchObject({ total: 2, failed: 1, completed: 1 });
    expect(coverage.logical).toMatchObject({ total: 1, failed: 0, completed: 1 });
    expect(coverage.coverage).toBe("complete");
  });

  it("counts replayed, skipped and killed physical outcomes", () => {
    const coverage = aggregateWorkflowCoverage([
      attempt({ logicalChildIndex: 0, logicalChildId: "replayed", status: "replayed", invocation: "replay", cached: true }),
      attempt({ logicalChildIndex: 1, logicalChildId: "skipped", status: "skipped", skipped: true }),
      attempt({ logicalChildIndex: 2, logicalChildId: "killed", status: "killed" }),
    ]);

    expect(coverage.physical).toMatchObject({ total: 3, replayed: 1, skipped: 1, killed: 1 });
    expect(coverage.logical).toEqual(coverage.physical);
    expect(coverage.coverage).toBe("partial");
  });

  it.each([
    ["failed", [attempt({ status: "failed" }), attempt({ logicalChildIndex: 1, logicalChildId: "child-1", status: "killed" })]],
    ["partial", [attempt(), attempt({ logicalChildIndex: 1, logicalChildId: "child-1", status: "skipped" })]],
    ["unknown", [attempt({ status: "running" })]],
    ["unknown", []],
  ] as const)("classifies %s coverage explicitly", (expected, attempts) => {
    expect(aggregateWorkflowCoverage(attempts).coverage).toBe(expected);
    expect(aggregateWorkflowCoverage(attempts).complete).toBe(false);
  });

  it("does not treat a workflow's completed status as coverage complete", () => {
    // The aggregate has no workflow status input by design: a script may catch a
    // child failure and still return a completed workflow result.
    const coverage = aggregateWorkflowCoverage([attempt({ status: "failed" })]);
    expect(coverage.coverage).toBe("failed");
    expect(coverage.complete).toBe(false);
  });

  it("clones nested usage so callers cannot mutate the source snapshot", () => {
    const original = attempt({
      usage: { turns: 2, toolCalls: 3, tokens: { input: 4, output: 5, cacheWrite: 6, cost: 0.1 } },
    });
    const snapshot = snapshotWorkflowChildAttempt(original);
    const clone = cloneWorkflowChildAttempt(original);

    snapshot.usage!.tokens.input = 99;
    clone.usage!.tokens.output = 88;

    expect(original.usage).toEqual({
      turns: 2,
      toolCalls: 3,
      tokens: { input: 4, output: 5, cacheWrite: 6, cost: 0.1 },
    });
  });

  it("rejects unsafe references and null status", () => {
    for (const [field, label] of [["recordId", "record id"], ["artifactId", "artifact id"], ["sourceAttemptId", "source attempt id"]] as const) {
      expect(() => attempt({ [field]: `bad/${field}` })).toThrow(`invalid ${label}`);
      expect(() => attempt({ [field]: `a${"x".repeat(128)}` })).toThrow();
      expect(() => attempt({ [field]: `bad\u0000${field}` })).toThrow();
    }
    expect(() => attempt({ status: null as unknown as WorkflowChildAttempt["status"] })).toThrow("invalid attempt status");
  });

  it("sanitizes and bounds errors, and drops prompt, text and path fields", () => {
    const untrusted = {
      ...attempt({ error: `${"provider failure ".repeat(100)}\nsecond line\u001b[31m` }),
      prompt: "must not be retained",
      fullText: "must not be retained",
      absolutePath: "/home/user/private.txt",
    } as WorkflowChildAttempt & Record<string, unknown>;
    const snapshot = snapshotWorkflowChildAttempt(untrusted);

    expect(snapshot.error).toHaveLength(512);
    expect(snapshot.error).not.toContain("second line");
    expect(snapshot.error).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u202E]/);
    expect(snapshot).not.toHaveProperty("prompt");
    expect(snapshot).not.toHaveProperty("fullText");
    expect(snapshot).not.toHaveProperty("absolutePath");
  });
});
