import { z } from "zod";
import { capText } from "../fmt.ts";
import { loadApiDump, OFFLINE_MESSAGE, queryApiDump } from "../robloxdocs.ts";
import { defineTool, TIMEOUT_ARG } from "../tool.ts";

export const tool = defineTool({
  name: "docs",
  description:
    "Roblox API lookup: a class name lists its members with signatures plus security/replication flags, `Class.Member` gives that member's detail, and free text fuzzy-searches class/member names. kind=guide returns create.roblox.com doc links instead.",
  schema: {
    query: z.string(),
    kind: z.enum(["api", "guide"]).optional(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(_bridge, _deps, args) {
    const dump = await loadApiDump();
    if (!dump) return OFFLINE_MESSAGE;
    return capText(queryApiDump(dump, args.query, args.kind ?? "api"));
  },
});
