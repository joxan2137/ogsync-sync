import { z } from "zod";
import { badArg, capText, lines, row } from "../fmt.ts";
import { defineTool, TIMEOUT_ARG } from "../tool.ts";
import type { SyncStatus } from "@proto/types";

const DISABLED = "sync disabled (no project)";

export const tool = defineTool({
  name: "sync",
  description:
    "Control filesystem⇄Studio script sync: op=status | conflicts | resolve {file, keep: fs|studio} | pause | resume | pull | push. pull/push force a full one-way pass; status reports mapping, connection and pending/conflict counts.",
  schema: {
    op: z.enum(["status", "conflicts", "resolve", "pause", "resume", "pull", "push"]),
    file: z.string().optional(),
    keep: z.enum(["fs", "studio"]).optional(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(_bridge, deps, args) {
    const sync = deps.sync;
    if (!sync) return DISABLED;

    switch (args.op) {
      case "status":
        return capText(statusBlock(sync.status()));
      case "conflicts": {
        const conflicts = sync.status().conflicts;
        if (!conflicts.length) return "no conflicts";
        return capText(
          lines(
            conflicts.map((c) =>
              row(c.file, { path: c.path, ts: c.ts, resolution: c.resolution, backup: c.backupFile }),
            ),
          ),
        );
      }
      case "resolve": {
        if (!args.file || !args.keep) throw badArg("resolve requires file and keep=fs|studio");
        return capText(await sync.resolve(args.file, args.keep));
      }
      case "pause":
        sync.pause();
        return capText(statusBlock(sync.status()));
      case "resume":
        sync.resume();
        return capText(statusBlock(sync.status()));
      case "pull":
        return capText(await sync.fullPull());
      case "push":
        return capText(await sync.fullPush());
    }
  },
});

function statusBlock(status: SyncStatus): string {
  return lines(
    row("sync", {
      enabled: status.enabled,
      paused: status.paused,
      connected: status.connected,
      project: status.projectName,
      pending: status.pending,
      conflicts: status.conflicts.length,
    }),
    status.conflicts.filter((c) => c.resolution === "pending").map((c) => `conflict ${c.file}`),
  );
}
