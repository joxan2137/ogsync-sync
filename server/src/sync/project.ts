// Rojo `default.project.json` subset → bidirectional instance ⇄ file mapping.
// v1 syncs LuaSourceContainers and Folders only; every other file type is
// counted (ignoredCounts) so the daemon can print one startup notice.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { contentHash, normalizeSource } from "../proto/types.ts";

export type NodeKind = "server" | "client" | "module" | "plugin" | "folder";

export interface MappedNode {
  /** instance dot-path from `game` */
  path: string;
  class: string;
  kind: NodeKind;
}

export interface FsEntry {
  /** project-relative path, posix separators */
  file: string;
  class: string;
  source: string;
  hash: string;
}

export const ROOT_INST = "game";
export const FOLDER_CLASS = "Folder";
/** Folders carry no source; both sides normalize their hash to this. */
export const FOLDER_HASH = contentHash("");
export const NESTED_PROJECT_FILE = "default.project.json";

const SCRIPT_CLASSES = new Set(["Script", "LocalScript", "ModuleScript"]);

interface Suffix {
  ext: string;
  class: string;
  kind: NodeKind;
}

// Longest/most specific first — matched by endsWith.
const SUFFIXES: readonly Suffix[] = [
  { ext: ".server.luau", class: "Script", kind: "server" },
  { ext: ".server.lua", class: "Script", kind: "server" },
  { ext: ".client.luau", class: "LocalScript", kind: "client" },
  { ext: ".client.lua", class: "LocalScript", kind: "client" },
  { ext: ".plugin.luau", class: "Script", kind: "plugin" },
  { ext: ".plugin.lua", class: "Script", kind: "plugin" },
  { ext: ".luau", class: "ModuleScript", kind: "module" },
  { ext: ".lua", class: "ModuleScript", kind: "module" },
];

/** Directory promotion order per Rojo 7.5 (project file wins, then inits). */
const INIT_BASENAMES: readonly string[] = [
  "init.luau",
  "init.lua",
  "init.server.luau",
  "init.server.lua",
  "init.client.luau",
  "init.client.lua",
];

const PLAIN_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONFLICT_BACKUP = /\.conflict-\d+(?:-\d+)?\.luau$/;
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
const QUOTE_OR_BACKSLASH = /["\\]/g;

export function isSyncableClass(cls: string): boolean {
  return cls === FOLDER_CLASS || SCRIPT_CLASSES.has(cls);
}

export function isScriptClass(cls: string): boolean {
  return SCRIPT_CLASSES.has(cls);
}

/** File suffix a class/kind pair is written back to disk with. */
export function fileSuffixFor(cls: string, kind?: NodeKind): string {
  if (cls === "LocalScript") return ".client.luau";
  if (cls === "Script") return kind === "plugin" ? ".plugin.luau" : ".server.luau";
  return ".luau";
}

/**
 * Bracket form of one segment. The plugin's Path.luau unescapes `\"` and `\\`
 * and nothing else — a `\n` or `\uXXXX` escape would come back as the literal
 * letters, so the escape set here must stay exactly those two characters.
 */
export function quoteSegment(name: string): string {
  return `"${name.replace(QUOTE_OR_BACKSLASH, "\\$&")}"`;
}

/** Control characters survive neither the path grammar nor line-based output. */
export function isSyncableName(name: string): boolean {
  return name !== "" && !CONTROL_CHAR.test(name);
}

export function joinInst(base: string, name: string): string {
  return PLAIN_SEGMENT.test(name) ? `${base}.${name}` : `${base}[${quoteSegment(name)}]`;
}

export function buildInst(segments: readonly string[]): string {
  const [head, ...rest] = segments;
  if (head === undefined) return "";
  return rest.reduce(joinInst, head);
}

export function splitInst(path: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < path.length) {
    const ch = path[i];
    if (ch === ".") {
      i++;
      continue;
    }
    if (ch === "[") {
      const [name, next] = readBracket(path, i);
      out.push(name);
      i = next;
      continue;
    }
    let j = i;
    while (j < path.length && path[j] !== "." && path[j] !== "[") j++;
    out.push(path.slice(i, j));
    i = j;
  }
  return out;
}

function readBracket(path: string, open: number): [string, number] {
  if (path[open + 1] === '"') {
    let j = open + 2;
    let raw = "";
    while (j < path.length && path[j] !== '"') {
      if (path[j] === "\\") j++;
      raw += path[j] ?? "";
      j++;
    }
    const close = path.indexOf("]", j);
    return [raw, close < 0 ? path.length : close + 1];
  }
  const close = path.indexOf("]", open);
  if (close < 0) return [path.slice(open + 1), path.length];
  return [path.slice(open + 1, close), close + 1];
}

