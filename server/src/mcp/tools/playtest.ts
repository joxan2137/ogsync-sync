import { z } from "zod";
import { BridgeError, type Bridge, type PlaceState, type PlaytestInfo, type PlaytestPhase } from "@proto/types";
import { checkVisual } from "../../window/visual.ts";
import { capText, lines, row } from "../fmt.ts";
import { callOpts, defineTool, LONG_TIMEOUT_MS, TIMEOUT_ARG } from "../tool.ts";

/** How long start/stop wait for the plugin-reported state to settle before answering. */
const SETTLE_MS = 15_000;
const SETTLE_POLL_MS = 250;

interface PlaytestResult {
  started?: string;
  requested?: string;
  via?: string;
  note?: string;
  already?: boolean;
  /** Set by the daemon on `already`: false when Studio was running a test this call did not start. */
  yours?: boolean;
  stopped?: boolean;
}

export const tool = defineTool({
  name: "playtest",
  description:
    "Start, stop or inspect a playtest: action=start (mode=solo plays locally, mode=server runs server-only), stop (force=true to stop one another session or the user started), or status. Results report the plugin-confirmed state, lease owner, stale-code and plugin warnings; run code inside it with the `run` tool's context=server|client.",
  schema: {
    action: z.enum(["start", "stop", "status"]),
    mode: z.enum(["solo", "server"]).optional(),
    force: z.boolean().optional(),
    restore: z.boolean().optional(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    if (args.action === "status") return describe("playtest", bridge.place?.() ?? null);
    const opts = callOpts(args, LONG_TIMEOUT_MS);

    if (args.action === "start") {
      // A Studio that cannot paint never brings a play test up: say why now.
      const visual = await checkVisual(bridge.bound()?.placeName, { restore: args.restore });
      if (!visual.ok) throw new BridgeError("STUDIO", `playtest start refused: ${visual.reason}`);
      const notes = visual.warnings.map((warning) => `warn: ${warning}`);
      const data = (await bridge.call("play.start", { mode: args.mode ?? "solo" }, opts)) as PlaytestResult;
      if (data.already) {
        const head = data.yours === false
          ? "playtest already running, started outside this call (no lease; stop needs force=true)"
          : "playtest already running (yours)";
        return capText(lines(describe(head, bridge.place?.() ?? null), notes));
      }
      const place = await settle(bridge, ["running"], opts.timeoutMs);
      const confirmed = place?.playtest.state === "running";
      const head = confirmed ? `playtest started ${data.started ?? "?"}` : `playtest start requested (${data.started ?? "?"}), not confirmed yet`;
      const detail = row(head, {
        requested: data.requested === data.started ? undefined : data.requested,
        via: data.via,
      });
      return capText(lines(detail, data.note, place ? stateLines(place.playtest) : undefined, notes));
    }

    try {
      const data = (await bridge.call("play.stop", { force: args.force === true }, opts)) as PlaytestResult & {
        state?: string;
      };
      if (data.stopped === false && data.state === "idle") return "playtest not running";
    } catch (e) {
      // Stopping tears down the very session running the job, so a lost
      // connection here is the success signal, not a failure. The
      // cross-DataModel SetSetting path is the fallback for a wedged session.
      const code = e instanceof BridgeError ? e.code : "STUDIO";
      if (code !== "NOPLUGIN" && code !== "TIMEOUT") throw e;
      await bridge.call("play.stopSignal", {}, opts).catch(() => {});
    }
    const place = await settle(bridge, ["idle"], opts.timeoutMs);
    if (!place || place.playtest.state === "idle") return "playtest stopped";
    return describe("playtest stop requested, not confirmed yet", place);
  },
});

async function settle(bridge: Bridge, wanted: PlaytestPhase[], timeoutMs = SETTLE_MS): Promise<PlaceState | null> {
  const deadline = Date.now() + Math.min(SETTLE_MS, timeoutMs);
  let place = bridge.place?.() ?? null;
  while (place !== null && !wanted.includes(place.playtest.state) && Date.now() < deadline) {
    await Bun.sleep(SETTLE_POLL_MS);
    place = bridge.place?.() ?? null;
  }
  return place;
}

function describe(head: string, place: PlaceState | null): string {
  if (place === null) return `${head}: no Studio place resolved`;
  return capText(lines(`${head} ${place.key} (${place.name})`, stateLines(place.playtest)));
}

function stateLines(info: PlaytestInfo): string[] {
  const out = [
    row(`state=${info.state}`, {
      mode: info.mode ?? undefined,
      owner: info.owner ?? undefined,
      started_by: info.startedBy ?? undefined,
      for_s: Math.round((Date.now() - info.since) / 1000),
      players: info.players || undefined,
      heartbeat_ms: info.heartbeatAgeMs ?? "none",
    }),
  ];
  if (info.stale) {
    out.push(
      `STALE CODE: ${info.stale.changed} changed, ${info.stale.missing} missing since launch (${info.stale.sample.join(", ")}); restart the playtest to load current scripts`,
    );
  }
  if (info.warning) out.push(`WARNING: ${info.warning}`);
  return out;
}
