// Last-synced state per instance. Both sides diff against the shadow, never
// against each other — that is what makes conflicts detectable.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

export class ShadowStore {
  readonly #entries: Map<string, ShadowEntry>;

  private constructor(
    readonly dir: string,
    entries: Map<string, ShadowEntry>,
  ) {
    this.#entries = entries;
  }

  /** Loads `<projectDir>/.ogsync/shadow.json`, or an empty store. */
  static async load(projectDir: string): Promise<ShadowStore> {
    const entries = new Map<string, ShadowEntry>();
    try {
      const raw = await readFile(ShadowStore.pathOf(projectDir), "utf8");
      const doc: unknown = JSON.parse(raw);
      const bag = (doc as ShadowDoc | null)?.entries;
      if (typeof bag === "object" && bag !== null) {
        for (const [path, entry] of Object.entries(bag)) {
          if (isEntry(entry)) entries.set(path, entry);
        }
      }
    } catch {
      // absent or corrupt shadow ⇒ start empty; reconcile rebuilds it
    }
    return new ShadowStore(projectDir, entries);
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

  /** Atomic: write a temp sibling, then rename over the target. */
  async save(): Promise<void> {
    const target = ShadowStore.pathOf(this.dir);
    const tmp = `${target}.${process.pid}.tmp`;
    const doc: ShadowDoc = { version: FORMAT, entries: {} };
    for (const path of [...this.#entries.keys()].sort()) {
      doc.entries[path] = this.#entries.get(path) as ShadowEntry;
    }
    await mkdir(join(this.dir, SHADOW_DIR), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    await rename(tmp, target);
  }
}
