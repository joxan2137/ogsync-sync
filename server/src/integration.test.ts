// End-to-end daemon loop: in-memory MCP client → real Hub over HTTP → fake
// plugin speaking docs/PROTOCOL.md. No Studio required; this is the wire the
// live plugin plugs into.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CONFIG_DEFAULTS, PROTO_VERSION, contentHash, type Job } from "./proto/types.ts";
import { Hub } from "./hub/hub.ts";
import { createMcpServer } from "./mcp/server.ts";

const PLACE = "Place2";
/** Plugin endpoints require this header (browsers cannot set it). */
const PLUGIN_HEADERS = { "x-ogsync-plugin": String(PROTO_VERSION) };

class FakePlugin {
  cursor = 0;
  handled: Job[] = [];
  scripts = new Map<string, string>([
    ["game.ServerScriptService.Main", 'print("hello")\nreturn 1\n'],
  ]);
  #base: string;
  #session = "fake-session-0001";
  #token = "";
  #stopped = false;
  #loop: Promise<void> | null = null;

  constructor(port: number) {
    this.#base = `http://127.0.0.1:${port}`;
  }

  async handshake(): Promise<Response> {
    const res = await fetch(`${this.#base}/handshake`, {
      method: "POST",
      headers: PLUGIN_HEADERS,
      body: JSON.stringify({
        proto: PROTO_VERSION,
        session: this.#session,
        role: "edit",
        pluginVersion: "0.1.0",
        placeId: 123,
        placeName: PLACE,
      }),
    });
    this.#token = ((await res.clone().json()) as { token?: string }).token ?? "";
    return res;
  }

  /** Every pull and push presents the handshake's per-session secret. */
  #headers(): Record<string, string> {
    return { ...PLUGIN_HEADERS, "x-ogsync-token": this.#token };
  }

