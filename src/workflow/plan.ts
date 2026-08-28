import { createHash } from "node:crypto";
import { hasUnsafeControlDeep } from "./approval.js";
import { extractMeta, type WorkflowMeta } from "./meta.js";

const NODE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_PLAN_NODES = 64;
const MAX_TOTAL_PROMPT_CHARS = 32_000;
const MAX_COMPILED_SCRIPT_CHARS = 28_000;

const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const APPROVALS = new Set(["adaptive", "none", "required"]);
const SIDE_EFFECTS = new Set(["external", "none", "read", "write"]);

export type WorkflowPlanApproval = "adaptive" | "none" | "required";
export type WorkflowPlanSideEffects = "external" | "none" | "read" | "write";
export type WorkflowPlanEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface WorkflowPlanPersona {
  instructions?: string;
  name: string;
  role: string;
}

export interface WorkflowPlanNode {
  agentType?: string;
  approval?: WorkflowPlanApproval;
  capability: string;
  dependsOn?: string[];
  effort?: WorkflowPlanEffort;
  gate?: string;
  id: string;
  isolation?: "worktree";
  model?: string;
  phase?: string;
  prompt: string;
  schema?: Record<string, unknown>;
  sideEffects?: WorkflowPlanSideEffects;
  skills?: string[];
  title: string;
}

export interface WorkflowPlanOmission {
  capability: string;
  reason: string;
}

export interface WorkflowPlanInput {
  confidence?: number;
  evidence?: string[];
  nodes: WorkflowPlanNode[];
  objective: string;
  omitted?: WorkflowPlanOmission[];
  personas?: WorkflowPlanPersona[];
  playbook?: string;
}

export interface NormalizedWorkflowPlan extends Omit<WorkflowPlanInput, "nodes" | "omitted" | "personas"> {
  approved: boolean;
  evidence: string[];
  layers: string[][];
  nodes: Array<WorkflowPlanNode & {
    agentType: string;
    approval: WorkflowPlanApproval;
    dependsOn: string[];
    phase: string;
    sideEffects: WorkflowPlanSideEffects;
    skills: string[];
  }>;
  objective: string;
  omitted: WorkflowPlanOmission[];
  personas: WorkflowPlanPersona[];
}

export type WorkflowPlanCompilation =
  | { ok: true; plan: NormalizedWorkflowPlan; script: string; status: "ready" }
  | { ok: true; plan: NormalizedWorkflowPlan; status: "awaiting_approval" }
  | { ok: false; errors: string[] };

