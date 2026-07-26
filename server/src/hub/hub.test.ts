import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  BridgeError,
  CONFIG_DEFAULTS,
  PROTO_VERSION,
  RESULT_CAP_BYTES,
  type BridgeEvent,
  type HandshakeRequest,
  type HandshakeResponse,
  type OgsyncConfig,
  type PullResponse,
  type PushRequest,
  type SessionInfo,
} from "../proto/types.ts";
import { Hub, isLoopbackHost, type HealthResponse } from "./hub.ts";

const VERSION = "9.9.9-test";
const LONG_POLL_MS = 150;

let hub: Hub;
let base: string;

function config(bind: Partial<OgsyncConfig["bind"]> = {}): OgsyncConfig {
  return { ...CONFIG_DEFAULTS, bind: { ...CONFIG_DEFAULTS.bind, ...bind } };
}

beforeEach(() => {
  hub = new Hub({ config: config({ target_place: "Place2" }), version: VERSION, port: 0, longPollMs: LONG_POLL_MS });
  hub.listen();
  base = `http://127.0.0.1:${hub.port}`;
});

afterEach(() => {
  hub.stop();
});

async function handshake(overrides: Partial<HandshakeRequest> = {}): Promise<HandshakeResponse> {
  const body: HandshakeRequest = {
    proto: PROTO_VERSION,
    session: "s-edit",
    role: "edit",
    pluginVersion: VERSION,
    placeId: 42,
    placeName: "Place2",
    ...overrides,
  };
  const res = await fetch(`${base}/handshake`, {
    method: "POST",
    headers: PLUGIN_HEADERS,
    body: JSON.stringify(body),
  });
  return (await res.json()) as HandshakeResponse;
}

/** Plugin endpoints require this; browsers cannot set it without a preflight. */
const PLUGIN_HEADERS = { "x-ogsync-plugin": String(PROTO_VERSION) };

async function pull(session = "s-edit", cursor = 0): Promise<Response> {
  return fetch(`${base}/pull?session=${session}&cursor=${cursor}`, { headers: PLUGIN_HEADERS });
}

async function push(body: Partial<PushRequest>): Promise<Response> {
  return fetch(`${base}/push`, {
    method: "POST",
    headers: PLUGIN_HEADERS,
    body: JSON.stringify({ session: "s-edit", ...body }),
  });
}

async function jobsFrom(res: Response): Promise<PullResponse> {
  expect(res.status).toBe(200);
  return (await res.json()) as PullResponse;
}

/** Handles the rejection at call time so a later await never sees it unhandled. */
function capture(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => value,
    (err: unknown) => err,
  );
}

function expectBridgeError(value: unknown): BridgeError {
  expect(value).toBeInstanceOf(BridgeError);
  return value as BridgeError;
}

test("handshake binds a session whose place matches target_place", async () => {
  const res = await handshake();
  expect(res.accepted).toBe(true);
  expect(res.proto).toBe(PROTO_VERSION);
  expect(res.serverVersion).toBe(VERSION);
  expect(res.updatePlugin).toBe(false);
  expect(res.projectName).toBe(CONFIG_DEFAULTS.project.name);
  expect(hub.bound()?.session).toBe("s-edit");
});

test("handshake refuses a place that does not match target_place", async () => {
  const res = await handshake({ session: "s-other", placeName: "SomeOtherPlace" });
  expect(res.accepted).toBe(false);
  expect(res.reason).toContain("target_place");
  expect(hub.sessions()).toHaveLength(0);
});

test("handshake refuses a second session for the same place and role", async () => {
  expect((await handshake()).accepted).toBe(true);
  const second = await handshake({ session: "s-duplicate" });
  expect(second.accepted).toBe(false);
  expect(second.reason).toContain("already bound");
  expect(hub.sessions().map((info) => info.session)).toEqual(["s-edit"]);
});

test("handshake refuses a proto mismatch and asks for a plugin update", async () => {
  const res = await handshake({ proto: PROTO_VERSION + 1 });
  expect(res.accepted).toBe(false);
  expect(res.updatePlugin).toBe(true);
});

test("handshake accepts a version-drifted plugin but flags updatePlugin", async () => {
  const res = await handshake({ pluginVersion: "0.0.1" });
  expect(res.accepted).toBe(true);
  expect(res.updatePlugin).toBe(true);
});

test("long-poll delivers queued jobs and a cursor ack drops them", async () => {
  await handshake();
  const parked = pull();
  const call = hub.call("inst.get", { path: "game" }, { timeoutMs: 2_000 });

  const delivered = await jobsFrom(await parked);
  expect(delivered.jobs).toHaveLength(1);
  expect(delivered.jobs[0]!.op).toBe("inst.get");
  expect(delivered.cursor).toBe(1);

  await push({ results: [{ id: delivered.jobs[0]!.id, ok: true, data: { class: "DataModel" } }] });
  expect(await call).toEqual({ class: "DataModel" });

  const acked = await pull("s-edit", delivered.cursor);
  expect(acked.status).toBe(204);
  expect(acked.headers.get("x-ogsync-version")).toBe(VERSION);
});

