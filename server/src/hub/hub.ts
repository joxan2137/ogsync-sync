// Daemon side of docs/PROTOCOL.md: loopback-only Bun.serve serving every Studio
// place on the machine at once. Peers (one plugin session per DataModel) are
// grouped by place key and role; ops reach a place through a fair per-place
// scheduler, survive a plugin reconnect inside a grace window, and playtest
// start/stop go through the place's lease-holding PlaytestTracker.
//
// POST /rpc accepts two body shapes, both bearer-guarded:
//   {tool, args, caller}  → the registered tool executor (session proxies, CLI)
//   {op, args, timeoutMs} → a raw bridge op against the hub's default target
// Both answer `{ok: true, result}` or `{ok: false, error, code}`.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BridgeError,
  LONG_POLL_MS,
  OP_NAMES,
  PLUGIN_INSTALL_COMMAND,
  PROTO_VERSION,
  RESULT_CAP_BYTES,
  type Bridge,
  type BridgeErrorCode,
  type BridgeEvent,
  type CallOpts,
  type HandshakeRequest,
  type HandshakeResponse,
  type Job,
  type JobResult,
  type OgsyncConfig,
  type OpName,
  type PlaceState,
  type PullResponse,
  type PushRequest,
  type Role,
  type SessionInfo,
  type StateResponse,
  type SyncControl,
  type SyncStatus,
} from "../proto/types.ts";
import { ogsyncHome } from "../config.ts";
import { log } from "../log.ts";
import { DAEMON_CALLER, currentCaller, runAs } from "./caller.ts";
import { PlaytestTracker, compareHashes, type TrackerOptions } from "./playtest.ts";
import { FairScheduler } from "./scheduler.ts";
import {
  basePlaceKey,
  normalizePlaceName,
  parseTarget,
  resolvePlace,
  type PlaceIdentity,
  type TargetRole,
  type TargetSpec,
} from "./targets.ts";

const SWEEP_MS = 5_000;
const DEFAULT_CALL_TIMEOUT_MS = 15_000;
const MIN_CALL_TIMEOUT_MS = 1_000;
const MAX_CALL_TIMEOUT_MS = 600_000;
const HASHES_TIMEOUT_MS = 60_000;
/** Let a fresh play server settle (and the agent's first op go) before hashing every script. */
const STALE_CHECK_DELAY_MS = 2_000;
/** A dropped peer's in-flight calls wait this long for the same place and role to re-attach. */
const REATTACH_GRACE_MS = 30_000;
/** An unclean disappearance keeps the place listed (playtest "unknown") so hooks fail closed. */
const PLACE_LINGER_MS = 120_000;
const PLACE_CONCURRENCY = 1;
const MAX_BODY_BYTES = RESULT_CAP_BYTES * 2;
const MAX_TARGET_BRIDGES = 64;
const BEARER = "Bearer ";
/** Studio sends this; a browser cannot without a preflight the hub never answers. */
const PLUGIN_HEADER = "x-ogsync-plugin";
/** Per-registration secret from the handshake; pull and push without it are unknown sessions. */
const TOKEN_HEADER = "x-ogsync-token";
const PLUGIN_ROUTES: ReadonlySet<string> = new Set([
  "POST /handshake",
  "GET /pull",
  "POST /push",
]);
/** Read-only and secret-free: diagnostics, plugin port scans and Claude Code hooks. */
const OPEN_ROUTES: ReadonlySet<string> = new Set(["GET /health", "GET /id", "GET /state"]);

/** Ops whose args select a play-mode context; those go to the play-server session. */
const RUNTIME_CONTEXT_OPS: ReadonlySet<OpName> = new Set<OpName>(["run.exec", "log.tail"]);
/** Never wait behind the place queue: stopping must work while Studio is busy with something else. */
const PRIORITY_OPS: ReadonlySet<OpName> = new Set<OpName>(["play.stop", "play.stopSignal", "play.status"]);

const PLUGIN_ERROR_CODES = ["NOPLUGIN", "TIMEOUT", "NOPATH", "BADARG", "STUDIO"] as const satisfies readonly BridgeErrorCode[];

export interface HubOptions {
  config: OgsyncConfig;
  version: string;
  /** Defaults to config.daemon.port; 0 picks a free port. */
  port?: number;
  /** Tried in order until one binds; overrides `port`. */
  ports?: readonly number[];
  hostname?: string;
  longPollMs?: number;
  graceMs?: number;
  /** Tests shorten these; production derives the TTL from the long-poll window. */
  sessionTtlMs?: number;
  sweepMs?: number;
  tracker?: TrackerOptions;
}

export interface RpcCaller {
  id: string;
  /** Working directory of the client; selects ogsync.toml (default target, aliases, sync). */
  cwd?: string;
  label?: string;
}

export type RpcHandler = (tool: string, args: unknown, caller: RpcCaller) => Promise<unknown>;
export type AttachHandler = (body: { client?: unknown; cwd?: unknown }) => unknown;

/** Session ids are bearer-like (pull/push key on them) and never leave the daemon. */
export interface HealthSession {
  role: Role;
  placeName: string;
  placeId: number;
  placeKey: string;
  pluginVersion: string;
  /** Seconds since the last pull/push from this session. */
  age: number;
}

/** GET /health envelope. */
export interface HealthResponse {
  service: "ogsync";
  version: string;
  proto: number;
  sessions: HealthSession[];
  /** Place key the hub's own default target resolves to, if exactly one. */
  bound: string | null;
  sync: { enabled: boolean; pending: number; conflicts: number };
}

/** GET /id: the cheap identity probe the plugin and clients scan ports with. */
export interface IdResponse {
  service: "ogsync";
  version: string;
  proto: number;
  pid: number;
}

export type RpcResponse =
  | { ok: true; result: unknown; serverVersion?: string }
  | { ok: false; error: string; code: BridgeErrorCode; serverVersion?: string };

interface QueuedJob {
  seq: number;
  job: Job;
  delivered: boolean;
}

