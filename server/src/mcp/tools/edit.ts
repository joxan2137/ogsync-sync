import { z } from "zod";
import { badArg, capText, lines } from "../fmt.ts";
import { wireText } from "../source.ts";
import { callOpts, defineTool, TIMEOUT_ARG } from "../tool.ts";

interface EditResult {
  path?: string;
  total?: number;
  hash?: string;
  created?: boolean;
  replaced?: number;
  verified?: boolean;
  editor?: boolean;
  context?: Array<{ n: number; t: string }>;
}

export const tool = defineTool({
  name: "edit",
  description:
    "Edit a script with exactly one mode: old+new string replace (all=true for every match), lines={start,end}+new to replace/delete a range, insert_after=N+new, or source for a full overwrite (creates the script as `class` if missing). Text travels binary-safe with no size ceiling, LF-normalized, and every write is read back (from the open editor when there is one) and hash-verified.",
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

    const opts = callOpts(args);
    const opArgs: Record<string, unknown> = { path: args.path };
    if (modes.old) opArgs.all = args.all ?? false;
    if (modes.lines) opArgs.lines = args.lines;
    if (modes.insert_after) opArgs.insert_after = args.insert_after;
    if (modes.source) opArgs.class = args.class ?? "ModuleScript";
    const texts = { old: args.old, new: args.new, source: args.source };
    for (const [field, text] of Object.entries(texts)) {
      if (text !== undefined) Object.assign(opArgs, (await wireText(bridge, field, text, opts)).fields);
    }

    const data = (await bridge.call("script.edit", opArgs, opts)) as EditResult;
    const head = [
      `ok ${data.path ?? args.path}`,
      `${data.total ?? 0}L`,
      (data.hash ?? "").slice(0, 8),
      data.created ? "created" : undefined,
      data.replaced === undefined ? undefined : `${data.replaced} replaced`,
      data.verified ? (data.editor ? "verified(editor)" : "verified") : undefined,
    ]
      .filter((b): b is string => Boolean(b))
      .join(" ");
    const context = (data.context ?? []).map((c) => `${c.n}\t${c.t}`);
    return capText(lines(head, context));
  },
});
