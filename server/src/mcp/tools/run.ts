import { z } from "zod";
import { badArg, capText, lines } from "../fmt.ts";
import { formatHandle, renderRun, vmLabel, type RunResult } from "../jobs.ts";
import { callOpts, defineTool, TIMEOUT_ARG } from "../tool.ts";

export const tool = defineTool({
  name: "run",
  description:
    "Execute Luau in Studio and get print output plus serialized return values; context=edit (default) runs in the edit session, server/client need an active playtest and run in the GAME VM (shared require cache) unless vm=plugin, and client picks a target with `player`. async=true returns a job handle at once for the `job` tool (no call timeout), and `key` makes a new job supersede the previous one with that key, whose ogsync.delay timers then stop firing.",
  schema: {
    code: z.string(),
    context: z.enum(["edit", "server", "client"]).optional(),
    player: z.union([z.string(), z.number()]).optional(),
    vm: z.enum(["game", "plugin"]).optional(),
    async: z.boolean().optional(),
    key: z.string().optional(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    const context = args.context ?? "edit";
    if (context === "edit" && args.vm === "game") {
      throw badArg("context=edit has no game VM; vm=game needs context=server|client during a playtest");
    }
    const data = (await bridge.call(
      "run.exec",
      { code: args.code, context, player: args.player, vm: args.vm, async: args.async, key: args.key },
      callOpts(args, undefined, args.player === undefined ? undefined : { player: args.player }),
    )) as RunResult;

    if (args.async) {
      const handle = formatHandle({
        context,
        ...(args.player === undefined ? {} : { player: String(args.player) }),
        id: String(data.job),
      });
      return `job ${handle} started vm=${data.vm ?? "?"} gen=${data.gen ?? "?"}${data.key ? ` key=${data.key}` : ""}\npoll, collect or cancel with the job tool: handle="${handle}"`;
    }
    const body = lines(vmLabel(context, data.vm), renderRun(data));
    return capText(body || `ok ${context}, no output`);
  },
});