interface PollWaiter {
  resolve: (res: Response) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Peer {
  info: SessionInfo & { placeKey: string };
  /** Handshake-issued secret every pull and push must present. */
  token: string;
  /** Set while a push is being handled: jobs it unblocks ride back on its response. */
  pushing: boolean;
  slot: string;
  /** Jobs delivered-but-unacked and not-yet-delivered, in seq order. */
  queue: QueuedJob[];
  /** Acked by cursor, result not back yet: redelivered if this session re-handshakes. */
  inflight: Map<string, Job>;
  seq: number;
  waiter: PollWaiter | null;
}

interface Orphaned {
  session: string;
  jobs: QueuedJob[];
  timer: ReturnType<typeof setTimeout>;
}

interface PlaceRecord {
  key: string;
  name: string;
  placeId: number;
  tracker: PlaytestTracker;
  scheduler: FairScheduler<PendingCall>;
  /** Set when the last peer left; the record lingers so its state reads "unknown". */
  emptySince: number | null;
}

interface PendingCall {
  id: string;
  job: Job;
  place: string;
  slot: string;
  client: string;
  /** Session the job was handed to; null while it waits for admission or a re-attach. */
  session: string | null;
  scheduled: boolean;
  /** Handed to the plugin (pull or push response); before that a stop may cancel it. */
  delivered: boolean;
  onDeliver?: () => void;
  resolve: (data: unknown) => void;
  reject: (err: unknown) => void;
  onPartial?: (data: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Restarts the timeout so a streaming op is not killed mid-stream. */
  rearm: () => void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** `~/.ogsync/token`, generated 0600 on first run. Guards POST /rpc, /attach, /shutdown. */
export function ensureToken(): string {
  const file = join(ogsyncHome(), "token");
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    if (existing !== "") return existing;
  }
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

export function isLoopbackHost(host: string): boolean {
  const bare = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return bare === "localhost" || bare === "::1" || bare === "0:0:0:0:0:0:0:1" || bare.startsWith("127.");
}

export function versionMismatchReason(pluginProto: unknown, daemonProto = PROTO_VERSION): string {
  return `plugin speaks proto ${String(pluginProto)}, daemon speaks proto ${daemonProto}: run \`${PLUGIN_INSTALL_COMMAND}\` (or restart \`ogsync serve\`) and reload plugins in Studio`;
}

export class Hub implements Bridge {
  readonly version: string;
  readonly token: string;
  readonly startedAt = Date.now();
  private readonly config: OgsyncConfig;
  private readonly hostname: string;
  private readonly requestedPorts: readonly number[];
  private readonly longPollMs: number;
  private readonly sessionTtlMs: number;
  private readonly sweepMs: number;
  private readonly graceMs: number;
  private readonly trackerOptions: TrackerOptions;
  private readonly registry = new Map<string, Peer>();
  /** slot (`placeKey/role`) → session currently holding it. */
  private readonly slots = new Map<string, string>();
  private readonly orphans = new Map<string, Orphaned>();
  private readonly places = new Map<string, PlaceRecord>();
  private readonly calls = new Map<string, PendingCall>();
  private readonly listeners = new Set<(ev: BridgeEvent, from: SessionInfo) => void>();
  private readonly targets = new Map<string, TargetBridge>();
  private server: Bun.Server<undefined> | null = null;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private rpcHandler: RpcHandler | null = null;
  private attachHandler: AttachHandler | null = null;
  private shutdownHandler: (() => void) | null = null;
  private projectInfo: ((placeKey: string) => { name: string; syncEnabled: boolean } | null) | null = null;
  private syncControl: SyncControl | null = null;

  constructor(opts: HubOptions) {
    this.config = opts.config;
    this.version = opts.version;
    this.hostname = opts.hostname ?? "127.0.0.1";
    this.requestedPorts = opts.ports ?? [opts.port ?? opts.config.daemon.port];
    this.longPollMs = opts.longPollMs ?? LONG_POLL_MS;
    this.graceMs = opts.graceMs ?? REATTACH_GRACE_MS;
    this.trackerOptions = opts.tracker ?? {};
    // A Studio main-thread stall must not outlive the park window plus slack,
    // or a healthy session gets swept mid-poll.
    this.sessionTtlMs = opts.sessionTtlMs ?? Math.max(30_000, this.longPollMs * 2);
    this.sweepMs = opts.sweepMs ?? SWEEP_MS;
    if (!isLoopbackHost(this.hostname)) {
      throw new Error(`refusing to bind ${this.hostname}: the hub is loopback-only and has no override`);
    }
    this.token = ensureToken();
  }

  /** Binds the first free port of the requested list. */
  listen(): number {
    let lastError: unknown = null;
    for (const port of this.requestedPorts) {
      try {
        this.server = Bun.serve({
          hostname: this.hostname,
          port,
          // Must outlast a parked long-poll or Bun closes the socket mid-park.
          idleTimeout: Math.min(255, Math.ceil(this.longPollMs / 1000) + 10),
          maxRequestBodySize: MAX_BODY_BYTES,
          fetch: (req, server) => this.handle(req, server),
          error: (err: Error) => {
            log.error("hub request failed:", err);
            return this.json({ error: "internal error", code: "INTERNAL" }, 500);
          },
        });
        break;
      } catch (err) {
        lastError = err;
        log.debug(`port ${port} unavailable:`, err);
      }
    }
    if (this.server === null) {
      throw new Error(`no port available among ${this.requestedPorts.join(", ")}: ${errorMessage(lastError)}`);
    }
    this.sweeper = setInterval(() => this.sweep(), this.sweepMs);
    this.sweeper.unref?.();
    log.info(`hub listening on http://${this.hostname}:${this.port}`);
    return this.port;
  }

  get port(): number {
    return this.server?.port ?? this.requestedPorts[0] ?? 0;
  }

  stop(): void {
    for (const peer of [...this.registry.values()]) this.dropPeer(peer.info.session, "hub stopped", "fail");
    for (const slot of [...this.orphans.keys()]) this.expireOrphans(slot, "hub stopped");
    for (const id of [...this.calls.keys()]) this.failCall(id, new BridgeError("NOPLUGIN", "hub stopped"));
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    this.server?.stop(true);
    this.server = null;
  }

  setRpcHandler(fn: RpcHandler | null): void {
    this.rpcHandler = fn;
  }

  setAttachHandler(fn: AttachHandler | null): void {
    this.attachHandler = fn;
  }

  setShutdownHandler(fn: (() => void) | null): void {
    this.shutdownHandler = fn;
  }

  /** Which project (if any) syncs a place; reported to the plugin panel at handshake. */
  setProjectInfo(fn: ((placeKey: string) => { name: string; syncEnabled: boolean } | null) | null): void {
    this.projectInfo = fn;
  }

  setSyncControl(control: SyncControl | null): void {
    this.syncControl = control;
  }

  // ------------------------------------------------------------- Bridge (hub's own default target)

  async call(op: OpName, args: unknown, opts: CallOpts = {}): Promise<unknown> {
    return this.callTarget(this.defaultSpec(), this.config.aliases, op, args, opts);
  }

  bound(): SessionInfo | null {
    return this.resolvedPeer(this.defaultSpec(), this.config.aliases);
  }

  sessions(): SessionInfo[] {
    return [...this.registry.values()].map((peer) => peer.info);
  }

  onEvent(fn: (ev: BridgeEvent, from: SessionInfo) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  place(): PlaceState | null {
    return this.placeState(this.defaultSpec(), this.config.aliases);
  }

  // ------------------------------------------------------------- targets

  /** Bridge scoped to one target spec; cached so per-bridge state (log buffers) persists. */
  target(spec: TargetSpec, aliases: Readonly<Record<string, string>> = {}): Bridge {
    const key = JSON.stringify([spec.place, spec.role, aliases]);
    const cached = this.targets.get(key);
    if (cached) return cached;
    const bridge = new TargetBridge(this, spec, aliases);
    this.targets.set(key, bridge);
    if (this.targets.size > MAX_TARGET_BRIDGES) {
      const oldest = this.targets.keys().next().value;
      if (oldest !== undefined) this.targets.delete(oldest);
    }
    return bridge;
  }

  async callTarget(
    spec: TargetSpec,
    aliases: Readonly<Record<string, string>>,
    op: OpName,
    args: unknown,
    opts: CallOpts = {},
  ): Promise<unknown> {
    const place = this.resolveRecord(spec, aliases);
    if (op === "play.start") return this.startPlaytest(place, spec.role, args, opts);
    if (op === "play.stop") return this.stopPlaytest(place, spec.role, args, opts);
    return this.callPlace(place, spec.role, op, args, opts);
  }

  resolvedPeer(spec: TargetSpec, aliases: Readonly<Record<string, string>>): SessionInfo | null {
    try {
      const place = this.resolveRecord(spec, aliases);
      return this.peerAt(slotOf(place.key, "edit"))?.info ?? null;
    } catch {
      return null;
    }
  }

  resolvedKey(spec: TargetSpec, aliases: Readonly<Record<string, string>>): string | null {
    try {
      return this.resolveRecord(spec, aliases).key;
    } catch {
      return null;
    }
  }

  placeState(spec: TargetSpec, aliases: Readonly<Record<string, string>>): PlaceState | null {
    try {
      return this.describe(this.resolveRecord(spec, aliases));
    } catch {
      return null;
    }
  }

  state(): StateResponse {
    return {
      daemon: { version: this.version, proto: PROTO_VERSION, pid: process.pid, port: this.port, startedAt: this.startedAt },
      places: [...this.places.values()].map((place) => this.describe(place)),
    };
  }

  private defaultSpec(): TargetSpec {
    return parseTarget(this.config.bind.target_place);
  }

  private resolveRecord(spec: TargetSpec, aliases: Readonly<Record<string, string>>): PlaceRecord {
    const candidates: PlaceIdentity[] = [...this.places.values()].filter((place) => this.isReachable(place));
    const resolved = resolvePlace(spec, candidates, aliases);
    return this.places.get(resolved.key)!;
  }

  /** Live peers, or a dropped one still inside its re-attach window. */
  private isReachable(place: PlaceRecord): boolean {
    if (this.peersOf(place.key).length > 0) return true;
    for (const slot of this.orphans.keys()) if (slot.startsWith(`${place.key}/`)) return true;
    return false;
  }

  private describe(place: PlaceRecord): PlaceState {
    const now = Date.now();
    return {
      key: place.key,
      name: place.name,
      placeId: place.placeId,
      peers: this.peersOf(place.key).map((peer) => ({
        role: peer.info.role,
        pluginVersion: peer.info.pluginVersion,
        ageMs: now - peer.info.lastSeen,
      })),
      playtest: place.tracker.snapshot(),
    };
  }

  // ------------------------------------------------------------- playtest leases

  private async startPlaytest(place: PlaceRecord, role: TargetRole | null, args: unknown, opts: CallOpts): Promise<unknown> {
    const caller = currentCaller();
    const admission = place.tracker.admitStart(caller);
    if (admission.kind === "refused") throw new BridgeError("LEASE", admission.reason);
    if (admission.kind === "already") return { already: true, yours: true, ...place.tracker.snapshot() };
    const mode = isRecord(args) && typeof args["mode"] === "string" ? args["mode"] : "solo";
    const clients = mode === "solo" ? 1 : 0;
    if (clients > caller.playtest.max_clients) {
      throw new BridgeError("LEASE", `mode=${mode} spawns ${clients} client(s), over playtest.max_clients=${caller.playtest.max_clients}`);
    }
    place.tracker.beginStart(caller, mode, {
      maxClients: caller.playtest.max_clients,
      autoEndMs: caller.playtest.auto_end_s * 1000,
      pluginGraceMs: caller.playtest.plugin_grace_s * 1000,
    });
    try {
      const data = await this.callPlace(place, role, "play.start", args, opts, () => place.tracker.startDelivered());
      // Studio was already running a test this call did not start: no credit, no lease.
      if (isRecord(data) && data["already"] === true) {
        place.tracker.startFailed();
        return { ...data, yours: false };
      }
      place.tracker.startSucceeded();
      return data;
    } catch (err) {
      place.tracker.startFailed();
      throw err;
    }
  }

  private async stopPlaytest(place: PlaceRecord, role: TargetRole | null, args: unknown, opts: CallOpts): Promise<unknown> {
    const force = isRecord(args) && args["force"] === true;
    const admission = place.tracker.admitStop(currentCaller(), force);
    if (admission.kind === "refused") throw new BridgeError("LEASE", admission.reason);
    if (admission.kind === "idle") return { stopped: false, state: "idle" };
    const queuedStart = [...this.calls.values()].find(
      (call) => call.place === place.key && call.job.op === "play.start" && !call.delivered,
    );
    if (queuedStart) {
      this.failCall(queuedStart.id, new BridgeError("LEASE", "play.start was cancelled by play.stop before it reached Studio"));
      place.tracker.startFailed();
      if (place.tracker.snapshot().state === "idle") return { stopped: false, state: "idle", cancelledStart: true };
    }
    place.tracker.beginStop();
    try {
      return await this.callPlace(place, role, "play.stop", args, opts);
    } catch (err) {
      // The play session tearing down under the call is the success signal.
      const code = err instanceof BridgeError ? err.code : "STUDIO";
      if (code !== "NOPLUGIN" && code !== "TIMEOUT") place.tracker.stopFailed();
      throw err;
    }
  }

  private endPlaytest(place: PlaceRecord, reason: string): void {
    log.warn(`playtest on ${place.key} ${reason}`);
    place.tracker.beginStop();
    place.tracker.warn(reason);
    void runAs(DAEMON_CALLER, async () => {
      try {
        await this.callPlace(place, null, "play.stop", { force: true }, { timeoutMs: 10_000 });
      } catch {
        await this.callPlace(place, "edit", "play.stopSignal", {}, { timeoutMs: 10_000 }).catch(() => {});
      }
    });
  }

  /** Edit vs play-server script hashes, taken as the play server comes up. */
  private checkStaleCode(place: PlaceRecord): void {
    const timer = setTimeout(() => void this.compareScripts(place), STALE_CHECK_DELAY_MS);
    timer.unref?.();
  }

  private compareScripts(place: PlaceRecord): Promise<void> {
    return runAs(DAEMON_CALLER, async () => {
      if (this.server === null || this.peerAt(slotOf(place.key, "edit")) === null) return;
      try {
        const opts = { timeoutMs: HASHES_TIMEOUT_MS };
        const server = await this.callPlace(place, "server", "play.hashes", {}, opts);
        const edit = await this.callPlace(place, "edit", "play.hashes", {}, opts);
        place.tracker.setStale(compareHashes(hashesOf(edit), hashesOf(server)));
      } catch (err) {
        log.debug(`script hash comparison for ${place.key} failed:`, err);
      }
    });
  }

  // ------------------------------------------------------------- routing and admission

  private callPlace(
    place: PlaceRecord,
    role: TargetRole | null,
    op: OpName,
    args: unknown,
    opts: CallOpts,
    onDeliver?: () => void,
  ): Promise<unknown> {
    const routed = this.route(place, op, args, role);
    const id = crypto.randomUUID();
    const timeoutMs = clampTimeout(opts.timeoutMs);
    // Job ids must be unguessable: a result carrying a foreign id would
    // otherwise be a way to answer another client's call.
    const job: Job = { id, op, args: withPlayer(routed.args, routed.player ?? opts.player) };
    return new Promise<unknown>((resolve, reject) => {
      const expire = () => this.failCall(id, new BridgeError("TIMEOUT", `${op} not answered in ${timeoutMs}ms`));
      const call: PendingCall = {
        id,
        job,
        place: place.key,
        slot: routed.slot,
        client: currentCaller().id,
        session: null,
        scheduled: !PRIORITY_OPS.has(op),
        delivered: false,
        onDeliver,
        resolve,
        reject,
        onPartial: opts.onPartial,
        timer: setTimeout(expire, timeoutMs),
        rearm: () => {
          clearTimeout(call.timer);
          call.timer = setTimeout(expire, timeoutMs);
        },
      };
      this.calls.set(id, call);
      if (call.scheduled) place.scheduler.submit(call.client, call, (admitted) => this.deliver(admitted));
      else this.deliver(call);
    });
  }

  private route(
    place: PlaceRecord,
    op: OpName,
    args: unknown,
    role: TargetRole | null,
  ): { slot: string; args: unknown; player?: string | number } {
    const edit = slotOf(place.key, "edit");
    const server = slotOf(place.key, "server");
    const requireServer = (why: string): string => {
      if (this.peerAt(server) || this.orphans.has(server)) return server;
      throw new BridgeError("NOPLUGIN", `${why} needs a play-server session on ${place.key}; start a playtest first`);
    };
    if (role !== null && role.startsWith("client")) {
      const player = role === "client" ? undefined : Number(role.slice("client-".length));
      return { slot: requireServer(`target ${role}`), args: asClientContext(args), player };
    }
    if (role === "server") return { slot: requireServer("target server"), args };
    if (role === "edit" || op === "play.stopSignal") return { slot: edit, args };
    if (op === "play.stop") return { slot: this.peerAt(server) ? server : edit, args };
    const ctx = runtimeContext(op, args);
    if (ctx !== null) return { slot: requireServer(`${op} ctx=${ctx}`), args };
    return { slot: edit, args };
  }

  private deliver(call: PendingCall): void {
    if (!this.calls.has(call.id)) return;
    const peer = this.peerAt(call.slot);
    if (peer) {
      call.session = peer.info.session;
      this.enqueue(peer, call.job);
      return;
    }
    const orphaned = this.orphans.get(call.slot);
    if (orphaned) {
      orphaned.jobs.push({ seq: 0, job: call.job, delivered: false });
      return;
    }
    this.failCall(
      call.id,
      new BridgeError("NOPLUGIN", `no Studio session for ${call.slot}; open the place with the OGSync plugin enabled`),
    );
  }

  private peerAt(slot: string): Peer | null {
    const session = this.slots.get(slot);
    return session === undefined ? null : (this.registry.get(session) ?? null);
  }

  private peersOf(placeKey: string): Peer[] {
    return [...this.registry.values()].filter((peer) => peer.info.placeKey === placeKey);
  }

  // ------------------------------------------------------------- http

  private async handle(req: Request, server: Bun.Server<undefined>): Promise<Response> {
    const peer = server.requestIP(req);
    if (peer && !isLoopbackHost(peer.address)) {
      log.warn(`refused non-loopback request from ${peer.address}`);
      return this.json({ error: "loopback only", code: "FORBIDDEN" }, 403);
    }
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;
    // Loopback is not a trust boundary: any page the user visits can fetch
    // 127.0.0.1. Browsers cannot omit Origin on cross-site requests, cannot
    // send Sec-Fetch-Site: same-origin to another origin, and cannot set a
    // custom header without a preflight we never answer. Studio's
    // HttpService sends none of the three.
    const browserish =
      req.headers.get("origin") !== null ||
      req.headers.get("sec-fetch-site") !== null ||
      req.headers.get("sec-fetch-mode") !== null;
    if (browserish && !OPEN_ROUTES.has(route)) {
      log.warn(`refused browser-originated ${route} (origin ${req.headers.get("origin") ?? "-"})`);
      return this.json({ error: "browser requests are not accepted", code: "FORBIDDEN" }, 403);
    }
    if (PLUGIN_ROUTES.has(route) && !this.pluginHeaderOk(route, req.headers.get(PLUGIN_HEADER))) {
      return this.json(
        { error: `plugin endpoints require ${PLUGIN_HEADER}: ${PROTO_VERSION}`, code: "FORBIDDEN" },
        403,
      );
    }
    try {
      switch (route) {
        case "POST /handshake":
          return this.json(this.handshake(await this.body<HandshakeRequest>(req)));
        case "GET /pull":
          return await this.pull(req, url);
        case "POST /push":
          return this.push(await this.body<PushRequest>(req), req.headers.get(TOKEN_HEADER));
        case "GET /health":
          return this.json(this.health());
        case "GET /id":
          return this.json({ service: "ogsync", version: this.version, proto: PROTO_VERSION, pid: process.pid } satisfies IdResponse);
        case "GET /state":
          return this.json(this.state());
        case "POST /rpc":
          return await this.rpc(req);
        case "POST /attach":
          this.authorize(req);
          return this.json({ ok: true, result: this.attachHandler?.(await this.body(req)) ?? null });
        case "POST /shutdown":
          this.authorize(req);
          if (!this.shutdownHandler) throw new HttpError(503, "NOSHUTDOWN", "this hub has no shutdown handler");
          setTimeout(this.shutdownHandler, 50);
          return this.json({ ok: true });
        default:
          return this.json({ error: `no route for ${route}`, code: "NOROUTE" }, 404);
      }
    } catch (err) {
      if (err instanceof HttpError) return this.json({ error: err.message, code: err.code }, err.status);
      throw err;
    }
  }

  /**
   * A handshake from another protocol version must still reach handshake()
   * so the plugin gets a mismatch reason instead of a bare 403.
   */
  private pluginHeaderOk(route: string, header: string | null): boolean {
    if (header === null) return false;
    return route === "POST /handshake" ? /^\d+$/.test(header) : header === PROTO_VERSION.toString();
  }

  private async body<T>(req: Request): Promise<T> {
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      throw new HttpError(413, "TOOBIG", `body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    const raw = await req.text();
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
      throw new HttpError(413, "TOOBIG", `body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new HttpError(400, "BADJSON", "body is not valid JSON");
    }
  }

  private authorize(req: Request): void {
    const auth = req.headers.get("authorization") ?? "";
    const provided = auth.startsWith(BEARER) ? auth.slice(BEARER.length).trim() : "";
    if (provided === "" || provided !== this.token) {
      throw new HttpError(401, "AUTH", `bearer token required (${join(ogsyncHome(), "token")})`);
    }
  }

  private handshake(req: HandshakeRequest): HandshakeResponse {
    const base = { proto: PROTO_VERSION, serverVersion: this.version };
    const updatePlugin = req.pluginVersion !== this.version;
    const reject = (reason: string): HandshakeResponse => {
      log.warn(`handshake refused for ${short(String(req.session))}: ${reason}`);
      return { ...base, accepted: false, reason, updatePlugin, syncEnabled: false };
    };

    if (req.proto !== PROTO_VERSION) {
      const reason = versionMismatchReason(req.proto);
      log.warn(`handshake refused for ${short(String(req.session))}: ${reason}`);
      return { ...base, accepted: false, reason, updatePlugin: true, syncEnabled: false };
    }
    if (typeof req.session !== "string" || req.session === "") return reject("missing session id");
    if (req.role !== "edit" && req.role !== "server" && req.role !== "client") {
      return reject(`unknown role ${String(req.role)}`);
    }
    if (typeof req.placeName !== "string" || typeof req.placeId !== "number") {
      return reject("handshake needs placeName (string) and placeId (number)");
    }

    const now = Date.now();
    const existing = this.registry.get(req.session);
    const readopted =
      existing !== undefined &&
      typeof req.token === "string" &&
      req.token === existing.token &&
      existing.info.role === req.role &&
      existing.info.placeKey.split("~")[0] === basePlaceKey(req);
    if (existing && !readopted) {
      // A fresh registration under a known id (plugin restarted its loop without
      // the old secret): park the old one's calls for the new one to adopt.
      const samePlace = existing.info.role === req.role && existing.info.placeKey.split("~")[0] === basePlaceKey(req);
      this.dropPeer(req.session, "re-registered", samePlace ? "orphan" : "fail");
    }
    const placeKey = readopted ? existing.info.placeKey : this.assignKey(basePlaceKey(req), req.role, req.session);
    const info: Peer["info"] = {
      session: req.session,
      role: req.role,
      pluginVersion: req.pluginVersion,
      placeId: req.placeId,
      placeName: req.placeName,
      placeKey,
      connectedAt: readopted ? existing.info.connectedAt : now,
      lastSeen: now,
    };
    const place = this.ensurePlace(placeKey, req);

    if (readopted) {
      // Same plugin load reconnecting: everything it was given and has not
      // answered goes out again. Its job log answers duplicates from cache,
      // so an op it already ran is never run twice.
      this.releaseWaiter(existing);
      const pending = [...existing.inflight.values(), ...existing.queue.map((queued) => queued.job)];
      existing.inflight.clear();
      existing.queue = [];
      existing.seq = 0;
      existing.info = info;
      for (const job of pending) if (this.calls.has(job.id)) this.enqueue(existing, job);
    } else {
      const peer: Peer = {
        info,
        token: crypto.randomUUID(),
        pushing: false,
        slot: slotOf(placeKey, req.role),
        queue: [],
        inflight: new Map(),
        seq: 0,
        waiter: null,
      };
      this.registry.set(req.session, peer);
      this.slots.set(peer.slot, req.session);
      this.adoptOrphans(peer);
      if (req.role === "server") {
        place.tracker.serverPeer(true);
        this.checkStaleCode(place);
      }
    }

    log.info(`session ${short(req.session)} ${req.role} ${placeKey} (${req.placeName}) plugin ${req.pluginVersion}${readopted ? " re-adopted" : ""}`);
    if (updatePlugin) {
      log.warn(`plugin ${req.pluginVersion} != daemon ${this.version}; run \`${PLUGIN_INSTALL_COMMAND}\` and reload plugins in Studio`);
    }
    const project = this.projectInfo?.(placeKey) ?? { name: this.config.project.name, syncEnabled: this.config.sync.enabled };
    return {
      ...base,
      accepted: true,
      updatePlugin,
      syncEnabled: project.syncEnabled,
      projectName: project.name,
      placeKey,
      token: this.registry.get(req.session)!.token,
    };
  }

  /** Several Studios with one placeId each get their own key: `<id>`, `<id>~2`, … */
  private assignKey(base: string, role: Role, session: string): string {
    for (let n = 1; ; n += 1) {
      const key = n === 1 ? base : `${base}~${n}`;
      const holder = this.slots.get(slotOf(key, role));
      if (holder === undefined || holder === session) return key;
    }
  }

  private ensurePlace(key: string, req: HandshakeRequest): PlaceRecord {
    const name = req.placeName.replace(/ @ .*$/, "").trim();
    let place = this.places.get(key);
    if (!place) {
      place = {
        key,
        name,
        placeId: req.placeId,
        tracker: new PlaytestTracker(this.trackerOptions),
        scheduler: new FairScheduler<PendingCall>(PLACE_CONCURRENCY),
        emptySince: null,
      };
      this.places.set(key, place);
    }
    // Play DataModels carry a dated name; the edit peer's is the one to show.
    if (req.role === "edit" || normalizePlaceName(place.name) !== normalizePlaceName(name)) place.name = name;
    place.emptySince = null;
    return place;
  }

  private adoptOrphans(peer: Peer): void {
    const orphaned = this.orphans.get(peer.slot);
    if (!orphaned) return;
    clearTimeout(orphaned.timer);
    this.orphans.delete(peer.slot);
    for (const queued of orphaned.jobs) {
      const call = this.calls.get(queued.job.id);
      if (!call) continue;
      if (queued.delivered && orphaned.session !== peer.info.session) {
        this.failCall(
          queued.job.id,
          new BridgeError("NOPLUGIN", `Studio session changed while ${queued.job.op} was in flight; it may or may not have run`),
        );
        continue;
      }
      call.session = peer.info.session;
      this.enqueue(peer, queued.job);
    }
  }

  private pull(req: Request, url: URL): Promise<Response> | Response {
    const peer = this.requireSession(url.searchParams.get("session"), req.headers.get(TOKEN_HEADER));
    peer.info.lastSeen = Date.now();

    // A cursor beyond our own seq means the plugin kept state across a daemon
    // restart; honoring it would filter out every job we ever enqueue.
    const cursor = Number(url.searchParams.get("cursor") ?? "0");
    if (Number.isFinite(cursor) && cursor > 0 && cursor <= peer.seq) {
      for (const queued of peer.queue) {
        if (queued.seq <= cursor && this.calls.has(queued.job.id)) peer.inflight.set(queued.job.id, queued.job);
      }
      peer.queue = peer.queue.filter((queued) => queued.seq > cursor);
    } else if (cursor > peer.seq) {
      log.warn(`session ${short(peer.info.session)} sent cursor ${cursor} > seq ${peer.seq}; ignoring ack`);
    }
    this.releaseWaiter(peer);
    if (peer.queue.length > 0) return this.jobsResponse(peer);

    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        peer.waiter = null;
        resolve(this.noContent());
      }, this.longPollMs);
      const waiter: PollWaiter = { resolve, timer };
      peer.waiter = waiter;
      req.signal.addEventListener("abort", () => {
        if (peer.waiter === waiter) this.releaseWaiter(peer);
      });
    });
  }

