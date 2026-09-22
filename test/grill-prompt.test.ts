/**
 * grill-prompt.test.ts — the shipped `/grill` prompt template, actually parsed.
 *
 * `prompts/grill.md` is registered as a slash command through `pi.prompts` in
 * package.json, and the filename *is* the command name. A malformed or missing
 * frontmatter block drops the command silently — from the author's point of
 * view the command simply never appears. Nothing else guards this file.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const PROMPT_PATH = fileURLToPath(new URL("../prompts/grill.md", import.meta.url));
const MANIFEST_PATH = fileURLToPath(new URL("../package.json", import.meta.url));

describe("grill prompt template", () => {
  const content = readFileSync(PROMPT_PATH, "utf-8");
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);

  it("declares the description that makes it discoverable", () => {
    expect(typeof frontmatter.description).toBe("string");
    expect((frontmatter.description as string).length).toBeGreaterThan(0);
  });

  it("is registered as a prompt in the pi manifest", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
    expect(manifest.pi?.prompts).toContain("./prompts");
  });

  it("carries both disciplines inline, so it needs no other skill installed", () => {
    // The upstream `grill-with-docs` delegates to `grilling` + `domain-modeling`;
    // inlining them here is the whole point of the port.
    expect(body).toContain("# Grilling");
    expect(body).toContain("# Domain Modeling");
    expect(body).toContain("CONTEXT.md");
    expect(body).toContain("docs/adr/");
  });

  it("asks a round and stops, rather than dumping every question at once", () => {
    expect(body).toContain("frontier");
    expect(body).toMatch(/wait for the user's answers/i);
  });

  it("keeps the glossary free of implementation detail", () => {
    expect(body).toMatch(/implementation details/i);
  });
});
