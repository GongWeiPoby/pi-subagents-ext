import { describe, expect, it } from "vitest";
import { isSkillNameAllowed, matchesSkillName, parseSkillNameRule } from "../src/skill-rules.js";

describe("skill name globs", () => {
  it.each([
    ["research", "research", true], ["Research", "research", false], ["pre-research", "research", false],
    ["", "*", true], ["", "?", false], ["ab", "?", false], ["研究", "??", true], ["\u{20000}", "?", true],
    ["ab", "a*b", true], ["acccb", "a*b", true], ["abcc", "a*b", false], ["ab", "a**b", true],
    ["a.b", "a.b", true], ["axb", "a.b", false], ["[ab]", "[ab]", true], ["a", "[ab]", false],
    ["a", "{a,b}", false], ["foo", "!foo", false], ["a+b(c)|^$\\", "a+b(c)|^$\\", true], ["a\n", "a", false],
  ])("matches %j with %j as %s", (name, pattern, expected) => {
    expect(matchesSkillName(name, pattern)).toBe(expected);
  });
  it("handles repeated wildcards and preserves empty allow/deny semantics", () => {
    expect(matchesSkillName("a".repeat(2000), `${"*a".repeat(100)}b`)).toBe(false);
    expect(isSkillNameAllowed("writer", { allow: [] })).toBe(false);
    expect(isSkillNameAllowed("writer", { deny: [] })).toBe(true);
    expect(isSkillNameAllowed("writer", { allow: ["writ*"] })).toBe(true);
    expect(isSkillNameAllowed("writer", { deny: ["writ*"] })).toBe(false);
  });
  it.each([null, [], "*", { allow: undefined, deny: [] }, { allow: ["a\n"] }, { allow: Array(257).fill("x") }])("strictly rejects %j", value => {
    expect(() => parseSkillNameRule(value)).toThrow("skills");
  });
});
