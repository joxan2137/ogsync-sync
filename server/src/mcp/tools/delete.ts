import { z } from "zod";
import { capText, lines } from "../fmt.ts";
import { callOpts, defineTool, TIMEOUT_ARG } from "../tool.ts";

interface DeleteResult {
  deleted?: number;
  errors?: Array<{ path: string; err: string }>;
}

export const tool = defineTool({
  name: "delete",
  description:
    "Delete instances by path (batched; @selection allowed). Services are refused.",
  schema: {
    paths: z.union([z.string(), z.array(z.string())]),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    const paths = typeof args.paths === "string" ? [args.paths] : args.paths;
    const data = (await bridge.call("inst.delete", { paths }, callOpts(args))) as DeleteResult;
    const errors = (data.errors ?? []).map((e) => `ERR ${e.path}: ${e.err}`);
    return capText(lines(`ok ${data.deleted ?? 0} deleted`, errors));
  },
});
