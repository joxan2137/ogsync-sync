// Roblox API reference for the `docs` tool. The dump is fetched once a week and
// cached under ~/.ogsync/cache; a stale cache always beats being offline.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { clip } from "./fmt.ts";

const VERSION_URL = "https://setup.rbxcdn.com/versionQTStudio";
const DUMP_URL = (guid: string) => `https://setup.rbxcdn.com/${guid}-API-Dump.json`;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_SEARCH_HITS = 20;
const DOC_BASE = "https://create.roblox.com/docs/reference/engine";
const DOC_SEARCH = "https://create.roblox.com/docs/search#q=";

export interface ApiType {
  Name: string;
  Category?: string;
}

export interface ApiParameter {
  Name: string;
  Type: ApiType;
  Default?: string;
}

export interface ApiMember {
  Name: string;
  MemberType: string;
  Security?: string | { Read: string; Write: string };
  ValueType?: ApiType;
  Parameters?: ApiParameter[];
  ReturnType?: ApiType | ApiType[];
  Tags?: string[];
  Serialization?: { CanLoad: boolean; CanSave: boolean };
  Description?: string;
}

export interface ApiClass {
  Name: string;
  Superclass?: string;
  Members?: ApiMember[];
  Tags?: string[];
  Description?: string;
}

export interface ApiDump {
  Classes?: ApiClass[];
  Enums?: Array<{ Name: string; Items?: Array<{ Name: string; Value: number }> }>;
}

export const CACHE_FILE = join(homedir(), ".ogsync", "cache", "apidump.json");
export const OFFLINE_MESSAGE = "docs unavailable offline";

let memo: ApiDump | null = null;

export interface LoadOptions {
  cacheFile?: string;
  ttlMs?: number;
  now?: number;
}

/** Cached dump, refetched past TTL. null = no cache and no network. */
export async function loadApiDump(opts: LoadOptions = {}): Promise<ApiDump | null> {
  const cacheFile = opts.cacheFile ?? CACHE_FILE;
  const ttlMs = opts.ttlMs ?? TTL_MS;
  const now = opts.now ?? Date.now();
  if (memo && cacheFile === CACHE_FILE) return memo;

  const cached = await readCache(cacheFile);
  if (cached && now - cached.mtimeMs < ttlMs) return remember(cacheFile, cached.dump);

  const fresh = await fetchApiDump();
  if (fresh) {
    await mkdir(dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(fresh));
    return remember(cacheFile, fresh);
  }
  return cached ? remember(cacheFile, cached.dump) : null;
}

function remember(cacheFile: string, dump: ApiDump): ApiDump {
  if (cacheFile === CACHE_FILE) memo = dump;
  return dump;
}

