// Writes the embedded Studio plugin into the local Roblox plugins directory.
// Every failure path is non-fatal: the daemon still serves without a plugin
// install (the user can drop OGSync.rbxm in by hand).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../log.ts";

export const PLUGIN_FILE = "OGSync.rbxm";

export type InstallOutcome =
  | { status: "installed" | "updated" | "current" | "removed"; file: string }
  | { status: "skipped" | "failed"; reason: string };

/** null when the platform has no known plugins dir and OGSYNC_PLUGINS_DIR is unset. */
export function resolvePluginsDir(): string | null {
  const override = process.env["OGSYNC_PLUGINS_DIR"]?.trim();
  if (override !== undefined && override !== "") return override;

  if (process.platform === "win32") {
    const localAppData = process.env["LOCALAPPDATA"]?.trim();
    const base = localAppData !== undefined && localAppData !== "" ? localAppData : join(homedir(), "AppData", "Local");
    return join(base, "Roblox", "Plugins");
  }
  if (process.platform === "darwin") {
    const candidates = [
      join(homedir(), "Documents", "Roblox", "Plugins"),
      join(homedir(), "Library", "Application Support", "Roblox", "Plugins"),
    ];
    return candidates.find((dir) => existsSync(dir)) ?? candidates[0]!;
  }
  return null;
}

export async function installPlugin(rbxmBytes: Uint8Array | null): Promise<InstallOutcome> {
  if (!rbxmBytes || rbxmBytes.length === 0) {
    return skip("no plugin embedded in this build");
  }
  const dir = resolvePluginsDir();
  if (dir === null) {
    return skip(`no Roblox plugins dir on ${process.platform}; set OGSYNC_PLUGINS_DIR to auto-install the plugin`);
  }
  const file = join(dir, PLUGIN_FILE);
  try {
    const existed = existsSync(file);
    if (existed && sameBytes(file, rbxmBytes)) {
      log.debug(`plugin up to date at ${file}`);
      return { status: "current", file };
    }
    mkdirSync(dir, { recursive: true });
    // Studio watches this directory; a torn read would load a broken plugin.
    // Write beside the target, then rename atomically.
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, rbxmBytes);
    try {
      renameSync(tmp, file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    log.info(`${existed ? "updated" : "installed"} Studio plugin at ${file}`);
    return { status: existed ? "updated" : "installed", file };
  } catch (err) {
    const reason = `cannot write ${file}: ${err instanceof Error ? err.message : String(err)}`;
    log.warn(reason);
    return { status: "failed", reason };
  }
}

export function uninstallPlugin(): InstallOutcome {
  const dir = resolvePluginsDir();
  if (dir === null) return skip(`no Roblox plugins dir on ${process.platform}`);
  const file = join(dir, PLUGIN_FILE);
  if (!existsSync(file)) return skip(`${file} is not installed`);
  try {
    rmSync(file);
    log.info(`removed ${file}`);
    return { status: "removed", file };
  } catch (err) {
    const reason = `cannot remove ${file}: ${err instanceof Error ? err.message : String(err)}`;
    log.warn(reason);
    return { status: "failed", reason };
  }
}

function sameBytes(file: string, bytes: Uint8Array): boolean {
  try {
    const existing = readFileSync(file);
    return existing.length === bytes.length && Buffer.compare(existing, Buffer.from(bytes)) === 0;
  } catch {
    return false;
  }
}

function skip(reason: string): InstallOutcome {
  log.info(`plugin install skipped: ${reason}`);
  return { status: "skipped", reason };
}
