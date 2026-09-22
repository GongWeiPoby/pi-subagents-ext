/**
 * group-chat/store.ts — `.pi/groups/<roomId>/` roster + log. Binding lives on the Pi session.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LogLine, RoomMeta } from "./types.js";

const GROUPS_DIR = join(".pi", "groups");
const META_FILE = "meta.json";
const LOG_FILE = "log.jsonl";
const LEGACY_TRANSCRIPT = "transcript.jsonl";

export function groupsRoot(cwd: string): string {
  return join(cwd, GROUPS_DIR);
}

function roomDir(cwd: string, roomId: string): string {
  return join(groupsRoot(cwd), roomId);
}

function atomicWrite(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

function isRoomId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(id);
}

export function slugRoomId(name: string): string {
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || "room";
}

export class GroupStore {
  constructor(readonly cwd: string) {}

  list(): RoomMeta[] {
    const root = groupsRoot(this.cwd);
    if (!existsSync(root)) return [];
    const rooms: RoomMeta[] = [];
    for (const name of readdirSync(root, { withFileTypes: true })) {
      if (!name.isDirectory() || !isRoomId(name.name)) continue;
      const meta = this.readMeta(name.name);
      if (meta) rooms.push(meta);
    }
    return rooms.sort((a, b) => a.name.localeCompare(b.name));
  }

  readMeta(roomId: string): RoomMeta | undefined {
    if (!isRoomId(roomId)) return undefined;
    const path = join(roomDir(this.cwd, roomId), META_FILE);
    if (!existsSync(path)) return undefined;
    try {
      const data = JSON.parse(readFileSync(path, "utf-8")) as RoomMeta;
      if (data?.version !== 1 || data.id !== roomId || !Array.isArray(data.members)) return undefined;
      return data;
    } catch {
      return undefined;
    }
  }

  writeMeta(meta: RoomMeta): void {
    if (!isRoomId(meta.id)) throw new Error(`Invalid room id: ${meta.id}`);
    atomicWrite(join(roomDir(this.cwd, meta.id), META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
  }

  create(name: string, members: RoomMeta["members"]): RoomMeta {
    if (members.length === 0) throw new Error("A room needs at least one member.");
    const base = slugRoomId(name);
    let id = base;
    let n = 2;
    while (this.readMeta(id)) {
      id = `${base}-${n}`;
      n++;
    }
    const meta: RoomMeta = {
      version: 1,
      id,
      name: name.trim() || id,
      createdAt: new Date().toISOString(),
      members,
    };
    this.writeMeta(meta);
    atomicWrite(join(roomDir(this.cwd, id), LOG_FILE), "");
    return meta;
  }

  logPath(roomId: string): string {
    const modern = join(roomDir(this.cwd, roomId), LOG_FILE);
    if (existsSync(modern)) return modern;
    return join(roomDir(this.cwd, roomId), LEGACY_TRANSCRIPT);
  }

  readLog(roomId: string): LogLine[] {
    const path = this.logPath(roomId);
    if (!existsSync(path)) return [];
    const lines: LogLine[] = [];
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const raw = JSON.parse(line) as Partial<LogLine> & { role?: string; text?: string };
        if (typeof raw.text !== "string") continue;
        lines.push({
          id: typeof raw.id === "string" ? raw.id : `legacy-${lines.length}`,
          ts: typeof raw.ts === "string" ? raw.ts : new Date().toISOString(),
          kind: raw.kind ?? (raw.role === "user" ? "user" : raw.role === "system" ? "system" : "say"),
          role: raw.role === "user" || raw.role === "system" ? raw.role : "assistant",
          hop: typeof raw.hop === "number" ? raw.hop : 0,
          text: raw.text,
          ...(raw.handle ? { handle: raw.handle } : {}),
          ...(raw.to ? { to: raw.to } : {}),
          ...(raw.wake !== undefined ? { wake: raw.wake } : {}),
          ...(raw.originUserMsg ? { originUserMsg: raw.originUserMsg } : {}),
        });
      } catch { /* skip a corrupt line */ }
    }
    return lines;
  }

  append(roomId: string, line: Omit<LogLine, "id" | "ts"> & { id?: string; ts?: string }): LogLine {
    const full: LogLine = {
      id: line.id ?? `msg_${randomUUID().slice(0, 8)}`,
      ts: line.ts ?? new Date().toISOString(),
      kind: line.kind,
      role: line.role,
      hop: line.hop,
      text: line.text,
    };
    if (line.handle) full.handle = line.handle;
    if (line.to) full.to = line.to;
    if (line.wake !== undefined) full.wake = line.wake;
    if (line.originUserMsg) full.originUserMsg = line.originUserMsg;
    const path = join(roomDir(this.cwd, roomId), LOG_FILE);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(full)}\n`, { flag: "a" });
    return full;
  }

  find(nameOrId: string): RoomMeta | undefined {
    const wanted = nameOrId.trim().toLowerCase();
    if (!wanted) return undefined;
    return this.readMeta(wanted)
      ?? this.list().find(room => room.name.toLowerCase() === wanted || room.id.toLowerCase() === wanted);
  }
}