test("unacked jobs are redelivered on reconnect", async () => {
  await handshake();
  const call = capture(hub.call("inst.tree", {}, { timeoutMs: 2_000 }));
  const first = await jobsFrom(await pull());
  const second = await jobsFrom(await pull());
  expect(second.jobs.map((job) => job.id)).toEqual(first.jobs.map((job) => job.id));

  await push({ results: [{ id: first.jobs[0]!.id, ok: false, err: "NOPATH: game.Nope is missing" }] });
  const err = expectBridgeError(await call);
  expect(err.code).toBe("NOPATH");
  expect(err.message).toBe("game.Nope is missing");
});

test("partial results stream without settling the call", async () => {
  await handshake();
  const partials: unknown[] = [];
  const call = hub.call("prof.script", {}, { timeoutMs: 2_000, onPartial: (data) => partials.push(data) });
  const delivered = await jobsFrom(await pull());
  const id = delivered.jobs[0]!.id;

  await push({ results: [{ id, ok: true, data: "line 1", partial: true }] });
  await push({ results: [{ id, ok: true, data: "done" }] });
  expect(partials).toEqual(["line 1"]);
  expect(await call).toBe("done");
});

test("call rejects TIMEOUT when the plugin never answers", async () => {
  await handshake();
  const err = expectBridgeError(await capture(hub.call("inst.get", {}, { timeoutMs: 40 })));
  expect(err.code).toBe("TIMEOUT");
  const res = await pull();
  expect(res.status).toBe(204);
});

test("call rejects NOPLUGIN when no session is bound", async () => {
  const err = expectBridgeError(await capture(hub.call("inst.get", {})));
  expect(err.code).toBe("NOPLUGIN");
});

test("call rejects an oversized result payload", async () => {
  await handshake();
  const call = capture(hub.call("script.read", {}, { timeoutMs: 2_000 }));
  const delivered = await jobsFrom(await pull());
  await push({ results: [{ id: delivered.jobs[0]!.id, ok: true, data: "x".repeat(RESULT_CAP_BYTES + 10) }] });
  const err = expectBridgeError(await call);
  expect(err.code).toBe("STUDIO");
  expect(err.message).toContain("cap");
});

test("runtime-context ops route to the play-server session, stopSignal to edit", async () => {
  await handshake();
  await handshake({ session: "s-play", role: "server" });

  const exec = hub.call("run.exec", { code: "return 1", context: "server" }, { timeoutMs: 2_000 });
  const playJobs = await jobsFrom(await pull("s-play"));
  expect(playJobs.jobs[0]!.op).toBe("run.exec");
  await push({ session: "s-play", results: [{ id: playJobs.jobs[0]!.id, ok: true, data: 1 }] });
  expect(await exec).toBe(1);

  const signal = hub.call("play.stopSignal", {}, { timeoutMs: 2_000 });
  const editJobs = await jobsFrom(await pull());
  expect(editJobs.jobs[0]!.op).toBe("play.stopSignal");
  await push({ results: [{ id: editJobs.jobs[0]!.id, ok: true }] });
  await signal;
});

test("client-context ops need a play session", async () => {
  await handshake();
  const call = capture(hub.call("run.exec", { code: "return 1", ctx: "client" }, { timeoutMs: 2_000 }));
  expect(expectBridgeError(await call).code).toBe("NOPLUGIN");
});

test("events fan out to subscribers with their session", async () => {
  await handshake();
  const seen: [BridgeEvent, SessionInfo][] = [];
  const unsubscribe = hub.onEvent((ev, from) => seen.push([ev, from]));
  const ev: BridgeEvent = { ev: "scriptChanged", path: "game.X", hash: "abc", ts: 1 };
  await push({ events: [ev] });
  expect(seen).toHaveLength(1);
  expect(seen[0]![0]).toEqual(ev);
  expect(seen[0]![1].session).toBe("s-edit");

  unsubscribe();
  await push({ events: [ev] });
  expect(seen).toHaveLength(1);
});

test("health reports sessions, binding and sync state", async () => {
  await handshake();
  const health = (await (await fetch(`${base}/health`)).json()) as HealthResponse;
  expect(health.service).toBe("ogsync");
  expect(health.version).toBe(VERSION);
  expect(health.proto).toBe(PROTO_VERSION);
  expect(health.bound).toBe("s-edit");
  expect(health.sessions[0]!.role).toBe("edit");
  expect(health.sync).toEqual({ enabled: true, pending: 0, conflicts: 0 });
});