  /**
   * Settling a result usually admits the place's next call; its job rides back
   * on this response instead of waking the parked pull, which would cost the
   * plugin a second request per job against Studio's HttpService budget.
   */
  private push(body: PushRequest, token: string | null): Response {
    const peer = this.requireSession(body.session, token);
    peer.info.lastSeen = Date.now();
    peer.pushing = true;
    try {
      for (const result of body.results ?? []) this.settle(result, peer);
      for (const ev of body.events ?? []) this.dispatch(ev, peer);
    } finally {
      peer.pushing = false;
    }
    if (this.registry.get(peer.info.session) !== peer || peer.queue.length === 0) return this.json({ ok: true });
    const jobs = peer.queue.map((queued) => queued.job);
    // Delivered on this response, so acked too: the pull never resends them.
    for (const queued of peer.queue) {
      this.markDelivered(queued);
      peer.inflight.set(queued.job.id, queued.job);
    }
    peer.queue = [];
    return this.json({ ok: true, jobs });
  }

  private health(): HealthResponse {
    let status: SyncStatus | null = null;
    try {
      status = this.syncControl?.status() ?? null;
    } catch (err) {
      log.debug("sync status unavailable:", err);
    }
    const now = Date.now();
    return {
      service: "ogsync",
      version: this.version,
      proto: PROTO_VERSION,
      sessions: this.sessions().map((info) => ({
        role: info.role,
        placeName: info.placeName,
        placeId: info.placeId,
        placeKey: info.placeKey ?? basePlaceKey(info),
        pluginVersion: info.pluginVersion,
        age: Math.round((now - info.lastSeen) / 1000),
      })),
      bound: this.bound()?.placeKey ?? null,
      sync: {
        enabled: status?.enabled ?? this.config.sync.enabled,
        pending: status?.pending ?? 0,
        conflicts: status?.conflicts.length ?? 0,
      },
    };
  }

