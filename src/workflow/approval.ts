import { parse } from "@babel/parser";
import type { WorkflowMeta } from "./meta.js";

const UNSAFE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000D\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/g;
const HAS_UNSAFE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000D\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/;
const SINGLE_LINE_CONTROL = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/g;

/**
 * Detect nested workflow behavior through the parsed syntax tree.
 *
 * Direct scripts are rejected when they reference the injected `workflow`
 * binding at all: calls through optional chaining, Function.call/apply, comma
 * expressions, and local aliases all retain that reference in the AST. Static
 * property names such as `object.workflow` are not references to the binding.
 * Parse failures fail closed because an unparsed script cannot be proven free
 * of nested behavior.
 */
export function hasNestedWorkflowCall(source: string): boolean {
  let ast: unknown;
  try {
    ast = parse(source, {
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch {
    return true;
  }
  return containsWorkflowReference(ast);
}

function containsWorkflowReference(value: unknown, parent?: Record<string, unknown>, parentKey?: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsWorkflowReference(item, parent, parentKey));
  if (value === null || typeof value !== "object") return false;

  const node = value as Record<string, unknown>;
  if ((node.type === "CallExpression" || node.type === "OptionalCallExpression")
    && isReflectGetWorkflowCall(node)) {
    return true;
  }
  if (node.type === "Identifier" && node.name === "workflow" && isBindingReference(parent, parentKey)) {
    return true;
  }
  if ((node.type === "Identifier" && node.name === "globalThis" && isBindingReference(parent, parentKey))
    || node.type === "ThisExpression") {
    if (isWorkflowGlobalAccess(parent, parentKey)) return true;
  }
  return Object.entries(node).some(([key, child]) => containsWorkflowReference(child, node, key));
}

function isWorkflowGlobalAccess(
  parent: Record<string, unknown> | undefined,
  parentKey: string | undefined,
): boolean {
  if (!parent || parentKey !== "object"
    || (parent.type !== "MemberExpression" && parent.type !== "OptionalMemberExpression")) {
    return false;
  }
  if (parent.computed !== true) {
    const property = astRecord(parent.property);
    return property?.type === "Identifier" && property.name === "workflow";
  }
  const property = astRecord(parent.property);
  return property?.type !== "StringLiteral" || property.value === "workflow";
}

function isReflectGetWorkflowCall(node: Record<string, unknown>): boolean {
  const callee = astRecord(node.callee);
  if (!callee || (callee.type !== "MemberExpression" && callee.type !== "OptionalMemberExpression")
    || !isGlobalObjectMember(callee.object, "Reflect") || !isStaticProperty(callee, "get")
    || !Array.isArray(node.arguments) || node.arguments.length < 2
    || !isGlobalObjectExpression(node.arguments[0])) {
    return false;
  }
  const property = astRecord(node.arguments[1]);
  return property?.type !== "StringLiteral" || property.value === "workflow";
}

function isGlobalObjectExpression(value: unknown): boolean {
  const node = astRecord(value);
  return (node?.type === "Identifier" && node.name === "globalThis") || node?.type === "ThisExpression";
}

function isGlobalObjectMember(value: unknown, name: string): boolean {
  const node = astRecord(value);
  return node?.type === "Identifier" && node.name === name;
}

function isStaticProperty(node: Record<string, unknown>, name: string): boolean {
  if (node.computed !== true) {
    const property = astRecord(node.property);
    return property?.type === "Identifier" && property.name === name;
  }
  const property = astRecord(node.property);
  return property?.type === "StringLiteral" && property.value === name;
}

function isBindingReference(parent: Record<string, unknown> | undefined, parentKey: string | undefined): boolean {
  if (!parent || !parentKey) return true;
  const type = parent.type;
  if ((type === "MemberExpression" || type === "OptionalMemberExpression")
    && parentKey === "property" && parent.computed !== true) {
    return false;
  }
  if ((type === "ObjectProperty" || type === "ObjectMethod" || type === "ClassProperty"
      || type === "ClassMethod" || type === "ClassPrivateProperty" || type === "ClassPrivateMethod")
    && parentKey === "key" && parent.computed !== true) {
    return false;
  }
  if ((type === "LabeledStatement" || type === "BreakStatement" || type === "ContinueStatement")
    && parentKey === "label") {
    return false;
  }
  return !(type === "MetaProperty" && (parentKey === "meta" || parentKey === "property"));
}

export type DirectWorkflowApprovalCompleteness =
  | { ok: true }
  | { kind: "indirection" | "options" | "parse"; message: string; ok: false };

/**
 * Prove that a direct UI approval preview observes every injected call and each
 * behavior-affecting agent option. Headless automation and exact-approved Plans
 * deliberately do not use this policy boundary.
 */
export function validateDirectWorkflowApprovalCompleteness(
  source: string,
): DirectWorkflowApprovalCompleteness {
  const ast = parseWorkflowAst(source);
  if (!ast) {
    return {
      ok: false,
      kind: "parse",
      message: "the workflow script could not be parsed, so its approval preview cannot be proven complete",
    };
  }

  const indirect = new Set<string>();
  collectUnsupportedInjectedReferences(ast, indirect);
  if (indirect.size > 0) {
    return {
      ok: false,
      kind: "indirection",
      message: `unsupported indirect reference to injected workflow global(s): ${[...indirect].sort().join(", ")}`,
    };
  }

  const calls: StaticCall[] = [];
  collectCallsFromAst(ast, source, calls);
  const unsupportedSchema = calls.some(
    (call) => call.name === "agent" && call.agentOptions?.unsupportedSchema,
  );
  if (unsupportedSchema) {
    return {
      ok: false,
      kind: "options",
      message: "agent() opts.schema is no longer supported; workflow children return text/Markdown.",
    };
  }
  const unresolved = calls
    .filter((call) => call.name === "agent")
    .flatMap((call, index) => (call.agentOptions?.unresolved ?? [])
      .map((reason) => `agent call ${index + 1}: ${reason}`));
  if (unresolved.length > 0) {
    return {
      ok: false,
      kind: "options",
      message: `agent options cannot be previewed statically (${unresolved.join("; ")})`,
    };
  }
  return { ok: true };
}

function collectUnsupportedInjectedReferences(
  value: unknown,
  indirect: Set<string>,
  parent?: Record<string, unknown>,
  parentKey?: string,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectUnsupportedInjectedReferences(item, indirect, parent, parentKey);
    return;
  }
  if (value === null || typeof value !== "object") return;

  const node = value as Record<string, unknown>;
  if (node.type === "ThisExpression") indirect.add("this");
  if (node.type === "Identifier" && typeof node.name === "string"
    && (node.name === "globalThis" || CALL_NAMES.has(node.name))
    && isBindingReference(parent, parentKey) && !isSupportedDirectCallee(parent, parentKey)) {
    indirect.add(node.name);
  }
  for (const [key, child] of Object.entries(node)) {
    collectUnsupportedInjectedReferences(child, indirect, node, key);
  }
}

function isSupportedDirectCallee(
  parent: Record<string, unknown> | undefined,
  parentKey: string | undefined,
): boolean {
  return parentKey === "callee"
    && (parent?.type === "CallExpression" || parent?.type === "OptionalCallExpression");
}

/** Recursively guard strings and object keys before rendering structured values. */
export function hasUnsafeControlDeep(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") {
    return HAS_UNSAFE_CONTROL.test(value.replace(/\r\n/g, "\n"));
  }
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasUnsafeControlDeep(item, seen));
  return Object.entries(value).some(
    ([key, child]) => hasUnsafeControlDeep(key, seen) || hasUnsafeControlDeep(child, seen),
  );
}

