// Two-way sync engine. Every decision is a three-way diff against the shadow
// (never fs-vs-Studio directly), so "changed on both sides" is detectable and
// nothing is deleted that holds unsynced work.

import { mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import {
  BridgeError,
  contentHash,
  type Bridge,
  type BridgeEvent,
  type ConflictInfo,
  type OgsyncConfig,
  type SessionInfo,
  type SnapshotEntry,
  type SyncChange,
  type SyncControl,
  type SyncStatus,
} from "../proto/types.ts";
import {
  FOLDER_CLASS,
  FOLDER_HASH,
  isSyncableClass,
  isUnder,
  loadProject,
  matchSuffix,
  type NodeKind,
  type ProjectMap,
} from "./project.ts";
import { ShadowStore } from "./shadow.ts";
import { FsWatcher, silentLogger, type FsEvent, type SyncLogger } from "./watcher.ts";

export type { SyncLogger } from "./watcher.ts";

/** Burst coalescing window for both directions; sync.debounce_studio_ms wins. */
export const COALESCE_MS = 300;
/** Bridge has no bind callback; the engine samples bound() at this interval. */
export const BIND_POLL_MS = 1000;

export interface SyncEngineOptions {
  logger?: SyncLogger;
  now?: () => number;
  /** watcher sweep interval (tests shorten it) */
  pollMs?: number;
  coalesceMs?: number;
  bindPollMs?: number;
}

/** Outcome of the three-way diff for one instance path. */
export type Action =
  | "none"
  | "adopt"
  | "forget"
  | "studio-create"
  | "studio-write"
  | "studio-delete"
  | "fs-create"
  | "fs-write"
  | "fs-delete"
  | "conflict";

interface Hashed {
  hash: string;
}

/**
 * Pure three-way diff. `shadow` is the last state both sides agreed on.
 *
 * Deletion safety: a missing file whose Studio side also moved is still sent as
 * a delete — with `baseHash`, so the plugin rejects it and the caller turns the
 * rejection into a conflict. A Studio instance that vanished while the file has
 * unsynced edits is re-created instead of deleting the edits.
 */
export function decide(
  fs: Hashed | null,
  shadow: Hashed | null,
  studio: Hashed | null,
): Action {
  if (fs === null && studio === null) return shadow === null ? "none" : "forget";
  if (shadow === null) {
    if (studio === null) return "studio-create";
    if (fs === null) return "fs-create";
    return fs.hash === studio.hash ? "adopt" : "conflict";
  }
  if (fs === null) return "studio-delete";
  const fsChanged = fs.hash !== shadow.hash;
  if (studio === null) return fsChanged ? "studio-create" : "fs-delete";
  const studioChanged = studio.hash !== shadow.hash;
  if (!fsChanged && !studioChanged) return "none";
  if (fsChanged && !studioChanged) return "studio-write";
  if (!fsChanged && studioChanged) return "fs-write";
  return fs.hash === studio.hash ? "adopt" : "conflict";
}

type StudioEntry = Pick<SnapshotEntry, "class" | "hash" | "runCtx">;

interface ApplyResult {
  ok: boolean;
  conflictHash?: string;
  err?: string;
}

/** One queued sync.apply change plus what to record in the shadow on success. */
interface PendingChange {
  change: SyncChange;
  file: string;
  class: string;
  /** hash to record; null means "drop the shadow entry" (deletes) */
  hash: string | null;
}

type Winner = "fs" | "studio" | "manual";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function kindOf(runCtx: SnapshotEntry["runCtx"]): NodeKind | undefined {
  return runCtx === "plugin" ? "plugin" : undefined;
}

/** Directory an `init.*` file promotes, or null for a plain file. */
function promotedDirOf(rel: string): string | null {
  const slash = rel.lastIndexOf("/");
  if (slash <= 0) return null;
  return matchSuffix(rel.slice(slash + 1))?.name === "init" ? rel.slice(0, slash) : null;
}

function backupPathFor(rel: string, ts: number): string {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const conv = matchSuffix(base);
  const stem = conv === null ? rel : rel.slice(0, rel.length - (base.length - conv.name.length));
  return `${stem}.conflict-${ts}.luau`;
}

function normalizeApply(data: unknown, count: number): ApplyResult[] {
  const list = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.results)
      ? data.results
      : isRecord(data) && Array.isArray(data.changes)
        ? data.changes
        : null;
  if (list === null) {
    const ok = isRecord(data) && data.ok === true;
    return Array.from({ length: count }, () => ({ ok }));
  }
  return Array.from({ length: count }, (_unused, i) => {
    const item: unknown = list[i];
    if (!isRecord(item)) return { ok: item === true };
    const res: ApplyResult = { ok: item.ok !== false };
    if (typeof item.conflictHash === "string") {
      res.ok = false;
      res.conflictHash = item.conflictHash;
    }
    if (typeof item.err === "string") res.err = item.err;
    return res;
  });
}