export function compileWorkflowPlan(
  input: WorkflowPlanInput,
  options: { approved?: boolean } = {},
): WorkflowPlanCompilation {
  const errors: string[] = [];
  const objective = input.objective?.trim();
  if (!objective) errors.push("objective must be a non-empty string");
  else if (hasUnsafeControlDeep(objective)) errors.push("objective contains terminal control characters");
  if (input.playbook !== undefined && hasUnsafeControlDeep(input.playbook)) {
    errors.push("playbook contains terminal control characters");
  }
  if (!Array.isArray(input.nodes) || input.nodes.length === 0) {
    errors.push("nodes must contain at least one workflow node");
  } else if (input.nodes.length > MAX_PLAN_NODES) {
    errors.push(`nodes exceeds the maximum of ${MAX_PLAN_NODES}`);
  }
  if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
    errors.push("confidence must be a finite number from 0 to 1");
  }

  const personas = normalizePersonas(input.personas, errors);
  const omitted = normalizeOmissions(input.omitted, errors);
  const evidence = uniqueStrings(input.evidence);
  for (const item of evidence) {
    if (hasUnsafeControlDeep(item)) errors.push("evidence contains terminal control characters");
  }
  const ids = new Set<string>();
  const nodes = (Array.isArray(input.nodes) ? input.nodes : []).map((node, index) => {
    const id = typeof node.id === "string" ? node.id.trim() : "";
    const title = typeof node.title === "string" ? node.title.trim() : "";
    const capability = typeof node.capability === "string" ? node.capability.trim() : "";
    const prompt = typeof node.prompt === "string" ? node.prompt.trim() : "";
    if (!NODE_ID.test(id)) errors.push(`nodes[${index}].id must match ${NODE_ID}`);
    else if (ids.has(id)) errors.push(`duplicate node id "${id}"`);
    ids.add(id);
    if (!title) errors.push(`nodes[${index}].title must be non-empty`);
    else if (hasUnsafeControlDeep(title)) errors.push(`nodes[${index}].title contains terminal control characters`);
    if (!capability) errors.push(`nodes[${index}].capability must be non-empty`);
    else if (hasUnsafeControlDeep(capability)) errors.push(`nodes[${index}].capability contains terminal control characters`);
    if (!prompt) errors.push(`nodes[${index}].prompt must be non-empty`);
    else if (hasUnsafeControlDeep(prompt)) errors.push(`nodes[${index}].prompt contains terminal control characters`);

    if (node.effort !== undefined && !EFFORTS.has(node.effort)) {
      errors.push(`nodes[${index}].effort is not supported`);
    }
    if (node.isolation !== undefined && node.isolation !== "worktree") {
      errors.push(`nodes[${index}].isolation must be worktree when provided`);
    }
    if (node.approval !== undefined && !APPROVALS.has(node.approval)) {
      errors.push(`nodes[${index}].approval is not supported`);
    }
    if (node.sideEffects !== undefined && !SIDE_EFFECTS.has(node.sideEffects)) {
      errors.push(`nodes[${index}].sideEffects is not supported`);
    }
    if (node.schema !== undefined && (!node.schema || typeof node.schema !== "object" || Array.isArray(node.schema))) {
      errors.push(`nodes[${index}].schema must be a plain object`);
    } else if (node.schema !== undefined && hasUnsafeControlDeep(node.schema)) {
      errors.push(`nodes[${index}].schema contains terminal control characters`);
    }

    const dependsOn = uniqueStrings(node.dependsOn);
    if (dependsOn.includes(id)) errors.push(`node "${id}" cannot depend on itself`);
    const skills = uniqueStrings(node.skills);
    const approval = approvalValue(node.approval);
    const sideEffects = sideEffectsValue(node.sideEffects, `${capability}\n${title}\n${prompt}`);
    const phase = typeof node.phase === "string" && node.phase.trim() ? node.phase.trim() : "Execute";
    const agentType = typeof node.agentType === "string" && node.agentType.trim()
      ? node.agentType.trim()
      : "general-purpose";
    for (const [field, value] of [
      ["agentType", agentType],
      ["phase", phase],
      ["model", node.model],
      ["gate", node.gate],
      ...skills.map((skill) => ["skills", skill]),
    ] as Array<[string, string | undefined]>) {
      if (value && hasUnsafeControlDeep(value)) {
        errors.push(`nodes[${index}].${field} contains terminal control characters`);
      }
    }

    return {
      ...node,
      agentType,
      approval,
      capability,
      dependsOn,
      id,
      phase,
      prompt,
      sideEffects,
      skills,
      title,
    };
  });

  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) errors.push(`node "${node.id}" depends on unknown node "${dependency}"`);
    }
  }

  const totalPromptChars = nodes.reduce((total, node) => total + node.prompt.length, 0);
  if (totalPromptChars > MAX_TOTAL_PROMPT_CHARS) {
    errors.push(`node prompts exceed the combined ${MAX_TOTAL_PROMPT_CHARS}-character limit`);
  }

  const layers = topologicalLayers(nodes, errors);
  const plan: NormalizedWorkflowPlan = {
    ...input,
    approved: options.approved === true,
    evidence,
    layers,
    nodes,
    objective: objective ?? "",
    omitted,
    personas,
  };

  if (errors.length > 0) return { ok: false, errors };
  const requiresApproval = nodes.some(
    (node) => node.approval === "required" || node.sideEffects === "external" || !!node.gate,
  );
  if (requiresApproval && !plan.approved) return { ok: true, plan, status: "awaiting_approval" };

  const script = renderWorkflowScript(plan);
  if (script.length > MAX_COMPILED_SCRIPT_CHARS) {
    return { ok: false, errors: [`compiled script exceeds ${MAX_COMPILED_SCRIPT_CHARS} characters`] };
  }
  // Keep compiler and runtime metadata contracts coupled at the boundary.
  extractMeta(script);
  return { ok: true, plan, script, status: "ready" };
}

