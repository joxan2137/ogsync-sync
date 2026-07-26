import { z } from "zod";
import { badArg, capText, lines } from "../fmt.ts";
import { callOpts, defineTool, TIMEOUT_ARG } from "../tool.ts";

interface SetResult {
  instances?: number;
  properties?: number;
  errors?: Array<{ path: string; err: string }>;
}

const target = z.object({
  path: z.string().optional(),
  paths: z.array(z.string()).optional(),
  props: z.record(z.unknown()).optional(),
  attrs: z.record(z.unknown()).optional(),
  tags_add: z.array(z.string()).optional(),
  tags_remove: z.array(z.string()).optional(),
  name: z.string().optional(),
  parent: z.string().optional(),
});

export const tool = defineTool({
  name: "set",
  description:
    "Batch-write properties, attributes, tags, name and parent across instances in one undo waypoint; targets is an array of {path|paths, props, attrs, tags_add, tags_remove, name, parent}. An attrs value of null deletes that attribute, and `parent` reparents.",
  schema: {
    targets: z.array(target).min(1),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    for (const t of args.targets) {
      if (!t.path && !t.paths?.length) throw badArg("each target needs path or paths");
    }
    const data = (await bridge.call(
      "inst.set",
      { targets: args.targets },
      callOpts(args),
    )) as SetResult;

    const errors = (data.errors ?? []).map((e) => `ERR ${e.path}: ${e.err}`);
    const head = `ok ${data.instances ?? 0} instances, ${data.properties ?? 0} properties`;
    return capText(lines(head, errors));
  },
});
