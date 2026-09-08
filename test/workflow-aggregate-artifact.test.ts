import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import { sessionTaskDir, setOutputTranscriptDefault } from "../src/output-file.js";
import {
  readWorkflowAggregateArtifactBody,
  readWorkflowAggregateArtifactManifest,
  type WorkflowAggregateArtifactManifest,
  writeWorkflowAggregateArtifact,
} from "../src/result-artifact.js";
import {
  aggregateWorkflowCoverage,
  type WorkflowChildAttempt,
} from "../src/workflow/attempt.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

function attempt(overrides: Partial<WorkflowChildAttempt> = {}): WorkflowChildAttempt {
  return {
    logicalChildIndex: 0,
    logicalChildId: "workflow-child-0",
    physicalAttempt: 1,
    status: "completed",
    invocation: "spawn",
    queuedAt: 1_000,
    startedAt: 1_100,
    completedAt: 1_500,
    usage: { turns: 1, toolCalls: 2, tokens: { input: 3, output: 4, cacheWrite: 0 } },
    recordId: "record-1",
    artifactId: "artifact-1",
    ...overrides,
  };
}

describe("workflow aggregate result artifacts", () => {
  let taskDir: string;

  beforeEach(() => {
    taskDir = mkdtempSync(`${tmpdir()}/pi-workflow-aggregate-`);
  });

  afterEach(() => rmSync(taskDir, { recursive: true, force: true }));

  function input(overrides: Partial<Parameters<typeof writeWorkflowAggregateArtifact>[0]> = {}) {
    const childAttempts = [
      attempt(),
      attempt({
        logicalChildIndex: 1,
        logicalChildId: "workflow-child-1",
        status: "failed",
        physicalAttempt: 1,
        error: "first failure",
      }),
      attempt({
        logicalChildIndex: 1,
        logicalChildId: "workflow-child-1",
        status: "completed",
        physicalAttempt: 2,
        invocation: "retry",
        sourceAttemptId: "artifact-1",
      }),
    ];
    return {
      taskDir,
      artifactId: "workflow-wf_abc123",
      workflowId: "wf_abc123",
      workflowName: "review",
      status: "completed" as const,
      startedAt: 1_000,
      completedAt: 2_000,
      coverage: aggregateWorkflowCoverage(childAttempts),
      childAttempts,
      resultSummary: "final summary\nignored from summary",
      result: "final summary\nfull result\u001b[31m",
      includeBody: true,
      taskBinding: {
        storeId: "store-1",
        taskId: "7",
        taskAttemptId: "task-attempt-1",
        attemptId: "workflow-attempt-1",
        kind: "workflow" as const,
        executorId: "wf_abc123",
      },
      ...overrides,
    };
  }

  it.each(["completed", "failed", "killed"] as const)("persists a %s settle with coverage and safe child references", status => {
    const written = writeWorkflowAggregateArtifact(input({ status }));
    const manifest = JSON.parse(readFileSync(written.manifestPath, "utf-8")) as WorkflowAggregateArtifactManifest;

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      artifactId: "workflow-wf_abc123",
      workflowId: "wf_abc123",
      workflowName: "review",
      status,
      coverage: {
        logicalChildCount: 2,
        physicalAttemptCount: 3,
        coveredLogicalChildCount: 2,
        physical: { total: 3, failed: 1, completed: 2 },
        logical: { total: 2, completed: 2 },
        coverage: "complete",
        complete: true,
      },
      taskBinding: { taskId: "7", kind: "workflow", executorId: "wf_abc123" },
      artifactStatus: "complete",
    });
    expect(manifest.childAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        logicalChildId: "workflow-child-1",
        physicalAttempt: 1,
        status: "failed",
        artifactId: "artifact-1",
        error: "first failure",
      }),
      expect.objectContaining({
        logicalChildId: "workflow-child-1",
        physicalAttempt: 2,
        status: "completed",
        sourceAttemptId: "artifact-1",
      }),
    ]));
    expect(JSON.stringify(manifest)).not.toContain("full result");

    const body = readFileSync(written.bodyPath!, "utf-8");
    expect(body).toBe("final summary\nfull result[31m\n");
    expect(manifest.resultDigest).toBe(
      `sha256:${createHash("sha256").update(body).digest("hex")}`,
    );
    expect(written.status).toBe("complete");
  });

  it("records incomplete evidence when a killed child drain times out", () => {
    const childAttempts = [attempt({ status: "killed", error: "late child stopped" })];
    const written = writeWorkflowAggregateArtifact(input({
      status: "killed",
      evidenceIncomplete: true,
      childAttempts,
      coverage: aggregateWorkflowCoverage(childAttempts),
      includeBody: false,
      result: "private result",
    }));
    const manifest = JSON.parse(readFileSync(written.manifestPath, "utf-8")) as WorkflowAggregateArtifactManifest;

    expect(manifest.status).toBe("killed");
    expect(manifest.evidenceIncomplete).toBe(true);
    expect(manifest.coverage.coverage).toBe("failed");
    expect(manifest.resultSummary).toBe("Output persistence disabled.");
  });

  it("keeps only fixed error marker when body persistence is disabled", () => {
    const written = writeWorkflowAggregateArtifact(input({
      includeBody: false,
      result: "private full result",
      resultSummary: "summary\nprivate full result",
      error: "private workflow error",
    }));
    const manifest = JSON.parse(readFileSync(written.manifestPath, "utf-8")) as WorkflowAggregateArtifactManifest;

    expect(written.bodyPath).toBeUndefined();
    expect(manifest.artifactStatus).toBe("metadata-only");
    expect(manifest.resultSummary).toBe("Output persistence disabled.");
    expect(manifest.error).toBe("Workflow failed; output persistence disabled.");
    expect(manifest.childAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        logicalChildId: "workflow-child-1",
        physicalAttempt: 1,
        status: "failed",
      }),
    ]));
    expect(manifest.childAttempts.some(child => "error" in child)).toBe(false);
    expect(aggregateWorkflowCoverage(manifest.childAttempts)).toEqual(manifest.coverage);
    expect(JSON.stringify(manifest)).not.toContain("summary");
    expect(JSON.stringify(manifest)).not.toContain("private full result");
    expect(JSON.stringify(manifest)).not.toContain("private workflow error");
  });

  it("is idempotent and verifies the existing body before returning it", () => {
    const first = writeWorkflowAggregateArtifact(input());
    const second = writeWorkflowAggregateArtifact(input({ result: "replacement" }));

    expect(second).toEqual(first);
    expect(readFileSync(first.bodyPath!, "utf-8")).toContain("full result");
  });

  it("rejects changed bodies on an idempotent aggregate check", () => {
    const first = writeWorkflowAggregateArtifact(input());
    writeFileSync(first.bodyPath!, "tampered\n");

    const checked = writeWorkflowAggregateArtifact(input({ result: "replacement" }));

    expect(checked.status).toBe("failed");
    expect(checked.bodyPath).toBeUndefined();
    expect(checked.error).toContain("body digest mismatch");
  });

  it("rejects coverage that does not match the child attempt snapshots", () => {
    expect(() => writeWorkflowAggregateArtifact(input({
      coverage: aggregateWorkflowCoverage([]),
    }))).toThrow("invalid workflow aggregate coverage");
    expect(existsSync(join(taskDir, "results"))).toBe(false);
  });

  it("uses only the validated artifact ID to construct aggregate paths", () => {
    const written = writeWorkflowAggregateArtifact(input());

    expect(written.manifestPath).toBe(join(
      taskDir,
      "results",
      "workflow-wf_abc123",
      "workflow-wf_abc123.json",
    ));
    expect(written.bodyPath).toBe(join(
      taskDir,
      "results",
      "workflow-wf_abc123",
      "workflow-wf_abc123.md",
    ));
    const manifest = JSON.parse(readFileSync(written.manifestPath, "utf-8")) as WorkflowAggregateArtifactManifest;
    expect(manifest.resultBodyPath).toBe("workflow-wf_abc123.md");
    expect(manifest.resultBodyPath).not.toContain(taskDir);
  });

  it("reads only the fixed managed manifest and validates its task binding", () => {
    const cwd = join(taskDir, "managed-cwd");
    const sessionId = "aggregate-reader-session";
    const managedTaskDir = sessionTaskDir(cwd, sessionId);
    const taskBinding = input().taskBinding;
    try {
      const written = writeWorkflowAggregateArtifact(input({
        taskDir: managedTaskDir,
        taskBinding,
      }));
      rmSync(written.bodyPath!);

      const read = readWorkflowAggregateArtifactManifest({
        cwd,
        sessionId,
        workflowId: "wf_abc123",
        taskBinding,
      });
      expect(read).toMatchObject({
        manifestPath: written.manifestPath,
        manifest: {
          workflowId: "wf_abc123",
          artifactStatus: "complete",
          taskBinding,
        },
      });

      const mismatch = readWorkflowAggregateArtifactManifest({
        cwd,
        sessionId,
        workflowId: "wf_abc123",
        taskBinding: { ...taskBinding!, attemptId: "other-attempt" },
      });
      expect(mismatch).toMatchObject({ error: "workflow aggregate task binding does not match" });
    } finally {
      rmSync(dirname(managedTaskDir), { recursive: true, force: true });
    }
  });

  it("reads the fixed workflow body locator with binding, pagination, and digest validation", () => {
    const cwd = join(taskDir, "managed-body-cwd");
    const sessionId = "aggregate-body-session";
    const managedTaskDir = sessionTaskDir(cwd, sessionId);
    const taskBinding = input().taskBinding;
    try {
      const written = writeWorkflowAggregateArtifact(input({
        taskDir: managedTaskDir,
        taskBinding,
      }));

      const read = readWorkflowAggregateArtifactBody({
        cwd,
        sessionId,
        workflowId: "wf_abc123",
        taskBinding,
        offset: 6,
        limit: 10,
      });
      expect(read).toMatchObject({
        manifestPath: written.manifestPath,
        manifest: { workflowId: "wf_abc123", taskBinding },
        slice: {
          body: "summary\nfu",
          offset: 6,
          limit: 10,
          hasMore: true,
        },
      });

      expect(readWorkflowAggregateArtifactBody({
        cwd,
        sessionId,
        workflowId: "wf_abc123",
        taskBinding: { ...taskBinding!, attemptId: "other-attempt" },
      })).toMatchObject({ error: "workflow aggregate task binding does not match" });
      expect(readWorkflowAggregateArtifactBody({
        cwd,
        sessionId: "other-session",
        workflowId: "wf_abc123",
        taskBinding,
      })).toMatchObject({ error: "workflow aggregate manifest is missing" });

      writeFileSync(written.bodyPath!, "tampered\n");
      expect(readWorkflowAggregateArtifactBody({
        cwd,
        sessionId,
        workflowId: "wf_abc123",
        taskBinding,
      })).toMatchObject({ error: "workflow aggregate body digest mismatch" });
    } finally {
      rmSync(dirname(dirname(managedTaskDir)), { recursive: true, force: true });
    }
  });

  it("reads an unbound workflow body by its wf_* identity", () => {
    const cwd = join(taskDir, "managed-unbound-cwd");
    const sessionId = "aggregate-unbound-session";
    const managedTaskDir = sessionTaskDir(cwd, sessionId);
    try {
      writeWorkflowAggregateArtifact(input({
        taskDir: managedTaskDir,
        taskBinding: undefined,
      }));

      const read = readWorkflowAggregateArtifactBody({
        cwd,
        sessionId,
        workflowId: "wf_abc123",
        offset: 10_000,
        limit: 10,
      });
      expect(read).toMatchObject({
        manifest: { workflowId: "wf_abc123" },
        slice: { body: "", offset: 10_000, limit: 10, hasMore: false },
      });
      expect("manifest" in read && read.manifest.taskBinding).toBeUndefined();
    } finally {
      rmSync(dirname(dirname(managedTaskDir)), { recursive: true, force: true });
    }
  });

  it("returns a controlled error when workflow directories and the manifest are absent", () => {
    const cwd = join(taskDir, "missing-workflow-cwd");
    const sessionId = "aggregate-missing-session";
    const managedTaskDir = sessionTaskDir(cwd, sessionId);
    try {
      rmSync(join(managedTaskDir, "results"), { recursive: true, force: true });

      expect(() => readWorkflowAggregateArtifactBody({
        cwd,
        sessionId,
        workflowId: "wf_abc123",
      })).not.toThrow();
      expect(readWorkflowAggregateArtifactBody({
        cwd,
        sessionId,
        workflowId: "wf_abc123",
      })).toMatchObject({ error: "workflow aggregate manifest is missing" });
    } finally {
      rmSync(dirname(dirname(managedTaskDir)), { recursive: true, force: true });
    }
  });

  it("isolates an unbound wf_* result between formerly colliding project paths", () => {
    const projectA = join(taskDir, "a-b", "c");
    const projectB = join(taskDir, "a", "b-c");
    const sessionId = "shared-session";
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    const taskDirA = sessionTaskDir(projectA, sessionId);
    const taskDirB = sessionTaskDir(projectB, sessionId);
    try {
      expect(taskDirA).not.toBe(taskDirB);
      writeWorkflowAggregateArtifact(input({
        taskDir: taskDirA,
        taskBinding: undefined,
        result: "project A private result",
      }));

      const crossProjectRead = readWorkflowAggregateArtifactBody({
        cwd: projectB,
        sessionId,
        workflowId: "wf_abc123",
      });
      expect(crossProjectRead).toMatchObject({ error: "workflow aggregate manifest is missing" });
      expect(JSON.stringify(crossProjectRead)).not.toContain("project A private result");
    } finally {
      rmSync(dirname(dirname(taskDirA)), { recursive: true, force: true });
      rmSync(dirname(dirname(taskDirB)), { recursive: true, force: true });
    }
  });

  it("rejects unsafe aggregate and workflow IDs before creating results", () => {
    for (const artifactId of ["../escape", "a/b", "..", `a${"x".repeat(128)}`, "bad\u0000id"]) {
      expect(() => writeWorkflowAggregateArtifact(input({ artifactId })))
        .toThrow("invalid workflow aggregate artifact id");
    }
    for (const workflowId of ["../escape", "a/b", "..", `a${"x".repeat(128)}`, "bad\u0000id"]) {
      expect(() => writeWorkflowAggregateArtifact(input({ workflowId })))
        .toThrow("invalid workflow id");
    }
    expect(existsSync(join(taskDir, "results"))).toBe(false);
  });

  it("rejects unsafe child references and task binding locators", () => {
    expect(() => writeWorkflowAggregateArtifact(input({
      childAttempts: [attempt({ recordId: "../escape" })],
      coverage: aggregateWorkflowCoverage([attempt({ recordId: "../escape" })]),
    }))).toThrow("invalid record id");

    expect(() => writeWorkflowAggregateArtifact(input({
      taskBinding: {
        storeId: "store-1",
        taskId: "not safe",
        taskAttemptId: "task-attempt-1",
        attemptId: "workflow-attempt-1",
        kind: "workflow",
        executorId: "wf_abc123",
      },
    }))).toThrow("invalid workflow aggregate artifact input");

    expect(() => writeWorkflowAggregateArtifact(input({
      taskBinding: {
        storeId: "store-1",
        taskId: "7",
        taskAttemptId: "task-attempt-1",
        attemptId: "workflow-attempt-1",
        kind: "agent",
        executorId: "wf_abc123",
      },
    }))).toThrow("invalid workflow aggregate artifact input");

    expect(() => writeWorkflowAggregateArtifact(input({
      taskBinding: {
        storeId: "store-1",
        taskId: "7",
        taskAttemptId: "task-attempt-1",
        attemptId: "workflow-attempt-1",
        kind: "workflow",
        executorId: "wf_other",
      },
    }))).toThrow("invalid workflow aggregate artifact input");
  });
});