const RISK_WORDS = /\b(deploy|publish|release|push|merge|delete|destroy|drop|truncate|wipe|send|post|upload|submit|charge|purchase|pay)\b/gi;
const CALL_NAMES = new Set(["agent", "parallel", "pipeline", "phase", "workflow"]);
const BEHAVIOR_OPTION_NAMES = [
  "label",
  "phase",
  "agentType",
  "model",
  "effort",
  "isolation",
  "gate",
  "resume",
] as const;
const BEHAVIOR_OPTION_NAME_SET = new Set<string>(BEHAVIOR_OPTION_NAMES);

type BehaviorOptionName = typeof BEHAVIOR_OPTION_NAMES[number];

type StaticOptionValue =
  | { kind: "absent" }
  | { kind: "static"; value: string }
  | { expression: string; kind: "dynamic" };

interface StaticAgentOptions {
  fields: Record<BehaviorOptionName, StaticOptionValue>;
  unsupportedSchema: boolean;
  unresolved: string[];
}

interface StaticCall {
  agentOptions?: StaticAgentOptions;
  argRanges: StaticRange[];
  end: number;
  name: string;
  parallelBranchRanges?: StaticRange[];
  start: number;
  staticArgs: Array<string | undefined>;
}

interface StaticMapNode {
  call: StaticCall;
  label: string;
  purpose: string | undefined;
}