/** True when `path` is `root` or a descendant of it (segment-aware). */
export function isUnder(path: string, root: string): boolean {
  if (path === root) return true;
  return path.startsWith(`${root}.`) || path.startsWith(`${root}[`);
}

/** Paths the watcher and scanner must never look at. */
export function isIgnoredFile(rel: string): boolean {
  if (CONFLICT_BACKUP.test(rel)) return true;
  return rel.split("/").some((seg) => seg.startsWith("."));
}

export function matchSuffix(basename: string): { name: string; class: string; kind: NodeKind } | null {
  for (const s of SUFFIXES) {
    if (basename.length > s.ext.length && basename.endsWith(s.ext)) {
      return { name: basename.slice(0, -s.ext.length), class: s.class, kind: s.kind };
    }
  }
  return null;
}

function kindOfClass(cls: string): NodeKind {
  if (cls === FOLDER_CLASS) return "folder";
  if (cls === "LocalScript") return "client";
  if (cls === "Script") return "server";
  return "module";
}

interface Mount {
  /** instance dot-path of the mapped node */
  inst: string;
  /** project-relative posix path (directory or single file) */
  path: string;
  isDir: boolean;
  className?: string;
}

interface ProjectNode {
  $path?: string;
  $className?: string;
  $properties?: Record<string, unknown>;
  $ignoreUnknownInstances?: boolean;
  [child: string]: unknown;
}

function toPosix(p: string): string {
  const clean = p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return clean === "." ? "" : clean;
}

function relJoin(base: string, add: string): string {
  const a = toPosix(add);
  if (a === "") return base;
  return base === "" ? a : `${base}/${a}`;
}

