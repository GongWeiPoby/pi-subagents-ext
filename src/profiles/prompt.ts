import type { Skill } from "@earendil-works/pi-coding-agent";
import { isSkillNameAllowed, matchesSkillName } from "../skill-rules.js";
import type { AgentConfig } from "../types.js";

/** Metadata only: never reads SKILL.md or alters pi's native skill catalogue. */
export function profileGuidance(profile: AgentConfig, skills: readonly Skill[]): { text: string; warnings: string[] } {
  const selection = profile.skills;
  const rule = typeof selection === "object" && !Array.isArray(selection) ? selection : undefined;
  const patterns = rule ? rule.allow ?? rule.deny : Array.isArray(selection) ? selection : [];
  const warnings = patterns
    .filter(pattern => !skills.some(skill => rule ? matchesSkillName(skill.name, pattern) : skill.name === pattern))
    .map(pattern => `Profile ${profile.name}: skill pattern ${JSON.stringify(pattern)} matched no loaded skill.`);
  const recommended = skills.filter(skill => !skill.disableModelInvocation && selection !== false
    && (rule ? isSkillNameAllowed(skill.name, rule) : !Array.isArray(selection) || selection.includes(skill.name)));
  const lines = [
    `## Profile: ${profile.name}`,
    profile.systemPrompt,
    "## Profile skill usage guidance",
    "This is usage guidance, not permissions or security isolation. It does not hide or disable pi's native skill list, completion, /skill commands, or read access. Global and project instructions still apply.",
    "Prefer these skills when relevant; read their exact filePath on demand, not all skill bodies in advance. Skills marked manual-only by pi remain manual-only.",
    `Recommendation selection: ${JSON.stringify(selection)}`,
    recommended.length ? "Recommended loaded skills (metadata only):" : "No skills recommended by this profile; skill functionality is still enabled.",
    ...recommended.map(({ name, description, filePath }) => JSON.stringify({ name, description, filePath })),
    ...warnings.map(warning => `WARNING: ${warning}`),
  ];
  return { text: lines.join("\n\n"), warnings };
}
