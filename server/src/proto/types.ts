// Shared contract between hub, MCP tools, sync engine, and the wire protocol.
// docs/PROTOCOL.md is the authoritative wire spec; keep in lockstep.

export const PROTO_VERSION = 2;
export const DEFAULT_PORT = 3667;
/**
 * The only ports the daemon binds, in preference order; the plugin scans the
 * same list (plugin/src/Util/Ports.luau) when its last port stops answering.
 * All sit below the Windows dynamic range, where Hyper-V reserves blocks.
 */
export const CANDIDATE_PORTS: readonly number[] = [3667, 3668, 3669, 13667, 23667, 33667, 43667, 45667];
/** Named in every version-mismatch error: the one command that writes the plugin file. */
export const PLUGIN_INSTALL_COMMAND = "ogsync plugin install";
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
  /** placeId, or the normalized name of an unsaved place; `~N` marks a duplicate Studio. */
  placeKey?: string;
}

// ---------------------------------------------------------------- wire envelopes

export interface HandshakeRequest {
  proto: number;
  session: string;
  /** Secret from this session's previous handshake; proves a reconnect, not a new plugin load. */
  token?: string;
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
  placeKey?: string;
  /** Per-registration secret: send as X-OGSync-Token on every pull and push. */
  token?: string;
}

export interface Job {
  id: string;
  op: OpName;
  args: unknown;
  /** The daemon's deadline for this call; plugin-side waits (client broker) size themselves to it. */
  timeoutMs?: number;
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
  // Pushed on change and every PLAYTEST_HEARTBEAT_MS; "stopped" ends a play-mode peer.
  | { ev: "playtestState"; state: PlaytestReport; mode?: string; players?: number; hb?: boolean }
  | { ev: "selection"; paths: string[] }
  // Connection-panel UI (docs/PLUGIN_CONTRACT.md § Connection panel)
  | { ev: "syncToggle"; paused: boolean }
  | { ev: "resolveConflict"; file: string; keep: "fs" | "studio" }
  // Plugin unloading: drop the peer now instead of waiting out the session TTL.
  | { ev: "goodbye" };

export type PlaytestReport = "idle" | "starting" | "running" | "stopping" | "stopped";

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
  "run.job", "script.stage", "inst.transform",
  "play.hashes",
  "wait.check",
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
  /** Daemon view of the target place (peers, playtest state); absent on bridges without one. */
  place?(): PlaceState | null;
}

export type BridgeErrorCode =
  | "NOPLUGIN"   // no bound session
  | "TIMEOUT"    // op not answered in time
  | "NOPATH"     // instance path did not resolve
  | "BADARG"     // invalid arguments
  | "AUTH"       // /rpc bearer token missing or wrong
  | "STUDIO"     // plugin-side execution error
  | "TARGET"     // target missing, unknown or ambiguous across connected places
  | "THROTTLED"  // identical poll repeated inside the throttle window
  | "LEASE"      // playtest owned by another session or started by the user
  | "VERSION";   // plugin or daemon speaks another protocol version

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
    /** Default target (alias, placeName or placeId) for this project's sessions; null = the only connected place */
    target_place: string | number | null;
  };
  /** [aliases] name = placeName or placeId; usable anywhere a target is. */
  aliases: Record<string, string>;
  playtest: {
    /** Play-mode clients an agent may have running at once. */
    max_clients: number;
    /** Agent-started playtests are stopped after this long; 0 disables. */
    auto_end_s: number;
    /** A running test without a play-server peer after this long means user plugins are off in test mode. */
    plugin_grace_s: number;
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
  aliases: {},
  playtest: { max_clients: 2, auto_end_s: 1800, plugin_grace_s: 10 },
  sync: {
    enabled: true,
    conflict: "prefer-newest",
    debounce_fs_ms: 100,
    debounce_studio_ms: 300,
  },
  update: { auto: true },
};

// ---------------------------------------------------------------- daemon state (GET /state)

export type PlaytestPhase = "idle" | "starting" | "running" | "stopping" | "unknown";

export interface StaleCode {
  /** Scripts whose play-server copy differs from the edit DataModel. */
  changed: number;
  /** Scripts in the edit DataModel the play server does not have. */
  missing: number;
  sample: string[];
}

export interface PlaytestInfo {
  state: PlaytestPhase;
  mode: string | null;
  /** Client id holding the lease; null when no agent owns the playtest. */
  owner: string | null;
  startedBy: "agent" | "user" | null;
  /** Epoch ms of the last state change. */
  since: number;
  /** null until the first plugin heartbeat. */
  heartbeatAgeMs: number | null;
  players: number;
  stale: StaleCode | null;
  warning: string | null;
}

export interface PeerState {
  role: Role;
  pluginVersion: string;
  ageMs: number;
}

export interface PlaceState {
  key: string;
  name: string;
  placeId: number;
  peers: PeerState[];
  playtest: PlaytestInfo;
}

export interface StateResponse {
  daemon: { version: string; proto: number; pid: number; port: number; startedAt: number };
  places: PlaceState[];
}

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
