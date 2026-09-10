import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, SessionManager, type Skill } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAvailableTypes, getConfig, registerAgents } from "../src/agent-types.js";
import { runInChildSessionContext } from "../src/child-context.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { PROFILE_ENTRY_TYPE, registerProfiles } from "../src/profiles/index.js";
import { profileGuidance } from "../src/profiles/prompt.js";
import type { AgentConfig } from "../src/types.js";

type Hook = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
const models: Model<"openai-completions">[] = ["base", "novel-4-5", "manual"].map(id => ({
  id, provider: "test", name: id, api: "openai-completions", baseUrl: "https://invalid.example",
  reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000,
}));
const skills: Skill[] = ["writer", "web-search", "manual-only"].map(name => ({
  name, description: `${name} description`, filePath: `/never/read/${name}/SKILL.md`, baseDir: `/never/read/${name}`,
  sourceInfo: { path: `/never/read/${name}`, source: "test", scope: "user", origin: "top-level" },
  disableModelInvocation: name === "manual-only",
}));
let directory: string;

function harness() {
  const hooks = new Map<string, Hook>();
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  let model: ExtensionContext["model"] = models[0];
  let thinking: ReturnType<ExtensionAPI["getThinkingLevel"]> = "low";
  let idle = true;
  const manager = SessionManager.inMemory(directory);
  const notify = vi.fn();
  const select = vi.fn(async (_title: string, options: string[]) => options[1]);
  const setStatus = vi.fn();
  const setModel = vi.fn(async (next: NonNullable<ExtensionContext["model"]>) => { model = next; return true; });
  const setThinkingLevel = vi.fn((level: typeof thinking) => { thinking = level; });
  const appendEntry = vi.fn((type: string, data: unknown) => { manager.appendCustomEntry(type, data); });
  const registerTool = vi.fn();
  const pi = {
    on: (event: string, hook: Hook) => hooks.set(event, hook), registerTool,
    registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, options.handler),
    setModel, setThinkingLevel, appendEntry, getThinkingLevel: () => thinking,
  } as unknown as ExtensionAPI;
  const ctx = {
    get model() { return model; },
    modelRegistry: {
      find: (provider: string, id: string) => models.find(candidate => candidate.provider === provider && candidate.id === id),
      getAvailable: () => models, getAll: () => models,
    },
    hasUI: true, mode: "tui", cwd: directory, sessionManager: manager, isIdle: () => idle,
    ui: { notify, select, setStatus }, getSystemPromptOptions: () => ({ cwd: directory, skills }),
  } as unknown as ExtensionCommandContext;
  registerProfiles(pi);
  return {
    hooks, commands, registerTool, pi, ctx, manager, notify, select, setStatus, setModel, setThinkingLevel, appendEntry,
    event: (type: string, payload: Record<string, unknown> = {}) => hooks.get(type)?.({ type, ...payload }, ctx),
    turn: (base = "base", loaded = skills) => hooks.get("before_agent_start")?.({ systemPrompt: base, systemPromptOptions: { skills: loaded } }, ctx) as { systemPrompt: string } | undefined,
    command: (args: string) => commands.get("profile")!(args, ctx),
    manual: () => {
      model = models[2]; thinking = "medium";
      manager.appendModelChange("test", "manual"); manager.appendThinkingLevelChange(thinking);
    },
    busy: () => { idle = false; }, noModel: () => { model = undefined; },
  };
}