interface StaticRange {
  end: number;
  start: number;
}

export interface DirectWorkflowApprovalInput {
  args: unknown;
  meta: WorkflowMeta;
  script: string;
  source: string;
}

/**
 * Format an approval view for a direct script without exposing its source.
 *
 * This is deliberately a static behavior summary. Direct scripts may contain
 * loops and branches whose runtime fan-out cannot be known before execution;
 * the summary says so and reports call sites rather than pretending they are
 * exact agent counts.
 */
export function formatDirectWorkflowApproval(input: DirectWorkflowApprovalInput): string {
  const calls = collectStaticCalls(input.script);
  const parallel = calls.filter((call) => call.name === "parallel");
  const pipelines = calls.filter((call) => call.name === "pipeline");
  const agents = calls.filter((call) => call.name === "agent");
  const nested = calls.filter((call) => call.name === "workflow");
  const phaseCalls = calls.filter((call) => call.name === "phase");
  const declaredPhases = input.meta.phases?.map((phase) => phase.title) ?? [];
  const observedPhases = phaseCalls.map((call) => call.staticArgs[0]).filter((value): value is string => value !== undefined);
  const phases = [...new Set([...declaredPhases, ...observedPhases])];
  const risks = [...new Set(`${input.script}\n${safeJson(input.args)}`.match(RISK_WORDS)?.map((word) => word.toLowerCase()) ?? [])];

  const lines = [
    "Technical details",
    `Workflow: ${safeLine(input.meta.name)}`,
    `Description: ${safeLine(input.meta.description)}`,
    `Source: ${safeLine(input.source)}`,
    `Objective: ${safeLine(input.meta.description)}`,
    `Phases: ${phases.map(safeLine).join(" -> ") || "not declared"}`,
    `Orchestration: ${orchestrationSummary(parallel.length, pipelines.length, nested.length)}`,
    "Runtime shape: static call sites are listed below; loops, branches, discovered lists, and nested results may change the number and order of agents at runtime.",
    `Side effects: ${risks.length > 0 ? `potential external/high-impact actions (${risks.map(safeLine).join(", ")})` : "not declared; determined by agent tools and prompts"}`,
    ...workflowMap(calls),
    "Parameters:",
    safeJson(input.args),
    "",
    "Agent call sites:",
  ];

  if (agents.length === 0) lines.push("- none found statically (the script may compute calls dynamically)");
  for (const [index, call] of agents.entries()) {
    const options = call.agentOptions ?? emptyAgentOptions();
    const phase = renderOptionValue(options.fields.phase, ambientPhase(call, phaseCalls) ?? "runtime/default");
    const peers = enclosingCalls(call, parallel).length > 0
      ? "parallel barrier"
      : enclosingCalls(call, pipelines).length > 0
        ? "pipeline stage (items overlap without a stage barrier)"
        : "script order/runtime control flow";
    lines.push(`- ${index + 1}. ${safeLine(renderOptionValue(options.fields.label, `agent call ${index + 1}`))}`);
    lines.push(`  task: ${safeLine(call.staticArgs[0] ?? "dynamic prompt computed at runtime")}`);
    lines.push(`  agentType: ${safeLine(renderOptionValue(options.fields.agentType, "general-purpose"))}`);
    lines.push(`  model: ${safeLine(renderOptionValue(options.fields.model, "inherit"))}`);
    lines.push(`  effort: ${safeLine(renderOptionValue(options.fields.effort, "inherit"))}`);
    lines.push(`  phase: ${safeLine(phase)}`);
    lines.push(`  dependency/parallel relation: ${peers}`);
    lines.push(`  isolation: ${safeLine(renderOptionValue(options.fields.isolation, "none"))}`);
    lines.push(`  gate: ${safeLine(renderOptionValue(options.fields.gate, "none"))}`);
    lines.push(`  resume: ${safeLine(renderOptionValue(options.fields.resume, "none"))}`);
  }

  lines.push("", "Nested workflow calls:");
  if (nested.length === 0) lines.push("- none");
  else {
    for (const call of nested) {
      lines.push(`- ${safeLine(call.staticArgs[0] ?? "dynamic workflow reference")}`);
    }
  }
  lines.push("", "Omitted capabilities:", "- not declared by a direct script");
  lines.push("", "Approval summary", ...directWorkflowOverview(input, calls, risks));
  return lines.join("\n");
}

