// Second-instance support. When the port already hosts a live ogsync daemon,
// this process cannot own the Studio bridge, so it runs MCP-only and forwards
// work to the owner over POST /rpc (bearer token from ~/.ogsync/token).
//
// Simplification vs docs/DESIGN.md: rather than proxying whole MCP tool calls,
// RemoteBridge forwards individual bridge *ops* ({op, args} form of /rpc). Tool
// argument validation and output formatting therefore stay local, which keeps
// one MCP implementation instead of two and avoids re-serializing tool output.
// callRemoteTool() is the tool-level path, used by CLI clients that want the
// owner daemon to do the formatting too.
//
// Not forwarded in v1: plugin events (onEvent is inert) and partial results —
// long-running streaming ops report only their final value in proxy mode.

import {
  BridgeError,
  type Bridge,
  type BridgeErrorCode,
  type BridgeEvent,
  type CallOpts,
  type OpName,
  type SessionInfo,
} from "../proto/types.ts";
import { log } from "../log.ts";
import type { HealthResponse, RpcResponse } from "./hub.ts";

const HEALTH_TIMEOUT_MS = 1_000;
const HEALTH_POLL_MS = 2_000;

export interface DaemonIdentity {
  version: string;
  health: HealthResponse;
}

/** null when nothing answers on the port, or the answer is not an ogsync daemon. */
export async function detectExistingDaemon(port: number): Promise<DaemonIdentity | null> {
  try {
    const res = await fetch(healthUrl(port), { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const health = (await res.json()) as HealthResponse;
    if (health.service !== "ogsync") return null;
    return { version: health.version, health };
  } catch (err) {
    log.debug(`no daemon on :${port}:`, err);
    return null;
  }
}

export async function callRemoteTool(port: number, token: string, tool: string, args: unknown): Promise<unknown> {
  return postRpc(port, token, { tool, args });
}

export class RemoteBridge implements Bridge {
  private snapshot: SessionInfo[] = [];
  private boundSession: string | null = null;
  private readonly poll: ReturnType<typeof setInterval>;

  constructor(
    private readonly port: number,
    private readonly token: string,
  ) {
    this.poll = setInterval(() => void this.refresh(), HEALTH_POLL_MS);
    this.poll.unref?.();
    void this.refresh();
  }

  async call(op: OpName, args: unknown, opts: CallOpts = {}): Promise<unknown> {
    return postRpc(this.port, this.token, {
      op,
      args: opts.player === undefined ? args : withPlayer(args, opts.player),
      timeoutMs: opts.timeoutMs,
    });
  }

  bound(): SessionInfo | null {
    return this.snapshot.find((info) => info.session === this.boundSession) ?? null;
  }

  sessions(): SessionInfo[] {
    return this.snapshot;
  }

  onEvent(): () => void {
    return () => {};
  }

  close(): void {
    clearInterval(this.poll);
  }

  private async refresh(): Promise<void> {
    const identity = await detectExistingDaemon(this.port);
    if (!identity) {
      this.snapshot = [];
      this.boundSession = null;
      return;
    }
    const now = Date.now();
    // /health is lossy: placeId and pluginVersion are not part of that envelope.
    this.snapshot = identity.health.sessions.map((session) => ({
      session: session.session,
      role: session.role,
      pluginVersion: identity.version,
      placeId: 0,
      placeName: session.placeName,
      connectedAt: now - session.age * 1000,
      lastSeen: now - session.age * 1000,
    }));
    this.boundSession = identity.health.bound;
  }
}

async function postRpc(port: number, token: string, body: object): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new BridgeError("NOPLUGIN", `owner daemon on :${port} is unreachable: ${message(err)}`);
  }
  const payload = (await res.json().catch(() => null)) as RpcResponse | { error?: string; code?: string } | null;
  if (payload && "ok" in payload) {
    if (payload.ok) return payload.result;
    throw new BridgeError(payload.code, payload.error);
  }
  const code = isBridgeErrorCode(payload?.code) ? payload.code : "STUDIO";
  throw new BridgeError(code, payload?.error ?? `rpc failed with HTTP ${res.status}`);
}

const BRIDGE_ERROR_CODES: readonly BridgeErrorCode[] = ["NOPLUGIN", "TIMEOUT", "NOPATH", "BADARG", "STUDIO"];

function isBridgeErrorCode(value: unknown): value is BridgeErrorCode {
  return typeof value === "string" && (BRIDGE_ERROR_CODES as readonly string[]).includes(value);
}

function withPlayer(args: unknown, player: CallOpts["player"]): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
  return { ...(args as Record<string, unknown>), player };
}

function healthUrl(port: number): string {
  return `http://127.0.0.1:${port}/health`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
