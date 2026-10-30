// One daemon per machine. `~/.ogsync/daemon.lock` holds `{pid, nonce, at}` and
// is created complete (written to a temp name, then hard-linked into place),
// so no contender ever reads a half-written lock. A lock is live while it is
// young, or while its pid is alive AND answers GET /id as that pid (a reused
// pid answers nothing). A stale lock is taken over by renaming it to a unique
// name: only one rename of that file can win. `daemon.json` publishes the
// bound port for every client, plugin scans aside.

import { randomUUID } from "node:crypto";
import { existsSync, linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ogsyncHome } from "../config.ts";
import { log } from "../log.ts";

/** A lock this young is live whatever its pid says: its owner may not have bound a port yet. */
export const LOCK_GRACE_MS = 10_000;

export interface DaemonRecord {
  pid: number;
  port: number;
  version: string;
  proto: number;
  startedAt: number;
}

export interface DaemonLock {
  /** False once another process took the lock over; the daemon must then exit. */
  held(): boolean;
  release(): void;
}

interface LockContent {
  pid: number;
  nonce: string;
  at: number;
}

/** Whether a live process with this pid answers as the ogsync daemon. */
export type HolderProbe = (pid: number) => Promise<boolean>;

export function lockFile(): string {
  return join(ogsyncHome(), "daemon.lock");
}

export function recordFile(): string {
  return join(ogsyncHome(), "daemon.json");
}

export function logFile(): string {
  return join(ogsyncHome(), "daemon.log");
}

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as { code?: string }).code === "EPERM";
  }
}

/** null when a live daemon already holds the lock. */
export async function acquireLock(answers: HolderProbe, pid = process.pid): Promise<DaemonLock | null> {
  const file = lockFile();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const mine: LockContent = { pid, nonce: randomUUID(), at: Date.now() };
    if (createExclusive(file, mine)) return lockHandle(mine);
    const seen = readRaw(file);
    if (seen === null) continue;
    if (await isLive(seen, pid, answers)) return null;
    const parked = `${file}.stale-${pid}-${mine.nonce}`;
    try {
      renameSync(file, parked);
    } catch {
      continue; // another contender moved it first
    }
    const taken = readRaw(parked);
    if (taken?.text !== seen.text) {
      // The lock changed hands between our read and our rename: give it back
      // unless someone has already re-created the name, and stand down.
      try {
        linkSync(parked, file);
      } catch {
        // the name is taken again; its owner keeps it
      }
      rmSync(parked, { force: true });
      return null;
    }
    rmSync(parked, { force: true });
    log.info(`took over a stale daemon lock (pid ${seen.content?.pid ?? "?"})`);
  }
  return null;
}

export function lockHolder(): number | null {
  return readRaw(lockFile())?.content?.pid ?? null;
}

function lockHandle(mine: LockContent): DaemonLock {
  const held = (): boolean => {
    const current = readRaw(lockFile())?.content;
    return current?.pid === mine.pid && current.nonce === mine.nonce;
  };
  return {
    held,
    release: () => {
      if (held()) rmSync(lockFile(), { force: true });
      const record = readDaemonRecord();
      if (record?.pid === mine.pid) rmSync(recordFile(), { force: true });
    },
  };
}

function createExclusive(file: string, content: LockContent): boolean {
  const temp = `${file}.${content.pid}.${content.nonce}.tmp`;
  writeFileSync(temp, JSON.stringify(content));
  try {
    linkSync(temp, file);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code !== "EEXIST") throw err;
    return false;
  } finally {
    rmSync(temp, { force: true });
  }
}

function readRaw(file: string): { text: string; content: LockContent | null; mtimeMs: number } | null {
  try {
    const text = readFileSync(file, "utf8");
    return { text, content: parseLock(text), mtimeMs: statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

function parseLock(text: string): LockContent | null {
  const trimmed = text.trim();
  if (/^\d+$/.test(trimmed)) return { pid: Number(trimmed), nonce: "", at: 0 }; // pre-nonce format
  try {
    const raw = JSON.parse(trimmed) as Partial<LockContent>;
    if (typeof raw.pid !== "number" || typeof raw.nonce !== "string" || typeof raw.at !== "number") return null;
    return { pid: raw.pid, nonce: raw.nonce, at: raw.at };
  } catch {
    return null;
  }
}

async function isLive(
  seen: { content: LockContent | null; mtimeMs: number },
  pid: number,
  answers: HolderProbe,
): Promise<boolean> {
  const now = Date.now();
  const content = seen.content;
  if (content === null) return now - seen.mtimeMs < LOCK_GRACE_MS;
  if (content.pid === pid) return false;
  if (now - Math.max(content.at, seen.mtimeMs) < LOCK_GRACE_MS) return true;
  return isAlive(content.pid) && (await answers(content.pid));
}

export function writeDaemonRecord(record: DaemonRecord): void {
  const file = recordFile();
  const temp = `${file}.${record.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temp, file);
}

export function readDaemonRecord(): DaemonRecord | null {
  const file = recordFile();
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<DaemonRecord>;
    if (typeof raw.pid !== "number" || typeof raw.port !== "number") return null;
    return {
      pid: raw.pid,
      port: raw.port,
      version: typeof raw.version === "string" ? raw.version : "?",
      proto: typeof raw.proto === "number" ? raw.proto : 0,
      startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
    };
  } catch {
    return null;
  }
}
