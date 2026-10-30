import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  BridgeError,
  type Bridge,
  type BridgeEvent,
  type OpName,
  type PlaceState,
  type PlaytestInfo,
  type SessionInfo,
} from "@proto/types";
import { createMcpServer } from "./server.ts";
import { TOOLS } from "./tools/index.ts";

function fakeBridge(reply: (op: OpName, args: unknown) => unknown): Bridge {
  return {
    call: async (op, args) => reply(op, args),
    bound: () => null,
    sessions: () => [],
    onEvent: () => () => {},
  };
}

async function connect(bridge: Bridge): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    createMcpServer(bridge, { sync: null, version: "0.1.0" }).connect(serverSide),
    client.connect(clientSide),
  ]);
  return client;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("tool surface", () => {
  test("registers all 24 tools with json schemas and a target arg", async () => {
    const client = await connect(fakeBridge(() => ({})));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].map((t) => t.name).sort());
    expect(tools).toHaveLength(24);
    for (const t of tools) {
      expect(t.description ?? "").not.toBe("");
      expect(t.inputSchema.type).toBe("object");
      expect(Object.keys(t.inputSchema.properties ?? {})).toContain("target");
    }
  });

  test("descriptions stay at two sentences or fewer", () => {
    // Tool descriptions ship in every request, so their size is product surface.
    const tooLong = TOOLS.filter(
      (t) => t.description.split(/(?<=[.!?])\s+/).filter(Boolean).length > 2,
    ).map((t) => t.name);
    expect(tooLong).toEqual([]);
  });
});

describe("tool dispatch", () => {
  test("read renders a header plus numbered lines", async () => {
    const client = await connect(
      fakeBridge(() => ({ lines: ["local a = 1", "return a"], total: 2, hash: "abcdef1234567890" })),
    );
    const result = (await client.callTool({
      name: "read",
      arguments: { path: "game.ServerScriptService.Main" },
    })) as CallToolResult;
    expect(textOf(result)).toBe(
      "game.ServerScriptService.Main 2L abcdef12\n1\tlocal a = 1\n2\treturn a",
    );
  });

  test("tree renders the plugin's terse wire nodes", async () => {
    const client = await connect(
      fakeBridge(() => ({
        root: {
          n: "game",
          c: "DataModel",
          k: 1,
          ch: [{ n: "Main", c: "Script", k: 0, ln: 12 }],
        },
      })),
    );
    const result = (await client.callTool({ name: "tree", arguments: {} })) as CallToolResult;
    expect(textOf(result)).toBe("game DataModel [1]\n  Main Script #12");
  });

  test("logs collapse consecutive duplicates and report the next cursor", async () => {
    const client = await connect(
      fakeBridge(() => ({
        ctx: "server",
        entries: [
          { t: 1, l: "error", m: "boom" },
          { t: 2, l: "error", m: "boom" },
          { t: 3, l: "info", m: "ok" },
        ],
        cursor: 7,
      })),
    );
    // Backfilled entries are renumbered by the daemon buffer, so the cursor is
    // the buffer's own sequence rather than whatever the plugin reported.
    const result = (await client.callTool({ name: "logs", arguments: {} })) as CallToolResult;
    expect(textOf(result)).toBe(
      "[server][error] boom (x2)\n[server][info] ok\ncursor=3",
    );
  });

  test("profile memory renders MB shares of the total", async () => {
    const client = await connect(
      fakeBridge(() => ({ total_mb: 200, tags: [{ tag: "GraphicsTexture", mb: 50 }] })),
    );
    const result = (await client.callTool({
      name: "profile",
      arguments: { kind: "memory" },
    })) as CallToolResult;
    expect(textOf(result)).toBe("memory MB\ttotal=200\nGraphicsTexture  50  25%");
  });

  test("bridge failures come back as ERR text, not protocol errors", async () => {
    const client = await connect(
      fakeBridge(() => {
        throw new BridgeError("NOPLUGIN", "no Studio session bound");
      }),
    );
    const result = (await client.callTool({
      name: "tree",
      arguments: {},
    })) as CallToolResult;
    expect(textOf(result)).toBe("ERR NOPLUGIN: no Studio session bound");
  });

  test("bad argument combinations answer with ERR BADARG", async () => {
    const client = await connect(fakeBridge(() => ({})));
    const result = (await client.callTool({
      name: "edit",
      arguments: { path: "game.X", old: "a", new: "b", source: "c" },
    })) as CallToolResult;
    expect(textOf(result)).toStartWith("ERR BADARG: pass exactly one of");
  });

  test("sync without a project reports itself disabled", async () => {
    const client = await connect(fakeBridge(() => ({})));
    const result = (await client.callTool({
      name: "sync",
      arguments: { op: "status" },
    })) as CallToolResult;
    expect(textOf(result)).toBe("sync disabled (no project)");
  });

  test("screenshot returns png image content", async () => {
    const client = await connect(
      fakeBridge(() => ({ w: 1, h: 1, rgba: Buffer.from([1, 2, 3, 255]).toString("base64") })),
    );
    const result = (await client.callTool({
      name: "screenshot",
      arguments: {},
    })) as CallToolResult;
    const image = result.content.find((c) => c.type === "image");
    expect(image).toMatchObject({ mimeType: "image/png" });
    expect(Buffer.from(String((image as { data: string }).data), "base64").subarray(1, 4).toString()).toBe(
      "PNG",
    );
  });

  test("playtest stop reports success when the play session answers", async () => {
    const seen: OpName[] = [];
    const client = await connect(
      fakeBridge((op) => {
        seen.push(op);
        return { stopped: true };
      }),
    );
    const result = (await client.callTool({ name: "playtest", arguments: { action: "stop" } })) as CallToolResult;
    expect(textOf(result)).toContain("stopped");
    // The SetSetting fallback is only for a play session that cannot answer.
    expect(seen).toEqual(["play.stop"]);
  });

  test("playtest stop treats a lost play session as stopped, not as an error", async () => {
    const seen: OpName[] = [];
    const client = await connect(
      fakeBridge((op) => {
        seen.push(op);
        if (op === "play.stop") throw new BridgeError("TIMEOUT", "no answer");
        return {};
      }),
    );
    const result = (await client.callTool({ name: "playtest", arguments: { action: "stop" } })) as CallToolResult;
    expect(textOf(result)).toContain("stopped");
    expect(seen).toEqual(["play.stop", "play.stopSignal"]);
  });
});

