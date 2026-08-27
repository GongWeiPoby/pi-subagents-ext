import { describe, expect, it, vi } from "vitest";
import { extractMeta } from "../src/workflow/meta.js";
import {
  compileWorkflowPlan,
  formatWorkflowPlanApproval,
  formatWorkflowPlanYaml,
  type WorkflowPlanInput,
} from "../src/workflow/plan.js";
import { runWorkflow, type WorkflowHost, type WorkflowSpawnRequest } from "../src/workflow/runtime.js";

function plan(overrides: Partial<WorkflowPlanInput> = {}): WorkflowPlanInput {
  return {
    objective: "Review the auth change",
    playbook: "code-review",
    personas: [{ name: "work-backend", role: "backend engineer" }],
    confidence: 0.9,
    evidence: ["public API changed"],
    nodes: [
      {
        id: "inspect",
        title: "Inspect change",
        capability: "code-discovery",
        prompt: "Inspect the auth diff",
        agentType: "Explore",
        phase: "Discover",
      },
      {
        id: "review",
        title: "Review correctness",
        capability: "code-review",
        prompt: "Review the discovered change",
        agentType: "code-reviewer",
        effort: "high",
        phase: "Review",
        dependsOn: ["inspect"],
        skills: ["security-review"],
      },
      {
        id: "tests",
        title: "Review tests",
        capability: "test-review",
        prompt: "Check test coverage",
        phase: "Review",
        dependsOn: ["inspect"],
      },
      {
        id: "verify",
        title: "Verify findings",
        capability: "finding-verification",
        prompt: "Try to refute the findings",
        phase: "Verify",
        dependsOn: ["review", "tests"],
      },
    ],
    omitted: [{ capability: "ui-review", reason: "No UI changed" }],
    ...overrides,
  };
}

