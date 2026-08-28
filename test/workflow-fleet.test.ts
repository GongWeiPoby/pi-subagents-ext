import { describe, expect, it } from "vitest";
import { workflowFleetPhases } from "../src/workflow/fleet.js";
import type { WorkflowEntry } from "../src/workflow/progress.js";

describe("workflowFleetPhases", () => {
  it("maps progress events into FleetView phase and agent rows", () => {
    const progress: WorkflowEntry[] = [
      { type: "workflow_phase", index: 0, title: "Discover" },
      {
        type: "workflow_agent",
        index: 0,
        label: "auth scan",
        agentId: "wf-agent-0",
        recordId: "agent-record-0",
        agentType: "Explore",
        model: "claude-haiku-4-5",
        state: "start",
        queuedAt: 1_000,
        startedAt: 1_200,
        lastProgressAt: 2_000,
        tokens: 512,
        phaseIndex: 0,
        phaseTitle: "Discover",
      },
      {
        type: "workflow_agent",
        index: 0,
        label: "auth scan",
        agentId: "wf-agent-0",
        recordId: "agent-record-0",
        agentType: "Explore",
        model: "claude-haiku-4-5",
        state: "done",
        queuedAt: 1_000,
        startedAt: 1_200,
        lastProgressAt: 3_400,
        tokens: 1_024,
        phaseIndex: 0,
        phaseTitle: "Discover",
      },
      { type: "workflow_phase", index: 1, title: "Verify" },
      {
        type: "workflow_agent",
        index: 1,
        label: "verify finding",
        agentId: "wf-agent-1",
        recordId: "agent-record-1",
        agentType: "reviewer",
        state: "error",
        startedAt: 2_500,
        lastProgressAt: 4_000,
        phaseIndex: 1,
        phaseTitle: "Verify",
        error: "verification failed",
      },
    ];

    const phases = workflowFleetPhases(
      progress,
      { name: "audit", description: "Audit the change", phases: [{ title: "Discover" }, { title: "Verify" }] },
      false,
    );

    expect(phases).toHaveLength(2);
    expect(phases.map(phase => [phase.title, phase.doneCount, phase.totalCount])).toEqual([
      ["Discover", 1, 1],
      ["Verify", 0, 1],
    ]);
    expect(phases[0].agents[0]).toMatchObject({
      label: "auth scan",
      state: "done",
      agentType: "Explore",
      recordId: "agent-record-0",
      startedAt: 1_200,
      completedAt: 3_400,
      tokens: 1_024,
    });
    expect(phases[1].agents[0]).toMatchObject({
      label: "verify finding",
      state: "failed",
      recordId: "agent-record-1",
      startedAt: 2_500,
      completedAt: 4_000,
    });
  });

  it("freezes interrupted started agents at the workflow terminal timestamp", () => {
    const progress: WorkflowEntry[] = [{
      type: "workflow_agent",
      index: 0,
      label: "interrupted child",
      state: "progress",
      startedAt: 2_000,
      lastProgressAt: 4_000,
    }];

    const withEndTime = workflowFleetPhases(progress, undefined, false, 7_000)[0].agents[0];
    expect(withEndTime).toMatchObject({
      state: "interrupted",
      startedAt: 2_000,
      completedAt: 7_000,
    });

    const withoutEndTime = workflowFleetPhases(progress, undefined, false)[0].agents[0];
    expect(withoutEndTime.completedAt).toBe(4_000);
  });
});
