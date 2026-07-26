import { z } from "zod";
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
    "Start, stop or inspect a playtest: action=start (mode=solo|server, players=N for multiplayer), stop, or status. Status reports state, mode, uptime, connected players and error count.",
  schema: {
    action: z.enum(["start", "stop", "status"]),
    mode: z.enum(["solo", "server"]).optional(),
    players: z.number().int().positive().optional(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    const opts = callOpts(args, LONG_TIMEOUT_MS);
    if (args.action === "stop") {
      // Cross-DataModel stop signal (plugin:SetSetting) rides the edit session.
      void bridge.call("play.stopSignal", {}, opts).catch(() => {});
    }
    const op = args.action === "start" ? "play.start" : args.action === "stop" ? "play.stop" : "play.status";
    const opArgs =
      args.action === "start" ? { mode: args.mode ?? "solo", players: args.players } : {};
    const data = (await bridge.call(op, opArgs, opts)) as PlaytestResult;

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
