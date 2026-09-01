import type { PathLike } from "node:fs";
import * as nodeFs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const publishRace = vi.hoisted(() => ({
  armed: false,
  finalPath: "",
  competingContent: "",
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFs>();
  return {
    ...actual,
    linkSync: (existingPath: PathLike, newPath: PathLike) => {
      if (publishRace.armed && String(newPath) === publishRace.finalPath) {
        publishRace.armed = false;
        actual.writeFileSync(newPath, publishRace.competingContent, { flag: "wx" });
      }
      actual.linkSync(existingPath, newPath);
    },
  };
});

import { type ResultArtifactManifest, writeResultArtifact } from "../src/result-artifact.js";

const ARTIFACT_ID = "agent-attempt-race-1234";

describe("result artifact exclusive finalization", () => {
  let taskDir: string;

  beforeEach(() => {
    taskDir = mkdtempSync(join(tmpdir(), "result-artifact-race-"));
    Object.assign(publishRace, {
      armed: true,
      finalPath: join(taskDir, "results", ARTIFACT_ID, `${ARTIFACT_ID}.md`),
      competingContent: "concurrent winner\n",
    });
  });

  afterEach(() => {
    rmSync(taskDir, { recursive: true, force: true });
    Object.assign(publishRace, { armed: false, finalPath: "", competingContent: "" });
  });

  it("does not replace a target created at the final publish boundary", () => {
    const written = writeResultArtifact({
      taskDir,
      artifactId: ARTIFACT_ID,
      agentId: "agent-1",
      status: "completed",
      startedAt: 1_000,
      completedAt: 2_000,
      invocation: "spawn",
      usage: {
        turns: 1,
        toolCalls: 0,
        tokens: { input: 1, output: 1, cacheWrite: 0 },
      },
      result: "private full result",
      includeBody: true,
    });

    const manifest = JSON.parse(readFileSync(written.manifestPath, "utf-8")) as ResultArtifactManifest;
    expect(written.status).toBe("failed");
    expect(written.bodyPath).toBeUndefined();
    expect(readFileSync(publishRace.finalPath, "utf-8")).toBe("concurrent winner\n");
    expect(manifest.artifactStatus).toBe("failed");
    expect(JSON.stringify(manifest)).not.toContain("private full result");
    expect(readdirSync(join(taskDir, "results", ARTIFACT_ID)).every(name => !name.endsWith(".tmp")))
      .toBe(true);
  });
});