function placeWith(playtest: Partial<PlaytestInfo>): PlaceState {
  return {
    key: "42",
    name: "Place2",
    placeId: 42,
    peers: [],
    playtest: {
      state: "idle",
      mode: null,
      owner: null,
      startedBy: null,
      since: Date.now(),
      heartbeatAgeMs: 100,
      players: 0,
      stale: null,
      warning: null,
      ...playtest,
    },
  };
}

describe("playtest lifecycle and wait", () => {
  test("status reads daemon state, flags stale code and the plugins-in-test-mode warning", async () => {
    const bridge: Bridge = {
      ...fakeBridge(() => {
        throw new Error("status must not touch Studio");
      }),
      place: () =>
        placeWith({
          state: "running",
          mode: "play",
          owner: "serve-1",
          startedBy: "agent",
          stale: { changed: 2, missing: 1, sample: ["game.ServerScriptService.Main"] },
          warning: "Load User Plugins in Test Mode is probably off",
        }),
    };
    const text = textOf((await (await connect(bridge)).callTool({ name: "playtest", arguments: { action: "status" } })) as CallToolResult);
    expect(text).toContain("state=running");
    expect(text).toContain("owner=serve-1");
    expect(text).toContain("STALE CODE: 2 changed, 1 missing");
    expect(text).toContain("WARNING: Load User Plugins");
  });

  test("start answers only once the plugin confirms the playtest is running", async () => {
    let state: PlaytestInfo["state"] = "starting";
    const bridge: Bridge = {
      ...fakeBridge((op) => {
        expect(op).toBe("play.start");
        setTimeout(() => (state = "running"), 300);
        return { started: "solo", requested: "solo" };
      }),
      place: () => placeWith({ state, mode: "play" }),
    };
    const text = textOf((await (await connect(bridge)).callTool({ name: "playtest", arguments: { action: "start" } })) as CallToolResult);
    expect(text).toStartWith("playtest started solo");
    expect(text).toContain("state=running");
  });

  test("wait for=log returns the first new matching line", async () => {
    let emit: ((ev: BridgeEvent, from: SessionInfo) => void) | null = null;
    const bridge: Bridge = {
      ...fakeBridge(() => ({})),
      onEvent: (fn) => {
        emit = fn;
        return () => {};
      },
    };
    const from: SessionInfo = { session: "s", role: "server", pluginVersion: "0", placeId: 42, placeName: "P", connectedAt: 0, lastSeen: 0 };
    const client = await connect(bridge);
    const pending = client.callTool({ name: "wait", arguments: { for: "log", pattern: "ready \\d+", timeoutMs: 3_000 } });
    await Bun.sleep(50);
    emit!({ ev: "log", ctx: "server", level: "info", msg: "booting", ts: 1 }, from);
    emit!({ ev: "log", ctx: "server", level: "info", msg: "ready 7", ts: 2 }, from);
    const text = textOf((await pending) as CallToolResult);
    expect(text).toContain("wait ok: log matched");
    expect(text).toContain("[server][info] ready 7");
    expect(text).not.toContain("booting");
  });

  test("wait for=attribute re-checks through the plugin until the value matches", async () => {
    let checks = 0;
    const bridge = fakeBridge((op, args) => {
      expect(op).toBe("wait.check");
      expect(args).toMatchObject({ kind: "attribute", path: "game.Workspace", name: "Ready", value: true });
      checks += 1;
      return checks < 3 ? { met: false, value: false } : { met: true, value: true };
    });
    const text = textOf(
      (await (await connect(bridge)).callTool({
        name: "wait",
        arguments: { for: "attribute", path: "game.Workspace", name: "Ready", value: true, timeoutMs: 5_000 },
      })) as CallToolResult,
    );
    expect(text).toBe("wait ok: attribute game.Workspace@Ready value=true");
    expect(checks).toBe(3);
  });

  test("wait times out with ERR TIMEOUT naming the last observed state", async () => {
    const bridge: Bridge = { ...fakeBridge(() => ({})), place: () => placeWith({ state: "running" }) };
    const text = textOf(
      (await (await connect(bridge)).callTool({
        name: "wait",
        arguments: { for: "playtest", state: "idle", timeoutMs: 300 },
      })) as CallToolResult,
    );
    expect(text).toBe("ERR TIMEOUT: playtest is running, not idle");
  });
});
