import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BridgeError,
  CONFIG_DEFAULTS,
  contentHash,
  type Bridge,
  type BridgeEvent,
  type OgsyncConfig,
  type OpName,
  type SessionInfo,
  type SnapshotEntry,
  type SyncChange,
} from "../proto/types.ts";
import { FOLDER_CLASS, FOLDER_HASH } from "./project.ts";
import { ShadowStore } from "./shadow.ts";
import { SyncEngine, decide, type Action } from "./engine.ts";

const SHARED = "game.ReplicatedStorage.Shared";
const PROJECT = JSON.stringify({
  name: "T",
  tree: { ReplicatedStorage: { Shared: { $path: "src/shared" } } },
});

const SESSION: SessionInfo = {
  session: "sess-1",
  role: "edit",
  pluginVersion: "0.1.0",
  placeId: 2,
  placeName: "Place2",
  connectedAt: 0,
  lastSeen: 0,
};

// ------------------------------------------------------------------ decide table

const HASHES = { A: "aaaaaaaaaaaaaaaa", B: "bbbbbbbbbbbbbbbb" } as const;
type Cell = "-" | "A" | "B";

function cell(c: Cell): { hash: string } | null {
  return c === "-" ? null : { hash: HASHES[c] };
}

// fs, shadow, studio → expected action. All 3^3 content combinations.
const TABLE: [Cell, Cell, Cell, Action][] = [
  ["-", "-", "-", "none"],
  ["-", "-", "A", "fs-create"],
  ["-", "-", "B", "fs-create"],
  ["A", "-", "-", "studio-create"],
  ["A", "-", "A", "adopt"],
  ["A", "-", "B", "conflict"],
  ["B", "-", "-", "studio-create"],
  ["B", "-", "A", "conflict"],
  ["B", "-", "B", "adopt"],
  ["-", "A", "-", "forget"],
  ["-", "A", "A", "studio-delete"],
  ["-", "A", "B", "studio-delete"],
  ["A", "A", "-", "fs-delete"],
  ["A", "A", "A", "none"],
  ["A", "A", "B", "fs-write"],
  ["B", "A", "-", "studio-create"],
  ["B", "A", "A", "studio-write"],
  ["B", "A", "B", "adopt"],
  ["-", "B", "-", "forget"],
  ["-", "B", "A", "studio-delete"],
  ["-", "B", "B", "studio-delete"],
  ["A", "B", "-", "studio-create"],
  ["A", "B", "A", "adopt"],
  ["A", "B", "B", "studio-write"],
  ["B", "B", "-", "fs-delete"],
  ["B", "B", "A", "fs-write"],
  ["B", "B", "B", "none"],
];

describe("decide (three-way diff)", () => {
  test("covers every fs/shadow/studio combination", () => {
    expect(TABLE).toHaveLength(27);
    expect(new Set(TABLE.map((r) => r.slice(0, 3).join(""))).size).toBe(27);
  });

  for (const [fs, shadow, studio, expected] of TABLE) {
    test(`fs=${fs} shadow=${shadow} studio=${studio} → ${expected}`, () => {
      expect(decide(cell(fs), cell(shadow), cell(studio))).toBe(expected);
    });
  }
});

// ------------------------------------------------------------------ fake bridge

interface StudioInstance {
  class: string;
  hash: string;
  source: string;
}

class FakeBridge implements Bridge {
  readonly calls: { op: OpName; args: unknown }[] = [];
  readonly studio = new Map<string, StudioInstance>();
  session: SessionInfo | null = SESSION;
  readonly #listeners = new Set<(ev: BridgeEvent, from: SessionInfo) => void>();

  put(path: string, cls: string, source: string): void {
    this.studio.set(path, {
      class: cls,
      hash: cls === FOLDER_CLASS ? FOLDER_HASH : contentHash(source),
      source,
    });
  }