function profile(name = "novel", config: Record<string, unknown> = {}, prompt = "Novel instructions") {
  const dir = join(directory, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  writeFileSync(path, `---\n${Object.entries(config).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n${prompt}`);
  return path;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-profile-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
});
afterEach(() => {
  registerAgents(new Map()); vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("profile guidance", () => {
  it.each<[AgentConfig["skills"], string[]]>([
    [true, ["writer", "web-search"]], [false, []], [["writer"], ["writer"]], [["writ*"], []],
    [{ allow: ["writ??"] }, ["writer"]], [{ deny: ["web-*"] }, ["writer"]],
    [{ allow: [] }, []], [{ deny: [] }, ["writer", "web-search"]],
  ])("uses only eligible loaded metadata for %j", (selection, expected) => {
    profile("novel", { skills: selection });
    const result = profileGuidance(loadCustomAgents(directory).get("novel")!, skills);
    for (const skill of skills) expect(result.text.includes(skill.filePath)).toBe(expected.includes(skill.name));
    expect(result.text).toContain("not permissions");
    expect(result.text).toContain("native skill list, completion");
    expect(result.text).toContain("Novel instructions");
  });

  it("appends once to the current event, caches agent files, updates skill metadata and warns once", async () => {
    const path = profile("novel", { skills: { allow: ["writer", "absent"] }, prompt_mode: "replace" });
    const h = harness(); await h.command("novel");
    const entries = h.manager.getEntries().length;
    rmSync(path);
    expect(h.turn("global + project + extension")?.systemPrompt).toMatch(/^global \+ project \+ extension\n\n/);
    const second = h.turn("updated base", [])!.systemPrompt;
    expect(second).toMatch(/^updated base\n\n/);
    expect(second.match(/Novel instructions/g)).toHaveLength(1);
    expect(second).not.toContain(skills[0].filePath);
    expect(h.notify.mock.calls.filter(call => String(call[0]).includes('pattern "absent"'))).toHaveLength(1);
    expect(h.manager.getEntries()).toHaveLength(entries);
    expect(h.setModel).not.toHaveBeenCalled();
  });
});

describe("profile selection and routing", () => {
  it("uses Agent identity, exact/unambiguous case matching and never mutates the global registry", async () => {
    profile("file", { name: "Code Reviewer" }); profile("Case"); profile("case"); profile("disabled", { enabled: false });
    registerAgents(new Map());
    const h = harness(); await h.command("code reviewer");
    expect(h.manager.getBranch().at(-1)).toMatchObject({ data: { name: "Code Reviewer" } });
    for (const name of ["CASE", "disabled", "unknown"]) {
      await h.command(name);
      expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("Unknown or disabled"), "error");
    }
    await h.command("Case");
    expect(h.manager.getBranch().at(-1)).toMatchObject({ data: { name: "Case" } });
    expect(getAvailableTypes()).toEqual([]);
  });

  it("preserves rule objects through the Agent display/config view", () => {
    const rule = { allow: ["web-*"] };
    profile("novel", { skills: rule }); registerAgents(loadCustomAgents(directory));
    expect(getConfig("novel").skills).toEqual(rule);
  });

  it.each(["off", "default", "show", "status", "list", "use"])("use escapes a real agent named %s", async name => {
    profile(name); const h = harness(); await h.command(`use ${name}`);
    expect(h.manager.getBranch().at(-1)).toMatchObject({ data: { name } });
    await h.command("off");
    expect(h.manager.getBranch().at(-1)).toMatchObject({ data: { name: null } });
  });

  it("lists/picks enabled agents and shows source, guidance and unapplied fields", async () => {
    const path = profile("novel", { tools: "none", isolated: true, max_turns: 1 });
    profile("disabled", { enabled: false });
    const h = harness(); await h.command("list");
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining(path), "info");
    expect(String(h.notify.mock.lastCall?.[0])).not.toContain("disabled");
    await h.command(""); await h.command("show");
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("Agent source: project"), "info");
    for (const text of [path, "Not applied", "tools", "isolated", "max_turns", skills[0].filePath]) {
      expect(String(h.notify.mock.lastCall?.[0])).toContain(text);
    }
    expect(h.registerTool).not.toHaveBeenCalled();
  });

  it("applies fuzzy defaults once, inherits omissions from baseline and off releases baseline", async () => {
    profile("novel", { model: "test/novel-4.5-20250101", thinking: "high" }); profile("research");
    const h = harness(); await h.command("novel");
    expect(h.ctx.model?.id).toBe("novel-4-5"); expect(h.pi.getThinkingLevel()).toBe("high");
    expect(h.manager.getBranch().at(-1)).toMatchObject({ data: { baseline: { model: { provider: "test", id: "base" }, thinking: "low" } } });
    h.manual(); h.turn(); expect(h.ctx.model?.id).toBe("manual");
    await h.command("research"); expect(h.ctx.model?.id).toBe("base"); expect(h.pi.getThinkingLevel()).toBe("low");
    await h.command("novel"); await h.command("off");
    expect(h.ctx.model?.id).toBe("base"); expect(h.turn()).toBeUndefined();
    expect(h.setStatus).toHaveBeenLastCalledWith(PROFILE_ENTRY_TYPE, undefined);
    h.manual(); await h.command("research"); await h.command("off"); expect(h.ctx.model?.id).toBe("manual");
  });

  it("rejects cross-provider fallback, unavailable models, invalid thinking/rules and busy switches", async () => {
    profile("wrong", { model: "other/novel" }); profile("missing", { model: "unavailable" });
    profile("bad", { thinking: "turbo" }); profile("rule", { skills: { allow: [], deny: [] } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness(); await h.command("wrong");
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("No provider fallback"), "error");
    for (const name of ["missing", "bad", "rule"]) await h.command(name);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("rule.md"));
    profile(); h.busy(); await h.command("novel");
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("idle"), "error");
    expect(h.setModel).not.toHaveBeenCalled(); expect(h.appendEntry).not.toHaveBeenCalled();
  });

  it("requires a restorable model and reports host clamping", async () => {
    profile("novel", { thinking: "max" }); const h = harness();
    h.setThinkingLevel.mockImplementationOnce(() => {}); await h.command("novel");
    expect(h.notify).toHaveBeenCalledWith("Profile requested thinking max; host applied low.", "warning");
    h.noModel(); await h.command("novel");
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("no restorable baseline"), "error");
  });

  it("does not release the profile when its captured baseline cannot be restored", async () => {
    profile("novel", { model: "novel" }); const h = harness(); await h.command("novel");
    vi.spyOn(h.ctx.modelRegistry, "find").mockReturnValue(undefined);
    await h.command("off");
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("Baseline model is unavailable"), "error");
    expect(h.ctx.model?.id).toBe("novel-4-5"); expect(h.turn()?.systemPrompt).toContain("Novel instructions");
  });

  it("rejects a host model-selection no-op and a session shutdown during switching", async () => {
    profile("novel", { model: "novel" }); const h = harness();
    h.setModel.mockResolvedValueOnce(true); await h.command("novel");
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("Host did not select"), "error");
    h.setModel.mockImplementationOnce(async () => { h.event("session_shutdown"); return true; });
    await h.command("novel");
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("Session changed or became busy"), "error");
    expect(h.manager.getEntries()).toEqual([]);
  });

  it("handles an empty catalogue, picker cancellation, and a headless explicit selection", async () => {
    const h = harness(); await h.command("list");
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("No agents configured"), "info");
    await h.command(""); expect(h.manager.getEntries()).toEqual([]);
    h.ctx.hasUI = false; const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await h.command(""); expect(warn).toHaveBeenLastCalledWith(expect.stringContaining("requires a UI"));
    profile(); await h.command("novel"); expect(h.turn()?.systemPrompt).toContain("Novel instructions");
  });

  it("rolls back model/thinking/persistence failures and retains the previous profile", async () => {
    profile("research"); profile("novel", { model: "novel", thinking: "high" });
    const h = harness(); await h.command("research"); const previous = h.manager.getBranch();
    h.setModel.mockResolvedValueOnce(false); await h.command("novel");
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("authentication unavailable"), "error");
    h.setThinkingLevel.mockImplementationOnce(() => { throw new Error("thinking failed"); }); await h.command("novel");
    h.appendEntry.mockImplementationOnce(() => { throw new Error("entry failed"); }); await h.command("novel");
    expect(h.ctx.model?.id).toBe("base"); expect(h.pi.getThinkingLevel()).toBe("low");
    expect(h.manager.getBranch()).toEqual(previous); expect(h.turn()?.systemPrompt).toContain("Profile: research");
  });

  it("reports actual route on incomplete rollback", async () => {
    profile("novel", { model: "novel", thinking: "high" }); const h = harness();
    h.setThinkingLevel.mockImplementationOnce(() => { h.setModel.mockResolvedValueOnce(false); throw new Error("failed"); });
    await h.command("novel");
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("Rollback incomplete"), "error");
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("Actual model: test/novel-4-5"), "error");
    expect(h.manager.getEntries()).toEqual([]);
  });

  it("serializes picker switches, cancels transitions, and rechecks idle after the picker", async () => {
    profile(); const h = harness(); let finish!: (value: string) => void;
    h.select.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = h.command(""); await h.command("off");
    expect(h.notify).toHaveBeenLastCalledWith("Profile switch already in progress.", "warning");
    for (const event of ["session_before_switch", "session_before_fork", "session_before_tree"]) expect(h.event(event)).toEqual({ cancel: true });
    h.busy(); finish("2. novel: novel"); await pending;
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("idle"), "error");
    expect(h.manager.getEntries()).toEqual([]);
  });
});

