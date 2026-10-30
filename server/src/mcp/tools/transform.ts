import { z } from "zod";
import { badArg, capText, fmtValue, lines, moreLine, row } from "../fmt.ts";
import { callOpts, defineTool, TIMEOUT_ARG } from "../tool.ts";

interface Planned {
  path: string;
  from?: number[];
  to?: number[];
  rotFrom?: number[];
  rotTo?: number[];
}

interface TransformResult {
  dryRun?: boolean;
  moved?: number;
  planned?: Planned[];
  total?: number;
  truncated?: boolean;
  skipped?: Array<{ path: string; ancestor: string }>;
  errors?: Array<{ path?: string; err: string }>;
}

const vec3 = z.array(z.number()).length(3);

const target = z.object({
  path: z.string().optional(),
  paths: z.array(z.string()).optional(),
  move: vec3.optional(),
  rotate: vec3.optional(),
  origin: z.union([z.enum(["pivot", "center"]), vec3]).optional(),
  to: z.union([vec3, z.array(z.number()).length(12)]).optional(),
});

export const tool = defineTool({
  name: "transform",
  description:
    "Move/rotate many Models or BaseParts as one undo step: targets is an array of {path|paths, move [x,y,z], rotate [rx,ry,rz] degrees about origin pivot|center|[x,y,z], or to [x,y,z] / 12-number CFrame}. Every target pivot is computed from the original pivots before anything moves and applied with PivotTo (never WorldPivot), so welded assemblies do not compound; dry_run returns the planned from→to diff without writing.",
  schema: {
    targets: z.array(target).min(1),
    dry_run: z.boolean().optional(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    for (const t of args.targets) {
      if (!t.path && !t.paths?.length) throw badArg("each target needs path or paths");
      if (t.to && (t.move || t.rotate)) throw badArg("`to` cannot be combined with move/rotate");
      if (!t.to && !t.move && !t.rotate) throw badArg("each target needs move, rotate or to");
    }
    const data = (await bridge.call(
      "inst.transform",
      { targets: args.targets, dryRun: args.dry_run ?? false },
      callOpts(args),
    )) as TransformResult;

    const planned = (data.planned ?? []).map((p) =>
      row(p.path, {
        from: p.from && fmtValue(p.from),
        to: p.to && fmtValue(p.to),
        rot: sameRotation(p) ? undefined : `${fmtValue(p.rotFrom)}→${fmtValue(p.rotTo)}`,
      }),
    );
    const skipped = (data.skipped ?? []).map((s) => `skip ${s.path} (moves with ${s.ancestor})`);
    const errors = (data.errors ?? []).map((e) => `ERR ${e.path ?? "?"}: ${e.err}`);
    const head = data.dryRun
      ? `dry-run ${data.total ?? planned.length} planned`
      : `ok ${data.moved ?? 0} moved`;
    return capText(lines(head, planned, data.truncated ? moreLine() : undefined, skipped, errors));
  },
});

function sameRotation(p: Planned): boolean {
  return JSON.stringify(p.rotFrom) === JSON.stringify(p.rotTo);
}