function directWorkflowOverview(
  input: DirectWorkflowApprovalInput,
  calls: StaticCall[],
  risks: string[],
): string[] {
  const declaredPhases = input.meta.phases ?? [];
  const technicalMap = workflowMap(calls).slice(2)
    .filter((line) => line.trim() !== "v")
    .map((line) => line
      .replace("parallel() [barrier; parallel branches]", "parallel")
      .replace("pipeline() [overlapping per-item stages]", "pipeline")
      .replace("argument evaluation/control order:", "prepare inputs")
      .replace(/ \[output=(?:text|nested workflow result)\]$/, ""));
  const hasStaticNodes = calls.some((call) =>
    call.name === "agent" || call.name === "workflow" || call.name === "parallel" || call.name === "pipeline"
  );
  const flow = hasStaticNodes
    ? ["  Static call sites; runtime branches may skip or reorder them:", ...technicalMap]
    : ["  Steps are determined at runtime."];
  const impacts: string[] = [];
  for (const [index, call] of calls.filter((candidate) => candidate.name === "agent").entries()) {
    const options = call.agentOptions ?? emptyAgentOptions();
    const label = safeLine(renderOptionValue(options.fields.label, `agent call ${index + 1}`));
    if (options.fields.gate.kind !== "absent") {
      impacts.push(`  - ${label}: gate ${safeLine(renderOptionValue(options.fields.gate, "dynamic/unknown"))}`);
    }
    if (options.fields.isolation.kind !== "absent") {
      impacts.push(`  - ${label}: isolation ${safeLine(renderOptionValue(options.fields.isolation, "dynamic/unknown"))}`);
    }
  }
  if (risks.length > 0) impacts.push(`  - Possible high-impact actions: ${risks.map(safeLine).join(", ")}`);
  const lines = [
    "Goal",
    `  ${safeLine(input.meta.description)}`,
  ];
  const phaseLines = declaredPhases.map((phase, index) =>
    `  ${index + 1}. ${safeLine(phase.title)}${phase.detail ? ` — ${safeLine(phase.detail)}` : ""}`
  );
  lines.push(
    "",
    "Flow",
    ...flow,
    ...(phaseLines.length > 0 ? ["", "Declared phases", ...phaseLines] : []),
    "",
    "Result handoff",
    "  The call-site tree shows static control shape, not guaranteed data flow.",
    "  Data handoffs are script-defined and not statically proven.",
    "",
    "Impact",
    ...(impacts.length > 0
      ? impacts
      : ["  No high-impact keywords, gates, or worktree isolation detected; agents may still act through available tools."]),
    "  This is a simplified static view. Exact options and runtime uncertainty are available above.",
  );
  return lines;
}

function orchestrationSummary(parallel: number, pipelines: number, nested: number): string {
  const parts: string[] = [];
  if (parallel > 0) parts.push(`${parallel} parallel barrier call site${parallel === 1 ? "" : "s"}`);
  if (pipelines > 0) parts.push(`${pipelines} pipeline call site${pipelines === 1 ? "" : "s"}`);
  if (nested > 0) parts.push(`${nested} nested workflow call site${nested === 1 ? "" : "s"}`);
  return parts.join("; ") || "sequential/dynamic script control flow";
}

