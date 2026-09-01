import type { PathLike } from "node:fs";
import * as nodeFs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openRace = vi.hoisted(() => ({
  armed: false,
  outputPath: "",
  redirectTarget: "",
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFs>();
  return {
    ...actual,
    constants: { ...actual.constants, O_NOFOLLOW: 0 },
    openSync: (path: PathLike, flags: string | number, mode?: number) => {
      if (openRace.armed && path === openRace.outputPath) {
        openRace.armed = false;
        return actual.openSync(openRace.redirectTarget, flags, mode);
      }
      return actual.openSync(path, flags, mode);
    },
  };
});

import { streamToOutputFile, writeInitialEntry } from "../src/output-file.js";

function sessionWithSecret() {
  let callback: ((event: { type: string }) => void) | undefined;
  return {
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "text", text: "full secret result" }] },
    ],
    subscribe(fn: (event: { type: string }) => void) {
      callback = fn;
      return () => { callback = undefined; };
    },
    flush() { callback?.({ type: "turn_end" }); },
  };
}

describe("output transcript fallback without O_NOFOLLOW", () => {
  let dir: string;
  let outputPath: string;
  let redirectTarget: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "output-fallback-"));
    outputPath = join(dir, "agent.output");
    redirectTarget = join(dir, "redirect-target");
    writeFileSync(outputPath, "initial\n");
    writeFileSync(redirectTarget, "keep\n");
    Object.assign(openRace, { armed: false, outputPath, redirectTarget });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    Object.assign(openRace, { armed: false, outputPath: "", redirectTarget: "" });
  });

  it("pins and verifies the opened file before appending", () => {
    const session = sessionWithSecret();
    streamToOutputFile(session as never, outputPath, "agent-1", "/work");
    openRace.armed = true;

    session.flush();

    expect(readFileSync(outputPath, "utf-8")).toBe("initial\n");
    expect(readFileSync(redirectTarget, "utf-8")).toBe("keep\n");
  });

  it("uses exclusive creation for a new spawn", () => {
    expect(() => writeInitialEntry(outputPath, "agent-1", "secret prompt", "/work"))
      .toThrow();
    expect(readFileSync(outputPath, "utf-8")).toBe("initial\n");
  });
});