  private async rpc(req: Request): Promise<Response> {
    this.authorize(req);
    const body = await this.body<{
      tool?: unknown;
      op?: unknown;
      args?: unknown;
      timeoutMs?: unknown;
      caller?: unknown;
    }>(req);
    const args = body.args ?? {};
    const timeoutMs = typeof body.timeoutMs === "number" ? body.timeoutMs : undefined;
    try {
      if (typeof body.op === "string") {
        if (!(OP_NAMES as readonly string[]).includes(body.op)) {
          throw new HttpError(400, "BADARG", `unknown op ${body.op}`);
        }
        return this.json({ ok: true, result: await this.call(body.op as OpName, args, { timeoutMs }) });
      }
      if (typeof body.tool === "string") {
        if (!this.rpcHandler) throw new HttpError(503, "NORPC", "this daemon runs without the tool layer");
        return this.json({ ok: true, result: await this.rpcHandler(body.tool, args, rpcCaller(body.caller)) });
      }
      throw new HttpError(400, "BADARG", "expected {tool, args} or {op, args}");
    } catch (err) {
      if (err instanceof HttpError) throw err;
      return this.json(rpcFailure(err));
    }
  }

  // ------------------------------------------------------------- queues

  private enqueue(peer: Peer, job: Job): void {
    peer.seq += 1;
    peer.queue.push({ seq: peer.seq, job, delivered: false });
    log.debug(`job ${job.id} ${job.op} → ${short(peer.info.session)} (seq ${peer.seq})`);
    if (!peer.pushing) this.flush(peer);
  }

