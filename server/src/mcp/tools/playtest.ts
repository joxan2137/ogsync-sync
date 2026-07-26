import { z } from "zod";
import { BridgeError } from "@proto/types";
import { capText, lines, row } from "../fmt.ts";
import { callOpts, defineTool, LONG_TIMEOUT_MS, TIMEOUT_ARG } from "../tool.ts";

interface PlaytestResult {
  started?: string;
  requested?: string;
  via?: string;
  note?: string;
  stopped?: boolean;
  running?: boolean;
  mode?: string;
  uptime?: number;
  players?: string[];
  errors?: number;
}

export const tool = defineTool({
  name: "playtest",
  description:
    "Start, stop or inspect a playtest: action=start (mode=solo runs a local playtest, mode=server runs server-only), stop, or status. Status reports state, mode, uptime and connected players; run code inside a live playtest with the `run` tool's context=server|client.",
  schema: {
    action: z.enum(["start", "stop", "status"]),
    mode: z.enum(["solo", "server"]).optional(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    const opts = callOpts(args, LONG_TIMEOUT_MS);
    const op = args.action === "start" ? "play.start" : args.action === "stop" ? "play.stop" : "play.status";
    const opArgs = args.action === "start" ? { mode: args.mode ?? "solo" } : {};

    let data: PlaytestResult;
    try {
      data = (await bridge.call(op, opArgs, opts)) as PlaytestResult;
    } catch (e) {
      if (args.action !== "stop") throw e;
      // Stopping tears down the very session running the job, so a lost
      // connection here is the success signal, not a failure. The
      // cross-DataModel SetSetting path is the fallback for a wedged session.
      const code = e instanceof BridgeError ? e.code : "STUDIO";
      if (code !== "NOPLUGIN" && code !== "TIMEOUT") throw e;
      await bridge.call("play.stopSignal", {}, opts).catch(() => {});
      return code === "TIMEOUT"
        ? "playtest stopped (session ended during the call)"
        : "playtest not running";
    }

    const state =
      args.action === "start"
        ? `started ${data.started ?? "?"}`
        : args.action === "stop"
          ? data.stopped
            ? "stopped"
            : "stop requested"
          : data.running
            ? "running"
            : "idle";
    const head = row(`playtest ${state}`, {
      mode: data.mode,
      requested: data.requested === data.started ? undefined : data.requested,
      via: data.via,
      uptime_s: data.uptime === undefined ? undefined : Math.round(data.uptime),
      players: data.players?.length,
      errors: data.errors,
    });
    return capText(lines(head, data.note, data.players ?? []));
  },
});