test("pull and push refuse unknown sessions", async () => {
  expect((await pull("ghost")).status).toBe(409);
  expect((await push({ session: "ghost" })).status).toBe(409);
});

test("rpc requires the bearer token and forwards ops", async () => {
  await handshake();
  const unauthorized = await fetch(`${base}/rpc`, { method: "POST", body: JSON.stringify({ op: "sel.get" }) });
  expect(unauthorized.status).toBe(401);

  const rpc = fetch(`${base}/rpc`, {
    method: "POST",
    headers: { authorization: `Bearer ${hub.token}` },
    body: JSON.stringify({ op: "sel.get", args: {}, timeoutMs: 2_000 }),
  });
  const delivered = await jobsFrom(await pull());
  await push({ results: [{ id: delivered.jobs[0]!.id, ok: true, data: ["game.Workspace"] }] });
  expect(await (await rpc).json()).toMatchObject({ ok: true, result: ["game.Workspace"] });
});

test("rpc reports a missing mcp layer and rejects unknown ops", async () => {
  const headers = { authorization: `Bearer ${hub.token}` };
  const tool = await fetch(`${base}/rpc`, { method: "POST", headers, body: JSON.stringify({ tool: "read" }) });
  expect(tool.status).toBe(503);
  const bogus = await fetch(`${base}/rpc`, { method: "POST", headers, body: JSON.stringify({ op: "nope.nope" }) });
  expect(bogus.status).toBe(400);
});

test("unknown routes 404 and every JSON response carries serverVersion", async () => {
  const res = await fetch(`${base}/nope`);
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ serverVersion: VERSION });
});

test("without target_place the first edit session wins and later ones are refused", async () => {
  hub.stop();
  hub = new Hub({ config: config({ target_place: null }), version: VERSION, port: 0, longPollMs: LONG_POLL_MS });
  hub.listen();
  base = `http://127.0.0.1:${hub.port}`;
  expect((await handshake({ session: "s-first", placeName: "Anything" })).accepted).toBe(true);
  expect(hub.bound()?.session).toBe("s-first");
  // Silently binding a second place would let sync write to the wrong game.
  const second = await handshake({ session: "s-second", placeName: "OtherPlace", placeId: 99 });
  expect(second.accepted).toBe(false);
  expect(second.reason).toMatch(/target_place/);
  expect(hub.bound()?.session).toBe("s-first");
});

test("plugin endpoints refuse requests a web page could make", async () => {
  await handshake();
  const noHeader = await fetch(`${base}/pull?session=s-edit&cursor=0`);
  expect(noHeader.status).toBe(403);
  const withOrigin = await fetch(`${base}/pull?session=s-edit&cursor=0`, {
    headers: { ...PLUGIN_HEADERS, origin: "https://evil.example" },
  });
  expect(withOrigin.status).toBe(403);
  const fetchSite = await fetch(`${base}/push`, {
    method: "POST",
    headers: { ...PLUGIN_HEADERS, "sec-fetch-site": "cross-site" },
    body: JSON.stringify({ session: "s-edit" }),
  });
  expect(fetchSite.status).toBe(403);
  // /health stays open: second instances probe it to find a live daemon.
  expect((await fetch(`${base}/health`, { headers: { origin: "https://evil.example" } })).status).toBe(200);
});

test("a session cannot answer another session's job", async () => {
  await handshake();
  await handshake({ session: "s-play", role: "server" });
  const call = hub.call("sel.get", {}, { timeoutMs: 2000 });
  const [job] = (await jobsFrom(await pull())).jobs;
  expect(job).toBeDefined();
  const stolen = await fetch(`${base}/push`, {
    method: "POST",
    headers: PLUGIN_HEADERS,
    body: JSON.stringify({ session: "s-play", results: [{ id: job!.id, ok: true, data: ["forged"] }] }),
  });
  expect(stolen.status).toBe(200);
  await push({ results: [{ id: job!.id, ok: true, data: ["real"] }] });
  expect(await call).toEqual(["real"]);
});

test("a cursor past our seq is ignored instead of eating the queue", async () => {
  await handshake();
  const call = hub.call("sel.get", {}, { timeoutMs: 2000 });
  const res = await pull("s-edit", 9999);
  const { jobs } = await jobsFrom(res);
  expect(jobs).toHaveLength(1);
  await push({ results: [{ id: jobs[0]!.id, ok: true, data: [] }] });
  await call;
});

test("a non-loopback bind is refused outright", () => {
  expect(() => new Hub({ config: config(), version: VERSION, hostname: "0.0.0.0" })).toThrow(/loopback/);
  expect(isLoopbackHost("127.0.0.1")).toBe(true);
  expect(isLoopbackHost("[::1]")).toBe(true);
  expect(isLoopbackHost("192.168.1.10")).toBe(false);
});
