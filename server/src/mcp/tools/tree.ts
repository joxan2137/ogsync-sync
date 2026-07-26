import { z } from "zod";
import { capText, lines, moreLine, renderTree, type TreeNode } from "../fmt.ts";
import { callOpts, defineTool, TIMEOUT_ARG } from "../tool.ts";

/** Wire node keys are terse to keep the 1 MB plugin result budget for content. */
interface WireNode {
  n?: string;
  c?: string;
  k?: number;
  ln?: number;
  ch?: WireNode[];
}

interface TreeResult {
  root?: WireNode;
  truncated?: boolean;
  nodes?: number;
}

export const tool = defineTool({
  name: "tree",
  description:
    "Instance tree under path (default @game, @selection allowed) as 2-space indented `Name Class` lines, scripts tagged `#lines`. depth defaults to 2; filter by class name(s) or `scripts`; counts=true prints child counts instead of listing children.",
  schema: {
    path: z.string().optional(),
    depth: z.number().int().min(1).optional(),
    filter: z.union([z.string(), z.array(z.string())]).optional(),
    counts: z.boolean().optional(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    const data = (await bridge.call(
      "inst.tree",
      {
        path: args.path ?? "@game",
        depth: args.depth ?? 2,
        filter: args.filter,
        counts: args.counts ?? false,
      },
      callOpts(args),
    )) as TreeResult;

    const body = data.root ? renderTree(toTreeNode(data.root)) : [];
    return capText(lines(body.length ? body : "empty", data.truncated ? moreLine() : undefined));
  },
});

function toTreeNode(node: WireNode): TreeNode {
  return {
    name: node.n ?? "?",
    class: node.c,
    lines: node.ln,
    count: node.k ? node.k : undefined,
    children: node.ch?.map(toTreeNode),
  };
}
