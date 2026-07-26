// Daemon side of docs/PROTOCOL.md: loopback-only Bun.serve with per-session job
// queues, 25 s long-poll delivery, cursor acks with redelivery of unacked jobs,
// and the Bridge implementation that MCP tools and the sync engine call.
//
// POST /rpc accepts two body shapes, both bearer-guarded:
//   {tool, args}          → the registered MCP tool handler (CLI, docs/PROTOCOL.md)
//   {op, args, timeoutMs} → a raw bridge op, for proxy instances whose own MCP
//                           layer formats output locally (see hub/proxy.ts)
// Both answer `{ok: true, result}` or `{ok: false, error, code}`.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BridgeError,
  LONG_POLL_MS,
  OP_NAMES,
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
  type PullResponse,
  type PushRequest,
  type Role,
  type SessionInfo,
  type SyncControl,
  type SyncStatus,
} from "../proto/types.ts";
import { ogsyncHome } from "../config.ts";
import { log } from "../log.ts";

const SESSION_TTL_MS = 30_000;
const SWEEP_MS = 5_000;
const DEFAULT_CALL_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = RESULT_CAP_BYTES * 2;
const BEARER = "Bearer ";

/** Ops whose args select a play-mode context; those go to the play-server session. */
const RUNTIME_CONTEXT_OPS: ReadonlySet<OpName> = new Set<OpName>(["run.exec", "log.tail"]);

const PLUGIN_ERROR_CODES = ["NOPLUGIN", "TIMEOUT", "NOPATH", "BADARG", "STUDIO"] as const satisfies readonly BridgeErrorCode[];

export interface HubOptions {
  config: OgsyncConfig;
  version: string;
  /** Defaults to config.daemon.port; 0 picks a free port. */
  port?: number;
  hostname?: string;
  longPollMs?: number;
}

export type RpcHandler = (tool: string, args: unknown) => Promise<unknown>;

export interface HealthSession {
  session: string;
  role: Role;
  placeName: string;
  /** Seconds since the last pull/push from this session. */
  age: number;
}

/** GET /health envelope; also how a second instance identifies a live daemon. */
export interface HealthResponse {
  service: "ogsync";
  version: string;
  proto: number;
  sessions: HealthSession[];
  bound: string | null;
  sync: { enabled: boolean; pending: number; conflicts: number };
}

export type RpcResponse =
  | { ok: true; result: unknown; serverVersion?: string }
  | { ok: false; error: string; code: BridgeErrorCode; serverVersion?: string };

interface QueuedJob {
  seq: number;
  job: Job;
}

