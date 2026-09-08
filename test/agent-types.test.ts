import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_TOOL_NAMES, buildAgentRegistry, getAgentConfig, getAllTypes, getAvailableTypes,
  getConfig, getDefaultAgent, getMemoryToolNames, getReadOnlyMemoryToolNames,
  getToolNamesForType, isValidType, registerAgents, resolveEnabledTypeIn,
  resolveSpawnType, resolveSpawnTypeIn, resolveType, setDefaultAgent,
} from "../src/agent-types.js";
import { resolveAgentInvocationConfig } from "../src/invocation-config.js";
import type { AgentConfig } from "../src/types.js";

const scout: AgentConfig = {
  name: "scout", description: "User scout", builtinToolNames: ["read", "bash"],
  extensions: true, skills: ["git-review"], systemPrompt: "Investigate.", promptMode: "append",
};

beforeEach(() => { registerAgents(new Map()); setDefaultAgent(undefined); });
afterEach(() => { registerAgents(new Map()); setDefaultAgent(undefined); });

describe("user-defined agent registry", () => {
  it("starts empty and never manufactures the former built-ins", () => {
    expect(getAvailableTypes()).toEqual([]);
    for (const name of ["Explorer", "Worker", "Reviewer", "Explore", "Plan", "general-purpose"]) {
      expect(getAgentConfig(name)).toBeUndefined();
      expect(isValidType(name)).toBe(false);
      expect(resolveSpawnType(name).ok).toBe(false);
      expect(() => getToolNamesForType(name)).toThrow("Unknown or disabled agent type");
    }
    expect(getConfig("Worker")).toMatchObject({ builtinToolNames: [], extensions: false, skills: false });
  });

  it("registers only supplied definitions and honors their capabilities", () => {
    registerAgents(new Map([[scout.name, scout]]));
    expect(getAvailableTypes()).toEqual(["scout"]);
    expect(resolveType("SCOUT")).toBe("scout");
    expect(getAgentConfig("SCOUT")).toBe(scout);
    expect(getToolNamesForType("SCOUT")).toEqual(["read", "bash"]);
    expect(getConfig("scout")).toMatchObject({ extensions: true, skills: ["git-review"], promptMode: "append" });
    registerAgents(new Map());
    expect(getAvailableTypes()).toEqual([]);
  });

  it("lets users define former role names without preset restrictions", () => {
    registerAgents(new Map([["Reviewer", { ...scout, name: "Reviewer", builtinToolNames: undefined }]]));
    expect(getToolNamesForType("Reviewer")).toEqual(BUILTIN_TOOL_NAMES);
    expect(getConfig("Reviewer").extensions).toBe(true);
  });

  it("preserves explicit zero tools and extension selection", () => {
    registerAgents(new Map([["quiet", { ...scout, name: "quiet", builtinToolNames: [], extensions: ["mcp"] }]]));
    expect(getToolNamesForType("quiet")).toEqual([]);
    expect(getConfig("quiet").extensions).toEqual(["mcp"]);
  });

  it("retains disabled definitions for management but rejects their execution", () => {
    registerAgents(new Map([[scout.name, { ...scout, enabled: false }]]));
    expect(getAllTypes()).toEqual(["scout"]);
    expect(getAvailableTypes()).toEqual([]);
    expect(isValidType("scout")).toBe(false);
    expect(resolveSpawnType("scout").ok).toBe(false);
    expect(() => getToolNamesForType("scout")).toThrow();
  });

  it("copies a branch registry without changing the main registry", () => {
    const input = new Map([[scout.name, scout]]);
    const branch = buildAgentRegistry(input);
    branch.clear();
    expect(input.size).toBe(1);
    expect(getAvailableTypes()).toEqual([]);
    expect(resolveSpawnTypeIn(input, "SCOUT")).toEqual({ ok: true, type: "scout" });
  });

  it("does not confuse model defaults with user pins", () => {
    expect(resolveAgentInvocationConfig(scout, { model: "provider/chosen", thinking: "high" }))
      .toMatchObject({ modelInput: "provider/chosen", thinking: "high" });
    expect(resolveAgentInvocationConfig({ ...scout, model: "provider/pinned" }, { model: "provider/chosen" }))
      .toMatchObject({ modelInput: "provider/pinned", modelFromParams: false });
  });
});

describe("strict dispatch", () => {
  it("reports setup instructions for an empty installation", () => {
    const result = resolveSpawnType("missing");
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining(".pi/agents/") });
    expect(result).toMatchObject({ message: expect.stringContaining("Available: (none)") });
  });

  it("never uses the workflow default for unknown, disabled, or missing types", () => {
    registerAgents(new Map([[scout.name, scout], ["disabled", { ...scout, name: "disabled", enabled: false }]]));
    setDefaultAgent("scout");
    expect(getDefaultAgent()).toBe("scout");
    for (const name of ["typo", "disabled", "", "   ", undefined]) {
      expect(resolveSpawnType(name).ok).toBe(false);
    }
  });

  it("accepts exact matches but refuses ambiguous case variants", () => {
    const registry = new Map([["scout", scout], ["Scout", { ...scout, name: "Scout" }]]);
    registerAgents(registry);
    expect(resolveSpawnType("scout")).toEqual({ ok: true, type: "scout" });
    expect(resolveSpawnType("SCOUT").ok).toBe(false);
    expect(resolveEnabledTypeIn(registry, "SCOUT")).toBeUndefined();
  });

  it("normalizes the explicit default without inventing one", () => {
    expect(getDefaultAgent()).toBeUndefined();
    setDefaultAgent(" scout ");
    expect(getDefaultAgent()).toBe("scout");
    setDefaultAgent("");
    expect(getDefaultAgent()).toBeUndefined();
  });
});

describe("tool helpers", () => {
  it("derives a deduplicated built-in set from pi", () => {
    expect(BUILTIN_TOOL_NAMES).toEqual(expect.arrayContaining(["read", "bash", "write", "edit", "grep", "find", "ls"]));
    expect(new Set(BUILTIN_TOOL_NAMES).size).toBe(BUILTIN_TOOL_NAMES.length);
  });
  it("adds only missing memory tools without escalating read-only memory", () => {
    expect(getMemoryToolNames(new Set())).toEqual(["read", "write", "edit"]);
    expect(getMemoryToolNames(new Set(["read", "edit"]))).toEqual(["write"]);
    expect(getMemoryToolNames(new Set(["read", "write", "edit"]))).toEqual([]);
    expect(getReadOnlyMemoryToolNames(new Set())).toEqual(["read"]);
    expect(getReadOnlyMemoryToolNames(new Set(["read"]))).toEqual([]);
  });
});