  countOf(op: OpName): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  async call(op: OpName, args: unknown): Promise<unknown> {
    this.calls.push({ op, args });
    if (op === "sync.snapshot") {
      const entries: SnapshotEntry[] = [...this.studio].map(([path, inst]) => ({
        path,
        class: inst.class,
        hash: inst.hash,
      }));
      return entries;
    }
    if (op === "script.read") {
      const { path } = args as { path: string };
      const inst = this.studio.get(path);
      if (inst === undefined) throw new BridgeError("NOPATH", path);
      return { path, source: inst.source, hash: inst.hash };
    }
    if (op === "sync.apply") {
      const { changes } = args as { changes: SyncChange[] };
      return changes.map((c) => this.#apply(c));
    }
    throw new BridgeError("BADARG", `unexpected op ${op}`);
  }

  bound(): SessionInfo | null {
    return this.session;
  }

  sessions(): SessionInfo[] {
    return this.session === null ? [] : [this.session];
  }

  onEvent(fn: (ev: BridgeEvent, from: SessionInfo) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  emit(ev: BridgeEvent): void {
    for (const fn of this.#listeners) fn(ev, this.session ?? SESSION);
  }

  // Mirrors the plugin: baseHash mismatch ⇒ reject with the current hash.
  #apply(c: SyncChange): { ok: boolean; conflictHash?: string } {
    const current = this.studio.get(c.path);
    if (c.baseHash !== undefined && current !== undefined && current.hash !== c.baseHash) {
      return { ok: false, conflictHash: current.hash };
    }
    if (c.kind === "delete") {
      this.studio.delete(c.path);
      return { ok: true };
    }
    if (c.kind === "rename") {
      if (current !== undefined) this.studio.delete(c.path);
      return { ok: true };
    }
    this.put(c.path, c.class ?? current?.class ?? "ModuleScript", c.source ?? "");
    return { ok: true };
  }
}

// ---------------------------------------------------------------------- harness

const temps: string[] = [];
const engines: SyncEngine[] = [];

afterEach(async () => {
  while (engines.length > 0) await engines.pop()?.stop();
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ogsync-engine-"));
  temps.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }
  return dir;
}

function makeConfig(sync: Partial<OgsyncConfig["sync"]> = {}): OgsyncConfig {
  return {
    ...CONFIG_DEFAULTS,
    project: { name: "T", file: "default.project.json" },
    sync: {
      enabled: true,
      conflict: "prefer-fs",
      debounce_fs_ms: 15,
      debounce_studio_ms: 50,
      ...sync,
    },
  };
}

interface Harness {
  dir: string;
  bridge: FakeBridge;
  engine: SyncEngine;
  logs: string[];
  file: (rel: string) => string;
  read: (rel: string) => string | null;
}

function harness(files: Record<string, string>, sync?: Partial<OgsyncConfig["sync"]>): Harness {
  const dir = fixture({ "default.project.json": PROJECT, ...files });
  const bridge = new FakeBridge();
  const logs: string[] = [];
  const engine = new SyncEngine(bridge, makeConfig(sync), dir, {
    pollMs: 40,
    coalesceMs: 10,
    bindPollMs: 60,
    logger: {
      info: (m) => logs.push(`info ${m}`),
      warn: (m) => logs.push(`warn ${m}`),
      error: (m) => logs.push(`error ${m}`),
    },
  });
  engines.push(engine);
  return {
    dir,
    bridge,
    engine,
    logs,
    file: (rel) => join(dir, rel),
    read: (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : null),
  };
}

async function waitFor(check: () => boolean, label: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function backupsIn(dir: string, stem: string): string[] {
  return readdirSync(join(dir, "src/shared")).filter((f) =>
    new RegExp(`^${stem}\\.conflict-\\d+\\.luau$`).test(f),
  );
}

function backupIn(dir: string, stem: string): string | undefined {
  return backupsIn(dir, stem)[0];
}

function shadowOf(dir: string): Record<string, { hash: string; file: string; class: string }> {
  const raw: unknown = JSON.parse(readFileSync(ShadowStore.pathOf(dir), "utf8"));
  return (raw as { entries: Record<string, { hash: string; file: string; class: string }> }).entries;
}

// ------------------------------------------------------------------ shadow store

describe("shadow store", () => {
  test("missing shadow loads empty", async () => {
    const dir = fixture({});
    const shadow = await ShadowStore.load(dir);
    expect(shadow.size).toBe(0);
    expect(shadow.get("game.X")).toBeUndefined();
  });

  test("save is atomic and reloads with sorted keys", async () => {
    const dir = fixture({});
    const shadow = await ShadowStore.load(dir);
    shadow.set("game.B", { hash: "2", file: "b.luau", class: "ModuleScript" });
    shadow.set("game.A", { hash: "1", file: "a.luau", class: "Script" });
    await shadow.save();
    expect(Object.keys(shadowOf(dir))).toEqual(["game.A", "game.B"]);
    expect(readdirSync(join(dir, ".ogsync"))).toEqual(["shadow.json"]);
    const again = await ShadowStore.load(dir);
    expect(again.size).toBe(2);
    expect(again.get("game.A")?.file).toBe("a.luau");
    expect(again.findByFile("b.luau")?.path).toBe("game.B");
  });

  test("corrupt shadow degrades to empty instead of throwing", async () => {
    const dir = fixture({ ".ogsync/shadow.json": "{not json" });
    expect((await ShadowStore.load(dir)).size).toBe(0);
  });
});

// -------------------------------------------------------------------- reconcile

describe("reconcile", () => {
  test("pushes fs-only scripts (and their folder) to Studio", async () => {
    const h = harness({
      "src/shared/Hello.luau": "return 1\n",
      "src/shared/Nested/Deep.server.luau": "print('deep')\n",
    });
    await h.engine.start();
    await h.engine.drain();
    expect(h.bridge.studio.get(`${SHARED}.Hello`)?.source).toBe("return 1\n");
    expect(h.bridge.studio.get(`${SHARED}.Nested.Deep`)?.class).toBe("Script");
    expect(h.bridge.studio.get(`${SHARED}.Nested`)?.class).toBe(FOLDER_CLASS);
    expect(shadowOf(h.dir)[`${SHARED}.Hello`]).toEqual({
      hash: contentHash("return 1\n"),
      file: "src/shared/Hello.luau",
      class: "ModuleScript",
    });
  });

  test("writes studio-only scripts to disk", async () => {
    const h = harness({ "src/shared/Keep.luau": "return 'keep'\n" });
    h.bridge.put(SHARED, FOLDER_CLASS, "");
    h.bridge.put(`${SHARED}.Keep`, "ModuleScript", "return 'keep'\n");
    h.bridge.put(`${SHARED}.Remote`, "Script", "print('remote')\n");
    await h.engine.start();
    await h.engine.drain();
    expect(h.read("src/shared/Remote.server.luau")).toBe("print('remote')\n");
    expect(shadowOf(h.dir)[`${SHARED}.Remote`]?.class).toBe("Script");
  });

  test("deletes local files the shadow proves Studio dropped", async () => {
    const source = "return 1\n";
    const h = harness({
      "src/shared/Gone.luau": source,
      ".ogsync/shadow.json": JSON.stringify({
        version: 1,
        entries: {
          [`${SHARED}.Gone`]: {
            hash: contentHash(source),
            file: "src/shared/Gone.luau",
            class: "ModuleScript",
          },
        },
      }),
    });
    h.bridge.put(SHARED, FOLDER_CLASS, "");
    await h.engine.start();
    await h.engine.drain();
    expect(h.read("src/shared/Gone.luau")).toBeNull();
    expect(shadowOf(h.dir)[`${SHARED}.Gone`]).toBeUndefined();
  });

  test("both sides differ with no shadow ⇒ conflict, prefer-fs keeps a backup", async () => {
    const h = harness({ "src/shared/Hello.luau": "fs version\n" });
    h.bridge.put(`${SHARED}.Hello`, "ModuleScript", "studio version\n");
    await h.engine.start();
    await h.engine.drain();
    expect(h.bridge.studio.get(`${SHARED}.Hello`)?.source).toBe("fs version\n");
    const backup = backupIn(h.dir, "Hello");
    expect(backup).toBeDefined();
    expect(h.read(`src/shared/${backup as string}`)).toBe("studio version\n");
    const [conflict] = h.engine.status().conflicts;
    expect(conflict?.resolution).toBe("kept-fs");
    expect(conflict?.path).toBe(`${SHARED}.Hello`);
  });

  test("manual policy applies nothing and leaves the conflict pending", async () => {
    const h = harness({ "src/shared/Hello.luau": "fs version\n" }, { conflict: "manual" });
    h.bridge.put(`${SHARED}.Hello`, "ModuleScript", "studio version\n");
    await h.engine.start();
    await h.engine.drain();
    expect(h.bridge.studio.get(`${SHARED}.Hello`)?.source).toBe("studio version\n");
    expect(h.read("src/shared/Hello.luau")).toBe("fs version\n");
    const [conflict] = h.engine.status().conflicts;
    expect(conflict?.resolution).toBe("pending");
    expect(h.read(`src/shared/${backupIn(h.dir, "Hello") as string}`)).toBe("studio version\n");
  });

  test("startup notice counts unsupported file types", async () => {
    const h = harness({ "src/shared/Hello.luau": "return 1\n", "src/shared/data.json": "{}\n" });
    await h.engine.start();
    expect(h.logs.some((l) => l.includes("unsupported file(s) (.json 1)"))).toBe(true);
  });
});

// ---------------------------------------------------------------- studio → fs

describe("studio → fs", () => {
  test("an event whose hash matches the shadow is dropped (echo suppression)", async () => {
    const h = harness({ "src/shared/Hello.luau": "return 1\n" });
    await h.engine.start();
    await h.engine.drain();
    const reads = h.bridge.countOf("script.read");
    h.bridge.emit({
      ev: "scriptChanged",
      path: `${SHARED}.Hello`,
      hash: contentHash("return 1\n"),
      ts: Date.now(),
    });
    await h.engine.drain();
    expect(h.bridge.countOf("script.read")).toBe(reads);
    expect(h.read("src/shared/Hello.luau")).toBe("return 1\n");
    expect(h.engine.status().pending).toBe(0);
  });

  test("an inlined source is written straight to disk", async () => {
    const h = harness({ "src/shared/Hello.luau": "return 1\n" });
    await h.engine.start();
    await h.engine.drain();
    const reads = h.bridge.countOf("script.read");
    h.bridge.emit({
      ev: "scriptChanged",
      path: `${SHARED}.Hello`,
      source: "return 2\n",
      hash: contentHash("return 2\n"),
      ts: Date.now(),
    });
    await h.engine.drain();
    expect(h.read("src/shared/Hello.luau")).toBe("return 2\n");
    expect(h.bridge.countOf("script.read")).toBe(reads);
    expect(shadowOf(h.dir)[`${SHARED}.Hello`]?.hash).toBe(contentHash("return 2\n"));
  });

  test("a source-less event is fetched with script.read", async () => {
    const h = harness({ "src/shared/Hello.luau": "return 1\n" });
    await h.engine.start();
    await h.engine.drain();
    h.bridge.put(`${SHARED}.Hello`, "ModuleScript", "return 3\n");
    h.bridge.emit({
      ev: "scriptChanged",
      path: `${SHARED}.Hello`,
      hash: contentHash("return 3\n"),
      ts: Date.now(),
    });
    await h.engine.drain();
    expect(h.read("src/shared/Hello.luau")).toBe("return 3\n");
  });

  test("instAdded creates folders and scripts, instRenamed moves the file", async () => {
    const h = harness({ "src/shared/Hello.luau": "return 1\n" });
    await h.engine.start();
    await h.engine.drain();
    h.bridge.put(`${SHARED}.Bag`, FOLDER_CLASS, "");
    h.bridge.emit({ ev: "instAdded", path: `${SHARED}.Bag`, class: FOLDER_CLASS });
    h.bridge.put(`${SHARED}.Bag.Item`, "LocalScript", "print('item')\n");
    h.bridge.emit({ ev: "instAdded", path: `${SHARED}.Bag.Item`, class: "LocalScript" });
    await h.engine.drain();
    expect(existsSync(h.file("src/shared/Bag"))).toBe(true);
    expect(h.read("src/shared/Bag/Item.client.luau")).toBe("print('item')\n");

    h.bridge.emit({ ev: "instRenamed", path: `${SHARED}.Howdy`, oldPath: `${SHARED}.Hello` });
    await h.engine.drain();
    expect(h.read("src/shared/Hello.luau")).toBeNull();
    expect(h.read("src/shared/Howdy.luau")).toBe("return 1\n");
    expect(shadowOf(h.dir)[`${SHARED}.Howdy`]?.file).toBe("src/shared/Howdy.luau");
  });

  test("instRemoved deletes a file that still matches the shadow", async () => {
    const h = harness({ "src/shared/Hello.luau": "return 1\n" });
    await h.engine.start();
    await h.engine.drain();
    h.bridge.emit({ ev: "instRemoved", path: `${SHARED}.Hello` });
    await h.engine.drain();
    expect(h.read("src/shared/Hello.luau")).toBeNull();
    expect(shadowOf(h.dir)[`${SHARED}.Hello`]).toBeUndefined();
  });

  test("instRemoved never deletes unsynced local work", async () => {
    const h = harness({ "src/shared/Hello.luau": "return 1\n" });
    await h.engine.start();
    await h.engine.drain();
    h.engine.pause();
    writeFileSync(h.file("src/shared/Hello.luau"), "local work\n", "utf8");
    h.bridge.emit({ ev: "instRemoved", path: `${SHARED}.Hello` });
    h.engine.resume();
    await h.engine.drain();
    expect(h.read("src/shared/Hello.luau")).toBe("local work\n");
    expect(h.bridge.studio.get(`${SHARED}.Hello`)?.source).toBe("local work\n");
    expect(h.engine.status().conflicts[0]?.resolution).toBe("kept-fs");
  });
});

// ---------------------------------------------------------------- fs → studio

describe("fs → studio", () => {
  test("watcher changes reach Studio; pause queues them and resume replays", async () => {
    const h = harness({ "src/shared/Hello.luau": "return 1\n" });
    await h.engine.start();
    await h.engine.drain();
    h.engine.pause();
    writeFileSync(h.file("src/shared/Fresh.luau"), "return 'fresh'\n", "utf8");
    await waitFor(() => h.engine.status().pending > 0, "watcher queued the new file");
    expect(h.bridge.studio.has(`${SHARED}.Fresh`)).toBe(false);
    expect(h.engine.status().paused).toBe(true);
    h.engine.resume();
    await waitFor(() => h.bridge.studio.has(`${SHARED}.Fresh`), "queued change replayed");
    expect(h.bridge.studio.get(`${SHARED}.Fresh`)?.source).toBe("return 'fresh'\n");
    expect(h.engine.status().pending).toBe(0);
  });

  test("a rejected write becomes a conflict; prefer-newest falls back to fs", async () => {
    const h = harness({ "src/shared/Hello.luau": "return 1\n" }, { conflict: "prefer-newest" });
    await h.engine.start();
    await h.engine.drain();
    h.bridge.put(`${SHARED}.Hello`, "ModuleScript", "studio drifted\n");
    writeFileSync(h.file("src/shared/Hello.luau"), "fs newer\n", "utf8");
    await waitFor(
      () => h.bridge.studio.get(`${SHARED}.Hello`)?.source === "fs newer\n",
      "forced apply after conflict",
    );
    const backup = backupIn(h.dir, "Hello");
    expect(backup).toBeDefined();
    expect(h.read(`src/shared/${backup as string}`)).toBe("studio drifted\n");
    expect(h.engine.status().conflicts[0]?.resolution).toBe("kept-fs");
  });

  test("deleting a file deletes the instance", async () => {
    const h = harness({ "src/shared/Hello.luau": "return 1\n" });
    await h.engine.start();
    await h.engine.drain();
    rmSync(h.file("src/shared/Hello.luau"));
    await waitFor(() => !h.bridge.studio.has(`${SHARED}.Hello`), "delete reached Studio");
    await h.engine.drain();
    expect(shadowOf(h.dir)[`${SHARED}.Hello`]).toBeUndefined();
  });
});

// ----------------------------------------------------------- control surface

describe("control surface", () => {
  test("status reports project, connection, queue depth and conflicts", async () => {
    const h = harness({ "src/shared/Hello.luau": "return 1\n" });
    await h.engine.start();
    await h.engine.drain();
    const status = h.engine.status();
    expect(status).toMatchObject({
      enabled: true,
      paused: false,
      connected: true,
      projectName: "T",
      pending: 0,
    });
    expect(status.conflicts).toEqual([]);
    h.bridge.session = null;
    expect(h.engine.status().connected).toBe(false);
  });

  test("resolve applies the chosen side and clears the conflict", async () => {
    const h = harness({ "src/shared/Hello.luau": "fs version\n" }, { conflict: "manual" });
    h.bridge.put(`${SHARED}.Hello`, "ModuleScript", "studio version\n");
    await h.engine.start();
    await h.engine.drain();
    expect(h.engine.status().conflicts).toHaveLength(1);
    const msg = await h.engine.resolve("src/shared/Hello.luau", "studio");
    expect(msg).toContain("kept Studio");
    expect(h.read("src/shared/Hello.luau")).toBe("studio version\n");
    expect(h.engine.status().conflicts).toEqual([]);
    expect(shadowOf(h.dir)[`${SHARED}.Hello`]?.hash).toBe(contentHash("studio version\n"));
  });

  test("resolve keep=fs pushes the local file and rejects unknown files", async () => {
    const h = harness({ "src/shared/Hello.luau": "fs version\n" }, { conflict: "manual" });
    h.bridge.put(`${SHARED}.Hello`, "ModuleScript", "studio version\n");
    await h.engine.start();
    await h.engine.drain();
    await h.engine.resolve("src/shared/Hello.luau", "fs");
    expect(h.bridge.studio.get(`${SHARED}.Hello`)?.source).toBe("fs version\n");
    expect(h.engine.status().conflicts).toEqual([]);
    await expect(h.engine.resolve("nowhere/Else.luau", "fs")).rejects.toThrow(/not a synced file/);
  });

  test("fullPush overwrites Studio from disk", async () => {
    const h = harness({ "src/shared/Hello.luau": "fs wins\n" }, { conflict: "manual" });
    h.bridge.put(`${SHARED}.Hello`, "ModuleScript", "studio loses\n");
    h.bridge.put(`${SHARED}.Stale`, "ModuleScript", "orphan\n");
    await h.engine.start();
    const report = await h.engine.fullPush();
    expect(h.bridge.studio.get(`${SHARED}.Hello`)?.source).toBe("fs wins\n");
    expect(h.bridge.studio.has(`${SHARED}.Stale`)).toBe(true); // never synced ⇒ kept
    expect(report).toContain("studio-only kept");
  });

  test("fullPull overwrites disk from Studio and backs up differences", async () => {
    const h = harness({ "src/shared/Hello.luau": "fs loses\n" }, { conflict: "manual" });
    h.bridge.put(SHARED, FOLDER_CLASS, "");
    h.bridge.put(`${SHARED}.Hello`, "ModuleScript", "studio wins\n");
    h.bridge.put(`${SHARED}.Extra`, "ModuleScript", "brand new\n");
    await h.engine.start();
    const report = await h.engine.fullPull();
    expect(h.read("src/shared/Hello.luau")).toBe("studio wins\n");
    expect(h.read("src/shared/Extra.luau")).toBe("brand new\n");
    expect(backupsIn(h.dir, "Hello").map((f) => h.read(`src/shared/${f}`))).toContain("fs loses\n");
    expect(report).toContain("1 overwritten (1 backed up)");
  });

  test("fs changes are queued while no session is bound", async () => {
    const h = harness({ "src/shared/Hello.luau": "return 1\n" });
    h.bridge.session = null;
    await h.engine.start();
    writeFileSync(h.file("src/shared/Later.luau"), "return 'later'\n", "utf8");
    await waitFor(() => h.engine.status().pending > 0, "change queued while offline");
    await h.engine.drain();
    expect(h.engine.status().pending).toBe(1);
    expect(h.bridge.countOf("sync.apply")).toBe(0);
  });
});