export function workflowPlanMeta(plan: NormalizedWorkflowPlan): WorkflowMeta {
  const phases = [...new Set(plan.nodes.map((node) => node.phase))].map((title) => ({ title }));
  const nameBase = plan.playbook || plan.objective || "adaptive-plan";
  const slug = nameBase.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
    || "adaptive-plan";
  const { approved: _approved, ...identity } = plan;
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 8);
  return {
    name: `${slug}-${digest}`,
    description: plan.objective,
    phases,
  };
}

export function formatWorkflowPlanApproval(plan: NormalizedWorkflowPlan): string {
  const meta = workflowPlanMeta(plan);
  const lines = [
    `Workflow: ${meta.name}`,
    `Description: ${meta.description}`,
    `Objective: ${plan.objective}`,
    `Confidence: ${plan.confidence ?? "not provided"}`,
    `Evidence: ${plan.evidence.length > 0 ? plan.evidence.join("; ") : "none provided"}`,
    `Playbook: ${plan.playbook ?? "(none)"}`,
    `Personas: ${plan.personas.map((persona) => `${persona.name} (${persona.role})`).join(", ") || "(none)"}`,
    `Phases: ${meta.phases?.map((phase) => phase.title).join(" -> ") || "Execute"}`,
    ...workflowPlanMap(plan),
    "Execution layers (layers run in order; nodes within one layer may run in parallel):",
    ...plan.layers.map((layer, index) => `  ${index + 1}. ${layer.join(" | ")}`),
    "",
    "Execution nodes:",
  ];
  for (const node of plan.nodes) {
    lines.push("");
    lines.push(`[${node.id}] ${node.title}`);
    lines.push(`Task: ${node.prompt}`);
    lines.push(`Capability: ${node.capability}`);
    lines.push(`Agent type: ${node.agentType}`);
    lines.push(`Model: ${node.model ?? "inherit"}`);
    lines.push(`Effort: ${node.effort ?? "inherit"}`);
    lines.push(`Dependencies: ${node.dependsOn.join(", ") || "none"}`);
    lines.push(`Parallel peers: ${parallelPeers(plan, node.id).join(", ") || "none"}`);
    lines.push(`Phase: ${node.phase}`);
    lines.push(`Isolation: ${node.isolation ?? "none"}`);
    lines.push(`Gate: ${node.gate ?? "none"}`);
    lines.push(`Side effects: ${node.sideEffects}`);
    lines.push(`Approval metadata (advisory): ${node.approval}`);
    lines.push(`Skills: ${node.skills.join(", ") || "none"}`);
    lines.push(`Structured output: ${node.schema ? JSON.stringify(node.schema) : "none"}`);
  }
  lines.push("", "Omitted capabilities:");
  if (plan.omitted.length === 0) lines.push("- none declared");
  else for (const omitted of plan.omitted) lines.push(`- ${omitted.capability}: ${omitted.reason}`);
  return lines.join("\n");
}

function workflowPlanMap(plan: NormalizedWorkflowPlan): string[] {
  const consumers = new Set(plan.nodes.flatMap((node) => node.dependsOn));
  const lines = [
    "Workflow map (exact dependencies; arrows mean prerequisite result handoff):",
    "Handoffs: downstream nodes read the listed upstream outputs; final results retain each node output.",
  ];
  for (const node of plan.nodes) {
    const id = safePlanMapText(node.id);
    if (node.dependsOn.length === 0) lines.push(`  START -> ${id}`);
    else lines.push(`  ${node.dependsOn.map(safePlanMapText).join(" + ")} -> ${id}`);
  }
  for (const node of plan.nodes) {
    if (!consumers.has(node.id)) lines.push(`  ${safePlanMapText(node.id)} -> END`);
  }
  lines.push("Node legend:");
  for (const node of plan.nodes) {
    const output = node.schema ? "structured (schema)" : "text";
    lines.push(
      `  [${safePlanMapText(node.id)}] title=${compactPlanMapText(node.title)} `
      + `capability=${compactPlanMapText(node.capability)} output=${output}`,
    );
  }
  lines.push("Failure/skip: either can yield null; final results retain each node output.");
  return lines;
}

function compactPlanMapText(value: string): string {
  const text = safePlanMapText(value).replace(/\s+/g, " ").trim();
  return text.length <= 56 ? text : `${text.slice(0, 53)}...`;
}

