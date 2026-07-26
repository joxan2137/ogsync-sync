import { z } from "zod";
import { badArg, capText } from "../fmt.ts";
import { callOpts, defineTool, TIMEOUT_ARG } from "../tool.ts";

interface HistoryResult {
  name?: string;
  depth?: number;
}

export const tool = defineTool({
  name: "history",
  description:
    "Studio history: op=undo | redo | waypoint {name}. Returns the waypoint that was acted on.",
  schema: {
    op: z.enum(["undo", "redo", "waypoint"]),
    name: z.string().optional(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    if (args.op === "waypoint" && !args.name) throw badArg("waypoint requires name");
    const data = (await bridge.call(
      "hist.op",
      { op: args.op, name: args.name },
      callOpts(args),
    )) as HistoryResult;
    return capText(`ok ${args.op} ${data.name ?? args.name ?? ""}`.trimEnd());
  },
});