function workflowMap(calls: StaticCall[]): string[] {
  const agents = calls.filter((call) => call.name === "agent");
  const mapCalls = calls.filter((call) =>
    call.name === "agent" || call.name === "workflow" || call.name === "parallel" || call.name === "pipeline"
  );
  const nodes = new Map<StaticCall, StaticMapNode>();
  for (const call of mapCalls) {
    if (call.name === "agent") {
      const agentIndex = agents.indexOf(call);
      const options = call.agentOptions ?? emptyAgentOptions();
      nodes.set(call, {
        call,
        label: renderOptionValue(options.fields.label, `agent call ${agentIndex + 1}`),
        purpose: call.staticArgs[0],
      });
    } else if (call.name === "workflow") {
      nodes.set(call, {
        call,
        label: `workflow: ${call.staticArgs[0] ?? "dynamic workflow reference"}`,
        purpose: "nested workflow call",
      });
    }
  }
  const roots = mapCalls.filter((call) => enclosingCalls(call, mapCalls).length === 0);
  const lines = [
    "Workflow map (execution/control order; based on static call sites; runtime fan-out/control flow may differ):",
    "Handoffs: script-defined; handoff not statically proven.",
  ];
  if (roots.length === 0) {
    lines.push("  (no static nodes found; runtime calls may still occur)");
    return lines;
  }

  for (const [index, call] of roots.entries()) {
    if (index > 0) lines.push("     v");
    lines.push(...renderMapCall(call, `  ${index + 1}. `, "     ", "", mapCalls, nodes));
  }
  return lines;
}

function renderMapCall(
  call: StaticCall,
  prefix: string,
  childIndent: string,
  label: string,
  calls: StaticCall[],
  nodes: Map<StaticCall, StaticMapNode>,
): string[] {
  const node = nodes.get(call);
  if (node) {
    const argumentRoots = callsInArgumentOrder(call, calls);
    if (argumentRoots.length === 0) return [`${prefix}${label}${renderMapNode(node)}`];

    const lines = [`${prefix}${label}argument evaluation/control order:`];
    for (const [index, root] of argumentRoots.entries()) {
      if (index > 0) lines.push(`${childIndent}       v`);
      lines.push(...renderMapCall(root, `${childIndent}+-- `, `${childIndent}    `, "", calls, nodes));
    }
    lines.push(`${childIndent}       v`);
    lines.push(`${childIndent}+-- ${renderMapNode(node)}`);
    return lines;
  }

  const pipeline = call.name === "pipeline";
  const lines = [
    `${prefix}${label}${call.name}() [${pipeline ? "overlapping per-item stages" : "barrier; parallel branches"}]`,
  ];
  const regions = pipeline ? call.argRanges.slice(1) : parallelBranchRanges(call);
  if (regions.length === 0) {
    lines.push(`${childIndent}+-- (no static callbacks found)`);
    return lines;
  }

  for (const [index, region] of regions.entries()) {
    const regionLabel = pipeline ? `stage ${index + 1}` : `branch ${index + 1}`;
    const roots = callsInRange(region, calls);
    if (roots.length === 0) {
      lines.push(`${childIndent}+-- ${regionLabel}: (no static nodes found; callback computed at runtime)`);
      continue;
    }
    if (roots.length === 1) {
      const root = roots[0];
      const nestedLabel = pipeline || root.name === "parallel" || root.name === "pipeline" ? `${regionLabel}: ` : "";
      lines.push(...renderMapCall(root, `${childIndent}+-- `, `${childIndent}    `, nestedLabel, calls, nodes));
      continue;
    }

    lines.push(`${childIndent}+-- ${regionLabel} [callback control flow; handoff not proven]`);
    for (const [rootIndex, root] of roots.entries()) {
      if (rootIndex > 0) lines.push(`${childIndent}       v`);
      lines.push(...renderMapCall(root, `${childIndent}    +-- `, `${childIndent}        `, "", calls, nodes));
    }
  }
  return lines;
}

function parallelBranchRanges(call: StaticCall): StaticRange[] {
  if (call.parallelBranchRanges) return call.parallelBranchRanges;
  const range = call.argRanges[0];
  return range ? [range] : [];
}