function pickSource(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return data.length > 0 ? pickSource(data[0]) : null;
  if (!isRecord(data)) return null;
  if (typeof data.source === "string") return data.source;
  if (typeof data.text === "string") return data.text;
  if (Array.isArray(data.lines) && data.lines.every((l) => typeof l === "string")) {
    return (data.lines as string[]).join("\n");
  }
  return null;
}

/** Instance paths sorted so an ancestor always precedes its descendants. */
function byPath<T>(map: Map<string, T>): [string, T][] {
  return [...map].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function studioEventPath(ev: BridgeEvent): string | null {
  switch (ev.ev) {
    case "scriptChanged":
    case "instAdded":
    case "instRemoved":
    case "instRenamed":
      return ev.path;
    default:
      return null;
  }
}

export class SyncEngine implements SyncControl {
  readonly #bridge: Bridge;
  readonly #config: OgsyncConfig;
  readonly #dir: string;
  readonly #opts: SyncEngineOptions;
  readonly #log: SyncLogger;

  readonly #fsQueue = new Map<string, FsEvent>();
  readonly #studioQueue = new Map<string, BridgeEvent>();
  readonly #studioTs = new Map<string, number>();
  readonly #conflicts = new Map<string, ConflictInfo>();

  #project: ProjectMap | null = null;
  #shadow: ShadowStore | null = null;
  #watcher: FsWatcher | null = null;
  #unsubscribe: (() => void) | null = null;
  #bindTimer: ReturnType<typeof setInterval> | null = null;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #chain: Promise<unknown> = Promise.resolve();
  #boundSession: string | null = null;
  #paused = false;
  #started = false;

  constructor(bridge: Bridge, config: OgsyncConfig, projectDir: string, opts: SyncEngineOptions = {}) {
    this.#bridge = bridge;
    this.#config = config;
    this.#dir = projectDir;
    this.#opts = opts;
    this.#log = opts.logger ?? silentLogger;
  }

  // ------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.#started) return;
    if (!this.#config.sync.enabled) {
      this.#log.info("sync: disabled in ogsync.toml");
      return;
    }
    const project = loadProject(this.#dir, this.#config.project.file);
    this.#project = project;
    this.#shadow = await ShadowStore.load(this.#dir);
    project.scanFs();
    this.#noticeIgnored();
    this.#unsubscribe = this.#bridge.onEvent((ev, from) => this.#onStudioEvent(ev, from));
    this.#watcher = new FsWatcher({
      dir: this.#dir,
      dirs: project.watchDirs(),
      debounceMs: this.#config.sync.debounce_fs_ms,
      pollMs: this.#opts.pollMs,
      onEvent: (ev) => this.#onFsEvent(ev),
      logger: this.#log,
      now: this.#opts.now,
    });
    this.#watcher.start();
    this.#started = true;
    const timer = setInterval(() => this.#checkBind(), this.#opts.bindPollMs ?? BIND_POLL_MS);
    timer.unref?.();
    this.#bindTimer = timer;
    this.#checkBind();
  }

  async stop(): Promise<void> {
    if (this.#bindTimer !== null) clearInterval(this.#bindTimer);
    this.#bindTimer = null;
    if (this.#flushTimer !== null) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#watcher?.stop();
    this.#watcher = null;
    this.#started = false;
    await this.#chain.catch(() => undefined);
    if (this.#shadow !== null) await this.#shadow.save();
  }

  /** Flushes queued work now and waits for it — deterministic entry for tests. */
  async drain(): Promise<void> {
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    await this.#enqueue(() => this.#flush());
  }

  // -------------------------------------------------------------- SyncControl

  status(): SyncStatus {
    return {
      enabled: this.#config.sync.enabled,
      paused: this.#paused,
      connected: this.#bridge.bound() !== null,
      projectName: this.#project?.name ?? this.#config.project.name,
      pending: this.#fsQueue.size + this.#studioQueue.size,
      conflicts: [...this.#conflicts.values()],
    };
  }

  pause(): void {
    if (this.#paused) return;
    this.#paused = true;
    this.#log.info("sync: paused");
  }

  resume(): void {
    if (!this.#paused) return;
    this.#paused = false;
    this.#log.info(`sync: resumed (${this.#fsQueue.size + this.#studioQueue.size} queued)`);
    this.#schedule();
  }

  async fullPull(): Promise<string> {
    return this.#enqueueResult(async () => {
      const project = this.#proj();
      const shadow = this.#shad();
      const studio = await this.#snapshot(project.syncRoots());
      const fs = project.scanFs();
      const ts = this.#now();
      let created = 0;
      let written = 0;
      let backed = 0;
      let folders = 0;
      for (const [path, entry] of byPath(studio)) {
        const local = fs.get(path);
        const file =
          local?.file ??
          shadow.get(path)?.file ??
          project.instToFile(path, entry.class, kindOf(entry.runCtx));
        if (file === null) continue;
        if (entry.class === FOLDER_CLASS) {
          await mkdir(join(this.#dir, file), { recursive: true });
          shadow.set(path, { hash: FOLDER_HASH, file, class: FOLDER_CLASS });
          folders++;
          continue;
        }
        const source = await this.#fetchSource(path);
        if (source === null) continue;
        const hash = contentHash(source);
        if (local === undefined) {
          created++;
        } else if (local.hash === hash) {
          shadow.set(path, { hash, file, class: entry.class });
          continue;
        } else {
          if ((await this.#backupLocal(file, ts)) !== undefined) backed++;
          written++;
        }
        await this.#writeLocal(file, source);
        shadow.set(path, { hash, file, class: entry.class });
      }
      const extra = [...fs.keys()].filter((p) => !studio.has(p));
      await shadow.save();
      return `pull: ${created} created, ${written} overwritten (${backed} backed up), ${folders} folders, ${extra.length} fs-only kept`;
    });
  }

  async fullPush(): Promise<string> {
    return this.#enqueueResult(async () => {
      const project = this.#proj();
      const shadow = this.#shad();
      const studio = await this.#snapshot(project.syncRoots());
      const fs = project.scanFs();
      const pending: PendingChange[] = [];
      for (const [path, entry] of byPath(fs)) {
        const remote = studio.get(path);
        if (remote !== undefined && remote.hash === entry.hash) {
          shadow.set(path, { hash: entry.hash, file: entry.file, class: entry.class });
          continue;
        }
        if (entry.class === FOLDER_CLASS) {
          if (remote !== undefined) continue;
          pending.push({
            change: { kind: "create", path, class: FOLDER_CLASS },
            file: entry.file,
            class: FOLDER_CLASS,
            hash: FOLDER_HASH,
          });
          continue;
        }
        pending.push({
          change: {
            kind: remote === undefined ? "create" : "write",
            path,
            class: entry.class,
            source: entry.source,
          },
          file: entry.file,
          class: entry.class,
          hash: entry.hash,
        });
      }
      let dropped = 0;
      let extra = 0;
      for (const path of [...studio.keys()].sort()) {
        if (fs.has(path)) continue;
        const known = shadow.get(path);
        if (known === undefined) {
          extra++;
          continue;
        }
        pending.push({
          change: { kind: "delete", path },
          file: known.file,
          class: known.class,
          hash: null,
        });
        dropped++;
      }
      await this.#pushChanges(pending);
      await shadow.save();
      return `push: ${pending.length - dropped} written, ${dropped} deleted, ${extra} studio-only kept`;
    });
  }

  async resolve(file: string, keep: "fs" | "studio"): Promise<string> {
    return this.#enqueueResult(async () => {
      const project = this.#proj();
      const shadow = this.#shad();
      const rel = this.#toRel(file);
      const tracked = shadow.findByFile(rel);
      const mapped = project.fileToInst(rel);
      const path = tracked?.path ?? mapped?.path ?? null;
      if (path === null) throw new BridgeError("BADARG", `not a synced file: ${file}`);
      const cls = tracked?.entry.class ?? mapped?.class ?? "ModuleScript";
      const ts = this.#now();
      if (keep === "fs") {
        const local = await this.#readLocal(rel);
        if (local === null) {
          await this.#pushChanges([
            { change: { kind: "delete", path }, file: rel, class: cls, hash: null },
          ]);
          this.#clearConflict(rel, ts, "kept-fs");
          return `resolved ${rel}: deleted ${path} in Studio`;
        }
        const hash = contentHash(local);
        await this.#pushChanges([
          {
            change: {
              kind: shadow.has(path) ? "write" : "create",
              path,
              class: cls,
              source: local,
            },
            file: rel,
            class: cls,
            hash,
          },
        ]);
        await shadow.save();
        this.#clearConflict(rel, ts, "kept-fs");
        return `resolved ${rel}: kept fs → ${path} (${hash})`;
      }
      const source = await this.#fetchSource(path);
      if (source === null) throw new BridgeError("STUDIO", `could not read ${path}`);
      await this.#writeLocal(rel, source);
      const hash = contentHash(source);
      shadow.set(path, { hash, file: rel, class: cls });
      await shadow.save();
      this.#clearConflict(rel, ts, "kept-studio");
      return `resolved ${rel}: kept Studio → ${rel} (${hash})`;
    });
  }

  // --------------------------------------------------------------- reconcile

  /** Three-way merge of fs, shadow and a fresh Studio snapshot. */
  async reconcile(): Promise<void> {
    const project = this.#proj();
    const shadow = this.#shad();
    const roots = project.syncRoots();
    if (roots.length === 0) {
      this.#log.warn("sync: project maps no roots; nothing to sync");
      return;
    }
    const studio = await this.#snapshot(roots);
    const fs = project.scanFs();
    const paths = new Set([...fs.keys(), ...shadow.paths(), ...studio.keys()]);
    const pending: PendingChange[] = [];
    const conflicted: { path: string; pending: PendingChange; studioHash: string }[] = [];
    const tally = new Map<Action, number>();
    // Sorted: an ancestor path is a prefix of its descendants, so parents are
    // created before children within one batch.
    for (const path of [...paths].sort()) {
      const local = fs.get(path) ?? null;
      const base = shadow.get(path) ?? null;
      const remote = studio.get(path) ?? null;
      const action = decide(local, base, remote);
      tally.set(action, (tally.get(action) ?? 0) + 1);
      switch (action) {
        case "none":
          break;
        case "forget":
          shadow.delete(path);
          break;
        case "adopt":
          if (local !== null) {
            shadow.set(path, { hash: local.hash, file: local.file, class: local.class });
          }
          break;
        case "studio-create":
        case "studio-write":
          if (local === null) break;
          pending.push({
            change: {
              kind: action === "studio-create" ? "create" : "write",
              path,
              class: local.class,
              ...(local.class === FOLDER_CLASS ? {} : { source: local.source }),
              ...(base === null ? {} : { baseHash: base.hash }),
            },
            file: local.file,
            class: local.class,
            hash: local.hash,
          });
          break;
        case "studio-delete":
          if (base === null) break;
          pending.push({
            change: { kind: "delete", path, baseHash: base.hash },
            file: base.file,
            class: base.class,
            hash: null,
          });
          break;
        case "fs-create":
        case "fs-write":
          if (remote !== null) await this.#pullOne(path, remote);
          break;
        case "fs-delete":
          if (local !== null && (await this.#deleteLocal(local.file))) shadow.delete(path);
          break;
        case "conflict":
          if (local === null || remote === null) break;
          conflicted.push({
            path,
            studioHash: remote.hash,
            pending: {
              change: {
                kind: "write",
                path,
                class: local.class,
                source: local.source,
                baseHash: base?.hash ?? remote.hash,
              },
              file: local.file,
              class: local.class,
              hash: local.hash,
            },
          });
          break;
      }
    }
    await this.#pushChanges(pending);
    for (const c of conflicted) {
      // No Studio timestamp exists at reconcile: prefer-newest degrades to
      // prefer-fs, with the Studio version kept as a .conflict backup.
      await this.#conflictFsSide(c.pending, c.studioHash, undefined);
    }
    await shadow.save();
    const summary = [...tally]
      .filter(([action]) => action !== "none")
      .map(([action, n]) => `${action}=${n}`)
      .join(" ");
    this.#log.info(`sync: reconciled ${paths.size} paths${summary === "" ? "" : ` (${summary})`}`);
  }

  // ------------------------------------------------------------------ queues

  #onFsEvent(ev: FsEvent): void {
    this.#fsQueue.set(ev.file, ev);
    this.#schedule();
  }

  #onStudioEvent(ev: BridgeEvent, from: SessionInfo): void {
    this.#checkBind();
    const bound = this.#bridge.bound();
    if (bound === null || bound.session !== from.session) return;
    if (ev.ev === "syncToggle") {
      if (ev.paused) this.pause();
      else this.resume();
      return;
    }
    if (ev.ev === "resolveConflict") {
      void this.resolve(ev.file, ev.keep).catch((e) =>
        this.#log.warn(`sync: panel resolve ${ev.file} failed: ${e instanceof Error ? e.message : e}`),
      );
      return;
    }
    const path = studioEventPath(ev);
    if (path === null || this.#project === null) return;
    const roots = this.#project.syncRoots();
    if (!roots.some((root) => isUnder(path, root))) return;
    if (ev.ev === "scriptChanged") this.#studioTs.set(path, ev.ts);
    this.#studioQueue.set(`${ev.ev}:${path}`, ev);
    this.#schedule();
  }

  #schedule(): void {
    if (!this.#started || this.#paused || this.#flushTimer !== null) return;
    const timer = setTimeout(() => {
      this.#flushTimer = null;
      void this.#enqueue(() => this.#flush());
    }, this.#opts.coalesceMs ?? this.#config.sync.debounce_studio_ms ?? COALESCE_MS);
    timer.unref?.();
    this.#flushTimer = timer;
  }

  #enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.#chain.then(work, work).catch((e: unknown) => {
      this.#log.error(`sync: ${msgOf(e)}`);
    });
    this.#chain = run;
    return run;
  }

  #enqueueResult<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(work, work);
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #checkBind(): void {
    const session = this.#bridge.bound()?.session ?? null;
    if (session === this.#boundSession) return;
    this.#boundSession = session;
    if (session === null) {
      this.#log.info("sync: no bound Studio session");
      return;
    }
    void this.#enqueue(() => this.reconcile());
  }

  async #flush(): Promise<void> {
    if (this.#paused || this.#project === null || this.#shadow === null) return;
    const studioEvents = [...this.#studioQueue.values()];
    this.#studioQueue.clear();
    for (const ev of studioEvents) await this.#applyStudioEvent(ev);
    const fsEvents = [...this.#fsQueue.values()];
    if (fsEvents.length > 0) {
      if (this.#bridge.bound() === null) {
        this.#log.info(`sync: ${fsEvents.length} fs change(s) queued until Studio connects`);
      } else {
        this.#fsQueue.clear();
        try {
          await this.#applyFsEvents(fsEvents);
        } catch (e) {
          this.#requeueFs(fsEvents);
          this.#log.warn(`sync: fs→studio batch deferred: ${msgOf(e)}`);
        }
      }
    }
    if (studioEvents.length > 0 || fsEvents.length > 0) await this.#shad().save();
  }

  #requeueFs(events: FsEvent[]): void {
    for (const ev of events) {
      if (!this.#fsQueue.has(ev.file)) this.#fsQueue.set(ev.file, ev);
    }
  }

  // ------------------------------------------------------------- fs → studio

  async #applyFsEvents(events: FsEvent[]): Promise<void> {
    const project = this.#proj();
    const shadow = this.#shad();
    const pending: PendingChange[] = [];
    const queued = new Set<string>();
    for (const ev of events) {
      const mapped = project.fileToInst(ev.file);
      // Folders and unsupported types only ever come from a full scan.
      if (mapped === null || mapped.class === FOLDER_CLASS) continue;
      const base = shadow.get(mapped.path);
      if (ev.kind === "deleted") {
        if (base === undefined) continue;
        pending.push({
          change: { kind: "delete", path: mapped.path, baseHash: base.hash },
          file: ev.file,
          class: base.class,
          hash: null,
        });
        queued.add(mapped.path);
        continue;
      }
      const source = await this.#readLocal(ev.file);
      if (source === null) continue;
      const hash = contentHash(source);
      if (base?.hash === hash) continue; // echo of our own write
      if (base === undefined) {
        for (const ancestor of project.ancestorsOf(mapped.path)) {
          if (shadow.has(ancestor) || queued.has(ancestor)) continue;
          if (this.#classOfInst(ancestor) !== FOLDER_CLASS) continue;
          const dir = project.instToFile(ancestor, FOLDER_CLASS);
          if (dir === null) continue;
          pending.push({
            change: { kind: "create", path: ancestor, class: FOLDER_CLASS },
            file: dir,
            class: FOLDER_CLASS,
            hash: FOLDER_HASH,
          });
          queued.add(ancestor);
        }
      }
      pending.push({
        change: {
          kind: base === undefined ? "create" : "write",
          path: mapped.path,
          class: mapped.class,
          source,
          ...(base === undefined ? {} : { baseHash: base.hash }),
        },
        file: ev.file,
        class: mapped.class,
        hash,
      });
      queued.add(mapped.path);
    }
    await this.#pushChanges(pending);
  }

  async #pushChanges(pending: PendingChange[]): Promise<void> {
    if (pending.length === 0) return;
    const results = await this.#callApply(pending.map((p) => p.change));
    for (const [i, p] of pending.entries()) {
      const res = results[i] ?? { ok: false, err: "no result" };
      if (res.ok) {
        this.#record(p);
        continue;
      }
      if (res.conflictHash !== undefined) {
        await this.#conflictFsSide(p, res.conflictHash, this.#studioTs.get(p.change.path));
        continue;
      }
      this.#log.warn(
        `sync: studio rejected ${p.change.kind} ${p.change.path}: ${res.err ?? "unknown"}`,
      );
    }
  }

  async #callApply(changes: SyncChange[]): Promise<ApplyResult[]> {
    const data = await this.#bridge.call("sync.apply", { changes });
    return normalizeApply(data, changes.length);
  }

  #record(p: PendingChange): void {
    if (p.hash === null) {
      this.#forget(p.change.path);
      return;
    }
    this.#shad().set(p.change.path, { hash: p.hash, file: p.file, class: p.class });
  }

  // ------------------------------------------------------------- studio → fs

  async #applyStudioEvent(ev: BridgeEvent): Promise<void> {
    try {
      switch (ev.ev) {
        case "scriptChanged":
          await this.#studioWrite(ev.path, ev.hash, ev.source, ev.ts);
          break;
        case "instAdded":
          await this.#studioAdd(ev.path, ev.class);
          break;
        case "instRemoved":
          await this.#studioRemove(ev.path);
          break;
        case "instRenamed":
          await this.#studioRename(ev.oldPath, ev.path);
          break;
        default:
          break;
      }
    } catch (e) {
      this.#log.warn(`sync: studio ${ev.ev} failed: ${msgOf(e)}`);
    }
  }

  async #studioWrite(
    path: string,
    hash: string,
    source: string | undefined,
    studioTs: number | undefined,
    cls?: string,
  ): Promise<void> {
    const project = this.#proj();
    const shadow = this.#shad();
    const base = shadow.get(path);
    if (base?.hash === hash) return; // echo of a change we applied
    const file = base?.file ?? project.instToFile(path, cls);
    if (file === null) return;
    const klass = cls ?? base?.class ?? project.fileToInst(file)?.class ?? "ModuleScript";
    const local = await this.#readLocal(file);
    if (local !== null) {
      const localHash = contentHash(local);
      if (localHash === hash) {
        shadow.set(path, { hash, file, class: klass });
        return;
      }
      if (base === undefined || localHash !== base.hash) {
        await this.#conflictStudioSide(path, file, klass, hash, source, studioTs);
        return;
      }
    }
    const src = source ?? (await this.#fetchSource(path));
    if (src === null) return;
    await this.#writeLocal(file, src);
    shadow.set(path, { hash: contentHash(src), file, class: klass });
  }

  async #studioAdd(path: string, cls: string): Promise<void> {
    if (!isSyncableClass(cls)) return; // v1 syncs scripts and folders only
    if (cls === FOLDER_CLASS) {
      const dir = this.#proj().instToFile(path, FOLDER_CLASS);
      if (dir === null) return;
      await mkdir(join(this.#dir, dir), { recursive: true });
      this.#shad().set(path, { hash: FOLDER_HASH, file: dir, class: FOLDER_CLASS });
      return;
    }
    const source = await this.#fetchSource(path);
    if (source === null) return;
    await this.#studioWrite(path, contentHash(source), source, this.#now(), cls);
  }

  async #studioRemove(path: string): Promise<void> {
    const project = this.#proj();
    const shadow = this.#shad();
    const base = shadow.get(path);
    const file = base?.file ?? project.instToFile(path);
    if (file === null) return;
    const st = await this.#statOf(file);
    if (st === null) {
      this.#forget(path);
      return;
    }
    if (st.isDirectory()) {
      if (await this.#deleteLocal(file)) this.#forget(path);
      return;
    }
    const local = await this.#readLocal(file);
    if (local === null) {
      this.#forget(path);
      return;
    }
    if (base === undefined) {
      this.#log.warn(`sync: ${file} was never synced; not deleting it for ${path}`);
      return;
    }
    if (contentHash(local) !== base.hash) {
      await this.#conflictDeleteVsLocal(path, file, base.class, local);
      return;
    }
    if (await this.#deleteLocal(file)) this.#forget(path);
  }

  async #studioRename(oldPath: string, newPath: string): Promise<void> {
    const project = this.#proj();
    const shadow = this.#shad();
    const base = shadow.get(oldPath);
    const oldFile = base?.file ?? project.instToFile(oldPath);
    const cls = base?.class ?? (oldFile === null ? null : project.fileToInst(oldFile)?.class) ?? "ModuleScript";
    if (oldFile === null) {
      await this.#studioAdd(newPath, cls);
      return;
    }
    const promoted = promotedDirOf(oldFile);
    const oldTarget = promoted ?? oldFile;
    const newTarget = project.instToFile(newPath, promoted === null ? cls : FOLDER_CLASS);
    if (newTarget === null || newTarget === oldTarget) return;
    if ((await this.#statOf(oldTarget)) === null) {
      await this.#studioAdd(newPath, cls);
      return;
    }
    await mkdir(dirname(join(this.#dir, newTarget)), { recursive: true });
    await rename(join(this.#dir, oldTarget), join(this.#dir, newTarget));
    for (const [path, entry] of shadow.entries()) {
      if (!isUnder(path, oldPath)) continue;
      shadow.delete(path);
      const movedPath = path === oldPath ? newPath : `${newPath}${path.slice(oldPath.length)}`;
      const movedFile = entry.file.startsWith(`${oldTarget}/`)
        ? `${newTarget}${entry.file.slice(oldTarget.length)}`
        : entry.file === oldTarget
          ? newTarget
          : entry.file;
      shadow.set(movedPath, { ...entry, file: movedFile });
    }
  }

  async #pullOne(path: string, remote: StudioEntry): Promise<void> {
    const project = this.#proj();
    const shadow = this.#shad();
    const file =
      shadow.get(path)?.file ?? project.instToFile(path, remote.class, kindOf(remote.runCtx));
    if (file === null) return;
    if (remote.class === FOLDER_CLASS) {
      await mkdir(join(this.#dir, file), { recursive: true });
      shadow.set(path, { hash: FOLDER_HASH, file, class: FOLDER_CLASS });
      return;
    }
    const source = await this.#fetchSource(path);
    if (source === null) return;
    await this.#writeLocal(file, source);
    shadow.set(path, { hash: contentHash(source), file, class: remote.class });
  }

  // ------------------------------------------------------------- conflicts

  #policyWinner(fileMtimeMs: number | null, studioTs: number | undefined): Winner {
    switch (this.#config.sync.conflict) {
      case "prefer-fs":
        return "fs";
      case "prefer-studio":
        return "studio";
      case "manual":
        return "manual";
      default:
        if (studioTs === undefined || fileMtimeMs === null) return "fs";
        return studioTs > fileMtimeMs ? "studio" : "fs";
    }
  }

  /** An fs-originated change the plugin rejected: Studio moved under us. */
  async #conflictFsSide(
    p: PendingChange,
    studioHash: string,
    studioTs: number | undefined,
  ): Promise<void> {
    const path = p.change.path;
    const studioSource = await this.#fetchSource(path);
    const winner = this.#policyWinner(await this.#mtimeOf(p.file), studioTs);
    const ts = this.#now();
    if (winner === "studio") {
      if (studioSource === null) {
        this.#log.warn(`sync: cannot resolve ${p.file}: Studio source unavailable`);
        return;
      }
      const backup = await this.#backupLocal(p.file, ts);
      await this.#writeLocal(p.file, studioSource);
      this.#shad().set(path, {
        hash: contentHash(studioSource),
        file: p.file,
        class: p.class,
      });
      this.#noteConflict(p.file, path, ts, "kept-studio", backup);
      return;
    }
    const backup =
      studioSource === null ? undefined : await this.#backup(p.file, studioSource, ts);
    if (winner === "manual") {
      this.#noteConflict(p.file, path, ts, "pending", backup);
      return;
    }
    const forced: PendingChange = { ...p, change: { ...p.change, baseHash: studioHash } };
    const [res] = await this.#callApply([forced.change]);
    if (res?.ok === true) {
      this.#record(forced);
      this.#noteConflict(p.file, path, ts, "kept-fs", backup);
      return;
    }
    this.#log.warn(`sync: forced ${p.change.kind} ${path} rejected: ${res?.err ?? "unknown"}`);
  }

  /** A Studio edit that would overwrite unsynced local work. */
  async #conflictStudioSide(
    path: string,
    file: string,
    cls: string,
    studioHash: string,
    source: string | undefined,
    studioTs: number | undefined,
  ): Promise<void> {
    const winner = this.#policyWinner(await this.#mtimeOf(file), studioTs);
    const ts = this.#now();
    const studioSource = source ?? (await this.#fetchSource(path));
    if (winner === "studio") {
      if (studioSource === null) {
        this.#log.warn(`sync: cannot resolve ${file}: Studio source unavailable`);
        return;
      }
      const backup = await this.#backupLocal(file, ts);
      await this.#writeLocal(file, studioSource);
      this.#shad().set(path, { hash: contentHash(studioSource), file, class: cls });
      this.#noteConflict(file, path, ts, "kept-studio", backup);
      return;
    }
    const backup = studioSource === null ? undefined : await this.#backup(file, studioSource, ts);
    if (winner === "manual") {
      this.#noteConflict(file, path, ts, "pending", backup);
      return;
    }
    const local = await this.#readLocal(file);
    if (local === null) return;
    const p: PendingChange = {
      change: { kind: "write", path, class: cls, source: local, baseHash: studioHash },
      file,
      class: cls,
      hash: contentHash(local),
    };
    const [res] = await this.#callApply([p.change]);
    if (res?.ok === true) {
      this.#record(p);
      this.#noteConflict(file, path, ts, "kept-fs", backup);
      return;
    }
    this.#log.warn(`sync: forced write ${path} rejected: ${res?.err ?? "unknown"}`);
  }

  /** Studio removed an instance whose file holds unsynced edits. */
  async #conflictDeleteVsLocal(
    path: string,
    file: string,
    cls: string,
    local: string,
  ): Promise<void> {
    const winner = this.#policyWinner(await this.#mtimeOf(file), this.#studioTs.get(path));
    const ts = this.#now();
    if (winner === "studio") {
      const backup = await this.#backupLocal(file, ts);
      if (await this.#deleteLocal(file)) this.#forget(path);
      this.#noteConflict(file, path, ts, "kept-studio", backup);
      return;
    }
    if (winner === "manual") {
      this.#noteConflict(file, path, ts, "pending");
      return;
    }
    await this.#pushChanges([
      {
        change: { kind: "create", path, class: cls, source: local },
        file,
        class: cls,
        hash: contentHash(local),
      },
    ]);
    this.#noteConflict(file, path, ts, "kept-fs");
  }

  #noteConflict(
    file: string,
    path: string,
    ts: number,
    resolution: ConflictInfo["resolution"],
    backupFile?: string,
  ): void {
    const info: ConflictInfo = { file, path, ts, resolution };
    if (backupFile !== undefined) info.backupFile = backupFile;
    this.#conflicts.set(file, info);
    const where = backupFile === undefined ? "" : ` (backup ${backupFile})`;
    this.#log.warn(`sync: conflict ${file} ⇄ ${path} → ${resolution}${where}`);
    this.#pushConflicts();
  }

  #clearConflict(file: string, ts: number, resolution: ConflictInfo["resolution"]): void {
    this.#conflicts.delete(file);
    this.#log.info(`sync: ${file} resolved ${resolution} at ${ts}`);
    this.#pushConflicts();
  }

  /** Keeps the plugin connection panel's conflict list current. Fire-and-forget. */
  #pushConflicts(): void {
    const list = [...this.#conflicts.values()]
      .filter((c) => c.resolution === "pending")
      .map((c) => ({ file: c.file, path: c.path, ts: c.ts }));
    void this.#bridge
      .call("sync.conflicts", { list }, { timeoutMs: 5000 })
      .catch(() => undefined);
  }

  // ---------------------------------------------------------------- plumbing

  #proj(): ProjectMap {
    if (this.#project === null) throw new Error("sync engine not started");
    return this.#project;
  }

  #shad(): ShadowStore {
    if (this.#shadow === null) throw new Error("sync engine not started");
    return this.#shadow;
  }

  #now(): number {
    return this.#opts.now?.() ?? Date.now();
  }

  #classOfInst(path: string): string {
    const known = this.#shad().get(path);
    if (known !== undefined) return known.class;
    const file = this.#proj().instToFile(path);
    if (file === null) return FOLDER_CLASS;
    return this.#proj().fileToInst(file)?.class ?? FOLDER_CLASS;
  }

  #forget(path: string): void {
    const shadow = this.#shad();
    for (const tracked of shadow.paths()) {
      if (isUnder(tracked, path)) shadow.delete(tracked);
    }
  }

  #noticeIgnored(): void {
    const counts = this.#proj().ignoredCounts();
    if (counts.size === 0) return;
    let total = 0;
    const parts: string[] = [];
    for (const [ext, n] of [...counts].sort((a, b) => b[1] - a[1])) {
      total += n;
      parts.push(`${ext} ${n}`);
    }
    this.#log.info(
      `sync: ignoring ${total} unsupported file(s) (${parts.join(", ")}); v1 syncs scripts and folders`,
    );
  }

  #toRel(file: string): string {
    const posix = file.replace(/\\/g, "/");
    if (!isAbsolute(file)) return posix.replace(/^\.\//, "");
    return relative(this.#dir, file).replace(/\\/g, "/");
  }

  async #snapshot(roots: string[]): Promise<Map<string, StudioEntry>> {
    const data = await this.#bridge.call("sync.snapshot", { roots });
    const list = Array.isArray(data)
      ? data
      : isRecord(data) && Array.isArray(data.entries)
        ? data.entries
        : [];
    const out = new Map<string, StudioEntry>();
    for (const item of list as unknown[]) {
      if (!isRecord(item) || typeof item.path !== "string") continue;
      const cls = typeof item.class === "string" ? item.class : "";
      if (!isSyncableClass(cls)) continue;
      const hash =
        cls === FOLDER_CLASS ? FOLDER_HASH : typeof item.hash === "string" ? item.hash : "";
      const entry: StudioEntry = { class: cls, hash };
      if (
        item.runCtx === "server" ||
        item.runCtx === "client" ||
        item.runCtx === "module" ||
        item.runCtx === "plugin"
      ) {
        entry.runCtx = item.runCtx;
      }
      out.set(item.path, entry);
    }
    return out;
  }

  async #fetchSource(path: string): Promise<string | null> {
    try {
      // limit must cover any script; the plugin default of 200 lines would
      // silently truncate what we write to disk.
      const source = pickSource(
        await this.#bridge.call("script.read", { path, limit: 1_000_000 }),
      );
      if (source === null) this.#log.warn(`sync: script.read returned no source for ${path}`);
      return source;
    } catch (e) {
      this.#log.warn(`sync: script.read ${path} failed: ${msgOf(e)}`);
      return null;
    }
  }

  async #readLocal(rel: string): Promise<string | null> {
    try {
      return await readFile(join(this.#dir, rel), "utf8");
    } catch {
      return null;
    }
  }

  async #writeLocal(rel: string, source: string): Promise<void> {
    const abs = join(this.#dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    // dot-prefixed temp: the watcher ignores dotfiles, so no echo event
    const tmp = join(dirname(abs), `.${basename(abs)}.ogsync-tmp`);
    await writeFile(tmp, source, "utf8");
    await rename(tmp, abs);
  }

  async #backup(rel: string, source: string, ts: number): Promise<string> {
    const target = backupPathFor(rel, ts);
    await this.#writeLocal(target, source);
    return target;
  }

  async #backupLocal(rel: string, ts: number): Promise<string | undefined> {
    const source = await this.#readLocal(rel);
    return source === null ? undefined : this.#backup(rel, source, ts);
  }

  async #statOf(rel: string): Promise<Stats | null> {
    try {
      return await stat(join(this.#dir, rel));
    } catch {
      return null;
    }
  }

  async #mtimeOf(rel: string): Promise<number | null> {
    return (await this.#statOf(rel))?.mtimeMs ?? null;
  }

  async #deleteLocal(rel: string): Promise<boolean> {
    if (this.#proj().isMountPath(rel)) {
      this.#log.warn(`sync: refusing to delete mapped root ${rel}`);
      return false;
    }
    const st = await this.#statOf(rel);
    if (st === null) return true;
    try {
      if (st.isDirectory()) await rmdir(join(this.#dir, rel));
      else await unlink(join(this.#dir, rel));
      return true;
    } catch (e) {
      this.#log.warn(`sync: kept ${rel}: ${msgOf(e)}`);
      return false;
    }
  }
}
