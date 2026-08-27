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
  if (node.type === "Identifier" && node.name === "workflow" && isBindingReference(parent, parentKey)) {
    return true;
  }
  return Object.entries(node).some(([key, child]) => containsWorkflowReference(child, node, key));
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

interface StaticCall {
  args: string[];
  end: number;
  name: string;
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
  const calls = scanCalls(input.script);
  const parallel = calls.filter((call) => call.name === "parallel");
  const pipelines = calls.filter((call) => call.name === "pipeline");
  const agents = calls.filter((call) => call.name === "agent");
  const nested = calls.filter((call) => call.name === "workflow");
  const phaseCalls = calls.filter((call) => call.name === "phase");
  const declaredPhases = input.meta.phases?.map((phase) => phase.title) ?? [];
  const observedPhases = phaseCalls.map((call) => staticString(call.args[0])).filter((value): value is string => value !== undefined);
  const phases = [...new Set([...declaredPhases, ...observedPhases])];
  const risks = [...new Set(`${input.script}\n${safeJson(input.args)}`.match(RISK_WORDS)?.map((word) => word.toLowerCase()) ?? [])];

  const lines = [
    `Workflow: ${safeLine(input.meta.name)}`,
    `Description: ${safeLine(input.meta.description)}`,
    `Source: ${safeLine(input.source)}`,
    `Objective: ${safeLine(input.meta.description)}`,
    `Phases: ${phases.map(safeLine).join(" -> ") || "not declared"}`,
    `Orchestration: ${orchestrationSummary(parallel.length, pipelines.length, nested.length)}`,
    "Runtime shape: static call sites are listed below; loops, branches, discovered lists, and nested results may change the number and order of agents at runtime.",
    `Side effects: ${risks.length > 0 ? `potential external/high-impact actions (${risks.map(safeLine).join(", ")})` : "not declared; determined by agent tools and prompts"}`,
    "Parameters:",
    safeJson(input.args),
    "",
    "Agent call sites:",
  ];

  if (agents.length === 0) lines.push("- none found statically (the script may compute calls dynamically)");
  for (const [index, call] of agents.entries()) {
    const options = objectOptions(call.args[1]);
    const phase = options.phase ?? ambientPhase(call, phaseCalls) ?? "runtime/default";
    const peers = enclosingCalls(call, parallel).length > 0
      ? "parallel barrier"
      : enclosingCalls(call, pipelines).length > 0
        ? "pipeline stage (items overlap without a stage barrier)"
        : "script order/runtime control flow";
    lines.push(`- ${index + 1}. ${safeLine(options.label ?? `agent call ${index + 1}`)}`);
    lines.push(`  task: ${safeLine(staticString(call.args[0]) ?? "dynamic prompt computed at runtime")}`);
    lines.push(`  agentType: ${safeLine(options.agentType ?? "general-purpose")}`);
    lines.push(`  model: ${safeLine(options.model ?? "inherit")}`);
    lines.push(`  effort: ${safeLine(options.effort ?? "inherit")}`);
    lines.push(`  phase: ${safeLine(phase)}`);
    lines.push(`  dependency/parallel relation: ${peers}`);
    lines.push(`  isolation: ${safeLine(options.isolation ?? "none")}`);
    lines.push(`  gate: ${safeLine(options.gate ?? "none")}`);
    lines.push(`  structured output: ${hasObjectOption(call.args[1], "schema") ? "configured" : "none"}`);
    lines.push(`  resume: ${safeLine(options.resume ?? "none")}`);
  }

  lines.push("", "Nested workflow calls:");
  if (nested.length === 0) lines.push("- none");
  else {
    for (const call of nested) {
      lines.push(`- ${safeLine(staticString(call.args[0]) ?? "dynamic workflow reference")}`);
    }
  }
  lines.push("", "Omitted capabilities:", "- not declared by a direct script");
  return lines.join("\n");
}

function orchestrationSummary(parallel: number, pipelines: number, nested: number): string {
  const parts: string[] = [];
  if (parallel > 0) parts.push(`${parallel} parallel barrier call site${parallel === 1 ? "" : "s"}`);
  if (pipelines > 0) parts.push(`${pipelines} pipeline call site${pipelines === 1 ? "" : "s"}`);
  if (nested > 0) parts.push(`${nested} nested workflow call site${nested === 1 ? "" : "s"}`);
  return parts.join("; ") || "sequential/dynamic script control flow";
}

