import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import { buildAgentRegistry, resolveSpawnTypeIn } from "../agent-types.js";
import { inChildSessionContext } from "../child-context.js";
import { loadCustomAgents } from "../custom-agents.js";
import { resolveModel } from "../model-resolver.js";
import { sanitizeArtifactText } from "../result-artifact.js";
import type { AgentConfig } from "../types.js";
import { selectItem } from "../ui/select-item.js";
import { profileGuidance } from "./prompt.js";

export const PROFILE_ENTRY_TYPE = "subagents:profile";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Baseline = { model: { provider: string; id: string }; thinking: ReturnType<ExtensionAPI["getThinkingLevel"]> };
interface ProfileState { name: string | null; baseline?: Baseline }

function readProfile(name: string, cwd: string): AgentConfig {
  const registry = buildAgentRegistry(loadCustomAgents(cwd));
  const resolved = resolveSpawnTypeIn(registry, name);
  if (!resolved.ok) throw new Error(resolved.message);
  const agent = registry.get(resolved.type)!;
  if (agent.thinking !== undefined && !THINKING_LEVELS.some(level => level === agent.thinking)) {
    throw new Error(`${agent.sourcePath}: invalid thinking level ${JSON.stringify(agent.thinking)}`);
  }
  return agent;
}

export function registerProfiles(pi: ExtensionAPI): void {
  if (inChildSessionContext()) return;
  let state: ProfileState = { name: null };
  let profile: AgentConfig | undefined;
  let loadError: string | undefined;
  let switching = false;
  let closed = false;
  let skills: readonly Skill[] = [];
  const warned = new Set<string>();

  function report(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
    if (ctx.hasUI) ctx.ui.notify(sanitizeArtifactText(text), level);
    else console.warn(`[pi-subagents] ${sanitizeArtifactText(text)}`);
  }

  function status(ctx: ExtensionContext): void {
    if (ctx.hasUI) ctx.ui.setStatus("subagents:profile", state.name === null ? undefined
      : sanitizeArtifactText(`profile: ${state.name}${loadError ? " (unavailable)" : ""}`));
  }

  function describe(ctx: ExtensionContext, detail = false): string {
    return `Profile: ${state.name ?? "off"}${loadError ? ` (unavailable: ${loadError})` : ""}\n`
      + `Actual model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}; thinking: ${pi.getThinkingLevel()}\n`
      + `Baseline: ${state.baseline ? `${state.baseline.model.provider}/${state.baseline.model.id}; thinking: ${state.baseline.thinking}` : "not captured"}`
      + (profile && detail ? `\nAgent source: ${profile.source} — ${profile.sourcePath}\nDefaults: model ${profile.model ?? "baseline"}; thinking ${profile.thinking ?? "baseline"}\n`
        + "Not applied to the main session: tools, disallowed_tools, extensions, exclude_extensions, isolated, isolation, max_turns, memory, allowed_subagents, inherit_context, run_in_background, persist_session, output_transcript, session_dir, prompt_mode (always append).\n"
        + profileGuidance(profile, skills).text : "");
  }

  function restore(ctx: ExtensionContext, fresh = false): void {
    state = { name: null };
    profile = undefined;
    loadError = undefined;
    skills = [];
    warned.clear();
    if (!fresh) {
      const entry = ctx.sessionManager.getBranch().slice().reverse().find(item => item.type === "custom" && item.customType === PROFILE_ENTRY_TYPE);
      if (entry?.type === "custom") {
        try {
          const data = entry.data as Partial<ProfileState> | undefined;
          if (!data || (data.name !== null && (typeof data.name !== "string" || !data.name.trim()))) throw new Error("Invalid saved profile state");
          state = { name: data.name };
          if (data.baseline !== undefined) {
            const baseline = data.baseline;
            if (!baseline || typeof baseline.model?.provider !== "string" || !baseline.model.provider.trim()
              || typeof baseline.model.id !== "string" || !baseline.model.id.trim()
              || !THINKING_LEVELS.some(level => level === baseline.thinking)) throw new Error("Invalid saved profile baseline");
            state.baseline = { model: { provider: baseline.model.provider, id: baseline.model.id }, thinking: baseline.thinking };
          }
          if (state.name !== null) {
            if (!state.baseline) throw new Error("Saved profile has no baseline");
            profile = readProfile(state.name, ctx.cwd);
          }
        } catch (error) {
          loadError = error instanceof Error ? error.message : String(error);
          report(ctx, `Cannot restore profile ${JSON.stringify(state.name)}: ${loadError}. No profile prompt applied; model/thinking unchanged.`, "warning");
        }
      }
    }
    // The host restores persisted /model and thinking changes. Never reapply the profile route here.
    status(ctx);
  }

  pi.on("session_start", (event, ctx) => { closed = false; restore(ctx, event.reason === "new"); });
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", (_event, ctx) => { closed = true; if (ctx.hasUI) ctx.ui.setStatus("subagents:profile", undefined); });
  const guardTransition = (_event: unknown, ctx: ExtensionContext) => {
    if (!switching) return;
    report(ctx, "Profile switch in progress; retry the session transition after it finishes.", "warning");
    return { cancel: true };
  };
  pi.on("session_before_switch", guardTransition);
  pi.on("session_before_fork", guardTransition);
  pi.on("session_before_tree", guardTransition);

  pi.on("before_agent_start", (event, ctx) => {
    skills = event.systemPromptOptions.skills ?? [];
    if (!profile) return;
    const guidance = profileGuidance(profile, skills);
    for (const warning of guidance.warnings) {
      if (warned.has(warning)) continue;
      warned.add(warning);
      report(ctx, warning, "warning");
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${guidance.text}` };
  });

  async function activate(name: string | null, ctx: ExtensionContext): Promise<void> {
    if (closed || !ctx.isIdle()) throw new Error("Profile switching requires an idle session.");
    const next = name === null ? undefined : readProfile(name, ctx.cwd);
    if (!next && !state.baseline) {
      if (state.name !== null) throw new Error("Cannot restore baseline: saved profile baseline is invalid or missing. Model/thinking unchanged.");
      pi.appendEntry(PROFILE_ENTRY_TYPE, { name: null });
      state = { name: null };
      profile = next;
      loadError = undefined;
      status(ctx);
      return;
    }
    const originalModel = ctx.model;
    if (!originalModel) throw new Error("Select a model before enabling a profile; no restorable baseline model exists.");
    const originalThinking = pi.getThinkingLevel();
    const baseline = state.baseline ?? {
      model: { provider: originalModel.provider, id: originalModel.id }, thinking: originalThinking,
    };
    const target: ExtensionContext["model"] | string = next?.model
      ? resolveModel(next.model, ctx.modelRegistry)
      : ctx.modelRegistry.find(baseline.model.provider, baseline.model.id);
    if (typeof target === "string") throw new Error(target);
    if (!target) throw new Error(`Baseline model is unavailable: ${baseline.model.provider}/${baseline.model.id}.`);
    if (!next?.model && (target.provider !== baseline.model.provider || target.id !== baseline.model.id)) {
      throw new Error("Host did not resolve the exact baseline model. Model/thinking unchanged.");
    }
    if (next?.model?.includes("/") && target.provider.toLowerCase() !== next.model.slice(0, next.model.indexOf("/")).toLowerCase()) {
      throw new Error(`Profile model ${next.model} resolved to ${target.provider}/${target.id}. No provider fallback is allowed.`);
    }
    const thinking = next?.thinking ?? baseline.thinking;
    try {
      if (ctx.model?.provider !== target.provider || ctx.model.id !== target.id) {
        if (!await pi.setModel(target)) throw new Error(`Could not select ${target.provider}/${target.id}: authentication unavailable.`);
      }
      if (closed || !ctx.isIdle()) throw new Error("Session changed or became busy during profile switching.");
      if (ctx.model?.provider !== target.provider || ctx.model.id !== target.id) throw new Error("Host did not select the requested profile model.");
      pi.setThinkingLevel(thinking);
      const nextState: ProfileState = next ? { name: next.name, baseline } : { name: null };
      pi.appendEntry(PROFILE_ENTRY_TYPE, nextState);
      state = nextState;
      profile = next;
      loadError = undefined;
      warned.clear();
    } catch (error) {
      const rollbackErrors: string[] = [];
      try {
        if (ctx.model?.provider !== originalModel.provider || ctx.model.id !== originalModel.id) {
          if (!await pi.setModel(originalModel)) throw new Error("model rollback refused");
        }
        if (ctx.model?.provider !== originalModel.provider || ctx.model.id !== originalModel.id) throw new Error("model rollback did not restore the original model");
      } catch (rollback) { rollbackErrors.push(String(rollback)); }
      try {
        pi.setThinkingLevel(originalThinking);
        if (pi.getThinkingLevel() !== originalThinking) throw new Error("thinking rollback was clamped");
      } catch (rollback) { rollbackErrors.push(String(rollback)); }
      status(ctx);
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n`
        + (rollbackErrors.length ? `Rollback incomplete: ${rollbackErrors.join("; ")}.\n` : "Previous route restored.\n")
        + describe(ctx));
    }
    status(ctx);
    if (pi.getThinkingLevel() !== thinking) report(ctx, `Profile requested thinking ${thinking}; host applied ${pi.getThinkingLevel()}.`, "warning");
  }

  pi.registerCommand("profile", {
    description: "Select a profile, or use <name>, show/status, list, off/default",
    handler: async (args, ctx) => {
      const command = args.trim();
      skills = ctx.getSystemPromptOptions().skills ?? [];
      if (command === "show" || command === "status") { report(ctx, describe(ctx, true)); return; }
      if (switching) { report(ctx, "Profile switch already in progress.", "warning"); return; }
      switching = true;
      try {
        if (command === "list" || !command) {
          if (!command && !ctx.isIdle()) throw new Error("Profile switching requires an idle session.");
          const catalogue = [...buildAgentRegistry(loadCustomAgents(ctx.cwd)).values()].filter(agent => agent.enabled !== false);
          if (command === "list") {
            report(ctx, catalogue.map(item => `${item.name}${item.name === state.name ? " (active)" : ""}: ${item.description} — ${item.sourcePath}`).join("\n") || "No agents configured. Use /agents to create one.");
            return;
          }
          if (!ctx.hasUI) throw new Error("The profile picker requires a UI; use /profile <name> instead.");
          const chosen = await selectItem(ctx.ui, "Profile", [{ name: null, description: "off (restore baseline)" }, ...catalogue], item =>
            sanitizeArtifactText(item.name === null ? item.description : `${item.name}${item.name === state.name ? " (active)" : ""}: ${item.description}`));
          if (!chosen) return;
          await activate(chosen.name, ctx);
        } else {
          const explicit = /^use\s+/.test(command);
          const name = explicit ? command.replace(/^use\s+/, "").trim() : command;
          await activate(!explicit && (name === "off" || name === "default") ? null : name, ctx);
        }
        report(ctx, describe(ctx));
      } catch (error) { report(ctx, error instanceof Error ? error.message : String(error), "error"); }
      finally { switching = false; }
    },
  });
}
