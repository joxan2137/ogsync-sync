// Daemon-side log buffer.
//
// The plugin pushes `log` events from every session it can reach, tagged with
// the context they came from. Serving the `logs` tool from here instead of a
// per-call `log.tail` round trip means: output survives a playtest ending,
// contexts aggregate (a solo playtest's shared DataModel reports client and
// server output through one session), and a tail costs no Studio work.
//
// A first call for a context still backfills from the plugin's own ring buffer,
// so logs printed before the daemon attached are not lost.

import type { Bridge, BridgeEvent, Role } from "@proto/types";

export interface LogLine {
  seq: number;
  ctx: Role;
  level: string;
  msg: string;
  ts: number;
}

const MAX_LINES = 4000;

export class LogBuffer {
  #lines: LogLine[] = [];
  #seq = 0;
  #dropped = 0;
  readonly #backfilled = new Set<string>();

  constructor(bridge: Bridge) {
    bridge.onEvent((ev, from) => {
      if (ev.ev !== "log") return;
      this.push(ev.ctx ?? from.role, ev.level, ev.msg, ev.ts);
    });
  }

  push(ctx: Role, level: string, msg: string, ts: number): void {
    this.#seq += 1;
    this.#lines.push({ seq: this.#seq, ctx, level, msg, ts });
    if (this.#lines.length > MAX_LINES) {
      this.#dropped += this.#lines.length - MAX_LINES;
      this.#lines = this.#lines.slice(-MAX_LINES);
    }
  }

  /** True the first time a context is asked for, so callers backfill once. */
  needsBackfill(ctx: string): boolean {
    if (this.#backfilled.has(ctx)) return false;
    this.#backfilled.add(ctx);
    return true;
  }

  query(opts: {
    ctx: string;
    minLevel?: string;
    pattern?: string;
    since?: number;
    limit: number;
  }): { lines: LogLine[]; cursor: number; dropped: number; truncated: boolean } {
    const rank = { info: 0, warn: 1, error: 2 } as const;
    const floor = opts.minLevel ? (rank[opts.minLevel as keyof typeof rank] ?? 0) : 0;
    const re = opts.pattern === undefined ? null : safeRegex(opts.pattern);
    const matched = this.#lines.filter((line) => {
      if (opts.since !== undefined && line.seq <= opts.since) return false;
      if (opts.ctx !== "all" && line.ctx !== opts.ctx) return false;
      if ((rank[line.level as keyof typeof rank] ?? 0) < floor) return false;
      if (re !== null && !re.test(line.msg)) return false;
      return true;
    });
    const lines = matched.slice(-opts.limit);
    return {
      lines,
      cursor: lines[lines.length - 1]?.seq ?? opts.since ?? this.#seq,
      dropped: this.#dropped,
      truncated: matched.length > lines.length,
    };
  }
}

function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

const buffers = new WeakMap<Bridge, LogBuffer>();

/** One buffer per bridge, attached on first use. */
export function logBufferFor(bridge: Bridge): LogBuffer {
  let buf = buffers.get(bridge);
  if (buf === undefined) {
    buf = new LogBuffer(bridge);
    buffers.set(bridge, buf);
  }
  return buf;
}

/** Type guard for the `log` event shape, used by tests. */
export function isLogEvent(ev: BridgeEvent): ev is Extract<BridgeEvent, { ev: "log" }> {
  return ev.ev === "log";
}