describe("WorkflowPlan compilation", () => {
  it("builds stable topological layers and temporary workflow JavaScript", () => {
    const first = compileWorkflowPlan(plan());
    const second = compileWorkflowPlan(plan());

    expect(first.ok).toBe(true);
    if (!first.ok || first.status !== "ready" || !second.ok || second.status !== "ready") return;
    expect(first.plan.layers).toEqual([["inspect"], ["review", "tests"], ["verify"]]);
    expect(first.script).toBe(second.script);
    expect(extractMeta(first.script).meta.phases?.map((phase) => phase.title))
      .toEqual(["Discover", "Review", "Verify"]);
    expect(first.script).toContain("await parallel([");
    expect(first.script).toContain("Prerequisite results");
    expect(first.script).not.toContain(".pi/workflows");
  });

  it("executes the compiled script through the real worker runtime", async () => {
    const compilation = compileWorkflowPlan(plan());
    if (!compilation.ok || compilation.status !== "ready") throw new Error("plan did not compile");
    const requests: WorkflowSpawnRequest[] = [];
    const host: WorkflowHost = {
      async spawnAgent(request) {
        requests.push(request);
        return { ok: true, text: `result:${request.label}` };
      },
      abortAgent: vi.fn(),
    };

    const result = await runWorkflow({ script: compilation.script, host, concurrency: 4 });

    expect(result.status).toBe("completed");
    expect(requests.map((request) => request.label)).toEqual([
      "Inspect change",
      "Review correctness",
      "Review tests",
      "Verify findings",
    ]);
    expect(requests[1].prompt).toContain('"inspect":"result:Inspect change"');
    expect(requests[3].prompt).toContain('"review":"result:Review correctness"');
    expect(result.value).toMatchObject({
      objective: "Review the auth change",
      results: {
        inspect: "result:Inspect change",
        review: "result:Review correctness",
        tests: "result:Review tests",
        verify: "result:Verify findings",
      },
    });
  });

  it("preserves every behavior-affecting node option in the runtime request", async () => {
    const compilation = compileWorkflowPlan(plan({
      nodes: [{
        id: "write",
        title: "Write safely",
        capability: "implementation",
        prompt: "Implement the approved change",
        agentType: "worker",
        model: "sonnet",
        effort: "high",
        isolation: "worktree",
        gate: "npm test",
        phase: "Implement",
        skills: ["secure-coding"],
        schema: {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
          additionalProperties: false,
        },
        approval: "required",
        sideEffects: "write",
      }],
    }), { approved: true });
    if (!compilation.ok || compilation.status !== "ready") throw new Error("plan did not compile");
    const requests: WorkflowSpawnRequest[] = [];
    const host: WorkflowHost = {
      async spawnAgent(request) {
        requests.push(request);
        return { ok: true, text: '{"summary":"done"}', cwd: "/tmp/worktree" };
      },
      abortAgent: vi.fn(),
      runGate: vi.fn(async () => ({ ok: true, output: "passed" })),
    };

    const result = await runWorkflow({ script: compilation.script, host, concurrency: 1 });

    expect(result.status).toBe("completed");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      label: "Write safely",
      agentType: "worker",
      model: "sonnet",
      effort: "high",
      isolation: "worktree",
      gate: "npm test",
      phaseTitle: "Implement",
    });
    expect(requests[0].schema).toBeDefined();
    expect(requests[0].prompt).toContain("Relevant skills requested by the plan: secure-coding");
    expect(host.runGate).toHaveBeenCalledWith("npm test", {
      agentId: requests[0].agentId,
      cwd: "/tmp/worktree",
    });
  });

  it("returns an approval plan without executable JavaScript", () => {
    const input = plan({
      nodes: [
        {
          id: "deploy",
          title: "Deploy production",
          capability: "deploy",
          prompt: "Deploy the current build",
          approval: "required",
          sideEffects: "external",
        },
      ],
    });

    const waiting = compileWorkflowPlan(input);
    const approved = compileWorkflowPlan(input, { approved: true });

    const external = compileWorkflowPlan(plan({
      nodes: [
        {
          id: "publish",
          title: "Publish",
          capability: "publish",
          prompt: "Publish the content",
          approval: "adaptive",
          sideEffects: "external",
        },
      ],
    }));

    const inferredExternal = compileWorkflowPlan(plan({
      nodes: [{
        id: "implicit-deploy",
        title: "Deploy production",
        capability: "production-deploy",
        prompt: "Deploy the current build to production",
      }],
    }));

    expect(waiting).toMatchObject({ ok: true, status: "awaiting_approval" });
    expect(waiting.ok && "script" in waiting).toBe(false);
    expect(external).toMatchObject({ ok: true, status: "awaiting_approval" });
    expect(inferredExternal).toMatchObject({
      ok: true,
      status: "awaiting_approval",
      plan: { nodes: [{ sideEffects: "external" }] },
    });
    expect(approved).toMatchObject({ ok: true, status: "ready" });
  });

  it.each([
    {
      name: "duplicates",
      mutate: (input: WorkflowPlanInput) => input.nodes.push({ ...input.nodes[0] }),
      error: "duplicate node id",
    },
    {
      name: "unknown dependency",
      mutate: (input: WorkflowPlanInput) => { input.nodes[0].dependsOn = ["missing"]; },
      error: "depends on unknown node",
    },
    {
      name: "self dependency",
      mutate: (input: WorkflowPlanInput) => { input.nodes[0].dependsOn = ["inspect"]; },
      error: "cannot depend on itself",
    },
    {
      name: "cycle",
      mutate: (input: WorkflowPlanInput) => {
        input.nodes[0].dependsOn = ["review"];
        input.nodes[1].dependsOn = ["inspect"];
      },
      error: "dependency cycle",
    },
    {
      name: "confidence",
      mutate: (input: WorkflowPlanInput) => { input.confidence = 2; },
      error: "confidence",
    },
    {
      name: "terminal controls",
      mutate: (input: WorkflowPlanInput) => { input.nodes[0].prompt = "Review\u001b[2Jhidden"; },
      error: "terminal control characters",
    },
    {
      name: "bidirectional controls",
      mutate: (input: WorkflowPlanInput) => { input.nodes[0].prompt = "Review\u202ehidden"; },
      error: "terminal control characters",
    },
    {
      name: "nested schema terminal controls",
      mutate: (input: WorkflowPlanInput) => {
        input.nodes[0].schema = { properties: { result: { description: "Visible\u001b[2Jhidden" } } };
      },
      error: "schema contains terminal control characters",
    },
    {
      name: "nested schema bidirectional controls in keys",
      mutate: (input: WorkflowPlanInput) => {
        input.nodes[0].schema = { properties: { "result\u202ehidden": { type: "string" } } };
      },
      error: "schema contains terminal control characters",
    },
    {
      name: "unsupported effort",
      mutate: (input: WorkflowPlanInput) => {
        (input.nodes[0] as unknown as { effort: string }).effort = "extreme";
      },
      error: "effort is not supported",
    },
    {
      name: "invalid schema",
      mutate: (input: WorkflowPlanInput) => {
        (input.nodes[0] as unknown as { schema: unknown }).schema = [];
      },
      error: "schema must be a plain object",
    },
  ])("rejects $name before compiling", ({ mutate, error }) => {
    const input = plan();
    mutate(input);

    const result = compileWorkflowPlan(input);

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.errors.join("\n")).toContain(error);
  });

  it("escapes prompts as data rather than executable source", () => {
    const malicious = 'Review this`; throw new Error("injected") //';
    const result = compileWorkflowPlan(plan({
      nodes: [{ id: "safe", title: "Safe", capability: "review", prompt: malicious }],
    }));

    expect(result).toMatchObject({ ok: true, status: "ready" });
    if (!result.ok || result.status !== "ready") return;
    expect(result.script).toContain(JSON.stringify(malicious));
    expect(() => extractMeta(result.script)).not.toThrow();
  });

  it("formats a complete approval view with every behavior-affecting field", () => {
    const result = compileWorkflowPlan(plan({
      nodes: [
        {
          id: "deploy",
          title: "Deploy",
          capability: "deploy",
          prompt: "Deploy the signed artifact",
          agentType: "operator",
          model: "provider/model",
          effort: "high",
          isolation: "worktree",
          gate: "./verify-production.sh",
          phase: "Release",
          dependsOn: [],
          approval: "required",
          sideEffects: "external",
          skills: ["deployment"],
          schema: { type: "object" },
        },
      ],
    }));
    if (!result.ok) throw new Error("plan did not compile");

    const approval = formatWorkflowPlanApproval(result.plan);

    expect(approval).toContain("Task: Deploy the signed artifact");
    expect(approval).toContain("Gate: ./verify-production.sh");
    expect(approval).toContain("Model: provider/model");
    expect(approval).toContain("Effort: high");
    expect(approval).toContain("Isolation: worktree");
    expect(approval).toContain("Skills: deployment");
    expect(approval).toContain("Workflow: code-review-");
    expect(approval).toContain("Agent type: operator");
    expect(approval).toContain("Parallel peers: none");
    expect(approval).toContain("Approval metadata (advisory): required");
    expect(approval).toContain("Omitted capabilities:");
    expect(approval).not.toContain("export const meta");
    expect(approval).not.toContain("parallel([");
  });

  it("formats an inspectable YAML plan without exposing node prompts", () => {
    const result = compileWorkflowPlan(plan());
    if (!result.ok) throw new Error("plan did not compile");

    const yaml = formatWorkflowPlanYaml(result.plan);

    expect(yaml).toContain('objective: "Review the auth change"');
    expect(yaml).toContain('id: "inspect"');
    expect(yaml).toContain('capability: "code-review"');
    expect(yaml).toContain('workflow: "code-review-');
    expect(yaml).toContain('agent_type: "code-reviewer"');
    expect(yaml).toContain('model: inherit');
    expect(yaml).toContain('reason: "No UI changed"');
    expect(yaml).not.toContain("Inspect the auth diff");
  });
});
