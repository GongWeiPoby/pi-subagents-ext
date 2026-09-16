import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareKimiCodeAuth } from "../src/acp/kimi-auth.js";

describe("prepareKimiCodeAuth", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it("does nothing without a usable Kimi config", () => {
    const home = mkdtempSync(join(tmpdir(), "pi-kimi-empty-"));
    homes.push(home);
    prepareKimiCodeAuth({}, home);
    expect(existsSync(join(home, ".kimi-code", "credentials", "kimi-code.json"))).toBe(false);
  });

  it("seeds a local gate token when config.toml has a non-empty API key", () => {
    const home = mkdtempSync(join(tmpdir(), "pi-kimi-config-"));
    homes.push(home);
    mkdirSync(join(home, ".kimi-code"));
    writeFileSync(join(home, ".kimi-code", "config.toml"), '[providers.moonshot]\napi_key = "sk-test"\n');
    prepareKimiCodeAuth({}, home);
    const token = JSON.parse(readFileSync(join(home, ".kimi-code", "credentials", "kimi-code.json"), "utf8"));
    expect(token._pi_subagents_synthetic).toBe(true);
    expect(token.access_token).toBe("pi-subagents-local-gate");
  });

  it("does not seed a token for an OAuth provider with an empty API key", () => {
    const home = mkdtempSync(join(tmpdir(), "pi-kimi-oauth-"));
    homes.push(home);
    mkdirSync(join(home, ".kimi-code"));
    writeFileSync(join(home, ".kimi-code", "config.toml"), `
      default_model = "kimi-code/k3-256k"
      [providers."managed:kimi-code"]
      api_key = ""
      [providers."managed:kimi-code".oauth]
      storage = "file"
      key = "oauth/kimi-code"
    `);
    prepareKimiCodeAuth({}, home);
    expect(existsSync(join(home, ".kimi-code", "credentials", "kimi-code.json"))).toBe(false);
  });

  it("removes its synthetic token when the config switches back to OAuth", () => {
    const home = mkdtempSync(join(tmpdir(), "pi-kimi-oauth-cleanup-"));
    homes.push(home);
    const path = join(home, ".kimi-code", "credentials", "kimi-code.json");
    mkdirSync(join(home, ".kimi-code", "credentials"), { recursive: true });
    writeFileSync(path, JSON.stringify({
      access_token: "pi-subagents-local-gate",
      refresh_token: "",
      _pi_subagents_synthetic: true,
    }));
    writeFileSync(join(home, ".kimi-code", "config.toml"), 'api_key = ""\n');
    prepareKimiCodeAuth({}, home);
    expect(existsSync(path)).toBe(false);
  });

  it("does not overwrite a real login token", () => {
    const home = mkdtempSync(join(tmpdir(), "pi-kimi-real-"));
    homes.push(home);
    const path = join(home, ".kimi-code", "credentials", "kimi-code.json");
    mkdirSync(join(home, ".kimi-code", "credentials"), { recursive: true });
    writeFileSync(path, JSON.stringify({ access_token: "real-oauth-token" }));
    mkdirSync(join(home, ".kimi-code"), { recursive: true });
    writeFileSync(join(home, ".kimi-code", "config.toml"), "api_key = \"sk-test\"\n");
    prepareKimiCodeAuth({}, home);
    expect(JSON.parse(readFileSync(path, "utf8")).access_token).toBe("real-oauth-token");
  });
});
