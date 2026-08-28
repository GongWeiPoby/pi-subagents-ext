import type { WorkflowMeta } from "./meta.js";
import { buildPhaseGroups, displayState, type WorkflowDisplayState, type WorkflowEntry } from "./progress.js";

export interface FleetWorkflowAgent {
  index: number;
  label: string;
  state: WorkflowDisplayState;
  agentType: string;
  model?: string;
  recordId?: string;
  tokens: number;
  startedAt?: number;
  completedAt?: number;
}

export interface FleetWorkflowPhase {
  id: string;
  title: string;
  doneCount: number;
  totalCount: number;
  agents: FleetWorkflowAgent[];
}

export interface FleetWorkflow {
  id: string;
  name: string;
  status: "running" | "completed" | "failed" | "killed" | "paused";
  doneCount: number;
  totalCount: number;
  startedAt: number;
  completedAt?: number;
  totalPausedMs?: number;
  tokens: number;
  phases: FleetWorkflowPhase[];
}

/** Elapsed workflow time with completed pauses removed. */
export function fleetWorkflowElapsed(workflow: FleetWorkflow, now: number): number {
  return Math.max(0, (workflow.completedAt ?? now) - workflow.startedAt - (workflow.totalPausedMs ?? 0));
}

/**
 * Pure adapter from the workflow event log to FleetView's execution tree.
 * Ownership stays on AgentRecord.workflowId; this only decides presentation.
 */
export function workflowFleetPhases(
  progress: readonly WorkflowEntry[],
  meta: WorkflowMeta | undefined,
  workflowActive: boolean,
  workflowEndTime?: number,
): FleetWorkflowPhase[] {
  return buildPhaseGroups(progress, meta?.phases).map((group, phaseIndex) => ({
    id: `${phaseIndex}:${group.title}`,
    title: group.title,
    doneCount: group.doneCount,
    totalCount: group.totalCount,
    agents: group.agents.map((agent) => {
      const state = displayState(agent, workflowActive);
      const completedAt = agent.state === "done" || agent.state === "error"
        ? agent.lastProgressAt ?? agent.startedAt
        : state === "interrupted"
          ? workflowEndTime ?? agent.lastProgressAt ?? agent.startedAt
          : undefined;
      return {
        index: agent.index,
        label: agent.label,
        state,
        agentType: agent.agentType ?? "general-purpose",
        ...(agent.model !== undefined ? { model: agent.model } : {}),
        ...(agent.recordId !== undefined ? { recordId: agent.recordId } : {}),
        tokens: agent.tokens ?? 0,
        ...(agent.startedAt !== undefined ? { startedAt: agent.startedAt } : {}),
        ...(completedAt !== undefined ? { completedAt } : {}),
      };
    }),
  }));
}