function safePlanMapText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000D\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/g, (character) => {
      if (character === "\n") return "\\n";
      if (character === "\r") return "\\r";
      if (character === "\t") return "\\t";
      return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
    })
    .replace(/[^\x20-\x7E]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function formatWorkflowPlanYaml(plan: NormalizedWorkflowPlan): string {
  const meta = workflowPlanMeta(plan);
  const lines = [
    `workflow: ${yamlString(meta.name)}`,
    `description: ${yamlString(meta.description)}`,
    `objective: ${yamlString(plan.objective)}`,
    `playbook: ${plan.playbook ? yamlString(plan.playbook) : "null"}`,
    `confidence: ${plan.confidence ?? "null"}`,
    `approved: ${plan.approved}`,
    "evidence:",
    ...(plan.evidence.length > 0 ? plan.evidence.map((item) => `  - ${yamlString(item)}`) : ["  []"]),
    `phases: [${meta.phases?.map((phase) => yamlString(phase.title)).join(", ") ?? ""}]`,
    "personas:",
    ...(plan.personas.length > 0 ? [] : ["  []"]),
  ];
  for (const persona of plan.personas) {
    lines.push(`  - name: ${yamlString(persona.name)}`);
    lines.push(`    role: ${yamlString(persona.role)}`);
  }
  lines.push("nodes:");
  for (const node of plan.nodes) {
    lines.push(`  - id: ${yamlString(node.id)}`);
    lines.push(`    title: ${yamlString(node.title)}`);
    lines.push(`    capability: ${yamlString(node.capability)}`);
    lines.push(`    agent_type: ${yamlString(node.agentType)}`);
    lines.push(`    model: ${node.model ? yamlString(node.model) : "inherit"}`);
    lines.push(`    effort: ${node.effort ?? "inherit"}`);
    lines.push(`    phase: ${yamlString(node.phase)}`);
    lines.push(`    depends_on: [${node.dependsOn.map(yamlString).join(", ")}]`);
    lines.push(`    parallel_with: [${parallelPeers(plan, node.id).map(yamlString).join(", ")}]`);
    lines.push(`    isolation: ${node.isolation ?? "none"}`);
    lines.push(`    gate: ${node.gate ? yamlString(node.gate) : "none"}`);
    lines.push(`    skills: [${node.skills.map(yamlString).join(", ")}]`);
    lines.push(`    structured_output: ${node.schema ? "configured" : "none"}`);
    lines.push(`    approval: ${node.approval}`);
    lines.push(`    side_effects: ${node.sideEffects}`);
  }
  lines.push("omitted:");
  if (plan.omitted.length === 0) lines.push("  []");
  for (const omitted of plan.omitted) {
    lines.push(`  - capability: ${yamlString(omitted.capability)}`);
    lines.push(`    reason: ${yamlString(omitted.reason)}`);
  }
  return lines.join("\n");
}

function parallelPeers(plan: NormalizedWorkflowPlan, nodeId: string): string[] {
  const layer = plan.layers.find((candidate) => candidate.includes(nodeId)) ?? [];
  return layer.filter((id) => id !== nodeId);
}

function topologicalLayers(
  nodes: Array<WorkflowPlanNode & { dependsOn: string[] }>,
  errors: string[],
): string[][] {
  const remaining = new Map(nodes.map((node) => [node.id, node]));
  const resolved = new Set<string>();
  const layers: string[][] = [];
  while (remaining.size > 0) {
    const layer = nodes
      .filter((node) => remaining.has(node.id) && node.dependsOn.every((dependency) => resolved.has(dependency)))
      .map((node) => node.id);
    if (layer.length === 0) {
      errors.push(`workflow plan contains a dependency cycle involving: ${[...remaining.keys()].join(", ")}`);
      return [];
    }
    layers.push(layer);
    for (const id of layer) {
      remaining.delete(id);
      resolved.add(id);
    }
  }
  return layers;
}

function renderWorkflowScript(plan: NormalizedWorkflowPlan): string {
  const meta = workflowPlanMeta(plan);
  const lines = [
    `export const meta = ${JSON.stringify(meta, null, 2)}`,
    "",
    "const results = {}",
    "const dependencyContext = (values) => {",
    "  const text = JSON.stringify(values)",
    "  if (text === undefined) return String(values)",
    "  return text.length > 16000 ? text.slice(0, 16000) + '\\n[... prerequisite results truncated]' : text",
    "}",
  ];
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));

  plan.layers.forEach((layer, layerIndex) => {
    lines.push("");
    lines.push(`const layer${layerIndex} = await parallel([`);
    layer.forEach((id) => {
      const node = byId.get(id);
      if (!node) return;
      const promptExpression = renderPromptExpression(node);
      lines.push(`  () => agent(${promptExpression}, ${JSON.stringify(agentOptions(node))}),`);
    });
    lines.push("])");
    layer.forEach((id, resultIndex) => {
      lines.push(`results[${JSON.stringify(id)}] = layer${layerIndex}[${resultIndex}]`);
    });
  });

  lines.push("");
  lines.push(`return { objective: ${JSON.stringify(plan.objective)}, results, omitted: ${JSON.stringify(plan.omitted)} }`);
  return lines.join("\n");
}

