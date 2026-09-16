import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SYNTHETIC_ACCESS = "pi-subagents-local-gate";

function kimiHome(env: NodeJS.ProcessEnv, home = homedir()): string {
  const configured = env.KIMI_CODE_HOME?.trim();
  return configured || join(home, ".kimi-code");
}

function credentialsPath(env: NodeJS.ProcessEnv, home = homedir()): string {
  return join(kimiHome(env, home), "credentials", "kimi-code.json");
}

function configPath(env: NodeJS.ProcessEnv, home = homedir()): string {
  return join(kimiHome(env, home), "config.toml");
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function hasAccessToken(token: Record<string, unknown>): boolean {
  return typeof token.access_token === "string" && token.access_token.trim().length > 0;
}

function isSynthetic(token: Record<string, unknown>): boolean {
  return token._pi_subagents_synthetic === true || token.access_token === SYNTHETIC_ACCESS;
}

function hasConfiguredApiKey(path: string, env: NodeJS.ProcessEnv): boolean {
  if (env.KIMI_MODEL_API_KEY?.trim()) return true;
  if (!existsSync(path)) return false;
  try {
    const text = readFileSync(path, "utf8");
    return [...text.matchAll(/^\s*api_key\s*=\s*"([^"]*)"\s*$/gm)]
      .some(match => match[1].trim().length > 0);
  } catch {
    return false;
  }
}

/** Reuse a real Kimi Code login; seed the ACP gate only for an actual API-key configuration. */
export function prepareKimiCodeAuth(env: NodeJS.ProcessEnv = process.env, home = homedir()): void {
  const path = credentialsPath(env, home);
  const existing = existsSync(path) ? readJson(path) : undefined;
  if (existing && hasAccessToken(existing) && !isSynthetic(existing)) return;
  if (!hasConfiguredApiKey(configPath(env, home), env)) {
    if (existing && isSynthetic(existing)) rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({
    access_token: SYNTHETIC_ACCESS,
    refresh_token: "",
    expires_at: 9_999_999_999,
    expires_in: 9_999_999,
    scope: "",
    token_type: "Bearer",
    _pi_subagents_synthetic: true,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
