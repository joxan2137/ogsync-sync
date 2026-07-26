import { z } from "zod";
import { capText, lines, moreLine, numberLines } from "../fmt.ts";
import { callOpts, defineTool, TIMEOUT_ARG } from "../tool.ts";

interface ReadResult {
  lines?: string[];
  total?: number;
  hash?: string;
}

export const tool = defineTool({
  name: "read",
  description:
    "Read a script's source as `cat -n` numbered lines, headed by `<path> <lines>L <hash8>`. Page with offset/cursor (1-based line) and limit (default 200).",
  schema: {
    path: z.string(),
    offset: z.number().int().min(1).optional(),
    cursor: z.number().int().min(1).optional(),
    limit: z.number().int().positive().optional(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    const offset = args.offset ?? args.cursor ?? 1;
    const limit = args.limit ?? 200;
    const data = (await bridge.call(
      "script.read",
      { path: args.path, offset, limit },
      callOpts(args),
    )) as ReadResult;

    const body = data.lines ?? [];
    const total = data.total ?? body.length;
    const header = `${args.path} ${total}L ${(data.hash ?? "").slice(0, 8)}`.trimEnd();
    const nextCursor = offset + body.length;
    const cursor = nextCursor <= total ? nextCursor : undefined;
    const text = lines(
      header,
      numberLines(body, offset),
      cursor === undefined ? undefined : moreLine(cursor),
    );
    return capText(text, undefined, cursor);
  },
});
