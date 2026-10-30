import { z } from "zod";
import { BridgeError, type Bridge, type PlaytestPhase } from "@proto/types";
import { capText, fmtValue, lines } from "../fmt.ts";
import { logBufferFor } from "../logbuf.ts";
import { defineTool } from "../tool.ts";

const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 300_000;
/** Log and playtest checks read daemon state; this only bounds reaction time. */
const LOCAL_POLL_MS = 200;
/**
 * Attribute/instance checks cost a Studio round trip each, against Studio's
 * HttpService request budget: start quick, then back off to a slow trickle.
 */
const STUDIO_POLL_MIN_MS = 500;
const STUDIO_POLL_MAX_MS = 4_000;
const STUDIO_POLL_GROWTH = 1.5;
const CHECK_TIMEOUT_MS = 10_000;
const MATCH_LIMIT = 20;

interface CheckResult {
  met?: boolean;
  exists?: boolean;
  value?: unknown;
}

export const tool = defineTool({
  name: "wait",
  description:
    "Block until a condition holds instead of polling: for=log (regex `pattern`, new lines only unless `since`), playtest (`state`), attribute (`path`, `name`, optional `value`) or instance (`path` exists). Returns as soon as it holds, or ERR TIMEOUT after timeoutMs (default 30000).",
  schema: {
    for: z.enum(["log", "playtest", "attribute", "instance"]),
    pattern: z.string().optional(),
    context: z.enum(["edit", "server", "client", "all"]).optional(),
    since: z.number().int().min(0).optional(),
    state: z.enum(["idle", "starting", "running", "stopping", "unknown"]).optional(),
    path: z.string().optional(),
    name: z.string().optional(),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    timeoutMs: z.number().int().positive().max(MAX_WAIT_MS).optional(),
  },
  async handler(bridge, _deps, args) {
    const deadline = Date.now() + (args.timeoutMs ?? DEFAULT_WAIT_MS);
    switch (args.for) {
      case "log":
        if (args.pattern === undefined) throw new BridgeError("BADARG", "for=log needs pattern");
        return waitLog(bridge, args.pattern, args.context ?? "all", args.since, deadline);
      case "playtest":
        if (args.state === undefined) throw new BridgeError("BADARG", "for=playtest needs state");
        return waitPlaytest(bridge, args.state, deadline);
      case "attribute":
        if (args.path === undefined || args.name === undefined) {
          throw new BridgeError("BADARG", "for=attribute needs path and name");
        }
        return waitStudio(bridge, { kind: "attribute", path: args.path, name: args.name, value: args.value }, deadline);
      case "instance":
        if (args.path === undefined) throw new BridgeError("BADARG", "for=instance needs path");
        return waitStudio(bridge, { kind: "instance", path: args.path }, deadline);
    }
  },
});

async function waitLog(bridge: Bridge, pattern: string, ctx: string, since: number | undefined, deadline: number): Promise<string> {
  try {
    new RegExp(pattern);
  } catch {
    throw new BridgeError("BADARG", `pattern is not a valid regex: ${pattern}`);
  }
  const buf = logBufferFor(bridge);
  const cursor = since ?? buf.query({ ctx: "all", limit: 1 }).cursor;
  for (;;) {
    const found = buf.query({ ctx, pattern, since: cursor, limit: MATCH_LIMIT });
    if (found.lines.length > 0) {
      const body = found.lines.map((line) => `[${line.ctx}][${line.level}] ${line.msg}`);
      return capText(lines(`wait ok: log matched /${pattern}/`, body, `cursor=${found.cursor}`));
    }
    if (Date.now() >= deadline) {
      throw new BridgeError("TIMEOUT", `no log line matched /${pattern}/ (cursor=${cursor})`);
    }
    await Bun.sleep(LOCAL_POLL_MS);
  }
}

async function waitPlaytest(bridge: Bridge, state: PlaytestPhase, deadline: number): Promise<string> {
  if (bridge.place === undefined) throw new BridgeError("BADARG", "this bridge has no playtest state");
  for (;;) {
    const place = bridge.place();
    if (place?.playtest.state === state) return `wait ok: playtest ${state} on ${place.key}`;
    if (Date.now() >= deadline) {
      throw new BridgeError("TIMEOUT", `playtest is ${place?.playtest.state ?? "unresolved"}, not ${state}`);
    }
    await Bun.sleep(LOCAL_POLL_MS);
  }
}

async function waitStudio(bridge: Bridge, check: Record<string, unknown>, deadline: number): Promise<string> {
  let last: CheckResult = {};
  let interval = STUDIO_POLL_MIN_MS;
  for (;;) {
    const remaining = Math.max(1_000, Math.min(CHECK_TIMEOUT_MS, deadline - Date.now()));
    last = (await bridge.call("wait.check", check, { timeoutMs: remaining })) as CheckResult;
    if (last.met === true) {
      const value = last.value === undefined ? "" : ` value=${fmtValue(last.value)}`;
      return `wait ok: ${check["kind"]} ${check["path"]}${check["name"] === undefined ? "" : `@${check["name"]}`}${value}`;
    }
    if (Date.now() >= deadline) {
      const seen = last.exists === false ? "instance missing" : `last value ${fmtValue(last.value)}`;
      throw new BridgeError("TIMEOUT", `${check["kind"]} condition on ${check["path"]} not met (${seen})`);
    }
    await Bun.sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
    interval = Math.min(STUDIO_POLL_MAX_MS, interval * STUDIO_POLL_GROWTH);
  }
}
