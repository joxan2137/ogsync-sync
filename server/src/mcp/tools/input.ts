import { z } from "zod";
import { capText, lines, row } from "../fmt.ts";
import { callOpts, defineTool, LONG_TIMEOUT_MS, TIMEOUT_ARG } from "../tool.ts";

interface Ack extends Record<string, unknown> {
  type?: string;
  ok?: boolean;
  err?: string;
}

interface InputResult {
  actions?: Ack[];
}

const action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("key"), code: z.string(), hold_ms: z.number().int().min(0).optional() }),
  z.object({
    type: z.literal("click"),
    x: z.number(),
    y: z.number(),
    button: z.enum(["left", "right", "middle"]).optional(),
  }),
  z.object({
    type: z.literal("move"),
    x: z.number(),
    y: z.number(),
    duration_ms: z.number().int().min(0).optional(),
  }),
  z.object({ type: z.literal("scroll"), delta: z.number(), x: z.number().optional(), y: z.number().optional() }),
  z.object({ type: z.literal("device"), name: z.string().optional(), reset: z.boolean().optional() }),
  z.object({ type: z.literal("network"), profile: z.string() }),
  z.object({
    type: z.literal("nav"),
    to: z.union([z.string(), z.array(z.number()).length(3)]),
    timeout_ms: z.number().int().positive().optional(),
  }),
]);

export const tool = defineTool({
  name: "input",
  description:
    "Send a batch of simulated inputs: key {code,hold_ms}, click {x,y,button}, move, scroll, device {name|reset}, network {profile}, nav {to: path|[x,y,z]} which walks the character. key/click/nav require an active playtest; returns one ack line per action.",
  schema: {
    actions: z.array(action).min(1),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    const data = (await bridge.call(
      "input.batch",
      { actions: args.actions },
      callOpts(args, LONG_TIMEOUT_MS),
    )) as InputResult;

    const acks = data.actions ?? [];
    const body = args.actions.map((action, i) => {
      const ack = acks[i];
      if (!ack) return `${i + 1} ${action.type} no ack`;
      const state = ack.err ? `ERR ${ack.err}` : ack.ok === false ? "failed" : "ok";
      return row(`${i + 1} ${action.type} ${state}`, detail(ack));
    });
    return capText(lines(body));
  },
});

/** Plugin merges per-action detail (code, x/y, reached, dist) into the ack. */
function detail({ type: _type, ok: _ok, err: _err, ...rest }: Ack): Record<string, unknown> {
  return rest;
}
