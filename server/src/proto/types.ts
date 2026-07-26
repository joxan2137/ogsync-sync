// Shared contract between hub, MCP tools, sync engine, and the wire protocol.
// docs/PROTOCOL.md is the authoritative wire spec; keep in lockstep.

export const PROTO_VERSION = 1;
export const DEFAULT_PORT = 3667;
export const LONG_POLL_MS = 25_000;
export const RESULT_CAP_BYTES = 1_048_576;

// ---------------------------------------------------------------- identity

export type Role = "edit" | "server" | "client";

export interface SessionInfo {
  session: string;
  role: Role;
  pluginVersion: string;
  placeId: number;
  placeName: string;
  connectedAt: number;
  lastSeen: number;
}

// ---------------------------------------------------------------- wire envelopes

export interface HandshakeRequest {
  proto: number;
  session: string;
  role: Role;
  pluginVersion: string;
  placeId: number;
  placeName: string;
}

export interface HandshakeResponse {
  proto: number;
  serverVersion: string;
  accepted: boolean;
  reason?: string;
  updatePlugin: boolean;
  syncEnabled: boolean;
  projectName?: string;
}

export interface Job {
  id: string;
  op: OpName;
  args: unknown;
}

export interface PullResponse {
  cursor: number;
  jobs: Job[];
}

export interface JobResult {
  id: string;
  ok: boolean;
  data?: unknown;
  err?: string;
  partial?: boolean;
}

export interface PushRequest {
  session: string;
  results?: JobResult[];
  events?: BridgeEvent[];
}

export type BridgeEvent =
  | { ev: "scriptChanged"; path: string; source?: string; hash: string; ts: number }
  | { ev: "instAdded"; path: string; class: string }
  | { ev: "instRemoved"; path: string }
  | { ev: "instRenamed"; path: string; oldPath: string }
  | { ev: "log"; ctx: Role; level: "info" | "warn" | "error"; msg: string; ts: number }
  | { ev: "playtestState"; state: "starting" | "running" | "stopped"; mode?: string }
  | { ev: "selection"; paths: string[] }
  // Connection-panel UI (docs/PLUGIN_CONTRACT.md § Connection panel)
  | { ev: "syncToggle"; paused: boolean }
  | { ev: "resolveConflict"; file: string; keep: "fs" | "studio" };

// ---------------------------------------------------------------- ops

export const OP_NAMES = [
  "inst.get", "inst.set", "inst.create", "inst.delete", "inst.duplicate",
  "inst.find", "inst.tree",
  "script.read", "script.edit", "script.grep",
  "run.exec",
  "play.start", "play.stop", "play.stopSignal", "play.status",
  "log.tail",
  "shot.capture",
  "prof.micro", "prof.script", "prof.memory",
  "input.batch",
  "asset.op",
  "rbxm.export", "rbxm.import",
  "hist.op",
  "sel.get",
  "sync.apply", "sync.snapshot", "sync.hash", "sync.conflicts",
] as const;
export type OpName = (typeof OP_NAMES)[number];

// ---------------------------------------------------------------- bridge interface
// Implemented by hub (direct daemon) and by the HTTP proxy (second instance).
// MCP tools and the sync engine depend ONLY on this.

export interface CallOpts {
  timeoutMs?: number;
  /** run.exec client context: play-server brokers to this player */
  player?: string | number;
  onPartial?: (data: unknown) => void;
}

export interface Bridge {
  /** Dispatch an op to the bound Studio session. Rejects with BridgeError. */
  call(op: OpName, args: unknown, opts?: CallOpts): Promise<unknown>;
  /** Bound session, or null when no matching Studio connected. */
  bound(): SessionInfo | null;
  sessions(): SessionInfo[];
  /** Subscribe to plugin events; returns unsubscribe. */
  onEvent(fn: (ev: BridgeEvent, from: SessionInfo) => void): () => void;
}

export type BridgeErrorCode =
  | "NOPLUGIN"   // no bound session
  | "TIMEOUT"    // op not answered in time
  | "NOPATH"     // instance path did not resolve
  | "BADARG"     // invalid arguments
  | "AUTH"       // /rpc bearer token missing or wrong
  | "STUDIO";    // plugin-side execution error

export class BridgeError extends Error {
  constructor(public code: BridgeErrorCode, message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

/** Uniform tool-output error line. */
export function errLine(e: unknown): string {
  if (e instanceof BridgeError) return `ERR ${e.code}: ${e.message}`;
  return `ERR STUDIO: ${e instanceof Error ? e.message : String(e)}`;
}

// ---------------------------------------------------------------- config

export interface OgsyncConfig {
  project: {
    name: string;
    /** rojo-style project file, default "default.project.json" */
    file: string;
  };
  daemon: { port: number };
  bind: {
    /** placeName or placeId the daemon binds ops+sync to; null = first session */
    target_place: string | number | null;
  };
  sync: {
    enabled: boolean;
    conflict: "prefer-newest" | "prefer-studio" | "prefer-fs" | "manual";
    debounce_fs_ms: number;
    debounce_studio_ms: number;
  };
  update: { auto: boolean };
}

export const CONFIG_DEFAULTS: OgsyncConfig = {
  project: { name: "game", file: "default.project.json" },
  daemon: { port: DEFAULT_PORT },
  bind: { target_place: null },
  sync: {
    enabled: true,
    conflict: "prefer-newest",
    debounce_fs_ms: 100,
    debounce_studio_ms: 300,
  },
  update: { auto: true },
};

// ---------------------------------------------------------------- sync

export interface SyncChange {
  kind: "write" | "create" | "delete" | "rename";
  path: string;          // instance dot-path
  class?: string;
  source?: string;
  baseHash?: string;
  newName?: string;
}

export interface ConflictInfo {
  file: string;        // fs path relative to project root
  path: string;        // instance dot-path
  ts: number;
  resolution: "pending" | "kept-fs" | "kept-studio";
  backupFile?: string; // where the losing version was saved
}

export interface SyncStatus {
  enabled: boolean;
  paused: boolean;
  connected: boolean;
  projectName: string;
  pending: number;
  conflicts: ConflictInfo[];
}

/** Handle the `sync` MCP tool drives; implemented by sync/engine.ts. */
export interface SyncControl {
  status(): SyncStatus;
  pause(): void;
  resume(): void;
  fullPull(): Promise<string>;
  fullPush(): Promise<string>;
  resolve(file: string, keep: "fs" | "studio"): Promise<string>;
}

export interface SnapshotEntry {
  path: string;
  class: string;
  hash: string;
  runCtx?: "server" | "client" | "module" | "plugin";
}

/**
 * Script sources are hashed and shipped LF-only. Studio never produces \r;
 * Windows editors do — normalize at every file-read boundary so both sides
 * hash identical bytes.
 */
export function normalizeSource(s: string): string {
  if (!s.includes("\r")) return s;
  return s.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

/**
 * Dual FNV-1a 32-bit over UTF-8 bytes, hex-concatenated (16 chars).
 * The plugin implements the identical algorithm in Luau over raw string
 * bytes (Luau strings are byte arrays; sources are UTF-8) — both sides must
 * produce identical hashes or echo suppression breaks.
 */
export function contentHash(s: string): string {
  const bytes = Buffer.from(s, "utf8");
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x01234567 >>> 0;
  for (const b of bytes) {
    h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ b, 0x01000197) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
