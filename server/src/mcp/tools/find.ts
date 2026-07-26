import { z } from "zod";
import { capText, lines, moreLine } from "../fmt.ts";
import { callOpts, defineTool, TIMEOUT_ARG } from "../tool.ts";

interface FindResult {
  matches?: Array<{ path: string; class?: string }>;
  truncated?: boolean;
  total?: number;
  scanned?: number;
}

export const tool = defineTool({
  name: "find",
  description:
    "Search descendants of root (default @game) by class (inherit=true by default), name glob, tag and/or a property predicate {name, op: eq|ne|lt|gt|contains, value} — all conditions ANDed. Returns `path (Class)` lines, limit default 100.",
  schema: {
    root: z.string().optional(),
    class: z.string().optional(),
    inherit: z.boolean().optional(),
    name: z.string().optional(),
    tag: z.string().optional(),
    prop: z
      .object({
        name: z.string(),
        op: z.enum(["eq", "ne", "lt", "gt", "contains"]),
        value: z.unknown(),
      })
      .optional(),
    limit: z.number().int().positive().optional(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    const data = (await bridge.call(
      "inst.find",
      {
        root: args.root ?? "@game",
        class: args.class,
        inherit: args.inherit ?? true,
        name: args.name,
        tag: args.tag,
        prop: args.prop,
        limit: args.limit ?? 100,
      },
      callOpts(args),
    )) as FindResult;

    const body = (data.matches ?? []).map((m) => (m.class ? `${m.path} (${m.class})` : m.path));
    const more = data.truncated ? moreLine() : undefined;
    return capText(lines(body.length ? body : "no matches", more));
  },
});