async function readCache(cacheFile: string): Promise<{ dump: ApiDump; mtimeMs: number } | null> {
  try {
    const [info, text] = await Promise.all([stat(cacheFile), readFile(cacheFile, "utf8")]);
    return { dump: JSON.parse(text) as ApiDump, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

async function fetchApiDump(): Promise<ApiDump | null> {
  try {
    const guid = (await fetchText(VERSION_URL)).trim();
    if (!guid) return null;
    return JSON.parse(await fetchText(DUMP_URL(guid))) as ApiDump;
  } catch {
    return null;
  }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return await res.text();
}

// ---------------------------------------------------------------- rendering

function typeName(t: ApiType | ApiType[] | undefined): string {
  if (!t) return "void";
  if (Array.isArray(t)) return t.length ? t.map((x) => x.Name).join(", ") : "void";
  return t.Name;
}

function paramList(params: ApiParameter[] | undefined): string {
  return (params ?? [])
    .map((p) => `${p.Name}: ${typeName(p.Type)}${p.Default === undefined ? "" : ` = ${p.Default}`}`)
    .join(", ");
}

function securityFlag(sec: ApiMember["Security"]): string | null {
  if (!sec) return null;
  if (typeof sec === "string") return sec === "None" ? null : `sec=${sec}`;
  if (sec.Read === "None" && sec.Write === "None") return null;
  if (sec.Read === sec.Write) return `sec=${sec.Read}`;
  return `sec=r:${sec.Read}/w:${sec.Write}`;
}

function memberFlags(m: ApiMember): string {
  const bits = [...(m.Tags ?? [])];
  const sec = securityFlag(m.Security);
  if (sec) bits.push(sec);
  if (m.Serialization && !m.Serialization.CanSave) bits.push("nosave");
  return bits.length ? `  [${bits.join(" ")}]` : "";
}

function memberSignature(m: ApiMember): string {
  switch (m.MemberType) {
    case "Property":
      return `prop ${m.Name}: ${typeName(m.ValueType)}`;
    case "Function":
      return `func ${m.Name}(${paramList(m.Parameters)}): ${typeName(m.ReturnType)}`;
    case "Event":
      return `event ${m.Name}(${paramList(m.Parameters)})`;
    case "Callback":
      return `callback ${m.Name}(${paramList(m.Parameters)}): ${typeName(m.ReturnType)}`;
    default:
      return `${m.MemberType.toLowerCase()} ${m.Name}`;
  }
}

function describe(m: ApiMember | ApiClass): string {
  return m.Description ? `  — ${clip(m.Description.split("\n")[0] ?? "", 120)}` : "";
}

function memberLine(m: ApiMember): string {
  return `${memberSignature(m)}${memberFlags(m)}${describe(m)}`;
}

// ---------------------------------------------------------------- queries

function classIndex(dump: ApiDump): Map<string, ApiClass> {
  const byName = new Map<string, ApiClass>();
  for (const c of dump.Classes ?? []) byName.set(c.Name.toLowerCase(), c);
  return byName;
}

function ancestry(dump: ApiDump, cls: ApiClass): ApiClass[] {
  const byName = classIndex(dump);
  const chain: ApiClass[] = [];
  let current = cls.Superclass ? byName.get(cls.Superclass.toLowerCase()) : undefined;
  while (current) {
    chain.push(current);
    current = current.Superclass ? byName.get(current.Superclass.toLowerCase()) : undefined;
  }
  return chain;
}

function classLines(dump: ApiDump, cls: ApiClass): string[] {
  const tags = cls.Tags?.length ? `  [${cls.Tags.join(" ")}]` : "";
  const head = `${cls.Name} : ${cls.Superclass ?? "—"}${tags}${describe(cls)}`;
  const members = [...(cls.Members ?? [])]
    .sort((a, b) => a.MemberType.localeCompare(b.MemberType) || a.Name.localeCompare(b.Name))
    .map(memberLine);
  const chain = ancestry(dump, cls).map((c) => c.Name);
  const out = [head, ...members];
  if (chain.length) out.push(`inherits: ${chain.join(" < ")} (query Class.Member for inherited)`);
  return out;
}

function findMember(
  dump: ApiDump,
  cls: ApiClass,
  memberName: string,
): { owner: ApiClass; member: ApiMember } | null {
  const wanted = memberName.toLowerCase();
  for (const owner of [cls, ...ancestry(dump, cls)]) {
    const member = (owner.Members ?? []).find((m) => m.Name.toLowerCase() === wanted);
    if (member) return { owner, member };
  }
  return null;
}

function score(name: string, query: string): number {
  const n = name.toLowerCase();
  if (n === query) return 100;
  if (n.startsWith(query)) return 80;
  if (n.includes(query)) return 60;
  let i = 0;
  for (const ch of n) if (ch === query[i]) i++;
  return i === query.length ? 30 : -1;
}

function searchLines(dump: ApiDump, query: string): string[] {
  const q = query.toLowerCase();
  const hits: Array<{ rank: number; len: number; text: string }> = [];
  for (const cls of dump.Classes ?? []) {
    const classRank = score(cls.Name, q);
    if (classRank > 0) {
      hits.push({ rank: classRank + 5, len: cls.Name.length, text: `${cls.Name} (class)` });
    }
    for (const m of cls.Members ?? []) {
      const rank = score(m.Name, q);
      if (rank > 0) {
        hits.push({ rank, len: m.Name.length, text: `${cls.Name}.${memberSignature(m)}` });
      }
    }
  }
  hits.sort((a, b) => b.rank - a.rank || a.len - b.len || a.text.localeCompare(b.text));
  if (!hits.length) return [`no api match for "${query}"`];
  const top = hits.slice(0, MAX_SEARCH_HITS).map((h) => h.text);
  if (hits.length > MAX_SEARCH_HITS) top.push(`…${hits.length - MAX_SEARCH_HITS} more matches`);
  return top;
}

function guideLines(dump: ApiDump, query: string): string[] {
  const byName = classIndex(dump);
  const dot = query.indexOf(".");
  const className = dot > 0 ? query.slice(0, dot) : query;
  const cls = byName.get(className.toLowerCase());
  if (!cls) return [`${DOC_SEARCH}${encodeURIComponent(query)}`];
  const anchor = dot > 0 ? `#${query.slice(dot + 1)}` : "";
  return [`${cls.Name} : ${cls.Superclass ?? "—"}`, `${DOC_BASE}/classes/${cls.Name}${anchor}`];
}

/** query: `Class`, `Class.Member`, or free text. */
export function queryApiDump(dump: ApiDump, query: string, kind: "api" | "guide" = "api"): string {
  const trimmed = query.trim();
  if (!trimmed) return "no query";
  if (kind === "guide") return guideLines(dump, trimmed).join("\n");

  const byName = classIndex(dump);
  const dot = trimmed.indexOf(".");
  if (dot > 0) {
    const cls = byName.get(trimmed.slice(0, dot).toLowerCase());
    const hit = cls ? findMember(dump, cls, trimmed.slice(dot + 1)) : null;
    if (cls && hit) {
      const via = hit.owner === cls ? "" : ` (from ${hit.owner.Name})`;
      return `${cls.Name}.${memberLine(hit.member)}${via}`;
    }
  }
  const cls = byName.get(trimmed.toLowerCase());
  if (cls) return classLines(dump, cls).join("\n");
  return searchLines(dump, trimmed).join("\n");
}
