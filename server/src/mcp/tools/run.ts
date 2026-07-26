import { z } from "zod";
import { capText, clip, fmtValue, lines, moreLine } from "../fmt.ts";
import { callOpts, defineTool, TIMEOUT_ARG } from "../tool.ts";

const RETURN_CAP = 2000;

interface RunResult {
  output?: Array<{ level?: string; text?: string } | string>;
  returns?: unknown[];
  truncated?: boolean;
  dropped?: number;
}

export const tool = defineTool({
  name: "run",
  description:
    "Execute Luau in Studio and get print output plus serialized return values. context=edit (default) runs in the edit session; server/client need an active playtest, and client picks a target with `player`.",
  schema: {
    code: z.string(),
    context: z.enum(["edit", "server", "client"]).optional(),
    player: z.union([z.string(), z.number()]).optional(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    const context = args.context ?? "edit";
    const data = (await bridge.call(
      "run.exec",
      { code: args.code, context, player: args.player },
      callOpts(args, undefined, args.player === undefined ? undefined : { player: args.player }),
    )) as RunResult;

    const out = (data.output ?? []).map((entry) => {
      if (typeof entry === "string") return entry;
      const text = entry.text ?? "";
      return entry.level && entry.level !== "info" ? `[${entry.level}] ${text}` : text;
    });
    const returns = (data.returns ?? []).map((v) => `=> ${clip(fmtValue(v), RETURN_CAP)}`);
    const dropped = data.dropped ? `${data.dropped} output lines dropped` : undefined;
    const body = lines(out, returns, dropped, data.truncated ? moreLine() : undefined);
    return capText(body || `ok ${context}, no output`);
  },
});
