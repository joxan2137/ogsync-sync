// Client side of the machine-wide daemon: every `ogsync serve` session, the
// CLI and doctor talk to it through here.
//
// Requests use node:http with no agent and `connection: close`, never fetch:
// a short-lived process must not keep pooled sockets alive past its last call
// (undici's keep-alive pool has asserted on exit on Windows). Bun's node:http
// honours HTTP(S)_PROXY, so loopback is added to NO_PROXY at startup; outgoing
// internet requests (updates, docs) keep the user's proxy.

import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { request } from "node:http";
import { BridgeError, CANDIDATE_PORTS, PROTO_VERSION, type BridgeErrorCode } from "../proto/types.ts";
import { ogsyncHome } from "../config.ts";
import { log } from "../log.ts";
import { ensureToken, type IdResponse, type RpcCaller, type RpcResponse } from "../hub/hub.ts";
import { isAlive, logFile, readDaemonRecord } from "./lock.ts";

const PROBE_TIMEOUT_MS = 800;
const SPAWN_WAIT_MS = 10_000;
const SPAWN_POLL_MS = 150;
const SHUTDOWN_WAIT_MS = 5_000;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

export interface LocalResponse {
  status: number;
  body: unknown;
}

export interface DaemonEndpoint {
  port: number;
  identity: IdResponse;
}

/** Adds loopback to NO_PROXY/no_proxy (both spellings: tools disagree on which they read). */
export function withLoopbackNoProxy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of ["NO_PROXY", "no_proxy"]) {
    const listed = (out[name] ?? "").split(",").map((host) => host.trim()).filter(Boolean);
    out[name] = [...new Set([...listed, ...LOOPBACK_HOSTS])].join(",");
  }
  return out;
}

export function applyLoopbackNoProxy(): void {
  const patched = withLoopbackNoProxy(process.env);
  process.env["NO_PROXY"] = patched["NO_PROXY"];
  process.env["no_proxy"] = patched["no_proxy"];
}

export function localRequest(
  port: number,
  method: "GET" | "POST",
  path: string,
  opts: { body?: unknown; token?: string; timeoutMs?: number } = {},
): Promise<LocalResponse> {
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const headers: Record<string, string> = { connection: "close" };
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return new Promise<LocalResponse>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", fail);
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0, body: parseJson(Buffer.concat(chunks).toString("utf8")) });
      });
    });
    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error(`127.0.0.1:${port}${path} did not answer in ${timeoutMs}ms`), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    function fail(err: Error): void {
      clearTimeout(timer);
      reject(err);
    }
    req.on("error", fail);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** null when nothing answers or the answer is not an ogsync daemon. */
export async function probeDaemon(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<IdResponse | null> {
  try {
    const res = await localRequest(port, "GET", "/id", { timeoutMs });
    const body = res.body as Partial<IdResponse> | null;
    if (res.status !== 200 || body?.service !== "ogsync") return null;
    return body as IdResponse;
  } catch (err) {
    log.debug(`no daemon on :${port}:`, err);
    return null;
  }
}

/** daemon.json first; a scan of the candidate ports covers a missing or stale record. */
export async function findDaemon(): Promise<DaemonEndpoint | null> {
  const record = readDaemonRecord();
  if (record !== null && isAlive(record.pid)) {
    const identity = await probeDaemon(record.port);
    if (identity) return { port: record.port, identity };
  }
  for (const port of CANDIDATE_PORTS) {
    if (port === record?.port) continue;
    const identity = await probeDaemon(port, 300);
    if (identity) return { port, identity };
  }
  return null;
}

/** The running daemon, spawning a detached one when none answers. */
export async function ensureDaemon(opts: { port?: number | null } = {}): Promise<DaemonEndpoint & { spawned: boolean }> {
  const existing = await findDaemon();
  if (existing) {
    if (existing.identity.proto === PROTO_VERSION) return { ...existing, spawned: false };
    log.warn(
      `daemon ${existing.identity.version} on :${existing.port} speaks proto ${existing.identity.proto}, this ogsync speaks ${PROTO_VERSION}; restarting it`,
    );
    await stopDaemon(existing.port);
  }
  spawnDaemon(opts.port ?? null);
  log.info(`starting the ogsync daemon, log: ${logFile()}`);
  const deadline = Date.now() + SPAWN_WAIT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(SPAWN_POLL_MS);
    const started = await findDaemon();
    if (started && started.identity.proto === PROTO_VERSION) return { ...started, spawned: true };
  }
  throw new Error(`the ogsync daemon did not come up within ${SPAWN_WAIT_MS / 1000}s; see ${logFile()}`);
}