function ambientPhase(call: StaticCall, phases: StaticCall[]): string | undefined {
  let selected: string | undefined;
  for (const phase of phases) {
    if (phase.start >= call.start) break;
    selected = staticString(phase.args[0]) ?? selected;
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

function objectOptions(source: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!source) return out;
  const trimmed = source.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return out;
  for (const field of splitTopLevel(trimmed.slice(1, -1))) {
    const colon = topLevelColon(field);
    if (colon < 0) continue;
    const key = field.slice(0, colon).trim().replace(/^['"]|['"]$/g, "");
    if (!["label", "phase", "agentType", "model", "effort", "isolation", "gate", "resume"].includes(key)) continue;
    const value = staticString(field.slice(colon + 1));
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function hasObjectOption(source: string | undefined, wanted: string): boolean {
  if (!source) return false;
  const trimmed = source.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  return splitTopLevel(trimmed.slice(1, -1)).some((field) => {
    const colon = topLevelColon(field);
    return colon >= 0 && field.slice(0, colon).trim().replace(/^['"]|['"]$/g, "") === wanted;
  });
}

function topLevelColon(source: string): number {
  const positions = delimiterPositions(source, ":");
  return positions[0] ?? -1;
}

function splitTopLevel(source: string): string[] {
  const positions = delimiterPositions(source, ",");
  const result: string[] = [];
  let start = 0;
  for (const position of positions) {
    result.push(source.slice(start, position).trim());
    start = position + 1;
  }
  result.push(source.slice(start).trim());
  return result.filter(Boolean);
}

function delimiterPositions(source: string, delimiter: string): number[] {
  const positions: number[] = [];
  let braces = 0;
  let brackets = 0;
  let parens = 0;
  let mode: "code" | "single" | "double" | "template" = "code";
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (mode !== "code") {
      if (char === "\\") index++;
      else if ((mode === "single" && char === "'") || (mode === "double" && char === '"') || (mode === "template" && char === "`")) mode = "code";
      continue;
    }
    if (char === "'") { mode = "single"; continue; }
    if (char === '"') { mode = "double"; continue; }
    if (char === "`") { mode = "template"; continue; }
    if (char === "{") braces++;
    else if (char === "}") braces--;
    else if (char === "[") brackets++;
    else if (char === "]") brackets--;
    else if (char === "(") parens++;
    else if (char === ")") parens--;
    else if (char === delimiter && braces === 0 && brackets === 0 && parens === 0) positions.push(index);
  }
  return positions;
}

function staticString(source: string | undefined): string | undefined {
  const value = source?.trim();
  if (!value) return undefined;
  const quote = value[0];
  if ((quote !== "'" && quote !== '"' && quote !== "`") || value.at(-1) !== quote) return undefined;
  if (quote === "`" && /\$\{/.test(value)) return undefined;
  const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
  let output = "";
  for (let index = 1; index < value.length - 1; index++) {
    const char = value[index];
    if (char !== "\\") { output += char; continue; }
    const escaped = value[++index];
    if (escaped === undefined) return undefined;
    if (escaped === "x") {
      const hex = value.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return undefined;
      output += String.fromCharCode(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    if (escaped === "u") {
      if (value[index + 1] === "{") {
        const close = value.indexOf("}", index + 2);
        const hex = close < 0 ? "" : value.slice(index + 2, close);
        const codePoint = Number.parseInt(hex, 16);
        if (!/^[0-9A-Fa-f]{1,6}$/.test(hex) || codePoint > 0x10ffff) return undefined;
        output += String.fromCodePoint(codePoint);
        index = close;
        continue;
      }
      const hex = value.slice(index + 1, index + 5);
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return undefined;
      output += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
      continue;
    }
    if (escaped === "\n") continue;
    if (escaped === "\r") {
      if (value[index + 1] === "\n") index++;
      continue;
    }
    output += simple[escaped] ?? escaped;
  }
  return output;
}

function scanCalls(source: string): StaticCall[] {
  const calls: StaticCall[] = [];
  let index = 0;
  while (index < source.length) {
    const skipped = skipNonCode(source, index);
    if (skipped !== index) { index = skipped; continue; }
    if (!/[A-Za-z_$]/.test(source[index] ?? "")) { index++; continue; }
    const start = index;
    index++;
    while (/[A-Za-z0-9_$]/.test(source[index] ?? "")) index++;
    const name = source.slice(start, index);
    if (!CALL_NAMES.has(name)) continue;
    const open = skipWhitespaceAndComments(source, index);
    if (source[open] !== "(") continue;
    const end = matchingParen(source, open);
    if (end < 0) continue;
    calls.push({ name, start, end: end + 1, args: splitTopLevel(source.slice(open + 1, end)) });
  }
  return calls.sort((left, right) => left.start - right.start);
}

function skipWhitespaceAndComments(source: string, from: number): number {
  let index = from;
  for (;;) {
    while (/\s/.test(source[index] ?? "")) index++;
    if (source.startsWith("//", index)) {
      index = source.indexOf("\n", index + 2);
      if (index < 0) return source.length;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      return end < 0 ? source.length : skipWhitespaceAndComments(source, end + 2);
    }
    return index;
  }
}

function skipNonCode(source: string, index: number): number {
  if (source.startsWith("//", index)) {
    const end = source.indexOf("\n", index + 2);
    return end < 0 ? source.length : end + 1;
  }
  if (source.startsWith("/*", index)) {
    const end = source.indexOf("*/", index + 2);
    return end < 0 ? source.length : end + 2;
  }
  const quote = source[index];
  if (quote !== "'" && quote !== '"' && quote !== "`") return index;
  index++;
  while (index < source.length) {
    if (source[index] === "\\") { index += 2; continue; }
    if (source[index] === quote) return index + 1;
    index++;
  }
  return source.length;
}

function matchingParen(source: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < source.length) {
    const skipped = skipNonCode(source, index);
    if (skipped !== index) { index = skipped; continue; }
    if (source[index] === "(") depth++;
    else if (source[index] === ")") {
      depth--;
      if (depth === 0) return index;
    }
    index++;
  }
  return -1;
}
