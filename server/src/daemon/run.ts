// `ogsync daemon run`: the one process per machine that owns the Studio
// bridge. Sessions (`ogsync serve`), the CLI and hooks are all clients of it;
// it never dies with any of them. Tools execute here, so partial results and
// plugin events reach them directly; clients relay only the final result.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CONFIG_DEFAULTS, PROTO_VERSION } from "../proto/types.ts";
import { ogsyncHome } from "../config.ts";
import { log } from "../log.ts";
import { runAs } from "../hub/caller.ts";
import { Hub, type RpcCaller } from "../hub/hub.ts";
import { PollThrottle } from "../hub/throttle.ts";
import { VERSION } from "../version.ts";
import { acquireLock, lockHolder, writeDaemonRecord } from "./lock.ts";
import { portCandidates, readExcludedRanges } from "./ports.ts";
import { ATTACH_INTERVAL_MS, Projects } from "./projects.ts";

export const POLL_THROTTLE_MS = 1_000;

type ToolExecutor = typeof import("../mcp/server.ts").executeTool;

export async function runDaemon(opts: { port: number | null }): Promise<number> {
  const lock = acquireLock();
  if (lock === null) {
    log.info(`another ogsync daemon (pid ${lockHolder() ?? "?"}) already holds the lock`);
    return 0;
  }
  const hub = new Hub({
    config: CONFIG_DEFAULTS,
    version: VERSION,
    ports: portCandidates(opts.port, readExcludedRanges()),
  });
  let port: number;
  try {
    port = hub.listen();
  } catch (err) {
    lock.release();
    throw err;
  }
  writeDaemonRecord({ pid: process.pid, port, version: VERSION, proto: PROTO_VERSION, startedAt: hub.startedAt });

  const projects = new Projects(hub);
  const executeTool = await loadExecutor();
  const throttle = new PollThrottle(POLL_THROTTLE_MS);
  if (executeTool) {
    hub.setRpcHandler((tool, args, caller) => runTool(executeTool, projects, throttle, tool, args, caller));
  }
  hub.setProjectInfo((key) => projects.projectInfo(key));
  hub.setAttachHandler((body) =>
    typeof body.client === "string" && typeof body.cwd === "string" ? projects.attach(body.client, body.cwd) : null,
  );

  const sweeper = setInterval(() => void projects.sweep(), ATTACH_INTERVAL_MS);
  let stopping = false;
  const shutdown = (why: string): void => {
    if (stopping) return;
    stopping = true;
    log.info(`daemon stopping: ${why}`);
    clearInterval(sweeper);
    void projects.stopAll().finally(() => {
      hub.stop();
      lock.release();
      process.exit(0);
    });
  };
  hub.setShutdownHandler(() => shutdown("shutdown requested"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", () => lock.release());
  log.info(`ogsync daemon ${VERSION} (pid ${process.pid}) serving every Studio place on :${port}`);
  return 0;
}

export async function runTool(
  executeTool: ToolExecutor,
  projects: Projects,
  throttle: PollThrottle,
  tool: string,
  args: unknown,
  caller: RpcCaller,
): Promise<CallToolResult> {
  const dir = caller.cwd ?? ogsyncHome();
  const key = pollKey(caller.id, tool, args);
  const retryAfter = key === null ? 0 : throttle.check(key);
  if (retryAfter > 0) {
    return text(
      `ERR THROTTLED: identical ${tool} call repeated within ${POLL_THROTTLE_MS}ms; retry after ${retryAfter}ms, or block on the wait tool instead of polling`,
    );
  }
  const config = projects.configFor(dir);
  const bridge = projects.bridgeFor(dir, targetArg(args));
  return runAs({ id: caller.id, label: caller.label, playtest: config.playtest }, () =>
    executeTool(bridge, { sync: projects.syncFor(dir), version: VERSION }, tool, args),
  );
}

/** Only status polls are throttled; everything else may legitimately repeat. */
export function pollKey(client: string, tool: string, args: unknown): string | null {
  const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const isPoll = tool === "logs" || (tool === "playtest" && record["action"] === "status");
  return isPoll ? `${client}\u0000${tool}\u0000${JSON.stringify(args ?? {})}` : null;
}

function targetArg(args: unknown): string | number | null {
  if (typeof args !== "object" || args === null) return null;
  const target = (args as Record<string, unknown>)["target"];
  return typeof target === "string" || typeof target === "number" ? target : null;
}

function text(line: string): CallToolResult {
  return { content: [{ type: "text", text: line }] };
}

async function loadExecutor(): Promise<ToolExecutor | null> {
  try {
    return (await import("../mcp/server.ts")).executeTool;
  } catch (err) {
    log.warn("tool layer unavailable, /rpc tool calls will be refused:", err);
    return null;
  }
}
