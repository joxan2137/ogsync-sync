import { z } from "zod";
import { BridgeError } from "@proto/types";
import { checkVisual } from "../../window/visual.ts";
import { badArg, capText, lines, row } from "../fmt.ts";
import { callOpts, defineTool, LONG_TIMEOUT_MS, TIMEOUT_ARG } from "../tool.ts";

interface Ack extends Record<string, unknown> {
  type?: string;
  ok?: boolean;
  err?: string;
}

interface InputResult {
  actions?: Ack[];
}

/** Actions that go through the viewport and so need Studio painting. */
const VISUAL_ACTIONS: ReadonlySet<string> = new Set(["key", "click", "move", "scroll"]);

const action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("key"), code: z.string(), hold_ms: z.number().int().min(0).optional() }),
  z.object({
    type: z.literal("click"),
    path: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
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
    "Send a batch of simulated inputs to a playtest (context=client by default): key {code,hold_ms}, click {path | x,y, button} where path resolves a GuiObject or part to screen coordinates at runtime and the ack reports what was hit, move, scroll, nav {to: path|[x,y,z]} which walks the character, device and network. Refuses fast when Studio cannot paint (restore=true un-minimizes without taking focus) and answers `unsupported` with the reason instead of acking input that cannot land.",
  schema: {
    actions: z.array(action).min(1),
    context: z.enum(["edit", "server", "client"]).optional(),
    player: z.union([z.string(), z.number()]).optional(),
    restore: z.boolean().optional(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    for (const a of args.actions) {
      if (a.type === "click" && a.path === undefined && (a.x === undefined || a.y === undefined)) {
        throw badArg("click needs path or both x and y");
      }
    }
    let warnings: string[] = [];
    if (args.actions.some((a) => VISUAL_ACTIONS.has(a.type))) {
      const visual = await checkVisual(bridge.bound()?.placeName, { restore: args.restore });
      if (!visual.ok) throw new BridgeError("STUDIO", `input refused: ${visual.reason}`);
      warnings = visual.warnings;
    }

    const data = (await bridge.call(
      "input.batch",
      { actions: args.actions, context: args.context ?? "client", player: args.player },
      callOpts(args, LONG_TIMEOUT_MS, args.player === undefined ? undefined : { player: args.player }),
    )) as InputResult;

    const acks = data.actions ?? [];
    const body = args.actions.map((action, i) => {
      const ack = acks[i];
      if (!ack) return `${i + 1} ${action.type} no ack`;
      const state = ack.err ? `ERR ${ack.err}` : ack.ok === false ? "failed" : "ok";
      return row(`${i + 1} ${action.type} ${state}`, detail(ack));
    });
    return capText(lines(body, warnings.map((w) => `warn: ${w}`)));
  },
});

/** Plugin merges per-action detail (code, x/y, hit, reached, activated, dist) into the ack. */
function detail({ type: _type, ok: _ok, err: _err, ...rest }: Ack): Record<string, unknown> {
  return rest;
}
