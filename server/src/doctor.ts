// `ogsync doctor` — answers "why is nothing connected?" without making the user
// read logs. Every check reports what it found, and a failing one says the next
// action rather than just the symptom.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, loadConfig } from "./config.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errLine, type PlaceState, type StateResponse } from "./proto/types.ts";
import { DaemonClient, findDaemon, localRequest, probeDaemon, type DaemonEndpoint } from "./daemon/client.ts";
import { ensureToken, type HealthResponse } from "./hub/hub.ts";
import { parseTarget, resolvePlace } from "./hub/targets.ts";
import { PLUGIN_FILE, resolvePluginsDir } from "./update/plugin-installer.ts";
import { VERSION } from "./version.ts";

export type Level = "ok" | "warn" | "fail";

export interface Check {
  level: Level;
  title: string;
  detail: string;
  /** What to do about it; omitted when nothing is wrong. */
  fix?: string;
}

const MARK: Record<Level, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

/** Other MCP plugins that drive Studio; two of them fighting is worth flagging. */
const KNOWN_RIVALS = ["MCPPlugin.rbxmx", "MCPStudioPlugin.rbxm", "MCPInspectorPlugin.rbxmx"];

export async function runDoctor(dir: string, port?: number): Promise<Check[]> {
  const checks: Check[] = [];
  const config = loadConfig(dir);

  checks.push(projectCheck(dir, config.project.file));
  checks.push(...pluginChecks());

  const endpoint = port === undefined ? await findDaemon() : await probeAt(port);
  if (endpoint === null) {
    checks.push({
      level: "fail",
      title: "daemon",
      detail: port === undefined ? "no ogsync daemon running on this machine" : `nothing answering on 127.0.0.1:${port}`,
      fix: "start a session with `ogsync serve` (it spawns the daemon), or run `ogsync daemon start`",
    });
    return checks;
  }
  const health = await getJson<HealthResponse>(endpoint.port, "/health");
  const state = await getJson<StateResponse>(endpoint.port, "/state");
  if (health === null || state === null) {
    checks.push({
      level: "fail",
      title: "daemon",
      detail: `ogsync ${endpoint.identity.version} on :${endpoint.port} did not answer /health and /state`,
      fix: "restart it: `ogsync daemon stop`, then any `ogsync` session starts a fresh one",
    });
    return checks;
  }

  checks.push({
    level: health.version === VERSION ? "ok" : "warn",
    title: "daemon",
    detail: `ogsync ${health.version} on :${endpoint.port}, proto ${health.proto}`,
    ...(health.version === VERSION ? {} : { fix: `this CLI is ${VERSION}; run \`ogsync daemon stop\` so the next session starts the new build` }),
  });

  const places = state.places.filter((place) => place.peers.length > 0);
  const target = config.bind.target_place;
  if (places.length === 0) {
    checks.push({
      level: "fail",
      title: "studio",
      detail: "no Studio session has handshaken",
      fix: `open the place in Studio and enable the OGSync plugin (Plugins tab). Studio only scans ${PLUGIN_FILE} at startup, so restart Studio if you just installed it.`,
    });
  } else {
    checks.push(...bindingChecks(places, target, config.aliases));
    const stale = places.flatMap((place) => place.peers).filter((peer) => peer.pluginVersion !== health.version);
    if (stale.length > 0) {
      checks.push({
        level: "warn",
        title: "plugin version",
        detail: `Studio is running plugin ${[...new Set(stale.map((peer) => peer.pluginVersion))].join(", ")}, daemon is ${health.version}`,
        fix: "run `ogsync plugin install`, then restart Studio",
      });
    }
  }

  checks.push(await syncCheck(endpoint.port, dir, config.sync.enabled));
  return checks;
}

/** Sync runs per project inside the daemon, so ask it as this directory would. */
async function syncCheck(port: number, dir: string, enabled: boolean): Promise<Check> {
  if (!enabled) return { level: "ok", title: "sync", detail: `disabled in ${CONFIG_FILE}` };
  let text: string;
  try {
    const client = new DaemonClient(port, ensureToken(), { id: "doctor", cwd: dir });
    const result = (await client.callTool("sync", { op: "status" }, 5_000)) as CallToolResult;
    text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  } catch (err) {
    text = errLine(err);
  }
  const head = text.split("\n")[0] ?? "";
  const conflicts = Number(/conflicts=(\d+)/.exec(head)?.[1] ?? "0");
  if (head.startsWith("ERR") || head.includes("disabled")) {
    return {
      level: "warn",
      title: "sync",
      detail: head,
      fix: "keep an `ogsync serve` session open in this directory; it attaches the project's sync engine",
    };
  }
  return {
    level: conflicts > 0 ? "warn" : "ok",
    title: "sync",
    detail: head.replace(/^sync\t/, ""),
    ...(conflicts > 0 ? { fix: "inspect with the `sync` tool (op=conflicts) or the plugin panel" } : {}),
  };
}

