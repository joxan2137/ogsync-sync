import { z } from "zod";
import { badArg, capText, lines } from "../fmt.ts";
import { callOpts, defineTool, TIMEOUT_ARG } from "../tool.ts";

interface EditResult {
  path?: string;
  total?: number;
  hash?: string;
  created?: boolean;
  replaced?: number;
  context?: Array<{ n: number; t: string }>;
}

export const tool = defineTool({
  name: "edit",
  description:
    "Edit a script with exactly one mode: old+new string replace (all=true for every match), lines={start,end}+new to replace/delete a range, insert_after=N+new, or source for a full overwrite (creates the script as `class` if missing).",
  schema: {
    path: z.string(),
    old: z.string().optional(),
    new: z.string().optional(),
    all: z.boolean().optional(),
    lines: z.object({ start: z.number().int().min(1), end: z.number().int().min(1).optional() }).optional(),
    insert_after: z.number().int().min(0).optional(),
    source: z.string().optional(),
    class: z.string().optional(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    const modes = {
      old: args.old !== undefined,
      lines: args.lines !== undefined,
      insert_after: args.insert_after !== undefined,
      source: args.source !== undefined,
    };
    const picked = Object.entries(modes).filter(([, on]) => on).map(([m]) => m);
    if (picked.length !== 1) {
      throw badArg(
        `pass exactly one of old / lines / insert_after / source (got ${picked.join("+") || "none"})`,
      );
    }
    if (!modes.source && args.new === undefined) throw badArg("this mode requires `new`");

    const opArgs: Record<string, unknown> = { path: args.path };
    if (modes.old) Object.assign(opArgs, { old: args.old, new: args.new, all: args.all ?? false });
    if (modes.lines) Object.assign(opArgs, { lines: args.lines, new: args.new });
    if (modes.insert_after) Object.assign(opArgs, { insert_after: args.insert_after, new: args.new });
    if (modes.source) Object.assign(opArgs, { source: args.source, class: args.class ?? "ModuleScript" });

    const data = (await bridge.call("script.edit", opArgs, callOpts(args))) as EditResult;
    const head = [
      `ok ${data.path ?? args.path}`,
      `${data.total ?? 0}L`,
      (data.hash ?? "").slice(0, 8),
      data.created ? "created" : undefined,
      data.replaced === undefined ? undefined : `${data.replaced} replaced`,
    ]
      .filter((b): b is string => Boolean(b))
      .join(" ");
    const context = (data.context ?? []).map((c) => `${c.n}\t${c.t}`);
    return capText(lines(head, context));
  },
});
