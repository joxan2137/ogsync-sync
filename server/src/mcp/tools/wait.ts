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
/**
 * A client check rides the play server's RemoteFunction relay, which gives the
 * client the call timeout minus a margin; anything shorter starves it.
 */
const CLIENT_CHECK_MIN_MS = 5_000;
const EDIT_CHECK_MIN_MS = 1_000;
const MATCH_LIMIT = 20;

interface CheckResult {
  met?: boolean;
  exists?: boolean;
  value?: unknown;
}

export const tool = defineTool({
  name: "wait",
  description:
    "Block until a condition holds instead of polling: for=log (regex `pattern`, new lines only unless `since`), playtest (`state`), attribute (`path`, `name`, optional `value`) or instance (`path` exists), the last two probed in `context` (edit default, server, or client with `player`). Returns as soon as it holds, or ERR TIMEOUT after timeoutMs (default 30000); a single slow probe only counts as not-yet.",
  schema: {
    for: z.enum(["log", "playtest", "attribute", "instance"]),
    pattern: z.string().optional(),
    context: z.enum(["edit", "server", "client", "all"]).optional(),
    since: z.number().int().min(0).optional(),
    state: z.enum(["idle", "starting", "running", "stopping", "unknown"]).optional(),
    path: z.string().optional(),
    name: z.string().optional(),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    player: z.union([z.string(), z.number()]).optional(),
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
        return waitStudio(
          bridge,
          { kind: "attribute", path: args.path, name: args.name, value: args.value, ...studioContext(args) },
          deadline,
        );
      case "instance":
        if (args.path === undefined) throw new BridgeError("BADARG", "for=instance needs path");
        return waitStudio(bridge, { kind: "instance", path: args.path, ...studioContext(args) }, deadline);
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

/** Which DataModel probes the instance/attribute; the hub routes server/client to the play peers. */
function studioContext(args: { context?: string | undefined; player?: string | number | undefined }): Record<string, unknown> {
  if (args.context === "all") throw new BridgeError("BADARG", "context=all applies to for=log only");
  const context = args.context ?? "edit";
  return args.player === undefined ? { context } : { context, player: args.player };
}

export function checkTimeoutMs(context: unknown, remainingMs: number): number {
  const floor = context === "client" ? CLIENT_CHECK_MIN_MS : EDIT_CHECK_MIN_MS;
  return Math.max(floor, Math.min(CHECK_TIMEOUT_MS, remainingMs));
}

async function waitStudio(bridge: Bridge, check: Record<string, unknown>, deadline: number): Promise<string> {
  let last: CheckResult = {};
  let timedOut = false;
  let interval = STUDIO_POLL_MIN_MS;
  for (;;) {
    const timeoutMs = checkTimeoutMs(check["context"], deadline - Date.now());
    try {
      last = (await bridge.call("wait.check", check, { timeoutMs })) as CheckResult;
      timedOut = false;
    } catch (e) {
      // One slow probe (relay hiccup, busy Studio frame) means "not yet", not
      // failure; only the wait's own deadline ends it.
      if (!(e instanceof BridgeError) || e.code !== "TIMEOUT") throw e;
      timedOut = true;
    }
    if (!timedOut && last.met === true) {
      const value = last.value === undefined ? "" : ` value=${fmtValue(last.value)}`;
      return `wait ok: ${check["kind"]} ${check["path"]}${check["name"] === undefined ? "" : `@${check["name"]}`}${value}`;
    }
    if (Date.now() >= deadline) {
      const seen = timedOut
        ? "last check timed out"
        : last.exists === false
          ? "instance missing"
          : `last value ${fmtValue(last.value)}`;
      throw new BridgeError("TIMEOUT", `${check["kind"]} condition on ${check["path"]} not met (${seen})`);
    }
    await Bun.sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
    interval = Math.min(STUDIO_POLL_MAX_MS, interval * STUDIO_POLL_GROWTH);
  }
}
