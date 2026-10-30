import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Bridge, OpName } from "@proto/types";
import { createMcpServer } from "./server.ts";

interface Call {
  op: OpName;
  args: Record<string, unknown>;
  timeoutMs?: number;
}

function recordingBridge(reply: (op: OpName, args: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const bridge: Bridge = {
    call: async (op, args, opts) => {
      calls.push({ op, args: args as Record<string, unknown>, timeoutMs: opts?.timeoutMs });
      return reply(op, args as Record<string, unknown>);
    },
    bound: () => null,
    sessions: () => [],
    onEvent: () => () => {},
  };
  return { bridge, calls };
}

async function call(bridge: Bridge, name: string, args: Record<string, unknown>): Promise<string> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    createMcpServer(bridge, { sync: null, version: "0.1.0" }).connect(serverSide),
    client.connect(clientSide),
  ]);
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("run and job", () => {
  test("run async returns a routable job handle immediately", async () => {
    const { bridge, calls } = recordingBridge(() => ({ job: "7", gen: 7, nonce: "1a2b3c4d", vm: "game", async: true }));
    const text = await call(bridge, "run", {
      code: "while true do task.wait() end",
      context: "client",
      player: "Player1",
      async: true,
      key: "sampler",
    });
    expect(text).toStartWith("job client@Player1:7.1a2b3c4d started vm=game gen=7");
    expect(calls[0]!.args).toMatchObject({ context: "client", async: true, key: "sampler", player: "Player1" });
  });

  test("run labels plugin-VM results in a play context", async () => {
    const { bridge } = recordingBridge(() => ({ vm: "plugin", returns: [1] }));
    const text = await call(bridge, "run", { code: "return 1", context: "server", vm: "plugin" });
    expect(text).toBe("[vm=plugin: separate require cache, not the game's module instances]\n=> 1");
  });

  test("run leaves game-VM and edit results unlabelled", async () => {
    const { bridge } = recordingBridge(() => ({ vm: "game", returns: [2] }));
    expect(await call(bridge, "run", { code: "return 2", context: "server" })).toBe("=> 2");
  });

  test("run refuses vm=game in the edit context", async () => {
    const { bridge, calls } = recordingBridge(() => ({}));
    const text = await call(bridge, "run", { code: "return 1", vm: "game" });
    expect(text).toStartWith("ERR BADARG: context=edit has no game VM");
    expect(calls).toHaveLength(0);
  });

  test("job collect routes by handle and outwaits its own wait_ms", async () => {
    const { bridge, calls } = recordingBridge(() => ({
      id: "3",
      status: "done",
      vm: "game",
      elapsed: 41.27,
      output: [{ level: "info", text: "sampled" }],
      returns: [5],
    }));
    const text = await call(bridge, "job", { action: "collect", handle: "server:3.1a2b3c4d", wait_ms: 30_000 });
    expect(text).toBe("job server:3.1a2b3c4d done\tvm=game elapsed_s=41.3\nsampled\n=> 5");
    expect(calls[0]!.op).toBe("run.job");
    expect(calls[0]!.args).toMatchObject({ action: "collect", id: "3", nonce: "1a2b3c4d", context: "server", wait_ms: 30_000 });
    expect(calls[0]!.timeoutMs).toBeGreaterThan(30_000);
  });

  test("job caps client collect waits under the broker's relay timeout", async () => {
    const { bridge, calls } = recordingBridge(() => ({ status: "running" }));
    const text = await call(bridge, "job", { action: "collect", handle: "client@Player1:2.1a2b3c4d", wait_ms: 60_000 });
    expect(calls[0]!.args).toMatchObject({ context: "client", player: "Player1", wait_ms: 8_000 });
    expect(text).toContain("still running (client waits cap at 8000ms)");
  });

  test("job reports a cancelled job with its reason", async () => {
    const { bridge } = recordingBridge(() => ({ status: "cancelled", vm: "plugin", err: "superseded by job 9 (key sampler)" }));
    const text = await call(bridge, "job", { action: "poll", handle: "edit:4.1a2b3c4d" });
    expect(text).toBe("job edit:4.1a2b3c4d cancelled\tvm=plugin\nERR superseded by job 9 (key sampler)");
  });

  test("job list renders handles for the given context", async () => {
    const { bridge } = recordingBridge(() => ({ jobs: [{ id: "2", status: "running", vm: "game", key: "s", elapsed: 3 }], nonce: "1a2b3c4d" }));
    expect(await call(bridge, "job", { action: "list", context: "server" })).toBe(
      "server:2.1a2b3c4d\tstatus=running vm=game key=s elapsed_s=3",
    );
  });

  test("job rejects a malformed handle", async () => {
    const { bridge } = recordingBridge(() => ({}));
    expect(await call(bridge, "job", { handle: "7" })).toStartWith("ERR BADARG: bad handle '7'");
  });
});

