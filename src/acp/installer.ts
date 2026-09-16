import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import decompress from "decompress";
import type { AcpLaunchCandidate } from "./registry.js";

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 50_000;

function installKey(candidate: AcpLaunchCandidate): string {
  const digest = createHash("sha256")
    .update(candidate.registryVersion)
    .update("\0")
    .update(candidate.archive ?? "")
    .digest("hex")
    .slice(0, 16);
  return `${candidate.registryVersion.replace(/[^a-zA-Z0-9._-]+/g, "_")}-${digest}`;
}

export function acpBinaryInstallDir(candidate: AcpLaunchCandidate, agentDir = getAgentDir()): string {
  return join(agentDir, "acp-binaries", candidate.registryId, installKey(candidate));
}

function commandRelativePath(command: string): string {
  const normalized = command.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !normalized
    || isAbsolute(command)
    || /^[a-zA-Z]:/.test(normalized)
    || normalized.split("/").some(part => part === "" || part === "." || part === "..")
  ) throw new Error(`Registry binary command must be a safe relative path: ${command}`);
  return normalized;
}

function destinationPath(root: string, archivePath: string): string {
  const normalized = archivePath.replaceAll("\\", "/");
  if (
    !normalized
    || normalized.startsWith("/")
    || /^[a-zA-Z]:/.test(normalized)
    || normalized.split("/").some(part => part === "..")
  ) throw new Error(`Registry archive contains an unsafe path: ${archivePath}`);
  const destination = resolve(root, normalized);
  const resolvedRoot = resolve(root);
  if (destination !== resolvedRoot && !destination.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Registry archive path escapes the install directory: ${archivePath}`);
  }
  return destination;
}

function installedCommand(root: string, command: string): string {
  return destinationPath(root, commandRelativePath(command));
}

export function acpBinaryCommandPath(candidate: AcpLaunchCandidate, agentDir = getAgentDir()): string {
  return installedCommand(acpBinaryInstallDir(candidate, agentDir), candidate.command);
}

function isUsableCommand(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  return stat.isFile() && !stat.isSymbolicLink();
}

function archiveKind(url: string): "archive" | "raw" {
  const path = new URL(url).pathname.toLowerCase();
  if (
    path.endsWith(".zip")
    || path.endsWith(".tar.gz")
    || path.endsWith(".tgz")
    || path.endsWith(".tar.bz2")
    || path.endsWith(".tbz2")
  ) return "archive";
  const unsupported = [".dmg", ".pkg", ".deb", ".rpm", ".msi", ".appimage", ".tar.xz", ".txz", ".7z"];
  if (unsupported.some(suffix => path.endsWith(suffix))) {
    throw new Error(`Unsupported Registry binary archive format: ${basename(path)}`);
  }
  return "raw";
}

const MAX_REDIRECTS = 5;

function assertHttpsUrl(url: URL, what: string): void {
  if (url.protocol !== "https:") throw new Error(`${what} must use HTTPS.`);
  if (url.username || url.password) throw new Error(`${what} must not contain credentials.`);
}

async function fetchHttps(url: URL, signal?: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertHttpsUrl(current, hop === 0 ? "Registry binary downloads" : "Registry binary download redirect");
    const response = await fetch(current, { signal, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new Error(`Registry binary download failed: HTTP ${response.status} with no Location.`);
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`Registry binary download failed: HTTP ${response.status}`);
    if (new URL(response.url).protocol !== "https:") {
      throw new Error("Registry binary download redirected away from HTTPS.");
    }
    return response;
  }
  throw new Error(`Registry binary download exceeded ${MAX_REDIRECTS} redirects.`);
}

async function download(candidate: AcpLaunchCandidate, signal?: AbortSignal): Promise<Buffer> {
  const archive = candidate.archive;
  if (!archive) throw new Error(`Registry entry ${candidate.registryId} has no binary archive URL.`);
  const response = await fetchHttps(new URL(archive), signal);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
    throw new Error(`Registry binary exceeds the ${MAX_ARCHIVE_BYTES} byte download limit.`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`Registry binary exceeds the ${MAX_ARCHIVE_BYTES} byte download limit.`);
  }
  if (candidate.sha256) {
    const actual = createHash("sha256").update(body).digest("hex");
    if (actual !== candidate.sha256.toLowerCase()) throw new Error("Registry binary SHA-256 mismatch.");
  }
  return body;
}

async function extractArchive(body: Buffer, output: string): Promise<void> {
  const files = await decompress(body);
  if (files.length === 0) throw new Error("Registry binary archive contained no files.");
  if (files.length > MAX_ARCHIVE_FILES) throw new Error("Registry binary archive contains too many files.");
  let extractedBytes = 0;
  for (const file of files) {
    if (file.type !== "file" && file.type !== "directory") {
      throw new Error(`Registry binary archive contains unsupported ${file.type}: ${file.path}`);
    }
    destinationPath(output, file.path);
    if (file.type === "file") {
      extractedBytes += file.data.length;
      if (extractedBytes > MAX_EXTRACTED_BYTES) {
        throw new Error(`Registry binary archive exceeds the ${MAX_EXTRACTED_BYTES} byte extraction limit.`);
      }
    }
  }
  for (const file of files.filter(item => item.type === "directory")) {
    mkdirSync(destinationPath(output, file.path), { recursive: true, mode: 0o700 });
  }
  for (const file of files.filter(item => item.type === "file")) {
    const destination = destinationPath(output, file.path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, file.data, { mode: file.mode & 0o777 || 0o600 });
  }
}

export async function installAcpBinary(
  candidate: AcpLaunchCandidate,
  options: { agentDir?: string; signal?: AbortSignal } = {},
): Promise<string> {
  if (candidate.distribution !== "binary" || !candidate.archive) {
    throw new Error(`${candidate.registryId} is not a binary Registry distribution.`);
  }
  const agentDir = options.agentDir ?? getAgentDir();
  const installDir = acpBinaryInstallDir(candidate, agentDir);
  const command = acpBinaryCommandPath(candidate, agentDir);
  if (isUsableCommand(command)) return command;
  if (existsSync(installDir)) rmSync(installDir, { recursive: true, force: true });

  const parent = dirname(installDir);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.install-${process.pid}-${randomUUID()}`);
  mkdirSync(temporary, { mode: 0o700 });
  try {
    const body = await download(candidate, options.signal);
    if (archiveKind(candidate.archive) === "raw") {
      const destination = installedCommand(temporary, candidate.command);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, body, { mode: 0o700 });
    } else {
      await extractArchive(body, temporary);
    }
    const temporaryCommand = installedCommand(temporary, candidate.command);
    if (!isUsableCommand(temporaryCommand)) {
      throw new Error(`Registry archive did not contain its declared command: ${candidate.command}`);
    }
    chmodSync(temporaryCommand, 0o700);
    try {
      renameSync(temporary, installDir);
    } catch (error) {
      if (!isUsableCommand(command)) throw error;
      rmSync(temporary, { recursive: true, force: true });
    }
    if (!isUsableCommand(command)) throw new Error("Installed Registry binary is not a regular file.");
    return command;
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}