const WORKFLOW_SCRIPT = 'export const meta = { name: "aggregate", description: "aggregate test" };\n';

describe("workflow aggregate settle wiring", () => {
  let hermetic: Hermetic;
  let booted: ReturnType<typeof makePi>;
  let context: ReturnType<typeof ctx>;
  let sessionId: string;
  let persisted: boolean;
  let didShutdown: boolean;

  beforeEach(() => {
    hermetic = hermeticDir({ testAgents: true, settings: { schedulingEnabled: false, workflowsEnabled: true } });
    booted = makePi();
    subagentsExtension(booted.pi);
    sessionId = `aggregate-session-${process.pid}`;
    persisted = true;
    didShutdown = false;
    context = ctx({
      cwd: hermetic.dir,
      sessionManager: {
        getSessionId: vi.fn(() => sessionId),
        getSessionFile: vi.fn(() => persisted ? join(hermetic.dir, "parent.jsonl") : undefined),
        getBranch: vi.fn(() => []),
      },
    });
  });

  afterEach(async () => {
    if (!didShutdown) await booted.lifecycle.get("session_shutdown")?.({}, context);
    await flush();
    setOutputTranscriptDefault(true);
    const taskDir = sessionId.includes("/") ? undefined : sessionTaskDir(hermetic.dir, sessionId);
    hermetic.restore();
    if (taskDir !== undefined) rmSync(dirname(taskDir), { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function run(script: string): Promise<{ taskId: string; output: string }> {
    const started = await booted.tools.get("SubagentWorkflow").execute(
      "aggregate-run",
      { script },
      undefined,
      undefined,
      context,
    );
    const taskId = /Task ID: (\S+)/.exec(textOf(started))?.[1];
    if (taskId === undefined) throw new Error(`workflow did not start: ${textOf(started)}`);
    const output = await booted.tools.get("TaskOutput").execute(
      "aggregate-output",
      { task_id: taskId, block: true, timeout: 5000 },
      undefined,
      undefined,
      context,
    );
    return { taskId, output: textOf(output) };
  }

  function aggregateManifest(taskId: string): WorkflowAggregateArtifactManifest {
    const path = join(
      sessionTaskDir(hermetic.dir, sessionId),
      "results",
      `workflow-${taskId}`,
      `workflow-${taskId}.json`,
    );
    return JSON.parse(readFileSync(path, "utf-8")) as WorkflowAggregateArtifactManifest;
  }

  it("persists failed workflow settlement", async () => {
    const { taskId, output } = await run(`${WORKFLOW_SCRIPT}throw new Error("workflow failed");`);

    expect(output).toContain(`[failed]`);
    expect(aggregateManifest(taskId)).toMatchObject({
      workflowId: taskId,
      status: "failed",
      artifactStatus: "complete",
      error: "workflow failed",
    });
  });

  it("persists failed workflow settlement without its absolute cwd", async () => {
    const errorText = `workflow failed in ${hermetic.dir}`;
    const { taskId, output } = await run(`${WORKFLOW_SCRIPT}throw new Error(${JSON.stringify(errorText)});`);

    expect(output).toContain(`[failed]`);
    const manifest = aggregateManifest(taskId);
    expect(manifest.error).toBe(`workflow failed in <cwd>`);
    const bodyPath = join(
      sessionTaskDir(hermetic.dir, sessionId),
      "results",
      `workflow-${taskId}`,
      `workflow-${taskId}.md`,
    );
    expect(readFileSync(bodyPath, "utf-8")).toBe("workflow failed in <cwd>\n");
    expect(JSON.stringify(manifest)).not.toContain(hermetic.dir);
  });

  it("persists killed workflow settlement", async () => {
    const started = await booted.tools.get("SubagentWorkflow").execute(
      "aggregate-killed",
      { script: `${WORKFLOW_SCRIPT}await new Promise(() => {});` },
      undefined,
      undefined,
      context,
    );
    const taskId = /Task ID: (\S+)/.exec(textOf(started))?.[1];
    if (taskId === undefined) throw new Error(`workflow did not start: ${textOf(started)}`);

    await booted.lifecycle.get("session_shutdown")?.({}, context);
    didShutdown = true;

    expect(aggregateManifest(taskId)).toMatchObject({
      workflowId: taskId,
      status: "killed",
      artifactStatus: "complete",
    });
  });

  it("keeps workflow status completed when aggregate persistence fails", async () => {
    sessionId = "invalid/session";

    const { output } = await run(`${WORKFLOW_SCRIPT}return "workflow result";`);

    expect(output).toContain("[completed]");
    expect(output).toContain("workflow result");
  });

  it("skips aggregate persistence without a persisted parent session", async () => {
    persisted = false;

    const { output } = await run(`${WORKFLOW_SCRIPT}return "ephemeral result";`);
    const taskDir = sessionTaskDir(hermetic.dir, sessionId);

    expect(output).toContain("[completed]");
    expect(existsSync(join(taskDir, "results"))).toBe(false);
  });

  it("captures privacy-off at workflow start and writes metadata only", async () => {
    setOutputTranscriptDefault(false);

    const { taskId } = await run(`${WORKFLOW_SCRIPT}return "private workflow result";`);
    const manifest = aggregateManifest(taskId);
    const artifactDir = join(sessionTaskDir(hermetic.dir, sessionId), "results", `workflow-${taskId}`);

    expect(manifest.artifactStatus).toBe("metadata-only");
    expect(manifest.resultBodyPath).toBeUndefined();
    expect(manifest.resultDigest).toBeUndefined();
    expect(manifest.resultSummary).toBe("Output persistence disabled.");
    expect(JSON.stringify(manifest)).not.toContain("private workflow result");
    expect(existsSync(join(artifactDir, `workflow-${taskId}.md`))).toBe(false);
  });
});