function bindingChecks(
  places: PlaceState[],
  target: string | number | null,
  aliases: Record<string, string>,
): Check[] {
  let resolved: PlaceState;
  try {
    const identity = resolvePlace(parseTarget(target), places, aliases);
    resolved = places.find((place) => place.key === identity.key)!;
  } catch (err) {
    const keys = places.map((place) => `${place.key} (${place.name})`).join(", ");
    return [
      {
        level: "fail",
        title: "binding",
        detail: err instanceof Error ? err.message : String(err),
        fix: `set bind.target_place in ${CONFIG_FILE} (or pass target=) to one of: ${keys}`,
      },
    ];
  }
  const checks: Check[] = [
    {
      level: "ok",
      title: "binding",
      detail: `target ${String(target ?? "(only place)")} -> ${resolved.key} (${resolved.name}), roles ${resolved.peers.map((peer) => peer.role).join("+")}; ${places.length} place(s) connected`,
    },
  ];
  const playtest = resolved.playtest;
  const problems = [
    playtest.state === "unknown" ? "state unknown (no plugin heartbeat)" : "",
    playtest.stale ? `${playtest.stale.changed + playtest.stale.missing} stale script(s) in the running test` : "",
    playtest.warning ?? "",
  ].filter(Boolean);
  if (problems.length > 0) {
    checks.push({
      level: "warn",
      title: "playtest",
      detail: problems.join("; "),
      fix: "see `ogsync status`; restart the playtest to load current scripts",
    });
  }
  return checks;
}

async function probeAt(port: number): Promise<DaemonEndpoint | null> {
  const identity = await probeDaemon(port);
  return identity === null ? null : { port, identity };
}

async function getJson<T>(port: number, path: string): Promise<T | null> {
  try {
    const res = await localRequest(port, "GET", path, { timeoutMs: 2_000 });
    return res.status === 200 ? (res.body as T) : null;
  } catch {
    return null;
  }
}

function projectCheck(dir: string, file: string): Check {
  const path = join(dir, file);
  if (!existsSync(path)) {
    return {
      level: "warn",
      title: "project",
      detail: `${file} not found in ${dir}`,
      fix: "run `ogsync init` here, or serve from the directory holding your project file",
    };
  }
  return { level: "ok", title: "project", detail: `${file} found` };
}

function pluginChecks(): Check[] {
  const dir = resolvePluginsDir();
  if (dir === null) {
    return [
      {
        level: "warn",
        title: "plugin",
        detail: `no Roblox plugins directory on ${process.platform}`,
        fix: "set OGSYNC_PLUGINS_DIR to your Studio plugins folder",
      },
    ];
  }
  const file = join(dir, PLUGIN_FILE);
  if (!existsSync(file)) {
    return [
      {
        level: "fail",
        title: "plugin",
        detail: `${PLUGIN_FILE} is not installed in ${dir}`,
        fix: "run `ogsync plugin install`, then restart Studio",
      },
    ];
  }
  // The rbxm's own version string is LZ4-compressed inside the model, so the
  // installed build identifies itself through the handshake instead (below).
  const checks: Check[] = [
    { level: "ok", title: "plugin", detail: `${PLUGIN_FILE} installed (${sizeOf(file)})` },
  ];
  const rivals = readdirSync(dir).filter((name) => KNOWN_RIVALS.includes(name));
  if (rivals.length > 0) {
    checks.push({
      level: "warn",
      title: "plugin",
      detail: `other MCP plugins also loaded: ${rivals.join(", ")}`,
      fix: "they drive Studio independently; remove them if tool calls behave unpredictably",
    });
  }
  return checks;
}

function sizeOf(file: string): string {
  try {
    return `${Math.round(statSync(file).size / 1024)} KB`;
  } catch {
    return "unreadable";
  }
}

export function formatChecks(checks: Check[]): string {
  const out: string[] = [];
  for (const c of checks) {
    out.push(`[${MARK[c.level]}] ${c.title}: ${c.detail}`);
    if (c.fix !== undefined) out.push(`         → ${c.fix}`);
  }
  const failed = checks.filter((c) => c.level === "fail").length;
  const warned = checks.filter((c) => c.level === "warn").length;
  out.push(
    failed === 0 && warned === 0
      ? "\neverything checks out"
      : `\n${failed} failing, ${warned} warning(s)`,
  );
  return out.join("\n");
}