function callsInRange(range: StaticRange, calls: StaticCall[]): StaticCall[] {
  const contained = calls.filter((call) => call.start >= range.start && call.end <= range.end);
  return contained.filter((call) => enclosingCalls(call, contained).length === 0);
}

function callsInArgumentOrder(call: StaticCall, calls: StaticCall[]): StaticCall[] {
  const candidates = calls.filter((candidate) => candidate !== call);
  const roots: StaticCall[] = [];
  const seen = new Set<StaticCall>();
  for (const range of call.argRanges) {
    for (const root of callsInRange(range, candidates)) {
      if (seen.has(root)) continue;
      seen.add(root);
      roots.push(root);
    }
  }
  return roots;
}

function renderMapNode(node: StaticMapNode): string {
  const output = node.call.name === "agent" ? "text" : "nested workflow result";
  return `[${safeLine(node.label)}] ${compactMapText(node.purpose, "dynamic prompt computed at runtime")} [output=${output}]`;
}

function compactMapText(value: string | undefined, fallback: string): string {
  const text = safeLine(value ?? fallback).replace(/\s+/g, " ").trim();
  return text.length <= 88 ? text : `${text.slice(0, 85)}...`;
}

function ambientPhase(call: StaticCall, phases: StaticCall[]): string | undefined {
  let selected: string | undefined;
  for (const phase of phases) {
    if (phase.start >= call.start) break;
    selected = phase.staticArgs[0] ?? selected;
  }
  return selected;
}

function enclosingCalls(call: StaticCall, containers: StaticCall[]): StaticCall[] {
  return containers.filter((container) => container.start < call.start && container.end > call.end);
}