describe("profile session state", () => {
  it.each(["reload", "resume", "fork", "startup"])("restores prompt, not persisted manual model, on %s", async reason => {
    profile("novel", { model: "novel" }); const h = harness(); await h.command("novel"); h.manual();
    h.setModel.mockClear(); h.setThinkingLevel.mockClear(); await h.event("session_start", { reason });
    expect(h.ctx.model?.id).toBe("manual"); expect(h.pi.getThinkingLevel()).toBe("medium");
    expect(h.setModel).not.toHaveBeenCalled(); expect(h.setThinkingLevel).not.toHaveBeenCalled();
    expect(h.turn()?.systemPrompt).toContain("Novel instructions"); await h.command("default"); expect(h.ctx.model?.id).toBe("base");
  });

  it("reads only the active branch and starts new sessions off", async () => {
    profile(); const h = harness(); const before = h.manager.appendCustomEntry("unrelated", {});
    await h.command("novel"); h.manager.branch(before); await h.event("session_tree"); expect(h.turn()).toBeUndefined();
    await h.command("novel"); await h.event("session_start", { reason: "new" }); expect(h.turn()).toBeUndefined();
  });

  it.each(["deleted", "disabled", "invalid"])("rereads edits and reports %s restoration without changing the model", async failure => {
    const path = profile(); const h = harness(); await h.command("novel");
    profile("novel", {}, "Revised instructions"); await h.event("session_start", { reason: "reload" });
    expect(h.turn()?.systemPrompt).toContain("Revised instructions");
    if (failure === "deleted") rmSync(path);
    else profile("novel", failure === "disabled" ? { enabled: false } : { thinking: "invalid" });
    h.manual(); await h.event("session_start", { reason: "resume" });
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining('Cannot restore profile "novel"'), "warning");
    expect(h.ctx.model?.id).toBe("manual"); expect(h.turn()).toBeUndefined();
    expect(h.setStatus).toHaveBeenLastCalledWith(PROFILE_ENTRY_TYPE, "profile: novel (unavailable)");
    await h.command("off"); expect(h.ctx.model?.id).toBe("base");
  });

  it("rejects invalid saved state instead of inventing a baseline", async () => {
    profile(); const h = harness(); h.manager.appendCustomEntry(PROFILE_ENTRY_TYPE, { name: "novel", baseline: { model: null } });
    await h.event("session_start"); expect(h.turn()).toBeUndefined();
    await h.command("off"); expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("Cannot restore baseline"), "error");
    expect(h.setModel).not.toHaveBeenCalled();
  });

  it("registers nothing in child sessions", async () => {
    const h = await runInChildSessionContext(async () => harness());
    expect(h.registerTool).not.toHaveBeenCalled(); expect(h.commands.size).toBe(0); expect(h.hooks.size).toBe(0);
  });
});
