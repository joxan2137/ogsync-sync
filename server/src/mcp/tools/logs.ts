import { z } from "zod";
import { capText, lines } from "../fmt.ts";
import { callOpts, defineTool, TIMEOUT_ARG } from "../tool.ts";

interface WireEntry {
  t?: number;
  l?: string;
  m?: string;
}

interface LogEntry {
  ctx: string;
  level: string;
  msg: string;
  count: number;
}

interface LogResult {
  ctx?: string;
  entries?: WireEntry[];
  cursor?: number;
  truncated?: boolean;
  pending?: number;
  dropped?: number;
}

export const tool = defineTool({
  name: "logs",
  description:
    "Tail Studio and runtime output as `[ctx][level] message (xN)` lines, consecutive duplicates collapsed. Filter by context (edit|server|client|all), minimum level, regex pattern and `since` cursor; the trailing cursor= line feeds the next call.",
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
    const since = args.since ?? args.cursor;
    const data = (await bridge.call(
      "log.tail",
      {
        context: args.context ?? "all",
        level: args.level,
        since,
        pattern: args.pattern,
        limit: args.limit ?? 100,
      },
      callOpts(args),
    )) as LogResult;

    const ctx = data.ctx ?? args.context ?? "all";
    const body = collapse(data.entries ?? [], ctx).map(
      (e) => `[${e.ctx}][${e.level}] ${e.msg}${e.count > 1 ? ` (x${e.count})` : ""}`,
    );
    const trailer = [
      data.cursor === undefined ? undefined : `cursor=${data.cursor}`,
      data.pending ? `pending=${data.pending}` : undefined,
      data.dropped ? `dropped=${data.dropped}` : undefined,
    ]
      .filter((b): b is string => b !== undefined)
      .join(" ");
    return capText(
      lines(body.length ? body : "no logs", trailer || undefined),
      undefined,
      data.cursor,
    );
  },
});

/** Plugin streams one entry per line; collapsing dupes is the daemon's job. */
function collapse(entries: WireEntry[], ctx: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const e of entries) {
    const entry: LogEntry = { ctx, level: e.l ?? "info", msg: e.m ?? "", count: 1 };
    const prev = out[out.length - 1];
    if (prev && prev.level === entry.level && prev.msg === entry.msg) {
      prev.count += 1;
      continue;
    }
    out.push(entry);
  }
  return out;
}