export async function stopDaemon(port: number, token?: string): Promise<boolean> {
  try {
    await localRequest(port, "POST", "/shutdown", { token: token ?? ensureToken(), timeoutMs: 2_000 });
  } catch (err) {
    log.debug("shutdown request failed:", err);
  }
  const deadline = Date.now() + SHUTDOWN_WAIT_MS;
  while (Date.now() < deadline) {
    if ((await probeDaemon(port, 300)) === null) return true;
    await Bun.sleep(SPAWN_POLL_MS);
  }
  return false;
}

/** argv that re-enters this program: the compiled binary, or `bun <entry>` from source. */
export function selfCommand(args: string[]): string[] {
  const main = Bun.main;
  const compiled = main.includes("$bunfs") || /[\\/]~BUN[\\/]/.test(main);
  return compiled ? [process.execPath, ...args] : [process.execPath, main, ...args];
}

/**
 * Two hops: a short-lived `daemon detach` starts the real daemon and exits, so
 * the daemon's parent is already gone when the session that wanted it is
 * killed. Windows tree kills (`taskkill /T`) follow parent pids and would
 * otherwise take the daemon down with the Claude session.
 */
function spawnDaemon(port: number | null): void {
  detachedSpawn(["daemon", "detach", ...portArgs(port)]);
}

/** `ogsync daemon detach`: the middle hop of spawnDaemon. */
export function launchDaemon(port: number | null): number | undefined {
  return detachedSpawn(["daemon", "run", ...portArgs(port)]);
}

function portArgs(port: number | null): string[] {
  return port === null ? [] : ["--port", String(port)];
}

function detachedSpawn(argv: string[]): number | undefined {
  const [command, ...args] = selfCommand(argv);
  const out = openSync(logFile(), "a");
  const child = spawn(command!, args, {
    cwd: ogsyncHome(),
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
    env: withLoopbackNoProxy(process.env),
  });
  child.unref();
  return child.pid;
}

/**
 * One client process's channel to the daemon. A refused connection means the
 * daemon is gone (the request never landed), so it is respawned and the call
 * retried once; anything else is reported, never retried.
 */
export class DaemonClient {
  #port: number;

  constructor(
    port: number,
    private readonly token: string,
    private readonly caller: RpcCaller,
    private readonly respawn: () => Promise<number> = async () => (await ensureDaemon()).port,
  ) {
    this.#port = port;
  }

  get port(): number {
    return this.#port;
  }

  async callTool(tool: string, args: unknown, timeoutMs: number): Promise<unknown> {
    const res = await this.#post("/rpc", { tool, args, caller: this.caller }, timeoutMs);
    const payload = res.body as RpcResponse | { error?: string; code?: string } | null;
    if (payload && "ok" in payload) {
      if (payload.ok) return payload.result;
      throw new BridgeError(payload.code, payload.error);
    }
    const code = isBridgeErrorCode(payload?.code) ? payload.code : "STUDIO";
    throw new BridgeError(code, payload?.error ?? `daemon answered HTTP ${res.status}`);
  }

  /** Keeps this project's sync engine alive in the daemon; repeat inside the attach TTL. */
  async attach(cwd: string): Promise<void> {
    await this.#post("/attach", { client: this.caller.id, cwd }, 5_000);
  }

  async #post(path: string, body: unknown, timeoutMs: number): Promise<LocalResponse> {
    try {
      return await localRequest(this.#port, "POST", path, { body, token: this.token, timeoutMs });
    } catch (err) {
      if ((err as { code?: string }).code !== "ECONNREFUSED") throw transportError(err, this.#port);
      this.#port = await this.respawn();
      try {
        return await localRequest(this.#port, "POST", path, { body, token: this.token, timeoutMs });
      } catch (retryErr) {
        throw transportError(retryErr, this.#port);
      }
    }
  }
}

function transportError(err: unknown, port: number): BridgeError {
  if ((err as { code?: string }).code === "ETIMEDOUT") {
    return new BridgeError("TIMEOUT", `ogsync daemon on :${port} did not answer in time`);
  }
  return new BridgeError("NOPLUGIN", `ogsync daemon on :${port} is unreachable: ${err instanceof Error ? err.message : String(err)}`);
}

const BRIDGE_ERROR_CODES: readonly BridgeErrorCode[] = [
  "NOPLUGIN", "TIMEOUT", "NOPATH", "BADARG", "AUTH", "STUDIO", "TARGET", "THROTTLED", "LEASE", "VERSION",
];

function isBridgeErrorCode(value: unknown): value is BridgeErrorCode {
  return typeof value === "string" && (BRIDGE_ERROR_CODES as readonly string[]).includes(value);
}

function parseJson(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
