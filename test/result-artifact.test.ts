import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionTaskDir } from "../src/output-file.js";
import {
  canonicalJson,
  type ResultArtifactManifest,
  readResultArtifactBody,
  sanitizeArtifactText,
  writeResultArtifact,
} from "../src/result-artifact.js";

const ARTIFACT_ID = "agent-attempt-12345678";

function input(taskDir: string, overrides: Record<string, unknown> = {}) {
  return {
    taskDir,
    artifactId: ARTIFACT_ID,
    agentId: "agent-1",
    status: "completed" as const,
    startedAt: 1_000,
    completedAt: 2_000,
    invocation: "spawn" as const,
    usage: {
      turns: 2,
      toolCalls: 3,
      tokens: { input: 10, output: 5, cacheWrite: 1, cacheRead: 4, cost: 0.01 },
    },
    modelId: "provider/model",
    thinking: "high",
    result: "final answer",
    includeBody: true,
    ...overrides,
  };
}

describe("result artifact writer", () => {
  let taskDir: string;

  beforeEach(() => {
    taskDir = mkdtempSync(join(tmpdir(), "pi-result-artifact-"));
  });

  afterEach(() => rmSync(taskDir, { recursive: true, force: true }));

  it("writes canonical owner-only files with a verifiable body digest", () => {
    const written = writeResultArtifact(input(taskDir, {
      result: "line 1\r\nline\t2\u001b[31m\u0085\u202Ehidden",
    }));
    const manifest = JSON.parse(readFileSync(written.manifestPath, "utf-8")) as ResultArtifactManifest;
    const body = readFileSync(written.bodyPath!, "utf-8");

    expect(body).toBe("line 1\nline\t2[31mhidden\n");
    expect(manifest.resultBodyPath).toBe(basename(written.bodyPath!));
    expect(manifest.resultDigest).toBe(
      `sha256:${createHash("sha256").update(body).digest("hex")}`,
    );
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      artifactId: ARTIFACT_ID,
      producer: { kind: "agent", scope: "top-level", invocation: "spawn" },
      artifactStatus: "complete",
      usage: { turns: 2, toolCalls: 3 },
    });
    expect(readFileSync(written.manifestPath, "utf-8")).toBe(canonicalJson(manifest));
    expect(written.manifestPath).not.toContain("final answer");

    if (process.platform !== "win32") {
      expect(statSync(dirname(written.manifestPath)).mode & 0o777).toBe(0o700);
      expect(statSync(written.manifestPath).mode & 0o777).toBe(0o600);
      expect(statSync(written.bodyPath!).mode & 0o777).toBe(0o600);
    }
  });

  it("writes a minimal manifest and no body when persistence privacy opts out", () => {
    const written = writeResultArtifact(input(taskDir, {
      includeBody: false,
      result: "must stay in memory",
      modelId: "provider/\u001bmodel\u202E",
      error: "bad\u0000\u009ferror",
    }));
    const manifestText = readFileSync(written.manifestPath, "utf-8");
    const manifest = JSON.parse(manifestText) as ResultArtifactManifest;

    expect(written.bodyPath).toBeUndefined();
    expect(manifest.resultBodyPath).toBeUndefined();
    expect(manifest.resultDigest).toBeUndefined();
    expect(manifest.artifactStatus).toBe("metadata-only");
    expect(manifestText).not.toContain("must stay in memory");
    expect(manifestText).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202E]/);
  });

  it("is idempotent and never clobbers an existing attempt", () => {
    const first = writeResultArtifact(input(taskDir, { result: "first" }));
    const second = writeResultArtifact(input(taskDir, { result: "replacement" }));

    expect(second).toEqual(first);
    expect(readFileSync(first.bodyPath!, "utf-8")).toBe("first\n");
    expect(readFileSync(first.manifestPath, "utf-8")).not.toContain("replacement");
    expect(existsSync(join(dirname(first.manifestPath), "replacement"))).toBe(false);
  });

  it("preserves a pre-existing target in an incomplete attempt directory", () => {
    const artifactDir = join(taskDir, "results", ARTIFACT_ID);
    const bodyPath = join(artifactDir, `${ARTIFACT_ID}.md`);
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(bodyPath, "existing winner\n");

    const written = writeResultArtifact(input(taskDir, { result: "replacement" }));

    expect(written.status).toBe("failed");
    expect(written.error).toContain("manifest is missing");
    expect(readFileSync(bodyPath, "utf-8")).toBe("existing winner\n");
  });

  it("rejects invalid or overlong internal identifiers before creating results", () => {
    for (const artifactId of ["../escape", "a/b", "..", `a${"x".repeat(128)}`, "bad\u0000id"]) {
      expect(() => writeResultArtifact(input(taskDir, { artifactId }))).toThrow("invalid artifact id");
    }
    expect(existsSync(join(taskDir, "results"))).toBe(false);
  });

  it("fails closed for non-directory result path components", () => {
    writeFileSync(join(taskDir, "results"), "not a directory");
    expect(() => writeResultArtifact(input(taskDir))).toThrow("invalid results directory");
  });

  it.skipIf(process.platform === "win32")("fails closed for symlinked task and artifact directories", () => {
    const target = mkdtempSync(join(tmpdir(), "pi-result-artifact-target-"));
    const linkedTask = join(taskDir, "linked-task");
    symlinkSync(target, linkedTask, "dir");
    expect(() => writeResultArtifact(input(linkedTask))).toThrow("invalid task directory");

    const resultsDir = join(taskDir, "results");
    mkdirSync(resultsDir);
    const linkedArtifact = join(resultsDir, ARTIFACT_ID);
    symlinkSync(target, linkedArtifact, "dir");
    expect(() => writeResultArtifact(input(taskDir))).toThrow("invalid artifact directory");
    rmSync(target, { recursive: true, force: true });
  });

  it("reports a damaged complete artifact as failed instead of trusting it", () => {
    const first = writeResultArtifact(input(taskDir, { result: "original" }));
    writeFileSync(first.bodyPath!, "tampered\n");

    const second = writeResultArtifact(input(taskDir, { result: "replacement" }));

    expect(second.status).toBe("failed");
    expect(second.bodyPath).toBeUndefined();
    expect(second.error).toContain("body digest mismatch");
  });

  it("reports malformed manifests as failed", () => {
    const first = writeResultArtifact(input(taskDir));
    const parsed = JSON.parse(readFileSync(first.manifestPath, "utf-8")) as Record<string, unknown>;
    parsed.status = "not-a-status";
    writeFileSync(first.manifestPath, JSON.stringify(parsed));

    const second = writeResultArtifact(input(taskDir));

    expect(second).toMatchObject({ manifestPath: first.manifestPath, status: "failed" });
    expect(second.error).toContain("invalid manifest");
  });

  it("stores only a bounded, single-line provider error summary", () => {
    const longError = `${"provider failure ".repeat(100)}\nsecond line\u001b[31m`;
    const written = writeResultArtifact(input(taskDir, { includeBody: false, error: longError }));
    const manifest = JSON.parse(readFileSync(written.manifestPath, "utf-8")) as ResultArtifactManifest;

    expect(manifest.error).toBeDefined();
    expect(manifest.error!.length).toBeLessThanOrEqual(512);
    expect(manifest.error).not.toContain("second line");
    expect(manifest.error).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u202E]/);
  });
  it("preserves ordinary tabs and newlines while removing control and bidi characters", () => {
    expect(sanitizeArtifactText("a\tb\r\nc\u001b\u0085\u061C\u200F\u2069d"))
      .toBe("a\tb\ncd");
  });
});

