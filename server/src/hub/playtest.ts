// Playtest state per place, driven by what the plugin reports rather than
// inferred from which peers happen to be registered: the edit peer pushes its
// RunService/StudioTestService view on change and every heartbeat, the
// play-server peer's presence and player count arrive with it. Stale
// heartbeats read "unknown" so consumers (hooks, agents) can fail closed.
//
// Leases: a start records the calling client as owner. Stop by anyone else, or
// of a playtest no agent started, needs force.

import type { PlaytestInfo, PlaytestPhase, PlaytestReport, StaleCode } from "../proto/types.ts";
import { describeCaller } from "./caller.ts";

export const PLAYTEST_STALE_MS = 15_000;
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 30_000;
const STALE_SAMPLE = 5;

export interface LeaseLimits {
  maxClients: number;
  /** 0 disables auto-end. */
  autoEndMs: number;
  pluginGraceMs: number;
}

export interface TrackerOptions {
  now?: () => number;
  staleMs?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
}

export type StartAdmission = { kind: "proceed" } | { kind: "already" } | { kind: "refused"; reason: string };
export type StopAdmission = { kind: "proceed" } | { kind: "idle" } | { kind: "refused"; reason: string };

interface Lease {
  owner: string;
  label?: string;
  mode: string;
  limits: LeaseLimits;
  /** Set once the playtest is confirmed running. */
  runningAt: number | null;
}

const DEFAULT_LIMITS: LeaseLimits = { maxClients: 2, autoEndMs: 0, pluginGraceMs: 10_000 };

export class PlaytestTracker {
  readonly #now: () => number;
  readonly #staleMs: number;
  readonly #startTimeoutMs: number;
  readonly #stopTimeoutMs: number;
  #edit: { state: PlaytestReport; mode: string | null } | null = null;
  #players = 0;
  #serverPresent = false;
  #heartbeat: number | null = null;
  #lease: Lease | null = null;
  /** play.start admitted but still queued: "starting", with no timeout of its own (the call has one). */
  #startQueued = false;
  /** Set when play.start reaches the plugin; the start timeout counts from here. */
  #startingAt: number | null = null;
  /** The plugin answered that this start launched the test (not `already`). */
  #startConfirmed = false;
  #stoppingAt: number | null = null;
  #startedBy: "agent" | "user" | null = null;
  #phase: PlaytestPhase = "unknown";
  #since: number;
  #runningSince: number | null = null;
  #stale: StaleCode | null = null;
  #warning: string | null = null;

  constructor(opts: TrackerOptions = {}) {
    this.#now = opts.now ?? Date.now;
    this.#staleMs = opts.staleMs ?? PLAYTEST_STALE_MS;
    this.#startTimeoutMs = opts.startTimeoutMs ?? START_TIMEOUT_MS;
    this.#stopTimeoutMs = opts.stopTimeoutMs ?? STOP_TIMEOUT_MS;
    this.#since = this.#now();
  }

  report(from: "edit" | "server", state: PlaytestReport, mode?: string, players?: number): void {
    this.#heartbeat = this.#now();
    if (from === "edit") this.#edit = { state, mode: mode ?? null };
    else if (typeof players === "number") this.#players = players;
    this.#refresh();
  }

  serverPeer(present: boolean): void {
    this.#serverPresent = present;
    if (!present) this.#players = 0;
    this.#refresh();
  }

  setStale(stale: StaleCode | null): void {
    this.#stale = stale;
  }

