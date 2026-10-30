// ogsync.toml loading. Values are merged over CONFIG_DEFAULTS section by
// section; unknown keys and wrong types fall back to the default rather than
// failing the daemon. Bun.TOML.parse does the parsing when present, otherwise a
// hand parser covers the subset this file needs (strings, numbers, bools,
// one-level tables).

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DEFAULTS, type OgsyncConfig } from "./proto/types.ts";
import { log } from "./log.ts";

export const CONFIG_FILE = "ogsync.toml";

const CONFLICT_POLICIES = ["prefer-newest", "prefer-studio", "prefer-fs", "manual"] as const;

type TomlValue = string | number | boolean | TomlTable | TomlValue[];
interface TomlTable {
  [key: string]: TomlValue | undefined;
}

/** `~/.ogsync` (or OGSYNC_HOME), created on demand: token, update state, daemon lock. */
export function ogsyncHome(): string {
  const override = process.env["OGSYNC_HOME"];
  const dir = override !== undefined && override.trim() !== "" ? override : join(homedir(), ".ogsync");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadConfig(dir: string): OgsyncConfig {
  const file = join(dir, CONFIG_FILE);
  const root = existsSync(file) ? parseToml(file) : {};
  const project = section(root, "project");
  const daemon = section(root, "daemon");
  const bind = section(root, "bind");
  const aliases = section(root, "aliases");
  const playtest = section(root, "playtest");
  const sync = section(root, "sync");
  const update = section(root, "update");
  const defaults = CONFIG_DEFAULTS;

  return {
    project: {
      name: str(project["name"], defaults.project.name),
      file: str(project["file"], defaults.project.file),
    },
    daemon: {
      port: envPort() ?? num(daemon["port"], defaults.daemon.port),
    },
    bind: {
      target_place: targetPlace(bind["target_place"]),
    },
    aliases: aliasTable(aliases),
    playtest: {
      max_clients: num(playtest["max_clients"], defaults.playtest.max_clients),
      auto_end_s: num(playtest["auto_end_s"], defaults.playtest.auto_end_s),
      plugin_grace_s: num(playtest["plugin_grace_s"], defaults.playtest.plugin_grace_s),
    },
    sync: {
      enabled: bool(sync["enabled"], defaults.sync.enabled),
      conflict: oneOf(sync["conflict"], CONFLICT_POLICIES, defaults.sync.conflict),
      debounce_fs_ms: num(sync["debounce_fs_ms"], defaults.sync.debounce_fs_ms),
      debounce_studio_ms: num(sync["debounce_studio_ms"], defaults.sync.debounce_studio_ms),
    },
    update: {
      auto: bool(update["auto"], defaults.update.auto),
    },
  };
}

export function defaultConfigToml(projectName: string): string {
  const d = CONFIG_DEFAULTS;
  return `# OGSync project config. Docs: https://github.com/joxan2137/ogsync-sync

[project]
name = "${projectName}"
file = "${d.project.file}"

[daemon]
port = ${d.daemon.port}

[bind]
# Default target for tools and sync: an alias, placeName or placeId.
# Omit it and tools target the only connected place; with several open they
# ask for an explicit target instead of guessing.
# target_place = "${projectName}"

[aliases]
# Stable names for places, usable anywhere a target is: main = 1234567890

[playtest]
max_clients = ${d.playtest.max_clients}
auto_end_s = ${d.playtest.auto_end_s}
plugin_grace_s = ${d.playtest.plugin_grace_s}

[sync]
enabled = ${d.sync.enabled}
conflict = "${d.sync.conflict}"
debounce_fs_ms = ${d.sync.debounce_fs_ms}
debounce_studio_ms = ${d.sync.debounce_studio_ms}

[update]
auto = ${d.update.auto}
`;
}

function parseToml(file: string): TomlTable {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    log.warn(`cannot read ${file}:`, err);
    return {};
  }
  if (typeof Bun !== "undefined" && typeof Bun.TOML?.parse === "function") {
    try {
      return asTable(Bun.TOML.parse(text));
    } catch (err) {
      log.warn(`${CONFIG_FILE} is not valid TOML, using defaults:`, err);
      return {};
    }
  }
  return parseTomlSubset(text);
}

function parseTomlSubset(text: string): TomlTable {
  const root: TomlTable = {};
  let current = root;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line === "") continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      const name = unquote(header[1]!.trim());
      const existing = root[name];
      const table = isTable(existing) ? existing : {};
      root[name] = table;
      current = table;
      continue;
    }
    const assignment = /^([^=]+)=(.*)$/.exec(line);
    if (!assignment) continue;
    current[unquote(assignment[1]!.trim())] = parseScalar(assignment[2]!.trim());
  }
  return root;
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function parseScalar(raw: string): TomlValue {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^["']/.test(raw)) return unquote(raw);
  if (/^[+-]?(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(raw)) return Number(raw.replaceAll("_", ""));
  return raw;
}

function unquote(raw: string): string {
  const quoted = /^"(.*)"$/.exec(raw) ?? /^'(.*)'$/.exec(raw);
  if (!quoted) return raw;
  return quoted[1]!.replace(/\\(["'\\nrt])/g, (_, esc: string) => {
    if (esc === "n") return "\n";
    if (esc === "r") return "\r";
    if (esc === "t") return "\t";
    return esc;
  });
}

function isTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTable(value: unknown): TomlTable {
  return isTable(value) ? value : {};
}

function section(root: TomlTable, name: string): TomlTable {
  return asTable(root[name]);
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function targetPlace(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return CONFIG_DEFAULTS.bind.target_place;
}

function aliasTable(table: TomlTable): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(table)) {
    if (typeof value === "string" && value.trim() !== "") out[name] = value.trim();
    else if (typeof value === "number" && Number.isFinite(value)) out[name] = String(value);
  }
  return out;
}

function envPort(): number | null {
  const raw = process.env["OGSYNC_PORT"];
  if (raw === undefined || raw.trim() === "") return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    log.warn(`ignoring invalid OGSYNC_PORT=${raw}`);
    return null;
  }
  return port;
}
