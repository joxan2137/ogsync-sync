import { z } from "zod";
import { capText, compactPaths, lines, moreLine } from "../fmt.ts";
import { callOpts, defineTool, TIMEOUT_ARG } from "../tool.ts";

interface CreateItem {
  class: string;
  parent?: string;
  name?: string;
  props?: Record<string, unknown>;
  attrs?: Record<string, unknown>;
  tags?: string[];
  count?: number;
  offset?: number[];
  children?: CreateItem[];
}

interface CreateResult {
  created?: string[];
  total?: number;
  truncated?: boolean;
  errors?: Array<{ path?: string; err: string }>;
}

const item: z.ZodType<CreateItem> = z.lazy(() =>
  z.object({
    class: z.string(),
    parent: z.string().optional(),
    name: z.string().optional(),
    props: z.record(z.unknown()).optional(),
    attrs: z.record(z.unknown()).optional(),
    tags: z.array(z.string()).optional(),
    count: z.number().int().positive().optional(),
    offset: z.array(z.number()).optional(),
    children: z.array(item).optional(),
  }),
);

export const tool = defineTool({
  name: "create",
  description:
    "Create instances from a batched spec of {class, parent, name, props, attrs, tags, children}, where children nest recursively. count on an item mass-creates copies spaced by `offset` (Vector3 [x,y,z] or CFrame 12 numbers); returns created paths, compacted as `parent.Name[1..N]`.",
  schema: {
    items: z.array(item).min(1),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    const data = (await bridge.call(
      "inst.create",
      { items: args.items },
      callOpts(args),
    )) as CreateResult;

    const created = data.created ?? [];
    const errors = (data.errors ?? []).map((e) => `ERR ${e.path ?? "?"}: ${e.err}`);
    return capText(
      lines(
        `ok ${data.total ?? created.length} created`,
        compactPaths(created),
        errors,
        data.truncated ? moreLine() : undefined,
      ),
    );
  },
});