function relChild(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

export class ProjectMap {
  readonly #mounts: Mount[] = [];
  readonly #ignored = new Map<string, number>();
  readonly #duplicates = new Map<string, string[]>();
  readonly #unsyncable = new Map<string, string>();

  private constructor(
    readonly dir: string,
    readonly file: string,
    readonly name: string,
  ) {}

  static load(dir: string, file: string): ProjectMap {
    const raw = readFileSync(join(dir, file), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`${file}: not a JSON object`);
    }
    const doc = parsed as { name?: unknown; tree?: unknown };
    if (typeof doc.tree !== "object" || doc.tree === null) {
      throw new Error(`${file}: missing "tree"`);
    }
    const map = new ProjectMap(dir, file, typeof doc.name === "string" ? doc.name : ROOT_INST);
    map.#walkNode(doc.tree as ProjectNode, ROOT_INST, "", new Set([toPosix(file)]));
    map.#mounts.sort((a, b) => b.inst.length - a.inst.length);
    return map;
  }

  #walkNode(node: ProjectNode, inst: string, base: string, seenProjects: Set<string>): void {
    const path = typeof node.$path === "string" ? relJoin(base, node.$path) : null;
    if (path !== null) {
      const isDir = this.#looksLikeDir(path);
      const nested = isDir ? relJoin(path, NESTED_PROJECT_FILE) : null;
      if (nested !== null && existsSync(join(this.dir, nested)) && !seenProjects.has(nested)) {
        seenProjects.add(nested);
        const sub: unknown = JSON.parse(readFileSync(join(this.dir, nested), "utf8"));
        const tree = (sub as { tree?: unknown }).tree;
        if (typeof tree === "object" && tree !== null) {
          this.#walkNode(tree as ProjectNode, inst, path, seenProjects);
        }
      } else {
        const mount: Mount = { inst, path, isDir };
        if (typeof node.$className === "string") mount.className = node.$className;
        this.#mounts.push(mount);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith("$")) continue;
      if (typeof child !== "object" || child === null) continue;
      this.#walkNode(child as ProjectNode, joinInst(inst, key), base, seenProjects);
    }
  }

  #looksLikeDir(rel: string): boolean {
    const abs = join(this.dir, rel);
    if (existsSync(abs)) return statSync(abs).isDirectory();
    return matchSuffix(rel.slice(rel.lastIndexOf("/") + 1)) === null;
  }

  /** Instance dot-paths of the mapped roots, outermost only. */
  syncRoots(): string[] {
    const roots: string[] = [];
    for (const m of this.#mounts) {
      if (!this.#mounts.some((o) => o !== m && isUnder(m.inst, o.inst) && o.inst !== m.inst)) {
        roots.push(m.inst);
      }
    }
    return [...new Set(roots)].sort();
  }

  /** Project-relative directories the watcher must observe, outermost only. */
  watchDirs(): string[] {
    const dirs = this.#mounts.filter((m) => m.isDir).map((m) => m.path);
    return dirs
      .filter((d) => !dirs.some((o) => o !== d && (d === o || d.startsWith(`${o}/`))))
      .filter((d, i, all) => all.indexOf(d) === i)
      .sort();
  }

  isMountPath(rel: string): boolean {
    const p = toPosix(rel);
    return this.#mounts.some((m) => m.path === p);
  }

  #mountForInst(inst: string): Mount | null {
    // #mounts is sorted longest-inst-first: first hit is the deepest mount.
    return this.#mounts.find((m) => isUnder(inst, m.inst)) ?? null;
  }

  #mountForFile(rel: string): Mount | null {
    let best: Mount | null = null;
    for (const m of this.#mounts) {
      if (m.path === "" || rel === m.path || rel.startsWith(`${m.path}/`)) {
        if (best === null || m.path.length > best.path.length) best = m;
      }
    }
    return best;
  }

  /**
   * Instance dot-path → project-relative file. `cls` picks the extension for
   * files that do not exist yet; without it an existing file is probed and
   * ModuleScript convention is the fallback.
   */
  instToFile(instPath: string, cls?: string, kind?: NodeKind): string | null {
    const mount = this.#mountForInst(instPath);
    if (mount === null) return null;
    if (!mount.isDir) return instPath === mount.inst ? mount.path : null;

    const rest = splitInst(instPath).slice(splitInst(mount.inst).length);
    if (rest.length === 0) {
      const init = this.#existingInit(mount.path);
      if (init !== null) return init;
      if (cls !== undefined && isScriptClass(cls)) {
        return relChild(mount.path, `init${fileSuffixFor(cls, kind)}`);
      }
      return mount.path;
    }

    const last = rest[rest.length - 1] as string;
    const dirPart = relJoin(mount.path, rest.slice(0, -1).join("/"));
    if (cls !== undefined) {
      if (cls === FOLDER_CLASS) return relChild(dirPart, last);
      return relChild(dirPart, `${last}${fileSuffixFor(cls, kind)}`);
    }
    for (const s of SUFFIXES) {
      const candidate = relChild(dirPart, `${last}${s.ext}`);
      if (existsSync(join(this.dir, candidate))) return candidate;
    }
    const asDir = relChild(dirPart, last);
    if (existsSync(join(this.dir, asDir)) && statSync(join(this.dir, asDir)).isDirectory()) {
      return this.#existingInit(asDir) ?? asDir;
    }
    return relChild(dirPart, `${last}.luau`);
  }

  #existingInit(dirRel: string): string | null {
    for (const base of INIT_BASENAMES) {
      const candidate = relChild(dirRel, base);
      if (existsSync(join(this.dir, candidate))) return candidate;
    }
    return null;
  }

  /** Project-relative file (or directory) → mapped instance, or null when unsupported. */
  fileToInst(relPath: string): MappedNode | null {
    const rel = toPosix(relPath);
    if (rel === "" || isIgnoredFile(rel) || !this.#namesSyncable(rel)) return null;
    const mount = this.#mountForFile(rel);
    if (mount === null) return null;

    if (!mount.isDir) {
      if (rel !== mount.path) return null;
      const conv = matchSuffix(rel.slice(rel.lastIndexOf("/") + 1));
      const cls = mount.className ?? conv?.class ?? "ModuleScript";
      return { path: mount.inst, class: cls, kind: conv?.kind ?? kindOfClass(cls) };
    }

    const under = mount.path === "" ? rel : rel.slice(mount.path.length + 1);
    const rest = rel === mount.path ? [] : under.split("/");
    if (rest.length === 0) {
      const init = this.#existingInit(mount.path);
      const conv = init === null ? null : matchSuffix(init.slice(init.lastIndexOf("/") + 1));
      const cls = mount.className ?? conv?.class ?? FOLDER_CLASS;
      return { path: mount.inst, class: cls, kind: conv?.kind ?? kindOfClass(cls) };
    }

    const last = rest[rest.length - 1] as string;
    const conv = matchSuffix(last);
    if (conv === null) {
      if (last.includes(".")) return null; // unsupported file type
      return {
        path: buildInst([mount.inst, ...rest]),
        class: FOLDER_CLASS,
        kind: "folder",
      };
    }
    if (conv.name === "init") {
      // Only the highest-priority init file in a directory promotes it; the
      // others are shadowed and must not fight over the same instance.
      const dirRel = relJoin(mount.path, rest.slice(0, -1).join("/"));
      const preferred = this.#existingInit(dirRel);
      if (preferred !== null && preferred !== rel) return null;
    }
    const segments = conv.name === "init" ? rest.slice(0, -1) : [...rest.slice(0, -1), conv.name];
    const inst = buildInst([mount.inst, ...segments]);
    const cls = inst === mount.inst ? mount.className ?? conv.class : conv.class;
    return { path: inst, class: cls, kind: cls === conv.class ? conv.kind : kindOfClass(cls) };
  }

  #namesSyncable(rel: string): boolean {
    const bad = rel.split("/").find((seg) => !isSyncableName(seg));
    if (bad === undefined) return true;
    this.#unsyncable.set(rel, bad);
    return false;
  }

  /** Full scan of every mapped root. Refreshes ignoredCounts(). */
  scanFs(): Map<string, FsEntry> {
    const out = new Map<string, FsEntry>();
    const visited = new Set<string>();
    this.#ignored.clear();
    this.#duplicates.clear();
    this.#unsyncable.clear();
    for (const mount of this.#mounts) {
      const abs = join(this.dir, mount.path);
      if (!existsSync(abs)) continue;
      if (mount.isDir) {
        this.#addDir(out, visited, mount.path);
        this.#scanDir(out, visited, mount.path);
      } else {
        this.#addFile(out, visited, mount.path);
      }
    }
    return out;
  }

  ignoredCounts(): ReadonlyMap<string, number> {
    return this.#ignored;
  }

  /** Instance paths two or more files claim; excluded from sync, never guessed. */
  duplicatePaths(): ReadonlyMap<string, string[]> {
    return this.#duplicates;
  }

  /** Files whose name cannot round-trip through the path grammar → offending segment. */
  unsyncableFiles(): ReadonlyMap<string, string> {
    return this.#unsyncable;
  }

  #scanDir(out: Map<string, FsEntry>, visited: Set<string>, dirRel: string): void {
    for (const dirent of readdirSync(join(this.dir, dirRel), { withFileTypes: true })) {
      const rel = relChild(dirRel, dirent.name);
      if (isIgnoredFile(rel)) continue;
      if (dirent.isDirectory()) {
        this.#addDir(out, visited, rel);
        this.#scanDir(out, visited, rel);
      } else if (dirent.isFile()) {
        this.#addFile(out, visited, rel);
      }
    }
  }

  // A directory always enters as a Folder; an init.* child seen later in the
  // walk overwrites the entry with the promoted script class.
  #addDir(out: Map<string, FsEntry>, visited: Set<string>, rel: string): void {
    if (visited.has(rel)) return;
    visited.add(rel);
    const mapped = this.fileToInst(rel);
    if (mapped === null || !this.#claim(out, mapped.path, rel)) return;
    out.set(mapped.path, { file: rel, class: FOLDER_CLASS, source: "", hash: FOLDER_HASH });
  }

  #addFile(out: Map<string, FsEntry>, visited: Set<string>, rel: string): void {
    if (visited.has(rel)) return;
    visited.add(rel);
    const mapped = this.fileToInst(rel);
    if (mapped === null || mapped.class === FOLDER_CLASS) {
      this.#countIgnored(rel);
      return;
    }
    if (!this.#claim(out, mapped.path, rel)) return;
    const source = normalizeSource(readFileSync(join(this.dir, rel), "utf8"));
    out.set(mapped.path, { file: rel, class: mapped.class, source, hash: contentHash(source) });
  }

  /**
   * True when `rel` may own `inst`. Two files claiming one instance path is
   * ambiguous in both directions, so the path leaves the scan entirely instead
   * of silently resolving to whichever file the walk reached last.
   */
  #claim(out: Map<string, FsEntry>, inst: string, rel: string): boolean {
    const clash = this.#duplicates.get(inst);
    if (clash !== undefined) {
      if (!clash.includes(rel)) clash.push(rel);
      return false;
    }
    const existing = out.get(inst);
    if (existing === undefined) return true;
    // A directory entering as a Folder and its init.* child promoting it to a
    // script are the same node by design, not a collision.
    if (existing.class === FOLDER_CLASS && rel.startsWith(`${existing.file}/`)) return true;
    out.delete(inst);
    this.#duplicates.set(inst, [existing.file, rel]);
    return false;
  }

  #countIgnored(rel: string): void {
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    if (base.endsWith(".project.json")) return;
    const dot = base.indexOf(".");
    const ext = dot < 0 ? "(no extension)" : base.slice(dot);
    this.#ignored.set(ext, (this.#ignored.get(ext) ?? 0) + 1);
  }

  /**
   * Ancestor instance paths between the containing mapped root (inclusive) and
   * `instPath` (exclusive), shallowest first — the Folders that must exist
   * before a child can be created in Studio.
   */
  ancestorsOf(instPath: string): string[] {
    const mount = this.#mountForInst(instPath);
    if (mount === null || !mount.isDir) return [];
    const rest = splitInst(instPath).slice(splitInst(mount.inst).length);
    const out = [mount.inst];
    for (let i = 0; i < rest.length - 1; i++) {
      out.push(buildInst([mount.inst, ...rest.slice(0, i + 1)]));
    }
    return out.filter((p) => p !== instPath);
  }
}

export function loadProject(dir: string, file: string): ProjectMap {
  return ProjectMap.load(dir, file);
}