interface PollWaiter {
  resolve: (res: Response) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SessionEntry {
  info: SessionInfo;
  /** Jobs delivered-but-unacked and not-yet-delivered, in seq order. */
  queue: QueuedJob[];
  seq: number;
  waiter: PollWaiter | null;
}

interface PendingCall {
  session: string;
  resolve: (data: unknown) => void;
  reject: (err: unknown) => void;
  onPartial?: (data: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
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

/** `~/.ogsync/token`, generated 0600 on first run. Guards POST /rpc only. */
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

export class Hub implements Bridge {
  readonly version: string;
  readonly token: string;
  private readonly config: OgsyncConfig;
  private readonly hostname: string;
  private readonly requestedPort: number;
  private readonly longPollMs: number;
  private readonly registry = new Map<string, SessionEntry>();
  private readonly calls = new Map<string, PendingCall>();
  private readonly listeners = new Set<(ev: BridgeEvent, from: SessionInfo) => void>();
  private server: Bun.Server<undefined> | null = null;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private rpcHandler: RpcHandler | null = null;
  private syncControl: SyncControl | null = null;
  private jobCounter = 0;

  constructor(opts: HubOptions) {
    this.config = opts.config;
    this.version = opts.version;
    this.hostname = opts.hostname ?? "127.0.0.1";
    this.requestedPort = opts.port ?? opts.config.daemon.port;
    this.longPollMs = opts.longPollMs ?? LONG_POLL_MS;
    if (!isLoopbackHost(this.hostname)) {
      throw new Error(`refusing to bind ${this.hostname}: the hub is loopback-only and has no override`);
    }
    this.token = ensureToken();
  }

  listen(): number {
    this.server = Bun.serve({
      hostname: this.hostname,
      port: this.requestedPort,
      // Must outlast a parked long-poll or Bun closes the socket mid-park.
      idleTimeout: Math.min(255, Math.ceil(this.longPollMs / 1000) + 10),
      fetch: (req, server) => this.handle(req, server),
      error: (err: Error) => {
        log.error("hub request failed:", err);
        return this.json({ error: "internal error", code: "INTERNAL" }, 500);
      },
    });
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweeper.unref?.();
    log.info(`hub listening on http://${this.hostname}:${this.port}`);
    return this.port;
  }

  get port(): number {
    return this.server?.port ?? this.requestedPort;
  }

  stop(): void {
    for (const entry of [...this.registry.values()]) this.dropSession(entry.info.session, "hub stopped");
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    this.server?.stop(true);
    this.server = null;
  }

  setRpcHandler(fn: RpcHandler | null): void {
    this.rpcHandler = fn;
  }

  setSyncControl(control: SyncControl | null): void {
    this.syncControl = control;
  }

  // ------------------------------------------------------------- Bridge

  async call(op: OpName, args: unknown, opts: CallOpts = {}): Promise<unknown> {
    const entry = this.route(op, args);
    const id = `${Date.now().toString(36)}${(this.jobCounter += 1).toString(36)}`;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const job: Job = { id, op, args: withPlayer(args, opts.player) };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.dropQueuedJob(entry, id);
        this.failCall(id, new BridgeError("TIMEOUT", `${op} not answered in ${timeoutMs}ms`));
      }, timeoutMs);
      this.calls.set(id, { session: entry.info.session, resolve, reject, onPartial: opts.onPartial, timer });
      this.enqueue(entry, job);
    });
  }

  bound(): SessionInfo | null {
    return this.boundEntry()?.info ?? null;
  }

  sessions(): SessionInfo[] {
    return [...this.registry.values()].map((entry) => entry.info);
  }

  onEvent(fn: (ev: BridgeEvent, from: SessionInfo) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ------------------------------------------------------------- routing

  private route(op: OpName, args: unknown): SessionEntry {
    const edit = this.boundEntry();
    if (op === "play.stopSignal") return this.requireBound(edit, op);

    const playServer = this.playServerEntry(edit?.info ?? null);
    if (op === "play.stop") return playServer ?? this.requireBound(edit, op);

    const ctx = runtimeContext(op, args);
    if (ctx !== null) {
      if (!playServer) throw new BridgeError("NOPLUGIN", `${op} ctx=${ctx} needs a play-mode session; start a playtest first`);
      return playServer;
    }
    return this.requireBound(edit, op);
  }

  private requireBound(entry: SessionEntry | null, op: OpName): SessionEntry {
    if (!entry) {
      throw new BridgeError("NOPLUGIN", `no Studio session bound for ${op}; open the place with the OGSync plugin enabled`);
    }
    return entry;
  }

  private boundEntry(): SessionEntry | null {
    const matching = [...this.registry.values()].filter((entry) => this.matchesTarget(entry.info));
    return matching.find((entry) => entry.info.role === "edit") ?? matching[0] ?? null;
  }

  private playServerEntry(place: SessionInfo | null): SessionEntry | null {
    for (const entry of this.registry.values()) {
      if (entry.info.role !== "server") continue;
      const sameTarget = place ? placeKey(entry.info) === placeKey(place) : this.matchesTarget(entry.info);
      if (sameTarget) return entry;
    }
    return null;
  }

  private matchesTarget(place: { placeId: number; placeName: string }): boolean {
    const target = this.config.bind.target_place;
    if (target === null) return true;
    const wanted = String(target).trim().toLowerCase();
    return wanted === place.placeName.trim().toLowerCase() || wanted === String(place.placeId);
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
    try {
      switch (route) {
        case "POST /handshake":
          return this.json(this.handshake(await this.body<HandshakeRequest>(req)));
        case "GET /pull":
          return await this.pull(req, url);
        case "POST /push":
          return this.push(await this.body<PushRequest>(req));
        case "GET /health":
          return this.json(this.health());
        case "POST /rpc":
          return await this.rpc(req);
        default:
          return this.json({ error: `no route for ${route}`, code: "NOROUTE" }, 404);
      }
    } catch (err) {
      if (err instanceof HttpError) return this.json({ error: err.message, code: err.code }, err.status);
      throw err;
    }
  }

  private async body<T>(req: Request): Promise<T> {
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

  private handshake(req: HandshakeRequest): HandshakeResponse {
    const base = { proto: PROTO_VERSION, serverVersion: this.version };
    const updatePlugin = req.pluginVersion !== this.version;
    const reject = (reason: string): HandshakeResponse => {
      log.warn(`handshake refused for ${short(req.session)}: ${reason}`);
      return { ...base, accepted: false, reason, updatePlugin, syncEnabled: false };
    };

    if (req.proto !== PROTO_VERSION) {
      return { ...base, accepted: false, reason: `proto ${req.proto} unsupported, daemon speaks ${PROTO_VERSION}`, updatePlugin: true, syncEnabled: false };
    }
    if (typeof req.session !== "string" || req.session === "") return reject("missing session id");
    if (!this.matchesTarget(req)) {
      return reject(`place ${describePlace(req)} does not match target_place ${String(this.config.bind.target_place)}`);
    }
    const taken = [...this.registry.values()].find(
      (entry) =>
        entry.info.session !== req.session && entry.info.role === req.role && placeKey(entry.info) === placeKey(req),
    );
    if (taken) return reject(`another ${req.role} session is already bound to ${describePlace(req)}`);

    const existing = this.registry.get(req.session);
    const now = Date.now();
    const info: SessionInfo = {
      session: req.session,
      role: req.role,
      pluginVersion: req.pluginVersion,
      placeId: req.placeId,
      placeName: req.placeName,
      connectedAt: existing?.info.connectedAt ?? now,
      lastSeen: now,
    };
    if (existing) existing.info = info;
    else this.registry.set(req.session, { info, queue: [], seq: 0, waiter: null });

    log.info(`session ${short(req.session)} ${req.role} ${describePlace(req)} plugin ${req.pluginVersion}`);
    if (updatePlugin) {
      log.warn(`plugin ${req.pluginVersion} != daemon ${this.version} — reload plugins in Studio to pick up the new OGSync.rbxm`);
    }
    return {
      ...base,
      accepted: true,
      updatePlugin,
      syncEnabled: this.config.sync.enabled,
      projectName: this.config.project.name,
    };
  }

  private pull(req: Request, url: URL): Promise<Response> | Response {
    const entry = this.requireSession(url.searchParams.get("session"));
    entry.info.lastSeen = Date.now();

    const cursor = Number(url.searchParams.get("cursor") ?? "0");
    if (Number.isFinite(cursor) && cursor > 0) {
      entry.queue = entry.queue.filter((queued) => queued.seq > cursor);
    }
    this.releaseWaiter(entry);
    if (entry.queue.length > 0) return this.jobsResponse(entry);

    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        entry.waiter = null;
        resolve(this.noContent());
      }, this.longPollMs);
      const waiter: PollWaiter = { resolve, timer };
      entry.waiter = waiter;
      req.signal.addEventListener("abort", () => {
        if (entry.waiter === waiter) this.releaseWaiter(entry);
      });
    });
  }

  private push(body: PushRequest): Response {
    const entry = this.requireSession(body.session);
    entry.info.lastSeen = Date.now();
    for (const result of body.results ?? []) this.settle(result);
    for (const ev of body.events ?? []) this.dispatch(ev, entry);
    return this.json({ ok: true });
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
        session: info.session,
        role: info.role,
        placeName: info.placeName,
        age: Math.round((now - info.lastSeen) / 1000),
      })),
      bound: this.bound()?.session ?? null,
      sync: {
        enabled: status?.enabled ?? this.config.sync.enabled,
        pending: status?.pending ?? 0,
        conflicts: status?.conflicts.length ?? 0,
      },
    };
  }

  private async rpc(req: Request): Promise<Response> {
    const auth = req.headers.get("authorization") ?? "";
    const provided = auth.startsWith(BEARER) ? auth.slice(BEARER.length).trim() : "";
    if (provided === "" || provided !== this.token) {
      throw new HttpError(401, "AUTH", `bearer token required (${join(ogsyncHome(), "token")})`);
    }
    const body = await this.body<{ tool?: unknown; op?: unknown; args?: unknown; timeoutMs?: unknown }>(req);
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
        if (!this.rpcHandler) throw new HttpError(503, "NORPC", "this daemon runs without the MCP layer");
        return this.json({ ok: true, result: await this.rpcHandler(body.tool, args) });
      }
      throw new HttpError(400, "BADARG", "expected {tool, args} or {op, args}");
    } catch (err) {
      if (err instanceof HttpError) throw err;
      return this.json(rpcFailure(err));
    }
  }

  // ------------------------------------------------------------- queues

  private enqueue(entry: SessionEntry, job: Job): void {
    entry.seq += 1;
    entry.queue.push({ seq: entry.seq, job });
    log.debug(`job ${job.id} ${job.op} → ${short(entry.info.session)} (seq ${entry.seq})`);
    this.flush(entry);
  }

  private flush(entry: SessionEntry): void {
    const waiter = entry.waiter;
    if (!waiter || entry.queue.length === 0) return;
    entry.waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(this.jobsResponse(entry));
  }

  private jobsResponse(entry: SessionEntry): Response {
    const payload: PullResponse = {
      cursor: entry.queue.at(-1)?.seq ?? entry.seq,
      jobs: entry.queue.map((queued) => queued.job),
    };
    return this.json(payload);
  }

  private releaseWaiter(entry: SessionEntry): void {
    const waiter = entry.waiter;
    if (!waiter) return;
    entry.waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(this.noContent());
  }

  private dropQueuedJob(entry: SessionEntry, id: string): void {
    entry.queue = entry.queue.filter((queued) => queued.job.id !== id);
  }

  private settle(result: JobResult): void {
    const call = this.calls.get(result.id);
    if (!call) {
      log.debug(`result for unknown job ${result.id}`);
      return;
    }
    const size = payloadSize(result.data);
    if (size > RESULT_CAP_BYTES) {
      this.failCall(result.id, new BridgeError("STUDIO", `result of ${size} bytes exceeds the ${RESULT_CAP_BYTES} byte cap`));
      return;
    }
    if (result.partial === true) {
      call.onPartial?.(result.data);
      return;
    }
    clearTimeout(call.timer);
    this.calls.delete(result.id);
    if (result.ok) call.resolve(result.data);
    else call.reject(pluginError(result.err));
  }

  private failCall(id: string, err: BridgeError): void {
    const call = this.calls.get(id);
    if (!call) return;
    clearTimeout(call.timer);
    this.calls.delete(id);
    call.reject(err);
  }

  private dispatch(ev: BridgeEvent, entry: SessionEntry): void {
    for (const fn of this.listeners) {
      try {
        fn(ev, entry.info);
      } catch (err) {
        log.warn("event listener failed:", err);
      }
    }
    if (ev.ev === "playtestState" && ev.state === "stopped" && entry.info.role !== "edit") {
      this.dropSession(entry.info.session, "playtest stopped");
    }
  }

  private requireSession(session: string | null): SessionEntry {
    const entry = session === null ? undefined : this.registry.get(session);
    if (!entry) throw new HttpError(409, "NOSESSION", "unknown session, handshake first");
    return entry;
  }

  private dropSession(session: string, why: string): void {
    const entry = this.registry.get(session);
    if (!entry) return;
    this.registry.delete(session);
    this.releaseWaiter(entry);
    for (const [id, call] of this.calls) {
      if (call.session === session) this.failCall(id, new BridgeError("NOPLUGIN", `session ${short(session)} ${why}`));
    }
    log.info(`session ${short(session)} ${why}`);
  }

  private sweep(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const entry of [...this.registry.values()]) {
      if (entry.info.lastSeen >= cutoff) continue;
      this.dropSession(entry.info.session, `expired after ${SESSION_TTL_MS / 1000}s without a pull`);
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

function withPlayer(args: unknown, player: CallOpts["player"]): unknown {
  if (player === undefined || !isRecord(args) || args["player"] !== undefined) return args;
  return { ...args, player };
}

function runtimeContext(op: OpName, args: unknown): "server" | "client" | null {
  if (!RUNTIME_CONTEXT_OPS.has(op) || !isRecord(args)) return null;
  const ctx = args["ctx"] ?? args["context"];
  return ctx === "server" || ctx === "client" ? ctx : null;
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
  return { ok: false, error: err instanceof Error ? err.message : String(err), code: "STUDIO" };
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

function placeKey(place: { placeId: number; placeName: string }): string {
  return `${place.placeId}:${place.placeName.toLowerCase()}`;
}

function describePlace(place: { placeId: number; placeName: string }): string {
  return place.placeId > 0 ? `${place.placeName}#${place.placeId}` : place.placeName;
}

function short(session: string): string {
  return session.slice(0, 8);
}
