import { z } from "zod";
import { capText, compactPaths, lines, moreLine } from "../fmt.ts";
import { callOpts, defineTool, TIMEOUT_ARG } from "../tool.ts";

interface DuplicateResult {
  created?: string[];
  total?: number;
  truncated?: boolean;
  errors?: Array<{ path?: string; err: string }>;
}

export const tool = defineTool({
  name: "duplicate",
  description:
    "Clone an instance `count` times (default 1) into parent, naming copies with a `{n}` placeholder and spacing them by `offset` (Vector3 [x,y,z] or CFrame 12 numbers). props_per_copy applies per-copy property overrides; returns created paths compacted as `parent.Name[1..N]`.",
  schema: {
    path: z.string(),
    count: z.number().int().positive().optional(),
    parent: z.string().optional(),
    name: z.string().optional(),
    offset: z.array(z.number()).optional(),
    props_per_copy: z.array(z.record(z.unknown())).optional(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    const data = (await bridge.call(
      "inst.duplicate",
      {
        path: args.path,
        count: args.count ?? 1,
        parent: args.parent,
        name: args.name,
        offset: args.offset,
        props_per_copy: args.props_per_copy,
      },
      callOpts(args),
    )) as DuplicateResult;

    const created = data.created ?? [];
    const errors = (data.errors ?? []).map((e) => `ERR ${e.path ?? args.path}: ${e.err}`);
    return capText(
      lines(
        `ok ${data.total ?? created.length} copies`,
        compactPaths(created),
        errors,
        data.truncated ? moreLine() : undefined,
      ),
    );
  },
});
