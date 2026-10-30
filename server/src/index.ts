#!/usr/bin/env bun
// ogsync CLI. Hand-rolled arg parsing (no dependencies): serve (default), daemon,
// call, status, init, update, plugin, doctor, version.
//
// `serve` never owns the Studio bridge: it makes sure the one machine-wide
// daemon is running (spawning it detached when absent) and forwards every MCP
// tool call to it, so sessions come and go without dropping Studio.
//
// The MCP layer loads lazily so a failure degrades instead of killing startup.
// The specifiers stay literal: `bun build --compile` only bundles modules it
// can see statically.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errLine, type StateResponse } from "./proto/types.ts";
import { CONFIG_FILE, defaultConfigToml, loadConfig } from "./config.ts";
import { formatChecks, runDoctor } from "./doctor.ts";
import { log } from "./log.ts";
import { ensureToken, type RpcCaller } from "./hub/hub.ts";
import {
  DaemonClient,
  applyLoopbackNoProxy,
  ensureDaemon,
  findDaemon,
  launchDaemon,
  localRequest,
  stopDaemon,
} from "./daemon/client.ts";
import { ATTACH_INTERVAL_MS } from "./daemon/projects.ts";
import { runDaemon } from "./daemon/run.ts";
import { formatState } from "./daemon/status.ts";
import { getPluginBytes } from "./update/plugin-blob.ts";
import { installPlugin, uninstallPlugin } from "./update/plugin-installer.ts";
import { checkForUpdate, removeStaleBackup, reportOutcome, scheduleAutoUpdates } from "./update/updater.ts";
import { VERSION } from "./version.ts";

const PROJECT_FILE = "default.project.json";
const SOURCE_DIRS = ["src/server", "src/client", "src/shared"];
const VALUE_FLAGS = new Set(["port", "p", "as"]);
/** Forwarded calls wait this much past the tool's own timeout: queueing plus settle time. */
const FORWARD_SLACK_MS = 30_000;
const DEFAULT_FORWARD_MS = 60_000;

const HELP = `ogsync ${VERSION} — MCP server, live sync and Studio plugin for Roblox

usage: ogsync <command> [options]

commands:
  serve                    MCP over stdio for one session; starts the shared daemon if needed (default)
      --no-mcp             keep this project's sync attached without MCP
      --port <n>           preferred daemon port when one has to be started
  daemon run|start|stop    run in the foreground / ensure one is running / stop it
  call <tool> '<json>'     run one tool through the daemon and print the result JSON
      --as <id>            lease identity (default cli:<dir>; also OGSYNC_CLIENT)
  status [--json]          daemon, places, peers and playtest state
  init                     scaffold ${CONFIG_FILE}, ${PROJECT_FILE} and src/ in this directory
  update                   check GitHub Releases now and install a newer build
  plugin [install|uninstall]
                           write or remove the Studio plugin file
  doctor [--port <n>]      diagnose the project, plugin, daemon and Studio binding
  version                  print the version

env: OGSYNC_PORT, OGSYNC_HOME, OGSYNC_CLIENT, OGSYNC_LOG=debug, OGSYNC_PLUGINS_DIR, GITHUB_TOKEN`;

