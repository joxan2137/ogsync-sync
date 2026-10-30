// One daemon per machine. `~/.ogsync/daemon.lock` is created exclusively and
// holds the owner's pid, so two sessions racing to spawn a daemon end up with
// one; a lock whose pid is dead is stale and taken over. `daemon.json`
// publishes the bound port for every client, plugin scans aside.

import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ogsyncHome } from "../config.ts";
import { log } from "../log.ts";

export interface DaemonRecord {
  pid: number;
  port: number;
  version: string;
  proto: number;
  startedAt: number;
}

export interface DaemonLock {
  release(): void;
}

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

/** null when a live process already holds the lock. */
export function acquireLock(pid = process.pid): DaemonLock | null {
  const file = lockFile();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, String(pid));
      closeSync(fd);
      return { release: () => releaseLock(pid) };
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
      const holder = lockHolder();
      if (holder !== null && holder !== pid && isAlive(holder)) return null;
      log.info(`removing stale daemon lock (pid ${holder ?? "?"} is gone)`);
      rmSync(file, { force: true });
    }
  }
  return null;
}

export function lockHolder(): number | null {
  try {
    const pid = Number(readFileSync(lockFile(), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function releaseLock(pid: number): void {
  if (lockHolder() === pid) rmSync(lockFile(), { force: true });
  const record = readDaemonRecord();
  if (record?.pid === pid) rmSync(recordFile(), { force: true });
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
