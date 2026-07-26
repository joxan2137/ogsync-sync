import { z } from "zod";
import { capText, lines, row } from "../fmt.ts";
import { callOpts, defineTool, LONG_TIMEOUT_MS, TIMEOUT_ARG } from "../tool.ts";

interface ProfileResult {
  total_mb?: number;
  tags?: Array<{ tag: string; mb: number }>;
  duration_s?: number;
  total_ms?: number;
  functions?: Array<{ name: string; ms: number; pct?: number }>;
  service?: string;
  capture?: string;
}

interface Hotspot {
  name: string;
  value: number;
  pct?: number;
}

export const tool = defineTool({
  name: "profile",
  description:
    "Profile the session: kind=micro (frames=N), script (duration_s) or memory. Returns the top `top` hotspots/allocations (default 25) as `name  ms|MB  %` lines instead of a raw dump.",
  schema: {
    kind: z.enum(["micro", "script", "memory"]),
    frames: z.number().int().positive().optional(),
    duration_s: z.number().positive().optional(),
    top: z.number().int().positive().optional(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    const top = args.top ?? 25;
    const op = args.kind === "micro" ? "prof.micro" : args.kind === "script" ? "prof.script" : "prof.memory";
    const data = (await bridge.call(
      op,
      { frames: args.frames, duration_s: args.duration_s, top },
      callOpts(args, LONG_TIMEOUT_MS),
    )) as ProfileResult;

    const unit = args.kind === "memory" ? "MB" : "ms";
    const total = args.kind === "memory" ? data.total_mb : data.total_ms;
    const head = row(`${args.kind} ${unit}`, {
      total: total === undefined ? undefined : round(total),
      duration_s: data.duration_s,
      service: data.service,
      capture: data.capture,
    });
    const body = hotspots(data, total).slice(0, top).map(
      (e) => `${e.name}  ${round(e.value)}  ${e.pct === undefined ? "" : `${round(e.pct)}%`}`.trimEnd(),
    );
    return capText(lines(head, body.length ? body : "no samples"));
  },
});

function hotspots(data: ProfileResult, total: number | undefined): Hotspot[] {
  if (data.tags) {
    return data.tags.map((t) => ({
      name: t.tag,
      value: t.mb,
      pct: total ? (t.mb / total) * 100 : undefined,
    }));
  }
  return (data.functions ?? []).map((f) => ({ name: f.name, value: f.ms, pct: f.pct }));
}

function round(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