  private flush(peer: Peer): void {
    const waiter = peer.waiter;
    if (!waiter || peer.queue.length === 0) return;
    peer.waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(this.jobsResponse(peer));
  }

  private markDelivered(queued: QueuedJob): void {
    if (queued.delivered) return;
    queued.delivered = true;
    const call = this.calls.get(queued.job.id);
    if (!call || call.delivered) return;
    call.delivered = true;
    call.onDeliver?.();
  }

  private jobsResponse(peer: Peer): Response {
    for (const queued of peer.queue) this.markDelivered(queued);
    const payload: PullResponse = {
      cursor: peer.queue.at(-1)?.seq ?? peer.seq,
      jobs: peer.queue.map((queued) => queued.job),
    };
    return this.json(payload);
  }

  private releaseWaiter(peer: Peer): void {
    const waiter = peer.waiter;
    if (!waiter) return;
    peer.waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(this.noContent());
  }

  private settle(result: JobResult, from: Peer): void {
    const call = this.calls.get(result.id);
    if (!call) {
      log.debug(`result for unknown job ${result.id}`);
      return;
    }
    // Only the session the job was dispatched to may answer it.
    if (call.session !== from.info.session) {
      log.warn(`session ${short(from.info.session)} answered job ${result.id} it does not own`);
      return;
    }
    const size = payloadSize(result.data);
    if (size > RESULT_CAP_BYTES) {
      this.failCall(result.id, new BridgeError("STUDIO", `result of ${size} bytes exceeds the ${RESULT_CAP_BYTES} byte cap`));
      return;
    }
    if (result.partial === true) {
      call.onPartial?.(result.data);
      call.rearm();
      return;
    }
    this.finishCall(call);
    if (result.ok) call.resolve(result.data);
    else call.reject(pluginError(result.err));
  }

