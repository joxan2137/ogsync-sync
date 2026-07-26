// Hybrid filesystem watcher: fs.watch for latency, a periodic mtime sweep for
// truth. Bun's recursive fs.watch is unreliable on Windows, so correctness
// never depends on it — the sweep is the authority and every event funnels
// through the same stamp comparison.

import { watch, readdirSync, statSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { isIgnoredFile } from "./project.ts";

export interface SyncLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const silentLogger: SyncLogger = {
  info() {},
  warn() {},
  error() {},
};

export type FsEventKind = "changed" | "created" | "deleted";

export interface FsEvent {
  /** project-relative path, posix separators */
  file: string;
  kind: FsEventKind;
}

export const DEFAULT_POLL_MS = 700;

export interface WatcherOptions {
  /** absolute project directory */
  dir: string;
  /** project-relative directories to observe */
  dirs: string[];
  debounceMs: number;
  pollMs?: number;
  onEvent: (ev: FsEvent) => void;
  logger?: SyncLogger;
  now?: () => number;
}

interface Stamp {
  mtimeMs: number;
  size: number;
}

export class FsWatcher {
  readonly #opts: WatcherOptions;
  readonly #known = new Map<string, Stamp>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #watchers = new Map<string, FSWatcher>();
  #poll: ReturnType<typeof setInterval> | null = null;
  #sweepTimer: ReturnType<typeof setTimeout> | null = null;
  #recursive = true;

  constructor(opts: WatcherOptions) {
    this.#opts = opts;
  }

  /** Primes the baseline silently, then starts watching. */
  start(): void {
    const dirs = this.#sweep(true);
    for (const root of this.#opts.dirs) {
      if (!this.#addWatch(root, true)) {
        this.#recursive = false;
        break;
      }
    }
    if (!this.#recursive) {
      this.#closeWatchers();
      for (const dir of dirs) this.#addWatch(dir, false);
    }
    const pollMs = this.#opts.pollMs ?? DEFAULT_POLL_MS;
    this.#poll = setInterval(() => this.#sweep(false), pollMs);
    this.#poll.unref?.();
  }

  stop(): void {
    if (this.#poll !== null) clearInterval(this.#poll);
    this.#poll = null;
    if (this.#sweepTimer !== null) clearTimeout(this.#sweepTimer);
    this.#sweepTimer = null;
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
    this.#closeWatchers();
  }

  /** Runs one authority sweep now. */
  sweep(): void {
    this.#sweep(false);
  }

  #now(): number {
    return this.#opts.now?.() ?? Date.now();
  }

  #log(): SyncLogger {
    return this.#opts.logger ?? silentLogger;
  }

  #sweep(prime: boolean): string[] {
    const seen = new Set<string>();
    const dirs: string[] = [];
    for (const root of this.#opts.dirs) this.#walk(root, seen, dirs, prime);
    for (const rel of [...this.#known.keys()]) {
      if (seen.has(rel)) continue;
      this.#known.delete(rel);
      if (!prime) this.#emit(rel, "deleted");
    }
    if (!this.#recursive && !prime) {
      for (const dir of dirs) this.#addWatch(dir, false);
    }
    return dirs;
  }

  #walk(rel: string, seen: Set<string>, dirs: string[], prime: boolean): void {
    let dirents;
    try {
      dirents = readdirSync(join(this.#opts.dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    dirs.push(rel);
    for (const dirent of dirents) {
      const child = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
      if (isIgnoredFile(child)) continue;
      if (dirent.isDirectory()) {
        this.#walk(child, seen, dirs, prime);
        continue;
      }
      if (!dirent.isFile()) continue;
      seen.add(child);
      this.#observe(child, prime);
    }
  }

  #observe(rel: string, prime: boolean): void {
    const stamp = this.#stamp(rel);
    if (stamp === null) {
      const known = this.#known.delete(rel);
      if (known && !prime) this.#emit(rel, "deleted");
      return;
    }
    const prev = this.#known.get(rel);
    if (prev !== undefined && prev.mtimeMs === stamp.mtimeMs && prev.size === stamp.size) return;
    if (prime) {
      this.#known.set(rel, stamp);
      return;
    }
    if (this.#now() - stamp.mtimeMs < this.#opts.debounceMs) {
      this.#touch(rel); // still being written — let it settle
      return;
    }
    this.#known.set(rel, stamp);
    this.#emit(rel, prev === undefined ? "created" : "changed");
  }

  #stamp(rel: string): Stamp | null {
    try {
      const st = statSync(join(this.#opts.dir, rel));
      return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : null;
    } catch {
      return null;
    }
  }

  #touch(rel: string): void {
    const pending = this.#timers.get(rel);
    if (pending !== undefined) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.#timers.delete(rel);
      this.#observe(rel, false);
    }, this.#opts.debounceMs);
    timer.unref?.();
    this.#timers.set(rel, timer);
  }

  #scheduleSweep(): void {
    if (this.#sweepTimer !== null) return;
    this.#sweepTimer = setTimeout(() => {
      this.#sweepTimer = null;
      this.#sweep(false);
    }, this.#opts.debounceMs);
    this.#sweepTimer.unref?.();
  }

  #addWatch(rel: string, recursive: boolean): boolean {
    if (this.#watchers.has(rel)) return true;
    try {
      const w = watch(join(this.#opts.dir, rel), { recursive }, (_event, filename) => {
        this.#scheduleSweep();
        if (typeof filename !== "string" || filename === "") return;
        const sub = filename.replace(/\\/g, "/");
        const child = rel === "" ? sub : `${rel}/${sub}`;
        if (isIgnoredFile(child)) return;
        this.#touch(child);
      });
      w.on("error", (err) => {
        this.#log().warn(`sync: fs.watch failed on ${rel} (${String(err)}); polling only`);
        w.close();
        this.#watchers.delete(rel);
      });
      w.unref?.();
      this.#watchers.set(rel, w);
      return true;
    } catch {
      return false;
    }
  }

  #closeWatchers(): void {
    for (const w of this.#watchers.values()) w.close();
    this.#watchers.clear();
  }

  #emit(rel: string, kind: FsEventKind): void {
    try {
      this.#opts.onEvent({ file: rel, kind });
    } catch (e) {
      this.#log().error(`sync: watcher handler threw for ${rel}: ${String(e)}`);
    }
  }
}
