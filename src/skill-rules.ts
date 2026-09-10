/** Name filters for already-discovered skills, not filesystem permissions. */
export type SkillNameRule = { allow: string[]; deny?: never } | { deny: string[]; allow?: never };

export function parseSkillNameRule(value: unknown): SkillNameRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("skills: expected a rule object");
  const keys = Object.keys(value);
  if (keys.length !== 1 || (keys[0] !== "allow" && keys[0] !== "deny")) {
    throw new Error("skills: expected exactly one of allow or deny, with no other keys");
  }
  const field = keys[0];
  const patterns = (value as Record<string, unknown>)[field];
  if (!Array.isArray(patterns) || !patterns.every(pattern => typeof pattern === "string")) {
    throw new Error(`skills.${field}: expected an array of strings`);
  }
  if (patterns.length > 256 || patterns.some(pattern => !pattern.trim() || pattern.length > 256 || /[\u0000-\u001f\u007f]/.test(pattern))) {
    throw new Error(`skills.${field}: at most 256 non-empty patterns of at most 256 characters, without control characters`);
  }
  return field === "allow" ? { allow: [...patterns] } : { deny: [...patterns] };
}

/** Full-name, case-sensitive Unicode glob: only * and ? are special. */
export function matchesSkillName(name: string, pattern: string): boolean {
  // Dynamic programming avoids regex injection and exponential backtracking.
  const tokens = [...pattern];
  const row = [true, ...tokens.map(() => false)];
  for (let i = 1; i <= tokens.length; i++) row[i] = row[i - 1] && tokens[i - 1] === "*";
  for (const character of name) {
    let diagonal = row[0];
    row[0] = false;
    for (let i = 1; i <= tokens.length; i++) {
      const above = row[i];
      const token = tokens[i - 1];
      row[i] = token === "*" ? above || row[i - 1] : diagonal && (token === "?" || token === character);
      diagonal = above;
    }
  }
  return row[tokens.length];
}

export function isSkillNameAllowed(name: string, rule: SkillNameRule): boolean {
  if (rule.allow !== undefined) return rule.allow.some(pattern => matchesSkillName(name, pattern));
  return !rule.deny.some(pattern => matchesSkillName(name, pattern));
}
