import { z } from "zod";
import { badArg, capText, lines, moreLine, row } from "../fmt.ts";
import { callOpts, defineTool, TIMEOUT_ARG } from "../tool.ts";

interface ContextLine {
  n: number;
  t: string;
}

interface GrepResult {
  mode?: string;
  matches?: Array<{ path: string; line: number; text: string; before?: ContextLine[]; after?: ContextLine[] }>;
  files?: string[];
  counts?: Array<{ path: string; count: number }>;
  changed?: Array<{ path: string; count: number }>;
  total?: number;
  scripts?: number;
  truncated?: boolean;
}

export const tool = defineTool({
  name: "grep",
  description:
    "Regex (RE2-style, not Lua patterns) search of script sources under root (default @game), optionally narrowed by a name glob like `*.Handler`. mode=content|files|count, and `replace` rewrites every match in place (content mode only).",
  schema: {
    pattern: z.string(),
    root: z.string().optional(),
    glob: z.string().optional(),
    mode: z.enum(["content", "files", "count"]).optional(),
    context: z.number().int().min(0).optional(),
    limit: z.number().int().positive().optional(),
    replace: z.string().optional(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    const mode = args.mode ?? "content";
    if (args.replace !== undefined && mode !== "content") {
      throw badArg("replace requires mode=content");
    }
    const data = (await bridge.call(
      "script.grep",
      {
        pattern: args.pattern,
        root: args.root ?? "@game",
        glob: args.glob,
        mode,
        context: args.context ?? 0,
        limit: args.limit ?? 50,
        replace: args.replace,
      },
      callOpts(args),
    )) as GrepResult;

    const summary = `${data.total ?? 0} matches in ${data.scripts ?? 0} scripts`;
    const more = data.truncated ? moreLine(data.total) : undefined;
    return capText(lines(renderBody(data, mode), summary, more));
  },
});

function renderBody(data: GrepResult, mode: string): string[] {
  if (data.changed) return data.changed.map((c) => row(c.path, { replaced: c.count }));
  if (mode === "files") return data.files ?? [];
  if (mode === "count") return (data.counts ?? []).map((c) => row(c.path, { count: c.count }));
  return (data.matches ?? []).flatMap((m) => [
    ...(m.before ?? []).map((c) => `${m.path}:${c.n}- ${c.t}`),
    `${m.path}:${m.line}: ${m.text}`,
    ...(m.after ?? []).map((c) => `${m.path}:${c.n}- ${c.t}`),
  ]);
}
