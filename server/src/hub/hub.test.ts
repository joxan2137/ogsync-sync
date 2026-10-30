import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  type StateResponse,
} from "../proto/types.ts";
import { runAs, type Caller } from "./caller.ts";
import { Hub, isLoopbackHost, type HealthResponse, type IdResponse } from "./hub.ts";
import { parseTarget } from "./targets.ts";

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
  tokens.clear();
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
    body: JSON.stringify({ token: tokens.get(body.session), ...body }),
  });
  const answer = (await res.json()) as HandshakeResponse;
  if (answer.token !== undefined) tokens.set(body.session, answer.token);
  return answer;
}

/** Per-session secrets from the last handshake; pull/push present them. */
const tokens = new Map<string, string>();

function sessionHeaders(session: string): Record<string, string> {
  return { ...PLUGIN_HEADERS, "x-ogsync-token": tokens.get(session) ?? "" };
}

/** Plugin endpoints require this; browsers cannot set it without a preflight. */
const PLUGIN_HEADERS = { "x-ogsync-plugin": String(PROTO_VERSION) };

async function pull(session = "s-edit", cursor = 0): Promise<Response> {
  return fetch(`${base}/pull?session=${session}&cursor=${cursor}`, { headers: sessionHeaders(session) });
}

async function push(body: Partial<PushRequest>): Promise<Response> {
  const session = body.session ?? "s-edit";
  return fetch(`${base}/push`, {
    method: "POST",
    headers: sessionHeaders(session),
    body: JSON.stringify({ session, ...body }),
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

test("handshake accepts every place; the default target still picks only target_place", async () => {
  await handshake();
  const res = await handshake({ session: "s-other", placeName: "SomeOtherPlace", placeId: 7 });
  expect(res.accepted).toBe(true);
  expect(res.placeKey).toBe("7");
  expect(hub.sessions()).toHaveLength(2);
  expect(hub.bound()?.session).toBe("s-edit");
});

test("a second Studio on the same place gets its own key and makes the id ambiguous", async () => {
  expect((await handshake()).placeKey).toBe("42");
  const second = await handshake({ session: "s-duplicate" });
  expect(second.accepted).toBe(true);
  expect(second.placeKey).toBe("42~2");
  const ambiguous = expectBridgeError(await capture(hub.callTarget(parseTarget("42"), {}, "sel.get", {})));
  expect(ambiguous.code).toBe("TARGET");
  expect(ambiguous.message).toContain("42~2");
  const exact = hub.callTarget(parseTarget("42~2"), {}, "sel.get", {}, { timeoutMs: 2_000 });
  const [job] = (await jobsFrom(await pull("s-duplicate"))).jobs;
  await push({ session: "s-duplicate", results: [{ id: job!.id, ok: true, data: [] }] });
  expect(await exact).toEqual([]);
});

test("handshake refuses a proto mismatch naming both versions and the install command", async () => {
  const res = await fetch(`${base}/handshake`, {
    method: "POST",
    headers: { "x-ogsync-plugin": "1" },
    body: JSON.stringify({ proto: 1, session: "s-old", role: "edit", pluginVersion: "0.0.1", placeId: 42, placeName: "Place2" }),
  });
  const body = (await res.json()) as HandshakeResponse;
  expect(body.accepted).toBe(false);
  expect(body.updatePlugin).toBe(true);
  expect(body.reason).toContain("proto 1");
  expect(body.reason).toContain(`proto ${PROTO_VERSION}`);
  expect(body.reason).toContain("ogsync plugin install");
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

test("in run mode the edit peer is the server: server-context ops route to it, clients do not exist", async () => {
  await handshake();
  await report("running", "s-edit", { mode: "run" });
  const exec = hub.call("run.exec", { code: "return 1", context: "server", vm: "game" }, { timeoutMs: 2_000 });
  const [job] = (await jobsFrom(await pull())).jobs;
  expect(job).toMatchObject({ op: "run.exec", args: { context: "server" } });
  await push({ results: [{ id: job!.id, ok: true, data: 1 }] });
  expect(await exec).toBe(1);

  const job2 = hub.callTarget(parseTarget("Place2:server"), {}, "run.job", { action: "list", context: "server" }, { timeoutMs: 2_000 });
  const [listed] = (await jobsFrom(await pull("s-edit", 1))).jobs;
  expect(listed!.op).toBe("run.job");
  await push({ results: [{ id: listed!.id, ok: true, data: { jobs: [] } }] });
  await job2;

  const client = expectBridgeError(await capture(hub.call("run.exec", { code: "return 1", context: "client" })));
  expect(client.code).toBe("NOPLUGIN");
  expect(client.message).toContain("run mode");

  // Once the run ends, server context needs a play server again.
  await report("idle");
  const after = expectBridgeError(await capture(hub.call("run.exec", { code: "return 1", context: "server" })));
  expect(after.message).toContain("needs a play-server session");
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
  expect(health.bound).toBe("42");
  expect(JSON.stringify(health)).not.toContain("s-edit");
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

test("without target_place one place is the target and two are an explicit error", async () => {
  restart({ target_place: null });
  expect((await handshake({ session: "s-first", placeName: "Anything" })).accepted).toBe(true);
  expect(hub.bound()?.session).toBe("s-first");
  // Picking "first connected" would let sync and tools drive the wrong game.
  expect((await handshake({ session: "s-second", placeName: "OtherPlace", placeId: 99 })).accepted).toBe(true);
  expect(hub.bound()).toBeNull();
  const err = expectBridgeError(await capture(hub.call("sel.get", {})));
  expect(err.code).toBe("TARGET");
  expect(err.message).toContain("2 places connected");
  expect(err.message).toContain("99 (OtherPlace)");
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
    headers: sessionHeaders("s-play"),
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

function restart(bind: Partial<OgsyncConfig["bind"]> = { target_place: "Place2" }, extra: Partial<ConstructorParameters<typeof Hub>[0]> = {}): void {
  hub.stop();
  hub = new Hub({ config: config(bind), version: VERSION, port: 0, longPollMs: LONG_POLL_MS, ...extra });
  hub.listen();
  base = `http://127.0.0.1:${hub.port}`;
}

function caller(id: string): Caller {
  return { id, playtest: { ...CONFIG_DEFAULTS.playtest } };
}

async function report(state: string, session = "s-edit", extra: Record<string, unknown> = {}): Promise<void> {
  await push({ session, events: [{ ev: "playtestState", state, hb: true, ...extra } as BridgeEvent] });
}

async function answerNext(session: string, data: unknown): Promise<string> {
  const [job] = (await jobsFrom(await pull(session))).jobs;
  await push({ session, results: [{ id: job!.id, ok: true, data }] });
  return job!.op;
}

test("ops to one place run one at a time, round-robin across clients", async () => {
  await handshake();
  const order: string[] = [];
  const a1 = runAs(caller("a"), () => hub.call("sel.get", { n: "a1" }, { timeoutMs: 2_000 }));
  const a2 = runAs(caller("a"), () => hub.call("sel.get", { n: "a2" }, { timeoutMs: 2_000 }));
  const b1 = runAs(caller("b"), () => hub.call("sel.get", { n: "b1" }, { timeoutMs: 2_000 }));
  let jobs = (await jobsFrom(await pull())).jobs;
  for (let i = 0; i < 3; i += 1) {
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    order.push((job.args as { n: string }).n);
    // The next admitted job rides back on the push that freed the slot.
    const res = await push({ results: [{ id: job.id, ok: true, data: [] }] });
    jobs = ((await res.json()) as { jobs?: typeof jobs }).jobs ?? [];
  }
  await Promise.all([a1, a2, b1]);
  expect(order).toEqual(["a1", "b1", "a2"]);
});

test("a re-handshake of the same session redelivers in-flight jobs instead of failing them", async () => {
  await handshake();
  const call = hub.call("inst.get", { path: "game" }, { timeoutMs: 2_000 });
  const first = await jobsFrom(await pull());
  // ack by cursor: the job is now in flight, not queued
  const parked = pull("s-edit", first.cursor);
  await Bun.sleep(20);
  await handshake();
  expect((await parked).status).toBe(204);
  const again = await jobsFrom(await pull());
  expect(again.jobs.map((job) => job.id)).toEqual(first.jobs.map((job) => job.id));
  await push({ results: [{ id: again.jobs[0]!.id, ok: true, data: "ok" }] });
  expect(await call).toBe("ok");
});

test("an expired peer's calls wait for the place to re-attach within the grace window", async () => {
  restart(undefined, { sessionTtlMs: 150, sweepMs: 20, graceMs: 2_000 });
  await handshake();
  const delivered = capture(hub.call("inst.get", {}, { timeoutMs: 3_000 }));
  await jobsFrom(await pull());
  await Bun.sleep(300); // swept: no pull for longer than the TTL
  expect(hub.sessions()).toHaveLength(0);
  const queued = hub.call("sel.get", {}, { timeoutMs: 3_000 });

  // A new plugin load (new session id) takes the slot: the job it may already
  // have run fails honestly, the one it never saw is delivered.
  await handshake({ session: "s-new" });
  const err = expectBridgeError(await capture(delivered));
  expect(err.code).toBe("NOPLUGIN");
  expect(err.message).toContain("may or may not have run");
  expect(await answerNext("s-new", ["game.Workspace"])).toBe("sel.get");
  expect(await queued).toEqual(["game.Workspace"]);
});

test("target roles route to the play server, client-N with ctx=client and the player index", async () => {
  await handshake();
  await handshake({ session: "s-play", role: "server" });
  const call = hub.callTarget(parseTarget("Place2:client-2"), {}, "inst.get", { path: "game" }, { timeoutMs: 2_000 });
  const [job] = (await jobsFrom(await pull("s-play"))).jobs;
  expect(job!.args).toEqual({ path: "game", ctx: "client", player: 2 });
  await push({ session: "s-play", results: [{ id: job!.id, ok: true, data: 1 }] });
  expect(await call).toBe(1);
  const noServer = expectBridgeError(await capture(hub.callTarget(parseTarget("Place2:edit"), {}, "sel.get", {}, { timeoutMs: 50 })));
  expect(noServer.code).toBe("TIMEOUT");
});

test("playtest start records a lease; another client cannot stop it without force", async () => {
  await handshake();
  await report("idle");
  const start = runAs(caller("agent-a"), () => hub.call("play.start", { mode: "solo" }, { timeoutMs: 2_000 }));
  expect(await answerNext("s-edit", { started: "solo" })).toBe("play.start");
  expect(await start).toEqual({ started: "solo" });
  expect(hub.place()?.playtest.state).toBe("starting");
  await report("running", "s-edit", { mode: "play" });
  expect(hub.place()?.playtest).toMatchObject({ state: "running", owner: "agent-a", startedBy: "agent" });

  const again = await runAs(caller("agent-a"), () => hub.call("play.start", { mode: "solo" }));
  expect(again).toMatchObject({ already: true });
  const otherStart = expectBridgeError(await capture(runAs(caller("agent-b"), () => hub.call("play.start", {}))));
  expect(otherStart.code).toBe("LEASE");
  const refused = expectBridgeError(await capture(runAs(caller("agent-b"), () => hub.call("play.stop", {}))));
  expect(refused.code).toBe("LEASE");
  expect(refused.message).toContain("agent-a");

  const forced = runAs(caller("agent-b"), () => hub.call("play.stop", { force: true }, { timeoutMs: 2_000 }));
  expect(await answerNext("s-edit", { stopped: true })).toBe("play.stop");
  await forced;
  expect(hub.place()?.playtest.state).toBe("stopping");
  await report("idle");
  expect(hub.place()?.playtest).toMatchObject({ state: "idle", owner: null });
});

test("a playtest started in Studio is never stopped without force, and stop when idle is a no-op", async () => {
  await handshake();
  await report("idle");
  expect(await runAs(caller("agent"), () => hub.call("play.stop", {}))).toEqual({ stopped: false, state: "idle" });
  await handshake({ session: "s-play", role: "server" });
  await report("running", "s-play", { players: 1 });
  expect(hub.place()?.playtest).toMatchObject({ state: "running", startedBy: "user", owner: null, players: 1 });
  const err = expectBridgeError(await capture(runAs(caller("agent"), () => hub.call("play.stop", {}))));
  expect(err.code).toBe("LEASE");
  expect(err.message).toContain("started in Studio");
});

test("GET /state and /id answer without auth and with the playtest shape hooks read", async () => {
  await handshake();
  const id = (await (await fetch(`${base}/id`)).json()) as IdResponse;
  expect(id).toMatchObject({ service: "ogsync", version: VERSION, proto: PROTO_VERSION });
  let state = (await (await fetch(`${base}/state`)).json()) as StateResponse;
  expect(state.daemon).toMatchObject({ version: VERSION, proto: PROTO_VERSION, port: hub.port });
  expect(state.places[0]).toMatchObject({ key: "42", name: "Place2", peers: [{ role: "edit" }] });
  // Session ids key pull/push; open routes never show them.
  expect(JSON.stringify(state)).not.toContain("s-edit");
  // No heartbeat yet: consumers must be able to fail closed.
  expect(state.places[0]!.playtest).toMatchObject({ state: "unknown", heartbeatAgeMs: null });
  await report("idle");
  state = (await (await fetch(`${base}/state`)).json()) as StateResponse;
  expect(state.places[0]!.playtest.state).toBe("idle");
  expect(state.places[0]!.playtest.heartbeatAgeMs).toBeLessThan(1_000);
});

test("a goodbye drops the peer at once and fails its calls", async () => {
  await handshake();
  const call = capture(hub.call("inst.get", {}, { timeoutMs: 2_000 }));
  await jobsFrom(await pull());
  await push({ events: [{ ev: "goodbye" }] });
  expect(expectBridgeError(await call).code).toBe("NOPLUGIN");
  expect(hub.sessions()).toHaveLength(0);
  expect(hub.state().places).toHaveLength(0);
});

test("pull and push need the handshake secret; a re-registration voids the old one", async () => {
  const first = await handshake();
  const forged = await fetch(`${base}/pull?session=s-edit&cursor=0`, { headers: PLUGIN_HEADERS });
  expect(forged.status).toBe(409);
  tokens.delete("s-edit"); // plugin restarted its loop: no secret to prove a reconnect
  const second = await handshake();
  expect(second.token).not.toBe(first.token);
  // A goodbye still carrying the old secret is a stranger's and changes nothing.
  const late = await fetch(`${base}/push`, {
    method: "POST",
    headers: { ...PLUGIN_HEADERS, "x-ogsync-token": first.token! },
    body: JSON.stringify({ session: "s-edit", events: [{ ev: "goodbye" }] }),
  });
  expect(late.status).toBe(409);
  expect(hub.sessions()).toHaveLength(1);
});

test("a job admitted by a pushed result rides back on the push response", async () => {
  await handshake();
  const first = hub.call("sel.get", { n: 1 }, { timeoutMs: 2_000 });
  const second = hub.call("sel.get", { n: 2 }, { timeoutMs: 2_000 });
  const delivered = await jobsFrom(await pull());
  expect(delivered.jobs).toHaveLength(1);
  const parked = pull("s-edit", delivered.cursor);
  const res = await push({ results: [{ id: delivered.jobs[0]!.id, ok: true, data: [] }] });
  const body = (await res.json()) as { jobs?: { id: string; args: { n: number } }[] };
  expect(body.jobs?.map((job) => job.args.n)).toEqual([2]);
  await push({ results: [{ id: body.jobs![0]!.id, ok: true, data: ["x"] }] });
  expect(await first).toEqual([]);
  expect(await second).toEqual(["x"]);
  // The parked pull was never woken for it, and never resends it.
  expect((await parked).status).toBe(204);
});

test("a stop cancels a play.start still queued behind another op", async () => {
  await handshake();
  await report("idle");
  const busy = hub.call("sel.get", {}, { timeoutMs: 2_000 });
  const busyJob = (await jobsFrom(await pull())).jobs[0]!;
  const start = capture(runAs(caller("a"), () => hub.call("play.start", { mode: "solo" }, { timeoutMs: 2_000 })));
  expect(hub.place()?.playtest.state).toBe("starting");
  const stop = await runAs(caller("a"), () => hub.call("play.stop", {}));
  expect(stop).toEqual({ stopped: false, state: "idle", cancelledStart: true });
  const err = expectBridgeError(await start);
  expect(err.code).toBe("LEASE");
  expect(hub.place()?.playtest).toMatchObject({ state: "idle", owner: null });
  await push({ results: [{ id: busyJob.id, ok: true, data: [] }] });
  await busy;
});

test("a start the plugin answers `already` leaves no lease and credits the user", async () => {
  await handshake();
  await report("idle");
  const start = runAs(caller("a"), () => hub.call("play.start", { mode: "solo" }, { timeoutMs: 2_000 }));
  const job = (await jobsFrom(await pull())).jobs[0]!;
  await report("running", "s-edit", { mode: "play" });
  await push({ results: [{ id: job.id, ok: true, data: { already: true, mode: "play" } }] });
  expect(await start).toMatchObject({ already: true, yours: false });
  expect(hub.place()?.playtest).toMatchObject({ state: "running", owner: null, startedBy: "user" });
});

describe("pairing play peers of unsaved places (placeId 0)", () => {
  const LOCAL = { placeId: 0, placeName: "OGSyncTest.rbxl" };

  test("the launch token from play.start pairs the generic-named play server with its edit place", async () => {
    restart({ target_place: "ogsynctest.rbxl" });
    expect((await handshake(LOCAL)).placeKey).toBe("ogsynctest.rbxl");
    await report("idle");
    const start = runAs(caller("a"), () => hub.call("play.start", { mode: "solo" }, { timeoutMs: 2_000 }));
    await answerNext("s-edit", { started: "solo", launch: "tok-1" });
    await start;
    // Another placeId-0 edit place is open too: only the token can tell them apart.
    await handshake({ session: "s-other", placeId: 0, placeName: "Scratch" });
    const play = await handshake({ session: "s-play", role: "server", placeId: 0, placeName: "Game", launch: "tok-1" });
    expect(play.placeKey).toBe("ogsynctest.rbxl");
    expect(hub.state().places.map((place) => place.key).sort()).toEqual(["ogsynctest.rbxl", "scratch"]);
    expect(hub.place()?.name).toBe("OGSyncTest.rbxl");

    const exec = hub.call("run.exec", { code: "return 1", context: "server" }, { timeoutMs: 2_000 });
    expect(await answerNext("s-play", 1)).toBe("run.exec");
    expect(await exec).toBe(1);
    // play.stop reaches the paired play server.
    const stop = runAs(caller("a"), () => hub.call("play.stop", {}, { timeoutMs: 2_000 }));
    expect(await answerNext("s-play", { stopped: true })).toBe("play.stop");
    await stop;
  });

  test("without a token it joins the only placeId-0 edit place lacking a play server", async () => {
    restart({ target_place: null });
    await handshake(LOCAL);
    const play = await handshake({ session: "s-play", role: "server", placeId: 0, placeName: "Game" });
    expect(play.placeKey).toBe("ogsynctest.rbxl");
    expect(hub.state().places).toHaveLength(1);
  });

  test("several candidates stay separate, with a warning naming them; another placeId never merges", async () => {
    restart({ target_place: null });
    await handshake(LOCAL);
    await handshake({ session: "s-other", placeId: 0, placeName: "Scratch" });
    const play = await handshake({ session: "s-play", role: "server", placeId: 0, placeName: "Game" });
    expect(play.placeKey).toBe("game");
    const game = hub.state().places.find((place) => place.key === "game")!;
    expect(game.playtest.warning).toContain("ogsynctest.rbxl or scratch");

    const published = await handshake({ session: "s-pub", role: "server", placeId: 77, placeName: "Game", launch: "tok-x" });
    expect(published.placeKey).toBe("77");
  });
});