describe("result artifact body reader", () => {
  let cwd: string;
  let taskDir: string;
  const sessionId = "result-reader-session";

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-result-reader-cwd-"));
    taskDir = sessionTaskDir(cwd, sessionId);
  });

  afterEach(() => {
    rmSync(dirname(dirname(taskDir)), { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("reads sanitized Markdown by character slice and reports pagination", () => {
    writeResultArtifact(input(taskDir, {
      result: "# Heading\r\n\r\n- first\n- second\u001b[31m",
    }));

    const first = readResultArtifactBody({
      cwd,
      sessionId,
      agentId: "agent-1",
      artifactId: ARTIFACT_ID,
      offset: 2,
      limit: 12,
    });
    expect(first).toMatchObject({
      manifest: { agentId: "agent-1", artifactId: ARTIFACT_ID },
      slice: {
        body: "Heading\n\n- f",
        offset: 2,
        limit: 12,
        totalLength: 32,
        hasMore: true,
      },
    });

    const beyond = readResultArtifactBody({
      cwd,
      sessionId,
      agentId: "agent-1",
      artifactId: ARTIFACT_ID,
      offset: 1_000,
      limit: 25,
    });
    expect(beyond).toMatchObject({
      slice: { body: "", offset: 1_000, limit: 25, totalLength: 32, hasMore: false },
    });
  });

  it("rejects Agent and artifact identity mismatches", () => {
    const written = writeResultArtifact(input(taskDir));

    expect(readResultArtifactBody({
      cwd,
      sessionId,
      agentId: "agent-other",
      artifactId: ARTIFACT_ID,
    })).toMatchObject({ error: "result agent identity does not match" });

    const manifest = JSON.parse(readFileSync(written.manifestPath, "utf-8")) as ResultArtifactManifest;
    writeFileSync(written.manifestPath, JSON.stringify({ ...manifest, artifactId: "agent-attempt-other" }));
    expect(readResultArtifactBody({
      cwd,
      sessionId,
      agentId: "agent-1",
      artifactId: ARTIFACT_ID,
    })).toMatchObject({ error: "result manifest is invalid" });
  });

  it("rejects a changed digest and a missing body", () => {
    const written = writeResultArtifact(input(taskDir));
    writeFileSync(written.bodyPath!, "tampered\n");

    expect(readResultArtifactBody({
      cwd,
      sessionId,
      agentId: "agent-1",
      artifactId: ARTIFACT_ID,
    })).toMatchObject({ error: "result body digest mismatch" });

    rmSync(written.bodyPath!);
    expect(readResultArtifactBody({
      cwd,
      sessionId,
      agentId: "agent-1",
      artifactId: ARTIFACT_ID,
    })).toMatchObject({ error: "result body is missing" });
  });

  it("returns a controlled error when result directories and the manifest are absent", () => {
    rmSync(join(taskDir, "results"), { recursive: true, force: true });

    expect(() => readResultArtifactBody({
      cwd,
      sessionId,
      agentId: "agent-1",
      artifactId: ARTIFACT_ID,
    })).not.toThrow();
    expect(readResultArtifactBody({
      cwd,
      sessionId,
      agentId: "agent-1",
      artifactId: ARTIFACT_ID,
    })).toMatchObject({ error: "result manifest is missing" });
  });

  it("rejects a body larger than the bounded read limit", () => {
    const written = writeResultArtifact(input(taskDir));
    writeFileSync(written.bodyPath!, "x".repeat(8 * 1024 * 1024 + 1));

    expect(readResultArtifactBody({
      cwd,
      sessionId,
      agentId: "agent-1",
      artifactId: ARTIFACT_ID,
    })).toMatchObject({ error: "result body exceeds the read limit" });
  });
});
