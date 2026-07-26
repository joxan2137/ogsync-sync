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
    // JSON null object values vanish in the plugin's JSONDecode, so null
    // attr deletions travel as the plugin's attrs_remove list instead.
    const targets = args.targets.map((t) => {
      if (!t.attrs) return t;
      const attrs: Record<string, unknown> = {};
      const attrsRemove: string[] = [];
      for (const [k, v] of Object.entries(t.attrs)) {
        if (v === null) attrsRemove.push(k);
        else attrs[k] = v;
      }
      return {
        ...t,
        attrs: Object.keys(attrs).length ? attrs : undefined,
        attrs_remove: attrsRemove.length ? attrsRemove : undefined,
      };
    });
    const data = (await bridge.call(
      "inst.set",
      { targets },
      callOpts(args),
    )) as SetResult;

    const errors = (data.errors ?? []).map((e) => `ERR ${e.path}: ${e.err}`);
    const head = `ok ${data.instances ?? 0} instances, ${data.properties ?? 0} properties`;
    return capText(lines(head, errors));
  },
});
