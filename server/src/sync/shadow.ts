// Last-synced state per instance. Both sides diff against the shadow, never
// against each other — that is what makes conflicts detectable.

import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

export interface ShadowEntry {
  hash: string;
  /** project-relative file backing the instance */
  file: string;
  class: string;
}

export const SHADOW_DIR = ".ogsync";
export const SHADOW_FILE = "shadow.json";
const FORMAT = 1;

interface ShadowDoc {
  version: number;
  entries: Record<string, ShadowEntry>;
}

function isEntry(v: unknown): v is ShadowEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Partial<ShadowEntry>;
  return typeof e.hash === "string" && typeof e.file === "string" && typeof e.class === "string";
}

/**
 * Write-then-rename with the temp file fsynced first: without the sync a crash
 * can land the rename while the data is still in the page cache, leaving a
 * durable name over zeroed content.
 */
export async function writeDurable(target: string, body: string, tmp: string): Promise<void> {
  const fh = await open(tmp, "w");
  try {
    await fh.write(body, 0, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, target);
}

export class ShadowStore {
  readonly #entries: Map<string, ShadowEntry>;

  private constructor(
    readonly dir: string,
    entries: Map<string, ShadowEntry>,
    /** Where a corrupt shadow was moved aside, or null when the load was clean. */
    readonly corrupt: string | null,
  ) {
    this.#entries = entries;
  }

  /**
   * Loads `<projectDir>/.ogsync/shadow.json`, or an empty store. An absent file
   * means "nothing synced yet"; an unparseable one means the base state is lost
   * — it is renamed aside and reported via `corrupt` so the engine can refuse to
   * destroy either side.
   */
  static async load(projectDir: string): Promise<ShadowStore> {
    const target = ShadowStore.pathOf(projectDir);
    const entries = new Map<string, ShadowEntry>();
    let raw: string;
    try {
      raw = await readFile(target, "utf8");
    } catch {
      return new ShadowStore(projectDir, entries, null);
    }
    let bag: unknown;
    try {
      bag = (JSON.parse(raw) as ShadowDoc | null)?.entries;
    } catch {
      const aside = `${target}.corrupt-${Date.now()}`;
      await rename(target, aside).catch(() => undefined);
      return new ShadowStore(projectDir, entries, aside);
    }
    if (typeof bag === "object" && bag !== null) {
      for (const [path, entry] of Object.entries(bag)) {
        if (isEntry(entry)) entries.set(path, entry);
      }
    }
    return new ShadowStore(projectDir, entries, null);
  }

  static pathOf(projectDir: string): string {
    return join(projectDir, SHADOW_DIR, SHADOW_FILE);
  }

  get size(): number {
    return this.#entries.size;
  }

  get(path: string): ShadowEntry | undefined {
    return this.#entries.get(path);
  }

  has(path: string): boolean {
    return this.#entries.has(path);
  }

  set(path: string, entry: ShadowEntry): void {
    this.#entries.set(path, entry);
  }

  delete(path: string): boolean {
    return this.#entries.delete(path);
  }

  paths(): string[] {
    return [...this.#entries.keys()];
  }

  entries(): [string, ShadowEntry][] {
    return [...this.#entries];
  }

  findByFile(file: string): { path: string; entry: ShadowEntry } | null {
    for (const [path, entry] of this.#entries) {
      if (entry.file === file) return { path, entry };
    }
    return null;
  }

  /** Atomic and durable: write a temp sibling, fsync it, then rename over. */
  async save(): Promise<void> {
    const target = ShadowStore.pathOf(this.dir);
    const doc: ShadowDoc = { version: FORMAT, entries: {} };
    for (const path of [...this.#entries.keys()].sort()) {
      doc.entries[path] = this.#entries.get(path) as ShadowEntry;
    }
    await mkdir(join(this.dir, SHADOW_DIR), { recursive: true });
    await writeDurable(target, `${JSON.stringify(doc, null, 2)}\n`, `${target}.${process.pid}.tmp`);
  }
}
