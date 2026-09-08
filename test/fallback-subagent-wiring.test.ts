/** Strict dispatch through real tools and public registry; no implicit roster. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { getAllTypes, getAvailableTypes } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

let hermetic: Hermetic;
let booted: ReturnType<typeof makePi>;

beforeEach(() => {
  hermetic = hermeticDir({
    settings: { defaultAgent: "scout", outputTranscript: false },
    agentFiles: {
      scout: "---\ndescription: Scout\ntools: read\n---\nScout.",
      retired: "---\ndescription: Retired\nenabled: false\n---\nRetired.",
    },
  });
  booted = makePi();
  subagentsExtension(booted.pi);
  vi.mocked(runAgent).mockReset();
});

afterEach(async () => {
  await booted.lifecycle.get("session_shutdown")?.();
  hermetic.restore();
});

describe("strict user-defined dispatch", () => {
  it.each([false, true])("rejects missing and former built-in types before execution (background=%s)", async (background) => {
    for (const type of ["typo", "Worker", "Explorer", "Reviewer", "Explore", "Plan", "general-purpose", ""]) {
      await expect(booted.tools.get("Agent").execute("tc", {
        subagent_type: type, description: "check", prompt: "inspect", run_in_background: background,
      }, undefined, undefined, ctx())).rejects.toThrow(/agent type|No agent type/);
    }
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("rejects a loaded but disabled definition", async () => {
    expect(getAllTypes()).toContain("retired");
    expect(getAvailableTypes()).not.toContain("retired");
    await expect(booted.tools.get("Agent").execute("tc", {
      subagent_type: "retired", description: "check", prompt: "inspect",
    }, undefined, undefined, ctx())).rejects.toThrow("Unknown or disabled");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("does not schedule an unknown type", async () => {
    await booted.lifecycle.get("session_start")({}, ctx());
    await expect(booted.tools.get("Agent").execute("tc", {
      subagent_type: "missing", description: "later", prompt: "inspect", schedule: "+1h",
    }, undefined, undefined, ctx())).rejects.toThrow("Unknown or disabled");
    expect(booted.pi.events.emit.mock.calls.some(([name, data]: [string, { type?: string }]) =>
      name === "subagents:scheduled" && data.type === "added")).toBe(false);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("discovers a new user file on the next invocation", async () => {
    mkdirSync(join(hermetic.dir, ".pi", "agents"), { recursive: true });
    writeFileSync(join(hermetic.dir, ".pi", "agents", "writer.md"), "---\ndescription: Writer\n---\nWrite.");
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done", session: { dispose: vi.fn() } as never, aborted: false, steered: false,
    });
    await booted.tools.get("Agent").execute("tc", {
      subagent_type: "writer", description: "work", prompt: "bounded task", run_in_background: false,
    }, undefined, undefined, ctx());
    expect(runAgent).toHaveBeenCalledWith(expect.anything(), "writer", "bounded task", expect.anything());
  });

  it("rejects unknown types through the public registry", () => {
    const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as {
      spawn: (...args: unknown[]) => string;
    };
    expect(() => registry.spawn({}, ctx(), "missing", "inspect", { description: "rpc" })).toThrow("Unknown or disabled");
    expect(() => registry.spawn({}, ctx(), "scout", "inspect", {
      description: "rpc", structuredOutput: {},
    })).toThrow("options.structuredOutput is no longer supported");
    expect(runAgent).not.toHaveBeenCalled();
  });
});
