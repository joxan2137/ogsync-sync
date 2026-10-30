import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BridgeError, type Bridge, type OpName } from "@proto/types";
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
  test("registers all 22 tools with json schemas", async () => {
    const client = await connect(fakeBridge(() => ({})));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].map((t) => t.name).sort());
    expect(tools).toHaveLength(22);
    for (const t of tools) {
      expect(t.description ?? "").not.toBe("");
      expect(t.inputSchema.type).toBe("object");
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
