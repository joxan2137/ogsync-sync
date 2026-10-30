// Per-project state inside the machine-wide daemon. Each client sends its
// working directory; that directory's ogsync.toml decides the default target,
// aliases and playtest limits, and one sync engine per directory runs while at
// least one client keeps attaching. Two sessions in one project share the
// engine instead of each writing every file twice.

import { statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Bridge, OgsyncConfig, SyncControl } from "../proto/types.ts";
import { CONFIG_FILE, loadConfig } from "../config.ts";
import { log } from "../log.ts";
import { runAs, type Caller } from "../hub/caller.ts";
import type { Hub } from "../hub/hub.ts";
import { parseTarget } from "../hub/targets.ts";

/** Clients re-attach every ATTACH_INTERVAL_MS; an engine without one for this long stops. */
export const ATTACH_TTL_MS = 45_000;
export const ATTACH_INTERVAL_MS = 15_000;

interface Project {
  dir: string;
  config: OgsyncConfig;
  engine: (SyncControl & { stop(): Promise<void> }) | null;
  starting: Promise<void> | null;
  clients: Map<string, number>;
}

export class Projects {
  readonly #hub: Hub;
  readonly #configs = new Map<string, { stamp: number; config: OgsyncConfig }>();
  readonly #projects = new Map<string, Project>();

  constructor(hub: Hub) {
    this.#hub = hub;
  }

  configFor(dir: string): OgsyncConfig {
    const key = dirKey(dir);
    const stamp = configStamp(dir);
    const cached = this.#configs.get(key);
    if (cached && cached.stamp === stamp) return cached.config;
    const config = loadConfig(dir);
    this.#configs.set(key, { stamp, config });
    return config;
  }

  /** The target-scoped bridge a project's default target resolves through. */
  bridgeFor(dir: string, target?: string | number | null): Bridge {
    const config = this.configFor(dir);
    return this.#hub.target(parseTarget(target ?? config.bind.target_place), config.aliases);
  }

  syncFor(dir: string): SyncControl | null {
    return this.#projects.get(dirKey(dir))?.engine ?? null;
  }

  attach(client: string, dir: string): { project: string; sync: boolean } {
    const key = dirKey(dir);
    let project = this.#projects.get(key);
    if (!project) {
      project = { dir: resolve(dir), config: this.configFor(dir), engine: null, starting: null, clients: new Map() };
      this.#projects.set(key, project);
      project.starting = this.#startEngine(project);
    }
    project.clients.set(client, Date.now());
    return { project: project.config.project.name, sync: project.config.sync.enabled };
  }

  /** Name and sync flag for the plugin panel of whichever project targets this place. */
  projectInfo(placeKey: string): { name: string; syncEnabled: boolean } | null {
    for (const project of this.#projects.values()) {
      const bridge = this.bridgeFor(project.dir);
      if (bridge.place?.()?.key === placeKey) {
        return { name: project.config.project.name, syncEnabled: project.engine !== null };
      }
    }
    return null;
  }

  async sweep(now = Date.now()): Promise<void> {
    for (const [key, project] of [...this.#projects]) {
      for (const [client, at] of project.clients) if (now - at > ATTACH_TTL_MS) project.clients.delete(client);
      if (project.clients.size > 0) continue;
      this.#projects.delete(key);
      await project.starting;
      await project.engine?.stop().catch((err: unknown) => log.warn(`sync stop for ${project.dir} failed:`, err));
      log.info(`sync for ${project.dir} stopped: no session attached`);
    }
  }

  async stopAll(): Promise<void> {
    for (const project of this.#projects.values()) project.clients.clear();
    await this.sweep();
  }

  async #startEngine(project: Project): Promise<void> {
    if (!project.config.sync.enabled) return;
    try {
      const { SyncEngine } = await import("../sync/engine.ts");
      const caller: Caller = { id: `sync:${basename(project.dir)}`, playtest: project.config.playtest };
      const engine = new SyncEngine(asCaller(this.bridgeFor(project.dir), caller), project.config, project.dir);
      await engine.start();
      project.engine = engine;
      log.info(`sync for ${project.dir} started`);
    } catch (err) {
      log.warn(`sync engine for ${project.dir} unavailable:`, err);
    }
  }
}

/** Calls made by the engine's timers run as the engine, for fair queueing. */
function asCaller(bridge: Bridge, caller: Caller): Bridge {
  return {
    call: (op, args, opts) => runAs(caller, () => bridge.call(op, args, opts)),
    bound: () => bridge.bound(),
    sessions: () => bridge.sessions(),
    onEvent: (fn) => bridge.onEvent(fn),
    place: () => bridge.place?.() ?? null,
  };
}

function dirKey(dir: string): string {
  const full = resolve(dir);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

function configStamp(dir: string): number {
  try {
    return statSync(join(dir, CONFIG_FILE)).mtimeMs;
  } catch {
    return -1;
  }
}
