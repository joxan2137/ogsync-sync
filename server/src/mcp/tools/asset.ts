import { readFile } from "node:fs/promises";
import { z } from "zod";
import { capText, fmtValue, lines, moreLine, row } from "../fmt.ts";
import { resolveInCwd } from "../files.ts";
import { callOpts, defineTool, LONG_TIMEOUT_MS, TIMEOUT_ARG } from "../tool.ts";

interface AssetResult {
  assets?: Array<Record<string, unknown> & { id?: number | string; name?: string; creator?: string }>;
  inserted?: string[];
  id?: number | string;
  url?: string;
  errors?: Array<{ id?: number | string; err: string }>;
  truncated?: boolean;
}

export const tool = defineTool({
  name: "asset",
  description:
    "Marketplace/asset operations: op=search {query, category, limit} | details {ids} | thumbnail {id} | insert {id, parent} | upload {path|file, name, type} | library {category}. Search returns `id  name  by creator  type` lines; upload takes either an instance path or a local file.",
  schema: {
    op: z.enum(["search", "details", "thumbnail", "insert", "upload", "library"]),
    query: z.string().optional(),
    category: z.string().optional(),
    limit: z.number().int().positive().optional(),
    ids: z.array(z.union([z.number(), z.string()])).optional(),
    id: z.union([z.number(), z.string()]).optional(),
    parent: z.string().optional(),
    path: z.string().optional(),
    file: z.string().optional(),
    name: z.string().optional(),
    type: z.string().optional(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    const { timeout_ms: _t, file, ...rest } = args;
    const opArgs: Record<string, unknown> = { ...rest };
    if (file) {
      opArgs["file"] = file;
      opArgs["data"] = (await readFile(resolveInCwd(file))).toString("base64");
    }
    const data = (await bridge.call(
      "asset.op",
      opArgs,
      callOpts(args, args.op === "upload" ? LONG_TIMEOUT_MS : undefined),
    )) as AssetResult;

    const errors = (data.errors ?? []).map((e) => `ERR ${e.id ?? "?"}: ${e.err}`);
    return capText(
      lines(render(args.op, data), errors, data.truncated ? moreLine() : undefined),
    );
  },
});

function render(op: string, data: AssetResult): string[] {
  if (data.assets?.length) {
    return data.assets.map(({ id, name, creator, ...rest }) =>
      row(`${id ?? "?"}  ${name ?? ""}  by ${creator ?? "?"}`, rest),
    );
  }
  if (data.inserted?.length) return [`ok ${op} ${data.id ?? ""}`.trimEnd(), ...data.inserted];
  if (data.url) return [data.url];
  if (data.id !== undefined) return [`ok ${op} ${data.id}`];
  return [`ok ${op}`, ...Object.entries(data).map(([k, v]) => `${k}=${fmtValue(v)}`)];
}