  private failCall(id: string, err: BridgeError): void {
    const call = this.calls.get(id);
    if (!call) return;
    this.finishCall(call);
    call.reject(err);
  }

  /** Forgets a call wherever it sits: admission queue, a peer queue, an orphan list. */
  private finishCall(call: PendingCall): void {
    clearTimeout(call.timer);
    this.calls.delete(call.id);
    const peer = call.session === null ? undefined : this.registry.get(call.session);
    if (peer) {
      peer.queue = peer.queue.filter((queued) => queued.job.id !== call.id);
      peer.inflight.delete(call.id);
    }
    const orphaned = this.orphans.get(call.slot);
    if (orphaned) orphaned.jobs = orphaned.jobs.filter((queued) => queued.job.id !== call.id);
    if (call.scheduled) {
      const scheduler = this.places.get(call.place)?.scheduler;
      if (scheduler && !scheduler.cancel(call)) scheduler.release(call);
    }
  }

  private dispatch(ev: BridgeEvent, peer: Peer): void {
    for (const fn of this.listeners) {
      try {
        fn(ev, peer.info);
      } catch (err) {
        log.warn("event listener failed:", err);
      }
    }
    if (ev.ev === "goodbye") {
      this.dropPeer(peer.info.session, "unloaded", "fail");
      return;
    }
    if (ev.ev !== "playtestState") return;
    if (ev.state === "stopped" && peer.info.role !== "edit") {
      this.dropPeer(peer.info.session, "playtest stopped", "fail");
      return;
    }
    const tracker = this.places.get(peer.info.placeKey)?.tracker;
    tracker?.report(peer.info.role === "edit" ? "edit" : "server", ev.state, ev.mode, ev.players);
  }

