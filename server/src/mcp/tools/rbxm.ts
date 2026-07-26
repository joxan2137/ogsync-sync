import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { z } from "zod";
import { badArg, capText, lines } from "../fmt.ts";
import { RBXM_EXTENSIONS, resolveInCwd } from "../files.ts";
import { callOpts, defineTool, LONG_TIMEOUT_MS, TIMEOUT_ARG } from "../tool.ts";

interface ExportResult {
  data?: string;
  instances?: number;
}

interface ImportResult {
  path?: string;
  instances?: number;
}

export const tool = defineTool({
  name: "rbxm",
  description:
    "Move instance subtrees through model files: op=export {path, file} writes a .rbxm/.rbxmx, op=import {file, parent} inserts one. Files resolve relative to the working directory and paths escaping it are refused.",
  schema: {
    op: z.enum(["export", "import"]),
    path: z.string().optional(),
    parent: z.string().optional(),
    file: z.string(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    const file = resolveInCwd(args.file, RBXM_EXTENSIONS);
    const opts = callOpts(args, LONG_TIMEOUT_MS);

    if (args.op === "export") {
      if (!args.path) throw badArg("export requires path");
      const data = (await bridge.call(
        "rbxm.export",
        { path: args.path, file: relative(process.cwd(), file) },
        opts,
      )) as ExportResult;
      if (!data.data) throw badArg("plugin returned no model data");
      const bytes = Buffer.from(data.data, "base64");
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bytes);
      return capText(
        lines(`ok export ${args.path} → ${relative(process.cwd(), file)} ${bytes.length}B`),
      );
    }

    const bytes = await readFile(file);
    const data = (await bridge.call(
      "rbxm.import",
      { parent: args.parent, file: relative(process.cwd(), file), data: bytes.toString("base64") },
      opts,
    )) as ImportResult;
    return capText(
      lines(
        `ok import ${relative(process.cwd(), file)} → ${data.path ?? args.parent ?? "?"}${
          data.instances === undefined ? "" : ` ${data.instances} instances`
        }`,
      ),
    );
  },
});