function unicodeEscape(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

function safeLine(value: string): string {
  return value.replace(SINGLE_LINE_CONTROL, (character) => {
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    return unicodeEscape(character);
  });
}

function safeJson(value: unknown): string {
  if (value === undefined) return "(none)";
  try {
    return JSON.stringify(value, null, 2).replace(UNSAFE_CONTROL, unicodeEscape);
  } catch {
    return "(not JSON-serializable)";
  }
}

function emptyAgentOptions(): StaticAgentOptions {
  return {
    fields: Object.fromEntries(
      BEHAVIOR_OPTION_NAMES.map((name) => [name, { kind: "absent" as const }]),
    ) as Record<BehaviorOptionName, StaticOptionValue>,
    unsupportedSchema: false,
    unresolved: [],
  };
}

function renderOptionValue(option: StaticOptionValue, fallback: string): string {
  if (option.kind === "static") return option.value;
  return option.kind === "dynamic" ? "dynamic/unknown" : fallback;
}

function staticStringFromNode(value: unknown): string | undefined {
  const node = astRecord(value);
  if (node?.type === "StringLiteral" && typeof node.value === "string") return node.value;
  if (node?.type !== "TemplateLiteral" || !Array.isArray(node.expressions)
    || node.expressions.length > 0 || !Array.isArray(node.quasis) || node.quasis.length !== 1) {
    return undefined;
  }
  const quasi = astRecord(node.quasis[0]);
  const cooked = astRecord(quasi?.value)?.cooked;
  return typeof cooked === "string" ? cooked : undefined;
}

function staticPropertyName(node: Record<string, unknown>): string | undefined {
  if (node.computed === true) return undefined;
  const key = astRecord(node.key);
  if (key?.type === "Identifier" && typeof key.name === "string") return key.name;
  if (key?.type === "StringLiteral" && typeof key.value === "string") return key.value;
  return undefined;
}

function sourceForNode(value: unknown, source: string): string {
  const range = astRange(value);
  return range ? source.slice(range.start, range.end).trim() : "unknown expression";
}

function collectAgentOptions(argumentNodes: unknown[], source: string): StaticAgentOptions {
  const options = emptyAgentOptions();
  if (argumentNodes.some((argument) => astRecord(argument)?.type === "SpreadElement")) {
    options.unresolved.push("spread arguments can hide the prompt or options object");
    return options;
  }
  if (argumentNodes.length < 2) return options;

  const object = astRecord(argumentNodes[1]);
  if (object?.type !== "ObjectExpression" || !Array.isArray(object.properties)) {
    options.unresolved.push("the second argument is not an object literal");
    return options;
  }

  for (const propertyValue of object.properties) {
    const property = astRecord(propertyValue);
    if (!property) {
      options.unresolved.push("an option property has no static syntax node");
      continue;
    }
    if (property.type === "SpreadElement") {
      options.unresolved.push("an object spread can hide or override behavior options");
      continue;
    }
    if (property.type !== "ObjectProperty") {
      options.unresolved.push("an option method cannot be previewed as data");
      continue;
    }
    if (property.computed === true) {
      options.unresolved.push("a computed option key can hide or override behavior options");
      continue;
    }
    if (property.shorthand === true) {
      options.unresolved.push("a shorthand option property cannot be previewed faithfully");
      continue;
    }

    const key = staticPropertyName(property);
    if (!key) continue;
    if (key === "__proto__") {
      options.unresolved.push("a literal __proto__ property can change the options object's prototype");
      continue;
    }
    if (BEHAVIOR_OPTION_NAME_SET.has(key)) {
      const optionName = key as BehaviorOptionName;
      const value = staticStringFromNode(property.value);
      if (value === undefined) {
        options.fields[optionName] = {
          kind: "dynamic",
          expression: sourceForNode(property.value, source),
        };
        options.unresolved.push(`behavior option ${JSON.stringify(key)} has a dynamic value`);
      } else {
        options.fields[optionName] = { kind: "static", value };
      }
      continue;
    }
    if (key === "schema") options.unsupportedSchema = true;
  }
  return options;
}

function parseWorkflowAst(source: string): unknown | undefined {
  try {
    return parse(source, {
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch {
    return undefined;
  }
}

function collectStaticCalls(source: string): StaticCall[] {
  const ast = parseWorkflowAst(source);
  if (!ast) return [];

  const calls: StaticCall[] = [];
  collectCallsFromAst(ast, source, calls);
  return calls.sort((left, right) => left.start - right.start);
}

function collectCallsFromAst(value: unknown, source: string, calls: StaticCall[]): void {
  if (Array.isArray(value)) {
    for (const child of value) collectCallsFromAst(child, source, calls);
    return;
  }
  if (value === null || typeof value !== "object") return;

  const node = value as Record<string, unknown>;
  const call = staticCallFromNode(node, source);
  if (call) calls.push(call);
  for (const child of Object.values(node)) collectCallsFromAst(child, source, calls);
}

function staticCallFromNode(node: Record<string, unknown>, source: string): StaticCall | undefined {
  if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") return undefined;
  const callee = astRecord(node.callee);
  if (callee?.type !== "Identifier" || typeof callee.name !== "string" || !CALL_NAMES.has(callee.name)) {
    return undefined;
  }
  const range = astRange(node);
  if (!range || !Array.isArray(node.arguments)) return undefined;

  const argumentNodes = node.arguments;
  const argRanges = argumentNodes.map(astRange).filter((argument): argument is StaticRange => argument !== undefined);
  if (argRanges.length !== argumentNodes.length) return undefined;

  // `agent?.()` still directly invokes the injected identifier when it exists.
  // Member callees such as `object.agent()` are excluded by the Identifier check above.
  const firstArgument = astRecord(argumentNodes[0]);
  const parallelBranchRanges = callee.name === "parallel" && firstArgument?.type === "ArrayExpression"
    && Array.isArray(firstArgument.elements)
    ? firstArgument.elements.map(astRange).filter((element): element is StaticRange => element !== undefined)
    : undefined;
  return {
    name: callee.name,
    start: range.start,
    end: range.end,
    staticArgs: argumentNodes.map(staticStringFromNode),
    argRanges,
    parallelBranchRanges,
    ...(callee.name === "agent" ? { agentOptions: collectAgentOptions(argumentNodes, source) } : {}),
  };
}

function astRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function astRange(value: unknown): StaticRange | undefined {
  const node = astRecord(value);
  return node && typeof node.start === "number" && typeof node.end === "number"
    ? { start: node.start, end: node.end }
    : undefined;
}
