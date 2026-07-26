// `ogsync doctor` — answers "why is nothing connected?" without making the user
// read logs. Every check reports what it found, and a failing one says the next
// action rather than just the symptom.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, loadConfig } from "./config.ts";
import { detectExistingDaemon } from "./hub/proxy.ts";
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
  const usePort = port ?? config.daemon.port;

  checks.push(projectCheck(dir, config.project.file));
  checks.push(...pluginChecks());

  const daemon = await detectExistingDaemon(usePort);
  if (daemon === null) {
    checks.push({
      level: "fail",
      title: "daemon",
      detail: `nothing answering on 127.0.0.1:${usePort}`,
      fix: "run `ogsync serve` in this directory",
    });
    return checks;
  }

  checks.push({
    level: daemon.health.version === VERSION ? "ok" : "warn",
    title: "daemon",
    detail: `ogsync ${daemon.health.version} on :${usePort}, proto ${daemon.health.proto}`,
    ...(daemon.health.version === VERSION ? {} : { fix: `this CLI is ${VERSION}; restart the daemon after updating` }),
  });

  const sessions = daemon.health.sessions;
  const target = config.bind.target_place;
  if (sessions.length === 0) {
    checks.push({
      level: "fail",
      title: "studio",
      detail: "no Studio session has handshaken",
      fix: `open the place in Studio and enable the OGSync plugin (Plugins tab). Studio only scans ${PLUGIN_FILE} at startup, so restart Studio if you just installed it.`,
    });
  } else if (daemon.health.bound === null) {
    const names = sessions.map((s) => s.placeName).join(", ");
    checks.push({
      level: "fail",
      title: "binding",
      detail: `${sessions.length} session(s) connected (${names}) but none matches target_place ${String(target)}`,
      fix: `set bind.target_place in ${CONFIG_FILE} to one of: ${names}`,
    });
  } else {
    const bound = sessions.find((s) => s.session === daemon.health.bound);
    checks.push({
      level: "ok",
      title: "binding",
      detail: `bound to ${bound?.placeName ?? "?"} (${bound?.role ?? "?"}), ${sessions.length} session(s) connected`,
    });
    const stale = sessions.filter((s) => s.pluginVersion !== daemon.health.version);
    if (stale.length > 0) {
      checks.push({
        level: "warn",
        title: "plugin version",
        detail: `Studio is running plugin ${stale.map((s) => s.pluginVersion).join(", ")}, daemon is ${daemon.health.version}`,
        fix: "run `ogsync plugin install`, then restart Studio",
      });
    }
  }

  const sync = daemon.health.sync;
  checks.push({
    level: sync.conflicts > 0 ? "warn" : "ok",
    title: "sync",
    detail: sync.enabled
      ? `enabled, ${sync.pending} pending, ${sync.conflicts} conflict(s)`
      : "disabled in " + CONFIG_FILE,
    ...(sync.conflicts > 0 ? { fix: "inspect with the `sync` tool (op=conflicts) or the plugin panel" } : {}),
  });

  return checks;
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