interface Args {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

async function main(): Promise<number> {
  applyLoopbackNoProxy();
  const args = parseArgs(process.argv.slice(2));
  if (flag(args, "help", "h")) {
    log.info(HELP);
    return 0;
  }
  if (flag(args, "version", "v")) {
    log.info(`ogsync ${VERSION}`);
    return 0;
  }
  switch (args.command === "" ? "serve" : args.command) {
    case "serve":
      return serve(args);
    case "daemon":
      return daemon(args);
    case "call":
      return call(args);
    case "init":
      return init();
    case "update":
      return update();
    case "plugin":
      return managePlugin(args);
    case "status":
      return status(args);
    case "doctor":
      return doctor(args);
    case "version":
      out(`ogsync ${VERSION}`);
      return 0;
    case "help":
      out(HELP);
      return 0;
    default:
      log.error(`unknown command "${args.command}"`);
      log.info(HELP);
      return 1;
  }
}

async function serve(args: Args): Promise<number> {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const withMcp = !flag(args, "no-mcp");
  removeStaleBackup();
  // Only `serve` and `plugin install` write the plugin file; the daemon never does.
  await installStudioPlugin();

  const daemon = await ensureDaemon({ port: portFlag(args) ?? config.daemon.port });
  if (daemon.identity.version !== VERSION) {
    log.warn(`daemon runs ${daemon.identity.version}, this session ${VERSION}; \`ogsync daemon stop\` lets the next session start the new build`);
  }
  const client = new DaemonClient(daemon.port, ensureToken(), clientIdentity(args, `serve-${process.pid}`));
  keepAttached(client, cwd, !withMcp);

  if (withMcp) {
    try {
      const { startForwardingMcp } = await import("./mcp/server.ts");
      await startForwardingMcp(VERSION, (tool, toolArgs) => client.callTool(tool, toolArgs, forwardTimeout(toolArgs)) as Promise<CallToolResult>);
      // The session ends when its MCP client closes stdin; the daemon stays.
      process.stdin.on("end", () => process.exit(0));
    } catch (err) {
      log.warn("mcp server unavailable:", err);
    }
  }
  scheduleAutoUpdates(config);
  return 0;
}

async function daemon(args: Args): Promise<number> {
  const action = args.positionals[0] ?? "start";
  if (action === "run") return runDaemon({ port: portFlag(args) });
  if (action === "detach") {
    launchDaemon(portFlag(args));
    // Nothing may keep this hop alive: the daemon's parent must be gone.
    process.exit(0);
  }
  if (action === "start") {
    const started = await ensureDaemon({ port: portFlag(args) });
    out(`ogsync daemon ${started.identity.version} pid ${started.identity.pid} on 127.0.0.1:${started.port}${started.spawned ? " (started)" : ""}`);
    return 0;
  }
  if (action === "stop") {
    const running = await findDaemon();
    if (!running) {
      out("no ogsync daemon running");
      return 0;
    }
    const stopped = await stopDaemon(running.port);
    out(stopped ? `stopped daemon pid ${running.identity.pid}` : `daemon pid ${running.identity.pid} did not stop`);
    return stopped ? 0 : 1;
  }
  log.error(`unknown daemon action "${action}"; expected run, start or stop`);
  return 1;
}

async function call(args: Args): Promise<number> {
  const [tool, raw] = args.positionals;
  if (tool === undefined) {
    log.error("usage: ogsync call <tool> '<json-args>'");
    return 1;
  }
  let toolArgs: unknown = {};
  if (raw !== undefined) {
    try {
      toolArgs = JSON.parse(raw);
    } catch {
      log.error(`tool args are not valid JSON: ${raw}`);
      return 1;
    }
  }
  const cwd = process.cwd();
  const daemon = await ensureDaemon({ port: portFlag(args) });
  const client = new DaemonClient(daemon.port, ensureToken(), clientIdentity(args, `cli:${basename(cwd)}`));
  let result: CallToolResult;
  try {
    result = (await client.callTool(tool, toolArgs, forwardTimeout(toolArgs))) as CallToolResult;
  } catch (err) {
    result = { content: [{ type: "text", text: errLine(err) }] };
  }
  out(JSON.stringify(result));
  const failed = result.content.some((part) => part.type === "text" && part.text.startsWith("ERR "));
  return failed ? 1 : 0;
}

/** Caller identity: leases and fair queueing key on `id`, ogsync.toml comes from `cwd`. */
function clientIdentity(args: Args, fallback: string): RpcCaller {
  const cwd = process.cwd();
  const flagged = args.flags.get("as");
  const id = typeof flagged === "string" ? flagged : (process.env["OGSYNC_CLIENT"] ?? fallback);
  return { id, cwd, label: basename(cwd) };
}

function keepAttached(client: DaemonClient, cwd: string, holdOpen: boolean): void {
  const attach = (): void => {
    client.attach(cwd).catch((err: unknown) => log.debug("attach failed:", err));
  };
  attach();
  const timer = setInterval(attach, ATTACH_INTERVAL_MS);
  // Under MCP the session lives as long as stdin; --no-mcp lives for this loop.
  if (!holdOpen) timer.unref?.();
}

function forwardTimeout(toolArgs: unknown): number {
  const record = typeof toolArgs === "object" && toolArgs !== null ? (toolArgs as Record<string, unknown>) : {};
  const own = [record["timeoutMs"], record["timeout_ms"]].find((value): value is number => typeof value === "number");
  return (own ?? DEFAULT_FORWARD_MS) + FORWARD_SLACK_MS;
}

function init(): number {
  const dir = process.cwd();
  const projectName = basename(dir) === "" ? "game" : basename(dir);
  const created: string[] = [];
  const kept: string[] = [];

  writeIfMissing(join(dir, CONFIG_FILE), defaultConfigToml(projectName), created, kept);
  writeIfMissing(join(dir, PROJECT_FILE), defaultProjectJson(projectName), created, kept);
  for (const relative of SOURCE_DIRS) {
    const target = join(dir, relative);
    if (existsSync(target)) kept.push(relative);
    else {
      mkdirSync(target, { recursive: true });
      created.push(relative);
    }
  }

  if (created.length > 0) log.info(`created: ${created.join(", ")}`);
  if (kept.length > 0) log.info(`kept existing: ${kept.join(", ")}`);
  log.info("run `ogsync serve` and open the place in Studio");
  return 0;
}

async function update(): Promise<number> {
  removeStaleBackup();
  const outcome = await checkForUpdate({ force: true });
  reportOutcome(outcome);
  return outcome.status === "available" || outcome.status === "inconclusive" ? 1 : 0;
}

async function managePlugin(args: Args): Promise<number> {
  const action = args.positionals[0] ?? "install";
  if (action === "uninstall" || action === "remove") {
    return uninstallPlugin().status === "failed" ? 1 : 0;
  }
  if (action !== "install") {
    log.error(`unknown plugin action "${action}"; expected install or uninstall`);
    return 1;
  }
  const outcome = await installPlugin(await getPluginBytes());
  if (!("file" in outcome)) return 1;
  log.info(`plugin ${outcome.status}: ${outcome.file}`);
  return 0;
}

async function status(args: Args): Promise<number> {
  const json = flag(args, "json");
  const running = await findDaemon();
  if (!running) {
    if (json) out(JSON.stringify({ daemon: null, places: [] }));
    else log.error("no ogsync daemon running; `ogsync serve` or `ogsync daemon start` starts one");
    return 1;
  }
  const res = await localRequest(running.port, "GET", "/state", { timeoutMs: 2_000 });
  if (res.status !== 200) {
    log.error(`daemon on :${running.port} answered /state with HTTP ${res.status}`);
    return 1;
  }
  const state = res.body as StateResponse;
  out(json ? JSON.stringify(state) : formatState(state));
  return 0;
}

async function doctor(args: Args): Promise<number> {
  const checks = await runDoctor(process.cwd(), portFlag(args) ?? undefined);
  out(formatChecks(checks));
  return checks.some((c) => c.level === "fail") ? 1 : 0;
}

/**
 * Human-facing CLI output for non-serve commands. Under `serve`, stdout is
 * the MCP JSON-RPC channel and everything routes through log (stderr).
 */
function out(line: string): void {
  process.stdout.write(line + "\n");
}

async function installStudioPlugin(): Promise<void> {
  try {
    await installPlugin(await getPluginBytes());
  } catch (err) {
    log.warn("plugin install failed:", err);
  }
}

function writeIfMissing(file: string, contents: string, created: string[], kept: string[]): void {
  const label = basename(file);
  if (existsSync(file)) {
    kept.push(label);
    return;
  }
  writeFileSync(file, contents);
  created.push(label);
}

function defaultProjectJson(projectName: string): string {
  const project = {
    name: projectName,
    tree: {
      $className: "DataModel",
      ServerScriptService: { $className: "ServerScriptService", $path: "src/server" },
      ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src/shared" },
      StarterPlayer: {
        $className: "StarterPlayer",
        StarterPlayerScripts: { $className: "StarterPlayerScripts", $path: "src/client" },
      },
    },
  };
  return `${JSON.stringify(project, null, 2)}\n`;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    const [name, inline] = splitFlag(token);
    if (inline !== null) {
      flags.set(name, inline);
      continue;
    }
    const next = argv[i + 1];
    if (VALUE_FLAGS.has(name) && next !== undefined && !next.startsWith("-")) {
      flags.set(name, next);
      i += 1;
      continue;
    }
    flags.set(name, true);
  }
  return { command: positionals.shift() ?? "", positionals, flags };
}

function splitFlag(token: string): [string, string | null] {
  const bare = token.replace(/^-+/, "");
  const eq = bare.indexOf("=");
  return eq === -1 ? [bare, null] : [bare.slice(0, eq), bare.slice(eq + 1)];
}

function flag(args: Args, ...names: string[]): boolean {
  return names.some((name) => {
    const value = args.flags.get(name);
    return value === true || value === "true";
  });
}

function portFlag(args: Args): number | null {
  for (const name of ["port", "p"]) {
    const raw = args.flags.get(name);
    if (typeof raw !== "string") continue;
    const port = Number(raw);
    if (Number.isInteger(port) && port >= 0 && port <= 65535) return port;
    log.warn(`ignoring invalid --${name} ${raw}`);
  }
  return null;
}

const exitCode = await main().catch((err: unknown) => {
  log.error(err);
  return 1;
});
// A successful `serve` must keep running, so only failures exit explicitly.
if (exitCode !== 0) process.exit(exitCode);
