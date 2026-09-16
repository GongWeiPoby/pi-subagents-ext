import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installAcpBinary } from "../src/acp/installer.js";
import type { AcpLaunchCandidate } from "../src/acp/registry.js";

function candidate(overrides: Partial<AcpLaunchCandidate> = {}): AcpLaunchCandidate {
  return {
    registryId: "fixture-binary",
    displayName: "Fixture Binary",
    registryVersion: "1.2.3",
    description: "fixture",
    sourceUrl: "https://example.test/source",
    distribution: "binary",
    command: "./bin/fixture-agent",
    args: ["acp"],
    staticEnv: {},
    archive: "https://example.test/fixture.tar.gz",
    requiresInstalledBinary: true,
    ...overrides,
  };
}

function response(body: Buffer, url: string): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": String(body.length) }),
    url,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  } as Response;
}

const tempDirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ACP binary installer", () => {
  it("downloads, verifies and caches a raw Registry binary", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "acp-installer-"));
    tempDirs.push(agentDir);
    const body = Buffer.from("fixture executable\n");
    const archive = "https://example.test/fixture-agent";
    const fetchMock = vi.fn(async () => response(body, archive));
    vi.stubGlobal("fetch", fetchMock);
    const spec = candidate({
      command: "./fixture-agent",
      archive,
      sha256: createHash("sha256").update(body).digest("hex"),
    });

    const installed = await installAcpBinary(spec, { agentDir });
    expect(readFileSync(installed, "utf8")).toBe("fixture executable\n");
    expect(await installAcpBinary(spec, { agentDir })).toBe(installed);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("extracts a tar.gz Registry archive and resolves the declared command", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "acp-installer-"));
    const source = mkdtempSync(join(tmpdir(), "acp-archive-source-"));
    tempDirs.push(agentDir, source);
    mkdirSync(join(source, "bin"));
    const executable = join(source, "bin", "fixture-agent");
    writeFileSync(executable, "#!/bin/sh\necho fixture\n");
    chmodSync(executable, 0o700);
    const archivePath = join(source, "fixture.tar.gz");
    const packed = spawnSync("tar", ["-czf", archivePath, "-C", source, "bin"]);
    expect(packed.status).toBe(0);
    const body = readFileSync(archivePath);
    vi.stubGlobal("fetch", vi.fn(async () => response(body, "https://example.test/fixture.tar.gz")));

    const installed = await installAcpBinary(candidate({
      sha256: createHash("sha256").update(body).digest("hex"),
    }), { agentDir });
    expect(readFileSync(installed, "utf8")).toContain("echo fixture");
  });

  it("rejects checksum mismatches and unsafe declared commands", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "acp-installer-"));
    tempDirs.push(agentDir);
    const body = Buffer.from("wrong bytes");
    vi.stubGlobal("fetch", vi.fn(async () => response(body, "https://example.test/fixture-agent")));

    await expect(installAcpBinary(candidate({
      archive: "https://example.test/fixture-agent",
      command: "./fixture-agent",
      sha256: "0".repeat(64),
    }), { agentDir })).rejects.toThrow(/SHA-256 mismatch/);
    await expect(installAcpBinary(candidate({ command: "../escape" }), { agentDir }))
      .rejects.toThrow(/safe relative path/);
  });

  it("follows HTTPS redirects and rejects HTTP locations", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "acp-installer-"));
    tempDirs.push(agentDir);
    const body = Buffer.from("redirected executable\n");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://example.test/archive") {
        return {
          ok: false,
          status: 302,
          headers: new Headers({ location: "https://cdn.example.test/fixture-agent" }),
          url,
          body: { cancel: vi.fn(async () => {}) },
          arrayBuffer: async () => new ArrayBuffer(0),
        } as unknown as Response;
      }
      return response(body, url);
    });
    vi.stubGlobal("fetch", fetchMock);
    const installed = await installAcpBinary(candidate({
      archive: "https://example.test/archive",
      command: "./fixture-agent",
    }), { agentDir });
    expect(readFileSync(installed, "utf8")).toBe("redirected executable\n");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 302,
      headers: new Headers({ location: "http://evil.test/fixture-agent" }),
      url: "https://example.test/archive",
      body: { cancel: vi.fn(async () => {}) },
      arrayBuffer: async () => new ArrayBuffer(0),
    }) as unknown as Response));
    await expect(installAcpBinary(candidate({
      archive: "https://example.test/archive",
      command: "./fixture-agent",
      registryVersion: "1.2.4",
    }), { agentDir })).rejects.toThrow(/HTTPS/);
  });

  it("rejects HTTP and credentialed Registry URLs", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "acp-installer-"));
    tempDirs.push(agentDir);
    await expect(installAcpBinary(candidate({
      archive: "http://example.test/fixture-agent",
      command: "./fixture-agent",
    }), { agentDir })).rejects.toThrow(/HTTPS/);
    await expect(installAcpBinary(candidate({
      archive: "https://user:pass@example.test/fixture-agent",
      command: "./fixture-agent",
    }), { agentDir })).rejects.toThrow(/must not contain credentials/);
  });

  it.skipIf(process.platform === "win32")("rejects archives that contain symlinks", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "acp-installer-"));
    const source = mkdtempSync(join(tmpdir(), "acp-archive-link-"));
    tempDirs.push(agentDir, source);
    writeFileSync(join(source, "target"), "secret\n");
    spawnSync("ln", ["-s", "target", join(source, "link")]);
    const packed = spawnSync("tar", ["-czf", join(source, "linked.tar.gz"), "-C", source, "link"]);
    expect(packed.status).toBe(0);
    const body = readFileSync(join(source, "linked.tar.gz"));
    vi.stubGlobal("fetch", vi.fn(async () => response(body, "https://example.test/linked.tar.gz")));
    await expect(installAcpBinary(candidate({
      archive: "https://example.test/linked.tar.gz",
      command: "./link",
    }), { agentDir })).rejects.toThrow(/unsupported symlink/);
  });
});
