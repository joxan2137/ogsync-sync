#!/usr/bin/env bun
// ogsync CLI. Hand-rolled arg parsing (no dependencies) over five commands:
// serve (default), init, update, plugin, status, version.
//
// The MCP and sync layers load lazily so a failure in either degrades the
// daemon (warning) instead of killing startup. The specifiers stay literal:
// `bun build --compile` only bundles modules it can see statically.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Bridge, OgsyncConfig, SyncControl } from "./proto/types.ts";
import { CONFIG_FILE, defaultConfigToml, loadConfig } from "./config.ts";
import { formatChecks, runDoctor } from "./doctor.ts";
import { log } from "./log.ts";
import { Hub, ensureToken, type HealthResponse, type RpcHandler } from "./hub/hub.ts";
import { RemoteBridge, detectExistingDaemon } from "./hub/proxy.ts";
import { getPluginBytes } from "./update/plugin-blob.ts";
import { installPlugin, uninstallPlugin } from "./update/plugin-installer.ts";
import { checkForUpdate, removeStaleBackup, reportOutcome, scheduleAutoUpdates } from "./update/updater.ts";
import { VERSION } from "./version.ts";

const PROJECT_FILE = "default.project.json";
const SOURCE_DIRS = ["src/server", "src/client", "src/shared"];
const VALUE_FLAGS = new Set(["port", "p"]);

const HELP = `ogsync ${VERSION} — MCP server, live sync and Studio plugin for Roblox

usage: ogsync <command> [options]

commands:
  serve                    run the daemon: MCP over stdio + Studio bridge + sync (default)
      --no-mcp             bridge and sync only, leave stdio alone
      --port <n>           hub port (default from ogsync.toml, OGSYNC_PORT, else 3667)
  init                     scaffold ${CONFIG_FILE}, ${PROJECT_FILE} and src/ in this directory
  update                   check GitHub Releases now and install a newer build
  plugin [install|uninstall]
                           write or remove the Studio plugin file
  status [--port <n>]      query the local daemon's /health
  doctor [--port <n>]      diagnose the project, plugin, daemon and Studio binding
  version                  print the version

env: OGSYNC_PORT, OGSYNC_LOG=debug, OGSYNC_PLUGINS_DIR, GITHUB_TOKEN`;

interface Args {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

async function main(): Promise<number> {
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
  const port = portFlag(args) ?? config.daemon.port;
  const withMcp = !flag(args, "no-mcp");
  removeStaleBackup();

  const existing = await detectExistingDaemon(port);
  let hub: Hub | null = null;
  let bridge: Bridge;
  if (existing) {
    if (!withMcp) {
      log.error(`ogsync ${existing.version} already owns :${port}; --no-mcp leaves this instance nothing to do`);
      return 1;
    }
    log.info(`ogsync ${existing.version} already serving on :${port} — forwarding ops to it over /rpc`);
    bridge = new RemoteBridge(port, ensureToken());
  } else {
    hub = new Hub({ config, version: VERSION, port });
    hub.listen();
    bridge = hub;
  }

  await installStudioPlugin();

  // Only the port owner runs sync; a proxy instance would duplicate every write.
  let sync: SyncControl | null = null;
  if (hub) {
    sync = await startSyncEngine(bridge, config, cwd);
    hub.setSyncControl(sync);
  }
  if (withMcp) await startMcpLayer(bridge, hub, sync);
  if (hub) scheduleAutoUpdates(config);
  else log.debug("proxy mode: the owning daemon handles updates");

  return 0;
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
  const port = portFlag(args) ?? loadConfig(process.cwd()).daemon.port;
  const daemon = await detectExistingDaemon(port);
  if (!daemon) {
    log.error(`no ogsync daemon answering on 127.0.0.1:${port} — start one with \`ogsync serve\``);
    return 1;
  }
  printHealth(daemon.health, port);
  return 0;
}

async function doctor(args: Args): Promise<number> {
  const checks = await runDoctor(process.cwd(), portFlag(args) ?? undefined);
  out(formatChecks(checks));
  return checks.some((c) => c.level === "fail") ? 1 : 0;
}

function printHealth(health: HealthResponse, port: number): void {
  out(`ogsync ${health.version} on 127.0.0.1:${port} (proto ${health.proto})`);
  out(
    `sync: ${health.sync.enabled ? "enabled" : "disabled"} pending=${health.sync.pending} conflicts=${health.sync.conflicts}`,
  );
  if (health.sessions.length === 0) {
    out("sessions: none — open the place in Studio with the OGSync plugin enabled");
    return;
  }
  out("sessions: (* = bound)");
  for (const session of health.sessions) {
    const marker = session.session === health.bound ? "*" : " ";
    out(
      `  ${marker} ${session.session.slice(0, 8)} ${session.role.padEnd(6)} ${session.placeName} last seen ${session.age}s ago`,
    );
  }
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

async function startSyncEngine(bridge: Bridge, config: OgsyncConfig, cwd: string): Promise<SyncControl | null> {
  if (!config.sync.enabled) {
    log.info(`sync disabled in ${CONFIG_FILE}`);
    return null;
  }
  try {
    const { SyncEngine } = await import("./sync/engine.ts");
    const engine = new SyncEngine(bridge, config, cwd);
    await engine.start();
    return engine;
  } catch (err) {
    log.warn("sync engine unavailable:", err);
    return null;
  }
}

async function startMcpLayer(bridge: Bridge, hub: Hub | null, sync: SyncControl | null): Promise<void> {
  try {
    const { startMcp } = await import("./mcp/server.ts");
    const started: unknown = await startMcp(bridge, { sync, version: VERSION });
    const callTool = asRpcHandler(started);
    if (hub && callTool) hub.setRpcHandler(callTool);
  } catch (err) {
    log.warn("mcp server unavailable:", err);
  }
}

/** POST /rpc {tool} only works once startMcp hands back a tool executor. */
function asRpcHandler(started: unknown): RpcHandler | null {
  if (typeof started !== "object" || started === null) return null;
  const callTool = (started as { callTool?: unknown }).callTool;
  return typeof callTool === "function" ? (callTool as RpcHandler) : null;
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