describe("script writes", () => {
  test("edit stages a large source in chunks and sends only its hash inline", async () => {
    const { bridge, calls } = recordingBridge((op) =>
      op === "script.edit"
        ? { path: "game.X", total: 2, hash: "0123456789abcdef", verified: true, editor: true }
        : { ok: true },
    );
    const source = `${"x".repeat(100_000)}\r\nreturn 1`;
    const text = await call(bridge, "edit", { path: "game.X", source });
    expect(text).toBe("ok game.X 2L 01234567 verified(editor)");
    const stages = calls.filter((c) => c.op === "script.stage");
    expect(stages).toHaveLength(3);
    const upload = stages[0]!.args["upload"];
    expect(stages.every((s) => s.args["upload"] === upload && s.args["total"] === 3)).toBe(true);
    const joined = stages.map((s) => s.args["data"]).join("");
    expect(Buffer.from(joined, "base64").toString("utf8")).toBe(`${"x".repeat(100_000)}\nreturn 1`);
    const edit = calls.find((c) => c.op === "script.edit")!;
    expect(edit.args).toMatchObject({ source_upload: upload, class: "ModuleScript" });
    expect(edit.args["source"]).toBeUndefined();
    expect(edit.args["source_hash"]).toHaveLength(16);
  });

  test("edit sends old/new as base64 so control characters survive", async () => {
    const { bridge, calls } = recordingBridge(() => ({ path: "game.X", total: 1, hash: "0123456789abcdef" }));
    await call(bridge, "edit", { path: "game.X", old: "a\u0000b", new: "]]\r\n" });
    const args = calls[0]!.args;
    expect(Buffer.from(String(args["old_b64"]), "base64").toString()).toBe("a\u0000b");
    expect(Buffer.from(String(args["new_b64"]), "base64").toString()).toBe("]]\n");
    expect(args["old"]).toBeUndefined();
  });

  test("set moves props.Source onto the verified script-write path", async () => {
    const { bridge, calls } = recordingBridge(() => ({
      instances: 1,
      properties: 2,
      sources: [{ path: "game.S", hash: "fedcba9876543210", editor: false }],
    }));
    const text = await call(bridge, "set", {
      targets: [{ path: "game.S", props: { Source: "print(1)\r\n", Disabled: true } }],
    });
    expect(text).toBe("ok 1 instances, 2 properties\ngame.S\tsource=fedcba98 verified=source");
    const target = (calls[0]!.args["targets"] as Array<Record<string, unknown>>)[0]!;
    expect(target["props"]).toEqual({ Disabled: true });
    expect(Buffer.from(String(target["source_b64"]), "base64").toString()).toBe("print(1)\n");
  });
});

describe("place edits", () => {
  test("transform dry run renders the planned diff", async () => {
    const { bridge, calls } = recordingBridge(() => ({
      dryRun: true,
      total: 1,
      planned: [{ path: "game.Workspace.Hut", from: [0, 0, 0], to: [10, 0, 0], rotFrom: [0, 0, 0], rotTo: [0, 90, 0] }],
      skipped: [{ path: "game.Workspace.Hut.Door", ancestor: "game.Workspace.Hut" }],
    }));
    const text = await call(bridge, "transform", {
      targets: [{ paths: ["game.Workspace.Hut", "game.Workspace.Hut.Door"], move: [10, 0, 0], rotate: [0, 90, 0] }],
      dry_run: true,
    });
    expect(text).toBe(
      "dry-run 1 planned\ngame.Workspace.Hut\tfrom=[0,0,0] to=[10,0,0] rot=[0,0,0]→[0,90,0]\nskip game.Workspace.Hut.Door (moves with game.Workspace.Hut)",
    );
    expect(calls[0]!.args).toMatchObject({ dryRun: true });
  });

  test("transform rejects `to` combined with a relative move", async () => {
    const { bridge } = recordingBridge(() => ({}));
    const text = await call(bridge, "transform", {
      targets: [{ path: "game.Workspace.A", to: [0, 0, 0], move: [1, 0, 0] }],
    });
    expect(text).toStartWith("ERR BADARG: `to` cannot be combined");
  });
});

describe("visual tools", () => {
  test("screenshot reports scale, inset and capture warnings", async () => {
    const { bridge, calls } = recordingBridge(() => ({
      w: 1,
      h: 1,
      rgba: Buffer.from([1, 2, 3, 255]).toString("base64"),
      scale: 0.5,
      viewport: { w: 1920, h: 1080 },
      inset: { x: 0, y: 58 },
      warnings: ["2 AlwaysOnTop BillboardGui/SurfaceGui present; CaptureService captures can omit them"],
    }));
    const text = await call(bridge, "screenshot", { context: "client", frame: "game.Workspace.Hut", hide_ui: true });
    expect(text).toMatch(/^client 1x1 png \d+B\tviewport=1920x1080 scale=0\.5 inset=0,58\n/);
    expect(text).toEndWith("warn: 2 AlwaysOnTop BillboardGui/SurfaceGui present; CaptureService captures can omit them");
    expect(calls[0]!.args).toMatchObject({ context: "client", frame: "game.Workspace.Hut", hide_ui: true });
  });

  test("input click by path goes to the client and reports the hit", async () => {
    const { bridge, calls } = recordingBridge(() => ({
      actions: [{ type: "click", ok: true, x: 100, y: 158, hit: "game.Players.P.PlayerGui.Shop.Buy", reached: true }],
    }));
    const text = await call(bridge, "input", { actions: [{ type: "click", path: "game.Players.P.PlayerGui.Shop.Buy" }] });
    expect(text).toBe("1 click ok\tx=100 y=158 hit=game.Players.P.PlayerGui.Shop.Buy reached=true");
    expect(calls[0]!.args).toMatchObject({ context: "client" });
  });

  test("input surfaces an unsupported click as an error ack", async () => {
    const { bridge } = recordingBridge(() => ({
      actions: [{ type: "click", ok: false, err: "click unsupported: synthetic clicks do not fire ClickDetector.MouseClick" }],
    }));
    const text = await call(bridge, "input", { actions: [{ type: "click", path: "game.Workspace.Lever" }] });
    expect(text).toBe("1 click ERR click unsupported: synthetic clicks do not fire ClickDetector.MouseClick");
  });

  test("input click without a target is a bad argument", async () => {
    const { bridge } = recordingBridge(() => ({}));
    const text = await call(bridge, "input", { actions: [{ type: "click", x: 5 }] });
    expect(text).toBe("ERR BADARG: click needs path or both x and y");
  });
});
