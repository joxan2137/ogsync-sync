import { z } from "zod";
import { badArg, capText, lines, row } from "../fmt.ts";
import { formatHandle, parseHandle, renderRun, vmLabel, type RunResult } from "../jobs.ts";
import { callOpts, defineTool, TIMEOUT_ARG } from "../tool.ts";

/** The play server relays client jobs over a RemoteFunction capped at 10 s. */
const CLIENT_WAIT_CAP_MS = 8_000;
const WAIT_MARGIN_MS = 5_000;

interface ListResult {
  jobs?: Array<{ id: string; gen?: number; key?: string; vm?: string; status?: string; elapsed?: number }>;
  nonce?: string;
}

export const tool = defineTool({
  name: "job",
  description:
    "Manage async `run` jobs by handle: action=poll (status and output so far), collect (wait up to wait_ms, then return and forget a finished job), cancel, or list (jobs in `context`). A cancelled or superseded job's ogsync.delay timers never fire, so a stale timer cannot touch a newer job.",
  schema: {
    action: z.enum(["poll", "collect", "cancel", "list"]).optional(),
    handle: z.string().optional(),
    wait_ms: z.number().int().min(0).optional(),
    context: z.enum(["edit", "server", "client"]).optional(),
    player: z.union([z.string(), z.number()]).optional(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    const action = args.action ?? "poll";
    if (action === "list") {
      const context = args.context ?? "edit";
      const data = (await bridge.call(
        "run.job",
        { action, context, player: args.player },
        callOpts(args),
      )) as ListResult;
      const player = args.player === undefined ? {} : { player: String(args.player) };
      const rows = (data.jobs ?? []).map((j) =>
        row(formatHandle({ context, ...player, id: j.id, nonce: String(data.nonce) }), {
          status: j.status,
          vm: j.vm,
          key: j.key,
          elapsed_s: j.elapsed === undefined ? undefined : round(j.elapsed),
        }),
      );
      return capText(lines(rows.length ? rows : `no jobs in ${context}`));
    }

    if (!args.handle) throw badArg(`action=${action} needs a handle from run async=true`);
    const handle = parseHandle(args.handle);
    if (!handle) throw badArg(`bad handle '${args.handle}' (expected the handle run printed, e.g. server:7.1a2b3c4d)`);
    let waitMs = action === "collect" ? (args.wait_ms ?? 10_000) : 0;
    const clamped = handle.context === "client" && waitMs > CLIENT_WAIT_CAP_MS;
    if (clamped) waitMs = CLIENT_WAIT_CAP_MS;

    const opts = callOpts(args);
    const data = (await bridge.call(
      "run.job",
      { action, id: handle.id, nonce: handle.nonce, context: handle.context, player: handle.player, wait_ms: waitMs },
      { ...opts, timeoutMs: Math.max(opts.timeoutMs ?? 0, waitMs + WAIT_MARGIN_MS) },
    )) as RunResult;

    const head = row(`job ${args.handle} ${data.status ?? "?"}`, {
      vm: data.vm,
      gen: data.gen,
      elapsed_s: data.elapsed === undefined ? undefined : round(data.elapsed),
    });
    const tail =
      data.status === "running"
        ? `still running${clamped ? ` (client waits cap at ${CLIENT_WAIT_CAP_MS}ms)` : ""}; collect again`
        : undefined;
    return capText(
      lines(head, vmLabel(handle.context, data.vm), renderRun(data), data.err ? `ERR ${data.err}` : undefined, tail),
    );
  },
});

function round(seconds: number): number {
  return Math.round(seconds * 10) / 10;
}
