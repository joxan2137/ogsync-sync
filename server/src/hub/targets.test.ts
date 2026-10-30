import { describe, expect, test } from "bun:test";
import { BridgeError } from "../proto/types.ts";
import { FairScheduler } from "./scheduler.ts";
import { basePlaceKey, parseTarget, resolvePlace, type PlaceIdentity } from "./targets.ts";
import { PollThrottle } from "./throttle.ts";

const MAIN: PlaceIdentity = { key: "111", name: "Main", placeId: 111 };
const MAIN_TWIN: PlaceIdentity = { key: "111~2", name: "Main", placeId: 111 };
const SCRATCH: PlaceIdentity = { key: "scratch", name: "Scratch", placeId: 0 };

function resolveError(fn: () => unknown): BridgeError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BridgeError);
    return err as BridgeError;
  }
  throw new Error("expected a BridgeError");
}

describe("target grammar", () => {
  test("splits an optional role suffix off the place", () => {
    expect(parseTarget("Main:server")).toEqual({ place: "Main", role: "server" });
    expect(parseTarget("111:client-2")).toEqual({ place: "111", role: "client-2" });
    expect(parseTarget("client-1")).toEqual({ place: null, role: "client-1" });
    expect(parseTarget(111)).toEqual({ place: "111", role: null });
    expect(parseTarget("Odd:Name")).toEqual({ place: "Odd:Name", role: null });
    expect(parseTarget(null)).toEqual({ place: null, role: null });
  });

  test("play DataModels share the edit key; unsaved places key by normalized name", () => {
    expect(basePlaceKey({ placeId: 111, placeName: "Main @ 02 Aug 2026 15:49" })).toBe("111");
    expect(basePlaceKey({ placeId: 0, placeName: "Scratch @ 02 Aug 2026 15:49" })).toBe("scratch");
  });
});

describe("target resolution", () => {
  test("matches by alias, key, place id or name", () => {
    const places = [MAIN, SCRATCH];
    expect(resolvePlace(parseTarget("main"), places).key).toBe("111");
    expect(resolvePlace(parseTarget("scratch"), places).key).toBe("scratch");
    expect(resolvePlace(parseTarget("lobby"), places, { lobby: "111" }).key).toBe("111");
  });

  test("no target is fine with one place and an explicit error with several", () => {
    expect(resolvePlace(parseTarget(null), [MAIN]).key).toBe("111");
    const err = resolveError(() => resolvePlace(parseTarget(null), [MAIN, SCRATCH]));
    expect(err.code).toBe("TARGET");
    expect(err.message).toContain("111 (Main) | scratch");
  });

  test("never picks one of several matches", () => {
    const err = resolveError(() => resolvePlace(parseTarget("111"), [MAIN, MAIN_TWIN]));
    expect(err.code).toBe("TARGET");
    expect(err.message).toContain("111~2");
    expect(resolvePlace(parseTarget("111~2"), [MAIN, MAIN_TWIN]).key).toBe("111~2");
  });

  test("an unmatched target lists what is connected; nothing connected is NOPLUGIN", () => {
    expect(resolveError(() => resolvePlace(parseTarget("Other"), [MAIN])).code).toBe("TARGET");
    expect(resolveError(() => resolvePlace(parseTarget("Other"), [])).code).toBe("NOPLUGIN");
  });
});

describe("fair scheduler", () => {
  test("runs one item at a time and alternates between waiting clients", () => {
    const scheduler = new FairScheduler<string>(1);
    const started: string[] = [];
    const start = (item: string) => started.push(item);
    for (const [client, item] of [["a", "a1"], ["a", "a2"], ["a", "a3"], ["b", "b1"], ["c", "c1"]] as const) {
      scheduler.submit(client, item, start);
    }
    expect(started).toEqual(["a1"]);
    for (const item of ["a1", "b1", "a2", "c1"]) scheduler.release(item);
    expect(started).toEqual(["a1", "b1", "a2", "c1", "a3"]);
  });

  test("a cancelled waiter never starts", () => {
    const scheduler = new FairScheduler<string>(1);
    const started: string[] = [];
    scheduler.submit("a", "first", (item) => started.push(item));
    scheduler.submit("b", "dropped", (item) => started.push(item));
    expect(scheduler.cancel("dropped")).toBe(true);
    expect(scheduler.cancel("first")).toBe(false);
    scheduler.release("first");
    expect(started).toEqual(["first"]);
    expect(scheduler.waiting).toBe(0);
  });
});

describe("poll throttle", () => {
  test("refuses an identical key inside the window and says how long to wait", () => {
    let now = 1_000;
    const throttle = new PollThrottle(1_000, () => now);
    expect(throttle.check("logs")).toBe(0);
    now += 300;
    expect(throttle.check("logs")).toBe(700);
    expect(throttle.check("logs other args")).toBe(0);
    now += 700;
    expect(throttle.check("logs")).toBe(0);
  });
});