  /** Results go up; any job they unblocked comes back on the same response. */
  async #answer(jobs: Job[]): Promise<void> {
    while (jobs.length > 0) {
      const results = jobs.map((job) => this.#execute(job));
      this.handled.push(...jobs);
      const res = await fetch(`${this.#base}/push`, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify({ session: this.#session, results }),
      });
      jobs = ((await res.json()) as { jobs?: Job[] }).jobs ?? [];
    }
  }

  start(): void {
    this.#loop = (async () => {
      while (!this.#stopped) {
        const res = await fetch(`${this.#base}/pull?session=${this.#session}&cursor=${this.cursor}`, {
          headers: this.#headers(),
        }).catch(() => null);
        if (res === null || this.#stopped) return;
        if (res.status !== 200) continue;
        const body = (await res.json()) as { cursor: number; jobs: Job[] };
        this.cursor = body.cursor;
        await this.#answer(body.jobs);
      }
    })();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await Promise.race([this.#loop, Bun.sleep(50)]);
  }

  async pushEvent(ev: Record<string, unknown>): Promise<void> {
    await fetch(`${this.#base}/push`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify({ session: this.#session, events: [ev] }),
    });
  }

  #execute(job: Job): { id: string; ok: boolean; data?: unknown; err?: string } {
    const args = job.args as Record<string, unknown>;
    switch (job.op) {
      case "script.read": {
        const source = this.scripts.get(args.path as string);
        if (source === undefined) return { id: job.id, ok: false, err: "NOPATH: no such script" };
        const lines = source.replace(/\n$/, "").split("\n");
        return {
          id: job.id,
          ok: true,
          data: { lines, total: lines.length, hash: contentHash(source) },
        };
      }
      case "inst.set": {
        const targets = args.targets as Array<Record<string, unknown>>;
        return {
          id: job.id,
          ok: true,
          data: {
            instances: targets.length,
            properties: targets.reduce(
              (n, t) => n + Object.keys((t.props as object) ?? {}).length,
              0,
            ),
            seenAttrsRemove: targets.some((t) => Array.isArray(t.attrs_remove)),
          },
        };
      }
      case "run.exec":
        return { id: job.id, ok: true, data: { output: [{ level: "print", text: "ran" }], returns: [] } };
      default:
        return { id: job.id, ok: false, err: `STUDIO: unhandled op ${job.op}` };
    }
  }
}

describe("daemon loop end to end", () => {
  const config = structuredClone(CONFIG_DEFAULTS);
  config.bind.target_place = PLACE;
  let hub: Hub;
  let plugin: FakePlugin;
  let client: Client;

  beforeAll(async () => {
    hub = new Hub({ config, version: "0.0.0-test", port: 0, longPollMs: 300 });
    hub.listen();
    plugin = new FakePlugin(hub.port);
    const hs = await plugin.handshake();
    expect(hs.status).toBe(200);
    const body = (await hs.json()) as { accepted: boolean };
    expect(body.accepted).toBe(true);
    plugin.start();

    const server = createMcpServer(hub, { sync: null, version: "0.0.0-test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "it", version: "0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    hub.setRpcHandler(async (tool, args) =>
      client.callTool({ name: tool, arguments: (args ?? {}) as Record<string, unknown> }),
    );
  });

  afterAll(async () => {
    await plugin.stop();
    hub.stop();
  });

  test("read flows MCP → hub → plugin and renders numbered lines", async () => {
    const res = (await client.callTool({
      name: "read",
      arguments: { path: "game.ServerScriptService.Main" },
    })) as CallToolResult;
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("game.ServerScriptService.Main 2L");
    expect(text).toMatch(/1\tprint\("hello"\)/);
  });

  test("set translates null attrs into attrs_remove for the plugin", async () => {
    const res = (await client.callTool({
      name: "set",
      arguments: {
        targets: [{ path: "game.Workspace.Part", props: { Anchored: true }, attrs: { Old: null, Keep: 1 } }],
      },
    })) as CallToolResult;
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("ok 1 instances");
    const setJob = plugin.handled.find((j) => j.op === "inst.set");
    expect(setJob).toBeDefined();
    const target = (setJob!.args as { targets: Array<Record<string, unknown>> }).targets[0]!;
    expect(target.attrs_remove).toEqual(["Old"]);
    expect(target.attrs).toEqual({ Keep: 1 });
  });

  test("plugin errors surface as ERR text, not protocol errors", async () => {
    const res = (await client.callTool({
      name: "read",
      arguments: { path: "game.Nope" },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toStartWith("ERR");
  });

  test("batched jobs: two concurrent calls arrive in one or two pulls, both resolve", async () => {
    const [a, b] = await Promise.all([
      client.callTool({ name: "run", arguments: { code: "return 1" } }),
      client.callTool({ name: "read", arguments: { path: "game.ServerScriptService.Main" } }),
    ]);
    expect(((a as CallToolResult).content[0] as { text: string }).text).toContain("ran");
    expect(((b as CallToolResult).content[0] as { text: string }).text).toContain("2L");
  });

  test("events fan out to bridge subscribers", async () => {
    const got = new Promise((resolve) => {
      const un = hub.onEvent((ev) => {
        un();
        resolve(ev);
      });
    });
    await plugin.pushEvent({ ev: "log", ctx: "edit", level: "info", msg: "hi", ts: 1 });
    const ev = (await got) as { ev: string; msg?: string };
    expect(ev.ev).toBe("log");
  });

  test("/rpc with token executes a tool; without token 401", async () => {
    const token = hub.token;
    const ok = await fetch(`http://127.0.0.1:${hub.port}/rpc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tool: "read", args: { path: "game.ServerScriptService.Main" } }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const noAuth = await fetch(`http://127.0.0.1:${hub.port}/rpc`, {
      method: "POST",
      headers: PLUGIN_HEADERS,
      body: JSON.stringify({ tool: "read", args: { path: "x" } }),
    });
    expect(noAuth.status).toBe(401);
  });
});