  admitStart(caller: { id: string }): StartAdmission {
    const phase = this.#refresh();
    if (phase === "idle") return { kind: "proceed" };
    if (phase === "unknown") {
      return { kind: "refused", reason: `playtest state is unknown (${this.#heartbeatText()}); cannot start safely` };
    }
    if (phase === "stopping") {
      return { kind: "refused", reason: "the previous playtest is still stopping; wait for=playtest state=idle" };
    }
    if (this.#lease?.owner === caller.id) return { kind: "already" };
    return { kind: "refused", reason: `a playtest is already ${phase}: ${this.#ownerText()}` };
  }

  beginStart(caller: { id: string; label?: string }, mode: string, limits: LeaseLimits): void {
    this.#lease = { owner: caller.id, label: caller.label, mode, limits, runningAt: null };
    this.#startQueued = true;
    this.#startingAt = null;
    this.#startConfirmed = false;
    this.#warning = null;
    this.#refresh();
  }

  startDelivered(): void {
    if (!this.#startQueued) return;
    this.#startQueued = false;
    this.#startingAt = this.#now();
    this.#refresh();
  }

  /** The plugin says this start launched the test: the agent gets the credit. */
  startSucceeded(): void {
    this.#startConfirmed = true;
    if (this.#refresh() === "running") this.#creditAgent(this.#now());
  }

  /** Failed, cancelled, or the plugin found a test already running: no lease. */
  startFailed(): void {
    this.#lease = null;
    this.#startQueued = false;
    this.#startingAt = null;
    this.#startConfirmed = false;
    if (this.#refresh() === "running" && this.#startedBy === null) this.#startedBy = "user";
  }

  admitStop(caller: { id: string }, force: boolean): StopAdmission {
    const phase = this.#refresh();
    if (phase === "idle") return { kind: "idle" };
    if (force) return { kind: "proceed" };
    if (phase === "unknown") {
      return { kind: "refused", reason: `playtest state is unknown (${this.#heartbeatText()}); pass force=true to stop anyway` };
    }
    if (this.#lease === null) {
      return { kind: "refused", reason: "this playtest was started in Studio, not by an agent; pass force=true to stop it anyway" };
    }
    if (this.#lease.owner !== caller.id) {
      return { kind: "refused", reason: `${this.#ownerText()}; pass force=true to stop it anyway` };
    }
    return { kind: "proceed" };
  }

  beginStop(): void {
    this.#stoppingAt = this.#now();
    this.#refresh();
  }

  stopFailed(): void {
    this.#stoppingAt = null;
    this.#refresh();
  }

  /** Why the daemon should stop this playtest on its own, or null. */
  due(): string | null {
    const phase = this.#refresh();
    const lease = this.#lease;
    if (phase !== "running" || lease === null || this.#stoppingAt !== null) return null;
    const ranFor = lease.runningAt === null ? 0 : this.#now() - lease.runningAt;
    if (lease.limits.autoEndMs > 0 && ranFor >= lease.limits.autoEndMs) {
      return `auto-ended after ${Math.round(lease.limits.autoEndMs / 1000)}s (playtest.auto_end_s)`;
    }
    if (this.#players > lease.limits.maxClients) {
      return `stopped: ${this.#players} clients exceed playtest.max_clients=${lease.limits.maxClients}`;
    }
    return null;
  }

  warn(message: string): void {
    this.#warning = message;
  }

  snapshot(): PlaytestInfo {
    const phase = this.#refresh();
    const idle = phase === "idle";
    return {
      state: phase,
      mode: idle ? null : (this.#lease?.mode ?? this.#edit?.mode ?? (this.#serverPresent ? "play" : null)),
      owner: this.#lease?.owner ?? null,
      startedBy: this.#startedBy,
      since: this.#since,
      heartbeatAgeMs: this.#heartbeat === null ? null : this.#now() - this.#heartbeat,
      players: this.#players,
      stale: this.#stale,
      warning: this.#warning ?? this.#pluginWarning(phase),
    };
  }

  #refresh(): PlaytestPhase {
    const now = this.#now();
    this.#expireIntents(now);
    const phase = this.#derive(now);
    if (phase !== this.#phase) {
      this.#phase = phase;
      this.#since = now;
      if (phase === "running") this.#enterRunning(now);
      if (phase === "idle") this.#enterIdle();
    }
    return phase;
  }

  #isRunning(): boolean {
    return this.#serverPresent || this.#edit?.state === "running";
  }

  #expireIntents(now: number): void {
    const running = this.#isRunning();
    if (this.#stoppingAt !== null && now - this.#stoppingAt >= this.#stopTimeoutMs) {
      this.#stoppingAt = null;
      if (running) this.#warning = `stop requested ${Math.round(this.#stopTimeoutMs / 1000)}s ago but the playtest is still running`;
    }
    if (this.#startingAt !== null && !running && now - this.#startingAt >= this.#startTimeoutMs) {
      this.#startingAt = null;
      this.#lease = null;
      this.#warning = `start requested ${Math.round(this.#startTimeoutMs / 1000)}s ago but no running playtest was reported`;
    }
  }

  #derive(now: number): PlaytestPhase {
    if (this.#heartbeat === null || now - this.#heartbeat > this.#staleMs) return "unknown";
    const editState = this.#edit?.state;
    const running = this.#isRunning();
    if (this.#stoppingAt !== null && (running || editState === "stopping")) return "stopping";
    if (running) return "running";
    if (editState === "starting" || this.#startingAt !== null || this.#startQueued) return "starting";
    if (editState === "stopping") return "stopping";
    return "idle";
  }

  #enterRunning(now: number): void {
    this.#runningSince = now;
    if (this.#lease === null) this.#startedBy = "user";
    else if (this.#startConfirmed) this.#creditAgent(now);
    // Otherwise the start's own result decides: startSucceeded or startFailed.
    this.#startingAt = null;
  }

  #creditAgent(now: number): void {
    this.#startedBy = "agent";
    if (this.#lease !== null) this.#lease.runningAt ??= now;
  }

  #enterIdle(): void {
    const warning = this.#warning;
    this.#lease = null;
    this.#startedBy = null;
    this.#startQueued = false;
    this.#startingAt = null;
    this.#startConfirmed = false;
    this.#stoppingAt = null;
    this.#runningSince = null;
    this.#stale = null;
    this.#players = 0;
    // A start that never came up explains itself until the next start.
    this.#warning = warning !== null && warning.startsWith("start requested") ? warning : null;
  }

  #pluginWarning(phase: PlaytestPhase): string | null {
    if (phase !== "running" || this.#serverPresent || this.#edit?.mode !== "play" || this.#runningSince === null) {
      return null;
    }
    const graceMs = (this.#lease?.limits ?? DEFAULT_LIMITS).pluginGraceMs;
    if (this.#now() - this.#runningSince < graceMs) return null;
    return (
      `Studio reports a running play test but no play-server peer registered within ${Math.round(graceMs / 1000)}s: ` +
      `"Load User Plugins in Test Mode" is probably off, so server and client tools cannot reach it`
    );
  }

  #ownerText(): string {
    const lease = this.#lease;
    if (lease === null) return "started in Studio, not by an agent";
    const since = lease.runningAt ?? this.#since;
    return `owned by ${describeCaller({ id: lease.owner, label: lease.label })} for ${Math.round((this.#now() - since) / 1000)}s`;
  }

  #heartbeatText(): string {
    if (this.#heartbeat === null) return "no plugin heartbeat yet";
    return `no plugin heartbeat for ${Math.round((this.#now() - this.#heartbeat) / 1000)}s`;
  }
}

/** Edit-vs-play-server script hashes; paths only the server has are runtime clones and ignored. */
export function compareHashes(edit: Record<string, string>, server: Record<string, string>): StaleCode | null {
  const changed: string[] = [];
  const missing: string[] = [];
  for (const [path, hash] of Object.entries(edit)) {
    const other = server[path];
    if (other === undefined) missing.push(path);
    else if (other !== hash) changed.push(path);
  }
  if (changed.length === 0 && missing.length === 0) return null;
  return { changed: changed.length, missing: missing.length, sample: [...changed, ...missing].slice(0, STALE_SAMPLE) };
}
