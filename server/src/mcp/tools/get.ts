import { z } from "zod";
import { capText, instBlock, lines, moreLine } from "../fmt.ts";
import { callOpts, defineTool, TIMEOUT_ARG } from "../tool.ts";

interface InstanceInfo {
  path: string;
  class?: string;
  props?: Record<string, unknown>;
  attrs?: Record<string, unknown>;
  tags?: string[];
  refs?: { incoming?: string[]; outgoing?: string[]; truncated?: boolean };
  place?: Record<string, unknown>;
}

interface GetResult {
  instances?: InstanceInfo[];
  errors?: Array<{ path: string; err: string }>;
  truncated?: boolean;
}

export const tool = defineTool({
  name: "get",
  description:
    "Read properties, attributes and tags of one or many instances (paths is batched; @selection and @game work). props defaults to a class summary set and `*` gives all non-default values; attrs/tags/refs are opt-in.",
  schema: {
    paths: z.union([z.string(), z.array(z.string())]),
    props: z.union([z.literal("*"), z.array(z.string())]).optional(),
    attrs: z.union([z.boolean(), z.array(z.string())]).optional(),
    tags: z.boolean().optional(),
    refs: z.boolean().optional(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    const paths = typeof args.paths === "string" ? [args.paths] : args.paths;
    const data = (await bridge.call(
      "inst.get",
      { paths, props: args.props, attrs: args.attrs, tags: args.tags, refs: args.refs },
      callOpts(args),
    )) as GetResult;

    const out: string[] = [];
    for (const inst of data.instances ?? []) {
      const entries: Record<string, unknown> = { ...inst.props };
      for (const [k, v] of Object.entries(inst.place ?? {})) entries[k] = v;
      for (const [k, v] of Object.entries(inst.attrs ?? {})) entries[`@${k}`] = v;
      if (inst.tags?.length) entries["#tags"] = inst.tags.join(",");
      if (inst.refs?.outgoing?.length) entries["refs.out"] = inst.refs.outgoing.join(",");
      if (inst.refs?.incoming?.length) entries["refs.in"] = inst.refs.incoming.join(",");
      out.push(...instBlock(inst.path, inst.class, entries));
    }
    for (const e of data.errors ?? []) out.push(`ERR ${e.path}: ${e.err}`);
    return capText(
      lines(out.length ? out : "no instances", data.truncated ? moreLine() : undefined),
    );
  },
});
