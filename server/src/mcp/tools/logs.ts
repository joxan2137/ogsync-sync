import { z } from "zod";
import type { Role } from "@proto/types";
import { capText, lines } from "../fmt.ts";
import { logBufferFor, type LogLine } from "../logbuf.ts";
import { callOpts, defineTool, TIMEOUT_ARG } from "../tool.ts";

interface WireEntry {
  t?: number;
  l?: string;
  m?: string;
}

interface LogResult {
  ctx?: Role;
  entries?: WireEntry[];
  dropped?: number;
}

export const tool = defineTool({
  name: "logs",
  description:
    "Tail Studio and playtest output as `[ctx][level] message (xN)` lines, consecutive duplicates collapsed. Filter by context (edit|server|client|all), minimum level, regex pattern and `since` cursor; the trailing cursor= feeds the next call.",
  schema: {
    context: z.enum(["edit", "server", "client", "all"]).optional(),
    level: z.enum(["info", "warn", "error"]).optional(),
    since: z.number().int().min(0).optional(),
    cursor: z.number().int().min(0).optional(),
    pattern: z.string().optional(),
    limit: z.number().int().positive().optional(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    const ctx = args.context ?? "all";
    const buf = logBufferFor(bridge);

    // Logs stream in as events; a first look at a context also pulls whatever
    // the plugin buffered before the daemon attached.
    if (buf.needsBackfill(ctx)) {
      try {
        const data = (await bridge.call(
          "log.tail",
          { context: ctx, limit: args.limit ?? 100 },
          callOpts(args),
        )) as LogResult;
        const from = data.ctx ?? (ctx === "all" ? "edit" : (ctx as Role));
        for (const e of data.entries ?? []) {
          buf.push(from, e.l ?? "info", e.m ?? "", e.t ?? 0);
        }
      } catch {
        // No session, or the op is unavailable in this context: event stream only.
      }
    }

    const result = buf.query({
      ctx,
      minLevel: args.level,
      pattern: args.pattern,
      since: args.since ?? args.cursor,
      limit: args.limit ?? 100,
    });
    const body = collapse(result.lines).map(
      (e) => `[${e.ctx}][${e.level}] ${e.msg}${e.count > 1 ? ` (x${e.count})` : ""}`,
    );
    const trailer = [
      `cursor=${result.cursor}`,
      result.truncated ? "older lines dropped by limit" : undefined,
      result.dropped ? `evicted=${result.dropped}` : undefined,
    ]
      .filter((b): b is string => b !== undefined)
      .join(" ");
    return capText(lines(body.length ? body : "no logs", trailer), undefined, result.cursor);
  },
});

interface Collapsed {
  ctx: string;
  level: string;
  msg: string;
  count: number;
}

function collapse(entries: LogLine[]): Collapsed[] {
  const out: Collapsed[] = [];
  for (const e of entries) {
    const prev = out[out.length - 1];
    if (prev && prev.level === e.level && prev.msg === e.msg && prev.ctx === e.ctx) {
      prev.count += 1;
      continue;
    }
    out.push({ ctx: e.ctx, level: e.level, msg: e.msg, count: 1 });
  }
  return out;
}