function renderPromptExpression(
  node: WorkflowPlanNode & { dependsOn: string[]; skills: string[] },
): string {
  const skillText = node.skills.length > 0
    ? `\n\nRelevant skills requested by the plan: ${node.skills.join(", ")}. Use them when available and applicable.`
    : "";
  const base = JSON.stringify(node.prompt + skillText);
  if (node.dependsOn.length === 0) return base;
  const entries = node.dependsOn
    .map((dependency) => `${JSON.stringify(dependency)}: results[${JSON.stringify(dependency)}]`)
    .join(", ");
  return `${base} + "\\n\\nPrerequisite results:\\n" + dependencyContext({ ${entries} })`;
}

function agentOptions(
  node: WorkflowPlanNode & { agentType: string; phase: string },
): Record<string, unknown> {
  return {
    label: node.title,
    phase: node.phase,
    agentType: node.agentType,
    ...(node.model ? { model: node.model } : {}),
    ...(node.effort ? { effort: node.effort } : {}),
    ...(node.isolation ? { isolation: node.isolation } : {}),
    ...(node.gate ? { gate: node.gate } : {}),
    ...(node.schema ? { schema: node.schema } : {}),
  };
}

function normalizePersonas(value: WorkflowPlanPersona[] | undefined, errors: string[]): WorkflowPlanPersona[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push("personas must be an array");
    return [];
  }
  return value.flatMap((persona, index) => {
    const name = typeof persona?.name === "string" ? persona.name.trim() : "";
    const role = typeof persona?.role === "string" ? persona.role.trim() : "";
    if (!name || !role) {
      errors.push(`personas[${index}] requires non-empty name and role`);
      return [];
    }
    if (hasUnsafeControlDeep(name) || hasUnsafeControlDeep(role)
      || (persona.instructions && hasUnsafeControlDeep(persona.instructions))) {
      errors.push(`personas[${index}] contains terminal control characters`);
      return [];
    }
    return [{ ...persona, name, role }];
  });
}

function normalizeOmissions(value: WorkflowPlanOmission[] | undefined, errors: string[]): WorkflowPlanOmission[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push("omitted must be an array");
    return [];
  }
  return value.flatMap((item, index) => {
    const capability = typeof item?.capability === "string" ? item.capability.trim() : "";
    const reason = typeof item?.reason === "string" ? item.reason.trim() : "";
    if (!capability || !reason) {
      errors.push(`omitted[${index}] requires non-empty capability and reason`);
      return [];
    }
    if (hasUnsafeControlDeep(capability) || hasUnsafeControlDeep(reason)) {
      errors.push(`omitted[${index}] contains terminal control characters`);
      return [];
    }
    return [{ capability, reason }];
  });
}

function uniqueStrings(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
}

function approvalValue(value: WorkflowPlanApproval | undefined): WorkflowPlanApproval {
  return value === "required" || value === "none" ? value : "adaptive";
}

function sideEffectsValue(
  value: WorkflowPlanSideEffects | undefined,
  context: string,
): WorkflowPlanSideEffects {
  if (value === "external") return value;
  const riskyCapability = /(^|[-_])(deploy|publish|release|push|merge|delete|destroy|drop|truncate|wipe|send|post|upload|submit|payment|purchase)([-_]|$)/i;
  const imperativeRisk = /(^|[.!?\n]\s*)(deploy|publish|release|push|merge|delete|destroy|drop|truncate|wipe|send|post|upload|submit|charge|purchase|pay)\b/i;
  if (riskyCapability.test(context) || imperativeRisk.test(context)) return "external";
  return value === "read" || value === "write" ? value : "none";
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