  private requireSession(session: string | null, token: string | null): Peer {
    const peer = session === null ? undefined : this.registry.get(session);
    // A wrong secret reads exactly like an unknown session: re-handshake. That
    // also makes a goodbye from an older registration a no-op.
    if (!peer || token === null || token !== peer.token) {
      throw new HttpError(409, "NOSESSION", "unknown session, handshake first");
    }
    return peer;
  }

  /**
   * "orphan" parks the peer's unanswered jobs for the re-attach grace window
   * (expiry, transport loss); "fail" answers them NOPLUGIN now (the plugin is
   * gone on purpose: playtest over, plugin unloaded).
   */
  private dropPeer(session: string, why: string, mode: "orphan" | "fail"): void {
    const peer = this.registry.get(session);
    if (!peer) return;
    this.registry.delete(session);
    if (this.slots.get(peer.slot) === session) this.slots.delete(peer.slot);
    this.releaseWaiter(peer);
    const jobs: QueuedJob[] = [
      ...[...peer.inflight.values()].map((job) => ({ seq: 0, job, delivered: true })),
      ...peer.queue,
    ].filter((queued) => this.calls.has(queued.job.id));
    for (const queued of jobs) {
      const call = this.calls.get(queued.job.id);
      if (call) call.session = null;
    }
    if (mode === "orphan" && jobs.length > 0) {
      const existing = this.orphans.get(peer.slot);
      if (existing) clearTimeout(existing.timer);
      const orphaned: Orphaned = {
        session,
        jobs: [...(existing?.jobs ?? []), ...jobs],
        timer: setTimeout(() => this.expireOrphans(peer.slot, `did not re-attach within ${this.graceMs / 1000}s`), this.graceMs),
      };
      orphaned.timer.unref?.();
      this.orphans.set(peer.slot, orphaned);
    } else {
      for (const queued of jobs) {
        this.failCall(queued.job.id, new BridgeError("NOPLUGIN", `session ${short(session)} ${why}`));
      }
    }

    const place = this.places.get(peer.info.placeKey);
    if (place) {
      if (peer.info.role === "server") place.tracker.serverPeer(false);
      if (this.peersOf(place.key).length === 0) {
        // An unloaded edit plugin is a clean exit; anything else lingers as "unknown".
        if (why === "unloaded" && peer.info.role === "edit" && !this.isReachable(place)) this.places.delete(place.key);
        else place.emptySince = Date.now();
      }
    }
    log.info(`session ${short(session)} ${why}`);
  }

