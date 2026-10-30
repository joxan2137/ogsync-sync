import { describe, expect, test } from "bun:test";
import { PlaytestTracker, compareHashes, type LeaseLimits } from "./playtest.ts";

const LIMITS: LeaseLimits = { maxClients: 2, autoEndMs: 60_000, pluginGraceMs: 5_000 };
const A = { id: "agent-a", label: "proj" };
const B = { id: "agent-b" };

function tracker() {
  const clock = { now: 10_000 };
  const t = new PlaytestTracker({ now: () => clock.now, staleMs: 15_000, startTimeoutMs: 30_000, stopTimeoutMs: 30_000 });
  return { t, clock };
}

describe("playtest state machine", () => {
  test("is unknown until the first heartbeat and again when heartbeats stop", () => {
    const { t, clock } = tracker();
    expect(t.snapshot().state).toBe("unknown");
    t.report("edit", "idle");
    expect(t.snapshot().state).toBe("idle");
    clock.now += 16_000;
    expect(t.snapshot()).toMatchObject({ state: "unknown", heartbeatAgeMs: 16_000 });
  });

  test("agent start: starting, then running once the plugin says so, then idle clears the lease", () => {
    const { t, clock } = tracker();
    t.report("edit", "idle");
    expect(t.admitStart(A)).toEqual({ kind: "proceed" });
    t.beginStart(A, "solo", LIMITS);
    expect(t.snapshot()).toMatchObject({ state: "starting", owner: "agent-a" });
    // Queued behind other ops: no start timeout runs until the op is delivered.
    clock.now += 60_000;
    t.report("edit", "idle");
    expect(t.snapshot().state).toBe("starting");
    t.startDelivered();
    clock.now += 1_000;
    t.report("edit", "running", "play");
    t.serverPeer(true);
    // Running, but not credited until the plugin says this start launched it.
    expect(t.snapshot()).toMatchObject({ state: "running", owner: "agent-a", startedBy: null });
    t.startSucceeded();
    expect(t.snapshot()).toMatchObject({ state: "running", owner: "agent-a", startedBy: "agent", mode: "solo" });
    expect(t.admitStart(A)).toEqual({ kind: "already" });
    expect(t.admitStart(B).kind).toBe("refused");
    t.beginStop();
    expect(t.snapshot().state).toBe("stopping");
    t.serverPeer(false);
    t.report("edit", "idle");
    expect(t.snapshot()).toMatchObject({ state: "idle", owner: null, startedBy: null });
  });

  test("a start that never comes up times out back to idle with a warning", () => {
    const { t, clock } = tracker();
    t.report("edit", "idle");
    t.beginStart(A, "solo", LIMITS);
    t.startDelivered();
    clock.now += 31_000;
    t.report("edit", "idle");
    expect(t.snapshot()).toMatchObject({ state: "idle", owner: null });
    expect(t.snapshot().warning).toContain("no running playtest");
  });

  test("leases: stop by a non-owner, of a user-started test, or while unknown needs force", () => {
    const { t, clock } = tracker();
    t.report("server", "running", undefined, 1);
    t.serverPeer(true);
    expect(t.snapshot()).toMatchObject({ state: "running", startedBy: "user", owner: null });
    expect(t.admitStop(A, false)).toMatchObject({ kind: "refused" });
    expect(t.admitStop(A, true)).toEqual({ kind: "proceed" });

    clock.now += 20_000;
    const unknown = t.admitStop(A, false);
    expect(unknown.kind).toBe("refused");
    expect(unknown.kind === "refused" && unknown.reason).toContain("unknown");
  });

  test("an owner stops its own playtest; idle stop is a no-op", () => {
    const { t } = tracker();
    t.report("edit", "idle");
    expect(t.admitStop(A, false)).toEqual({ kind: "idle" });
    t.beginStart(A, "server", LIMITS);
    t.startDelivered();
    t.startSucceeded();
    t.report("edit", "running", "run");
    expect(t.admitStop(A, false)).toEqual({ kind: "proceed" });
    const other = t.admitStop(B, false);
    expect(other.kind === "refused" && other.reason).toContain("agent-a (proj)");
  });

  test("due: auto-end after the lease timeout and the client cap", () => {
    const { t, clock } = tracker();
    t.report("edit", "idle");
    t.beginStart(A, "solo", LIMITS);
    t.startDelivered();
    t.startSucceeded();
    t.serverPeer(true);
    t.report("server", "running", undefined, 1);
    expect(t.due()).toBeNull();
    t.report("server", "running", undefined, 3);
    expect(t.due()).toContain("max_clients=2");
    t.report("server", "running", undefined, 1);
    clock.now += 60_000;
    t.report("server", "running", undefined, 1);
    expect(t.due()).toContain("auto-ended");
    t.beginStop();
    expect(t.due()).toBeNull();
  });

  test("a play test with no play-server peer past the grace window warns about test-mode plugins", () => {
    const { t, clock } = tracker();
    t.report("edit", "idle");
    t.beginStart(A, "solo", LIMITS);
    t.startDelivered();
    t.startSucceeded();
    t.report("edit", "running", "play");
    expect(t.snapshot().warning).toBeNull();
    clock.now += 6_000;
    t.report("edit", "running", "play");
    expect(t.snapshot().warning).toContain("Load User Plugins in Test Mode");
    t.serverPeer(true);
    expect(t.snapshot().warning).toBeNull();
  });
});

test("a start whose plugin answer is `already` credits the user, not the agent", () => {
  const { t } = tracker();
  t.report("edit", "idle");
  t.beginStart(A, "solo", LIMITS);
  t.startDelivered();
  t.report("edit", "running", "play");
  t.startFailed();
  expect(t.snapshot()).toMatchObject({ state: "running", owner: null, startedBy: "user" });
});

test("run mode is the edit peer reporting a running simulation in mode run", () => {
  const { t } = tracker();
  t.report("edit", "running", "play");
  expect(t.runMode()).toBe(false);
  t.report("edit", "running", "run");
  expect(t.runMode()).toBe(true);
  t.report("edit", "stopping", "run");
  expect(t.runMode()).toBe(true);
  t.report("edit", "idle");
  expect(t.runMode()).toBe(false);
});

test("a stop Studio never finishes reads running again with a warning, not stopping forever", () => {
  const { t, clock } = tracker();
  t.report("edit", "running", "play");
  t.report("edit", "stopping", "play");
  expect(t.snapshot().state).toBe("stopping");
  t.beginStop();
  for (let i = 0; i < 7; i += 1) {
    clock.now += 5_000;
    t.report("edit", "stopping", "play");
  }
  const snapshot = t.snapshot();
  expect(snapshot.state).toBe("running");
  expect(snapshot.warning).toContain("still");
});

describe("stale code", () => {
  test("compares edit and play-server hashes, ignoring server-only runtime clones", () => {
    const edit = { "game.A": "1", "game.B": "2", "game.C": "3" };
    const server = { "game.A": "1", "game.B": "9", "game.Workspace.Player.Animate": "x" };
    expect(compareHashes(edit, server)).toEqual({ changed: 1, missing: 1, sample: ["game.B", "game.C"] });
    expect(compareHashes({ "game.A": "1" }, { "game.A": "1" })).toBeNull();
  });
});
