import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CANDIDATE_PORTS, CONFIG_DEFAULTS, PROTO_VERSION, type Bridge, type StateResponse } from "../proto/types.ts";
import { currentCaller } from "../hub/caller.ts";
import { Hub } from "../hub/hub.ts";
import { PollThrottle } from "../hub/throttle.ts";
import { DaemonClient, localRequest, probeDaemon, withLoopbackNoProxy } from "./client.ts";
import { acquireLock, lockFile, readDaemonRecord, recordFile, writeDaemonRecord } from "./lock.ts";
import { parseExcludedRanges, portCandidates } from "./ports.ts";
import { Projects } from "./projects.ts";
import { pollKey, runTool } from "./run.ts";
import { formatState } from "./status.ts";

const NETSH_OUTPUT = `
Protocol tcp Port Exclusion Ranges

Start Port    End Port
----------    --------
      3660        3669
     50000       50059     *

* - Administered port exclusions.
`;

let home: string;
const savedHome = process.env["OGSYNC_HOME"];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ogsync-home-"));
  process.env["OGSYNC_HOME"] = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env["OGSYNC_HOME"];
  else process.env["OGSYNC_HOME"] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe("ports", () => {
  test("parses netsh excluded ranges and skips candidates inside them", () => {
    const ranges = parseExcludedRanges(NETSH_OUTPUT);
    expect(ranges).toEqual([
      [3660, 3669],
      [50000, 50059],
    ]);
    const ports = portCandidates(null, ranges);
    expect(ports[0]).toBe(13667);
    expect(ports).not.toContain(3667);
    expect(ports.every((port) => CANDIDATE_PORTS.includes(port))).toBe(true);
  });

  test("an explicit preference goes first unless excluded", () => {
    expect(portCandidates(4000, [])[0]).toBe(4000);
    expect(portCandidates(3665, parseExcludedRanges(NETSH_OUTPUT))).not.toContain(3665);
  });
});

describe("single-instance lock", () => {
  test("a live holder blocks a second daemon; a dead one is taken over", () => {
    const first = acquireLock();
    expect(first).not.toBeNull();
    expect(acquireLock(process.pid + 1)).toBeNull();
    first!.release();
    expect(existsSync(lockFile())).toBe(false);

    writeFileSync(lockFile(), "2147483646"); // no such process
    const takeover = acquireLock();
    expect(takeover).not.toBeNull();
    takeover!.release();
  });

  test("daemon.json round-trips and is removed with the lock", () => {
    const lock = acquireLock()!;
    writeDaemonRecord({ pid: process.pid, port: 3668, version: "9.9.9", proto: PROTO_VERSION, startedAt: 1 });
    expect(readDaemonRecord()).toEqual({ pid: process.pid, port: 3668, version: "9.9.9", proto: PROTO_VERSION, startedAt: 1 });
    lock.release();
    expect(existsSync(recordFile())).toBe(false);
  });
});

describe("loopback client", () => {
  test("adds loopback to NO_PROXY without dropping the user's entries", () => {
    const env = withLoopbackNoProxy({ HTTP_PROXY: "http://127.0.0.1:7890", NO_PROXY: "corp.example" });
    expect(env["NO_PROXY"]).toBe("corp.example,127.0.0.1,localhost,::1");
    expect(env["no_proxy"]).toBe("127.0.0.1,localhost,::1");
    expect(env["HTTP_PROXY"]).toBe("http://127.0.0.1:7890");
  });

  describe("against a live hub", () => {
    let hub: Hub;
    let dir: string;

    beforeAll(() => {
      hub = new Hub({ config: CONFIG_DEFAULTS, version: "9.9.9-test", port: 0, longPollMs: 150 });
      hub.listen();
    });

    afterAll(() => hub.stop());

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "ogsync-project-"));
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test("probes identity over node:http and reads /state", async () => {
      expect(await probeDaemon(hub.port)).toMatchObject({ service: "ogsync", proto: PROTO_VERSION });
      expect(await probeDaemon(1)).toBeNull();
      const res = await localRequest(hub.port, "GET", "/state");
      expect((res.body as StateResponse).places).toEqual([]);
    });

    test("tool calls carry the caller, its ogsync.toml target and limits", async () => {
      writeFileSync(join(dir, "ogsync.toml"), '[bind]\ntarget_place = "lobby"\n[aliases]\nlobby = "77"\n[playtest]\nmax_clients = 1\n');
      const projects = new Projects(hub);
      const seen: unknown[] = [];
      hub.setRpcHandler((tool, args, caller) =>
        runTool(
          async (bridge: Bridge, _deps, name, toolArgs) => {
            const err = await bridge.call("sel.get", {}).catch((e: Error) => e.message);
            seen.push({ name, toolArgs, caller: currentCaller(), err });
            return { content: [{ type: "text", text: "ok" }] } satisfies CallToolResult;
          },
          projects,
          new PollThrottle(),
          tool,
          args,
          caller,
        ),
      );
      const client = new DaemonClient(hub.port, hub.token, { id: "cli:test", cwd: dir, label: "test" });
      expect(await client.callTool("tree", { depth: 1 }, 5_000)).toEqual({ content: [{ type: "text", text: "ok" }] });
      expect(seen[0]).toMatchObject({
        name: "tree",
        caller: { id: "cli:test", label: "test", playtest: { max_clients: 1 } },
        err: expect.stringContaining("lobby"),
      });
      hub.setRpcHandler(null);
    });
  });
});

describe("rpc policy", () => {
  test("only status polls are throttled", () => {
    expect(pollKey("a", "logs", { context: "all" })).not.toBeNull();
    expect(pollKey("a", "playtest", { action: "status" })).not.toBeNull();
    expect(pollKey("a", "playtest", { action: "stop" })).toBeNull();
    expect(pollKey("a", "read", { path: "game.X" })).toBeNull();
  });
});

describe("status", () => {
  test("prints the daemon, each place's peers and playtest facts", () => {
    const now = 100_000;
    const text = formatState(
      {
        daemon: { version: "1.0.0", proto: PROTO_VERSION, pid: 42, port: 3667, startedAt: now - 90_000 },
        places: [
          {
            key: "111",
            name: "Main",
            placeId: 111,
            peers: [{ role: "edit", session: "s", pluginVersion: "1.0.0", ageMs: 2_000 }],
            playtest: {
              state: "running",
              mode: "play",
              owner: "serve-9",
              startedBy: "agent",
              since: Date.now() - 5_000,
              heartbeatAgeMs: 1_000,
              players: 1,
              stale: { changed: 1, missing: 0, sample: ["game.A"] },
              warning: null,
            },
          },
        ],
      },
      now,
    );
    expect(text).toContain("daemon pid 42 on 127.0.0.1:3667 (proto 2), up 1m30s");
    expect(text).toContain("111 (Main)  peers: edit 2s");
    expect(text).toContain("playtest running mode=play owner=serve-9");
    expect(text).toContain("STALE CODE: 1 changed");
  });
});