  private expireOrphans(slot: string, why: string): void {
    const orphaned = this.orphans.get(slot);
    if (!orphaned) return;
    clearTimeout(orphaned.timer);
    this.orphans.delete(slot);
    for (const queued of orphaned.jobs) {
      this.failCall(queued.job.id, new BridgeError("NOPLUGIN", `no Studio session for ${slot}: ${why}`));
    }
  }

  private sweep(): void {
    const now = Date.now();
    const cutoff = now - this.sessionTtlMs;
    for (const peer of [...this.registry.values()]) {
      // A parked poll is proof of life even though lastSeen is not refreshed
      // until it returns; sweeping it would drop a healthy session's queue.
      if (peer.waiter !== null || peer.info.lastSeen >= cutoff) continue;
      this.dropPeer(peer.info.session, `expired after ${this.sessionTtlMs / 1000}s without a pull`, "orphan");
    }
    for (const place of [...this.places.values()]) {
      if (place.emptySince !== null && now - place.emptySince > PLACE_LINGER_MS && !this.isReachable(place)) {
        this.places.delete(place.key);
        continue;
      }
      const reason = place.tracker.due();
      if (reason !== null) this.endPlaytest(place, reason);
    }
  }

  private json(body: object, status = 200): Response {
    return Response.json({ serverVersion: this.version, ...body }, { status });
  }

  /** 204 carries no body, so the mandatory serverVersion travels as a header. */
  private noContent(): Response {
    return new Response(null, { status: 204, headers: { "x-ogsync-version": this.version } });
  }
}

/** A Bridge whose every call resolves its target at call time, so a reconnect or a new place never strands it. */
class TargetBridge implements Bridge {
  constructor(
    private readonly hub: Hub,
    private readonly spec: TargetSpec,
    private readonly aliases: Readonly<Record<string, string>>,
  ) {}

  call(op: OpName, args: unknown, opts?: CallOpts): Promise<unknown> {
    return this.hub.callTarget(this.spec, this.aliases, op, args, opts);
  }

  bound(): SessionInfo | null {
    return this.hub.resolvedPeer(this.spec, this.aliases);
  }

  sessions(): SessionInfo[] {
    return this.hub.sessions();
  }

  onEvent(fn: (ev: BridgeEvent, from: SessionInfo) => void): () => void {
    return this.hub.onEvent((ev, from) => {
      if (from.placeKey === this.hub.resolvedKey(this.spec, this.aliases)) fn(ev, from);
    });
  }

  place(): PlaceState | null {
    return this.hub.placeState(this.spec, this.aliases);
  }
}

function slotOf(placeKey: string, role: Role): string {
  return `${placeKey}/${role}`;
}

/** NaN, negatives and 2^31+ all fire setTimeout immediately; clamp to a sane band. */
function clampTimeout(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_CALL_TIMEOUT_MS;
  return Math.min(MAX_CALL_TIMEOUT_MS, Math.max(MIN_CALL_TIMEOUT_MS, Math.floor(requested)));
}

function withPlayer(args: unknown, player: CallOpts["player"]): unknown {
  if (player === undefined || !isRecord(args) || args["player"] !== undefined) return args;
  return { ...args, player };
}

/** The plugin dispatcher brokers a job to a client when its args say ctx=client. */
function asClientContext(args: unknown): unknown {
  const base = isRecord(args) ? args : {};
  return { ...base, ctx: "client", ...(base["context"] === undefined ? {} : { context: "client" }) };
}

function runtimeContext(op: OpName, args: unknown): "server" | "client" | null {
  if (!RUNTIME_CONTEXT_OPS.has(op) || !isRecord(args)) return null;
  const ctx = args["ctx"] ?? args["context"];
  return ctx === "server" || ctx === "client" ? ctx : null;
}

function hashesOf(data: unknown): Record<string, string> {
  if (!isRecord(data) || !isRecord(data["hashes"])) return {};
  const out: Record<string, string> = {};
  for (const [path, hash] of Object.entries(data["hashes"])) if (typeof hash === "string") out[path] = hash;
  return out;
}

function rpcCaller(raw: unknown): RpcCaller {
  if (!isRecord(raw) || typeof raw["id"] !== "string" || raw["id"] === "") return { id: "rpc" };
  return {
    id: raw["id"],
    cwd: typeof raw["cwd"] === "string" ? raw["cwd"] : undefined,
    label: typeof raw["label"] === "string" ? raw["label"] : undefined,
  };
}

function pluginError(err: string | undefined): BridgeError {
  const tagged = /^([A-Z]+):\s*(.*)$/.exec(err ?? "");
  const code = tagged?.[1];
  if (code && (PLUGIN_ERROR_CODES as readonly string[]).includes(code)) {
    return new BridgeError(code as BridgeErrorCode, tagged[2] ?? code);
  }
  return new BridgeError("STUDIO", err ?? "plugin reported failure without a message");
}

function rpcFailure(err: unknown): RpcResponse {
  if (err instanceof BridgeError) return { ok: false, error: err.message, code: err.code };
  return { ok: false, error: errorMessage(err), code: "STUDIO" };
}

function payloadSize(data: unknown): number {
  if (data === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(data) ?? "");
  } catch {
    return 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function short(session: string): string {
  return session.slice(0, 8);
}
