# OGSync bridge protocol v2

JSON over HTTP on loopback. One daemon per machine serves every Studio place
(`ogsync daemon run`, spawned by the first `ogsync serve`); the Studio plugin is
always the HTTP client. Wire version: `proto: 2`, exchanged in the handshake
and in `GET /id`.

All bodies are JSON. All daemon responses carry `serverVersion`. Non-2xx with
JSON body `{error: string, code?: string}`.

## Ports and discovery

The daemon binds only these ports, first free one wins, and the plugin scans
exactly this list (`CANDIDATE_PORTS` in `server/src/proto/types.ts`,
`plugin/src/Util/Ports.luau`):

    3667, 3668, 3669, 13667, 23667, 33667, 43667, 45667

On Windows the daemon first reads `netsh int ipv4 show excludedportrange
protocol=tcp` and skips candidates inside a Hyper-V/WSL reservation (those
blocks move across reboots). An explicit `--port`, `OGSYNC_PORT` or
`daemon.port` is tried before the list. The bound port is published in
`~/.ogsync/daemon.json` `{pid, port, version, proto, startedAt}`, trusted
only when that port's `GET /id` answers with the same pid.
`~/.ogsync/daemon.lock` keeps it to one daemon: `{pid, nonce, at}`, created
complete (temp file hard-linked into place). It is live while younger than
10 s, or while its pid is alive and answers `/id` as that pid; a stale lock is
taken over by renaming it to a unique name (one rename wins). A daemon
re-checks that it still holds its lock after binding and every 15 s, and exits
if not. `OGSYNC_HOME` relocates `~/.ogsync`. A preferred port outside the list
is warned about: the plugin finds it only if its panel names it.

The plugin tries its last good port (or the panel's port) first. When a
handshake cannot connect it scans the list with `GET /id`, skips daemons of
another proto, and follows a matching one wherever it answers; it never stays
pinned to a dead port. HttpService throttling ("requests exceeded limit") is
only backoff: it never drops the session or triggers a rescan. A pull that
cannot connect drops back to the handshake path, so a moved or restarted
daemon is found the same way.

## Identity

- `session` — GUID generated per plugin load (per DataModel). Key for polling.
- `place key` — `placeId`, or the normalized name (`" @ date"` suffix and case
  stripped) for an unsaved place. Edit and play DataModels of one place share
  it. A second Studio with the same place gets `<key>~2`, `~3`, …
- `role` — `edit` | `server` | `client`. Play clients never HTTP: they are
  reached through the play server's RemoteFunction broker, addressed as
  `client` or `client-N` (Nth player) in a target.
- `target` — `<place>[:<role>]`, place = alias (`[aliases]` in ogsync.toml),
  key, placeId or place name. Resolution never guesses: no target with several
  places connected, or a target matching several, is a `TARGET` error listing
  the candidates.

## Endpoints

### POST /handshake
Plugin → `{proto: 2, session, role, pluginVersion, placeId, placeName,
token?}`.
Daemon → `{proto: 2, serverVersion, accepted: bool, reason?, updatePlugin:
bool, syncEnabled: bool, projectName?, placeKey?, token}`.
`token` is a per-registration secret: every pull and push sends it as
`X-OGSync-Token`, and a wrong or missing one answers `409` exactly like an
unknown session. A re-handshake carrying the current token re-adopts the
registration; one without it (the plugin restarted its loop) starts a new
registration under the same id and voids the old secret, so a late goodbye
from the old one is refused.
Every place is accepted. `accepted:false` only for a malformed request or a
proto mismatch, whose `reason` names both versions and the fix ("plugin speaks
proto 1, daemon speaks proto 2: run `ogsync plugin install` (or restart
`ogsync serve`) and reload plugins in Studio"); the plugin then shows "Update required", scans for a daemon of its own proto
and otherwise retries every 30 s. Only `ogsync plugin
install` and `ogsync serve` ever write the plugin file, never the daemon.
A re-handshake with a known session id re-adopts that peer (same key, same
slot); a daemon restart answers `409` to pull/push and the plugin
re-handshakes with the same id.

### GET /pull?session=S&cursor=N
Long-poll, 25 s server timeout. Immediately returns queued jobs if any, else
parks. On timeout → `204 No Content` (plugin re-polls immediately; on network
error, backoff 1 s → ×1.5 → max 10 s).
Response 200: `{cursor, jobs: [{id, op, args}]}` — **all** queued jobs, not one.
`cursor` is a monotonically increasing per-session counter. The plugin stores it
on receipt and echoes it on the next pull, which acks every job up to that
point; acked jobs stay "in flight" until their result arrives.
A cursor **above** the daemon's own counter is ignored and logged (stale plugin
state after a daemon restart); both sides reset to 0 on every handshake.

Reconnects never lose a call and never run an op twice:
- same session re-handshakes → every unanswered job (queued or in flight) is
  delivered again; the plugin's job log (`Util/JobLog.luau`, last 512 ids)
  skips ids it is running or already ran, whose results are still in or
  through its push queue;
- a session drops without a goodbye (sweep after the session TTL) → its
  unanswered jobs wait 30 s for the same place and role to re-attach. A new
  plugin load (new session id) receives only jobs that were never delivered;
  delivered ones fail `NOPLUGIN: … may or may not have run`. No re-attach in
  time → `NOPLUGIN`.

Only requests carrying `X-OGSync-Plugin: 1` reach these endpoints, and any
request carrying `Origin` or `Sec-Fetch-*` is refused outright. Loopback is not
a trust boundary — a web page the user visits can reach 127.0.0.1, but cannot
set a custom header without a preflight the daemon never answers. Studio's
`HttpService` sends the header and none of the browser metadata.

### POST /push
Plugin → `{session, results?: [{id, ok: bool, data?, err?, partial?: bool}],
events?: [Event]}`. When the pushed results free the place's queue, the next
job rides back on this response (`{ok: true, jobs: [...]}`, already acked)
instead of waking the parked pull: one request per job, not two, against
Studio's HttpService budget. A push that fails in transport sends the plugin
back through the handshake, which redelivers anything it may have missed. `partial:true` streams incremental output for long jobs
(playtest logs, profiling); final result has `partial` absent.
Daemon → `{ok: true}`.

Events (plugin → daemon, fire-and-forget). A push from an unknown session
answers `409`; the plugin re-handshakes.
- `{ev: "scriptChanged", path, source?, hash, ts}` — source omitted when hash
  matches daemon shadow (daemon asks via job if it needs content).
- `{ev: "instAdded"|"instRemoved"|"instRenamed", path, class?, oldPath?}`
- `{ev: "log", ctx: "edit"|"server"|"client", level, msg, ts}`
- `{ev: "playtestState", state: "idle"|"starting"|"running"|"stopping"|"stopped",
  mode?: "play"|"run", players?, hb: true}` — pushed on change and every 5 s
  by edit and play-server peers; `stopped` from a play peer drops it
- `{ev: "goodbye"}` — plugin unloading or disconnecting: the peer is dropped
  at once and its calls fail `NOPLUGIN`. A play server sends `playtestState
  stopped` in the same push first.
- `{ev: "selection", paths}`
- `{ev: "syncToggle", paused}` — user hit Pause/Resume in the plugin panel
- `{ev: "resolveConflict", file, keep: "fs"|"studio"}` — panel conflict button

### GET /id
`{service: "ogsync", version, proto, pid}` — the cheap identity probe the
plugin's port scan and every client use. Never authenticated.

### GET /state
Never authenticated, answered from memory (no Studio round trip):

```
{daemon: {version, proto, pid, port, startedAt},
 places: [{key, name, placeId,
           peers: [{role, pluginVersion, ageMs}],
           playtest: {state: "idle"|"starting"|"running"|"stopping"|"unknown",
                      mode, owner, startedBy: "agent"|"user"|null, since,
                      heartbeatAgeMs, players, stale, warning}}]}
```

`state` is `unknown` until a place's first heartbeat and whenever its last one
is older than 15 s; consumers (Claude Code hooks blocking edits during a
playtest) must treat `unknown` as "playtest may be running". A place whose
peers vanished without a goodbye stays listed (as `unknown`) for 2 minutes.
`ogsync status --json` prints this body.

### GET /health
`{service: "ogsync", version, proto, sessions: [{role, placeName, placeId,
placeKey, pluginVersion, age}], bound: placeKey|null, sync: {enabled,
pending, conflicts}}`. Diagnostics. Never authenticated. Session ids never
appear on open routes: pull/push key on them.

### POST /rpc  (clients: session proxies, CLI)
`{tool, args, caller: {id, cwd?, label?}}` → the tool executed in the daemon,
`{ok: true, result: CallToolResult}`. `caller.id` is the lease owner and the
fairness key; `caller.cwd` selects the ogsync.toml that supplies the default
target, aliases and playtest limits (and the sync engine for the `sync`
tool). `args.target` overrides the default. `{op, args, timeoutMs}` runs one
raw op against the daemon's own default target (diagnostics).
Identical `logs` / `playtest status` calls from one caller inside 1 s answer
`ERR THROTTLED: … retry after N ms`.

### POST /attach
`{client, cwd}` — keeps that project's sync engine alive in the daemon; a
session repeats it every 15 s and an engine without an attach for 45 s stops.

### POST /shutdown
Stops the daemon (`ogsync daemon stop`).

`/rpc`, `/attach` and `/shutdown` need `Authorization: Bearer
<~/.ogsync/token>` (generated 0600 on first run). Plugin endpoints
(`/handshake`, `/pull`, `/push`) are localhost-trust (Studio can't read the
token file) — bind stays loopback-only, non-loopback bind refused (no
override). `GET /health`, `/id`, `/state` also answer browser-originated
requests: read-only, no secrets, and CORS keeps pages from reading them.

## Scheduling

Ops to one place run one at a time (Studio runs all of a place's DataModels on
one main thread; fan-out only starves its renderer). Callers take turns
round-robin, so a chatty session cannot starve another's single call.
`play.stop`, `play.stopSignal`, `play.status` and `run.job` (poll/collect/
cancel of an eval that is already running; collect may wait `wait_ms`)
bypass the queue. Each job carries `timeoutMs`, the daemon's deadline; the
play server's client broker waits that long (minus 1 s) instead of a fixed
10 s. The call
timeout includes time spent waiting for a turn.

## Clients

Sessions, the CLI and doctor talk to the daemon with node:http requests,
`agent: false` and `connection: close` — never fetch/undici keep-alive pools —
and add `127.0.0.1,localhost,::1` to `NO_PROXY`/`no_proxy` at startup, because
Bun honours `HTTP(S)_PROXY` for loopback too. Outgoing internet requests keep
the user's proxy. A refused connection means the daemon is gone: the client
respawns it and retries that request once; nothing else is retried. A client
that finds a daemon speaking an older proto stops it (`POST /shutdown`), waits
for its pid to exit, and starts its own; a newer-proto daemon is left alone and
the client fails with `VERSION` (update ogsync). A mere version difference is
only logged (`ogsync daemon stop` picks up a new build on the next call).

## Jobs (daemon → plugin ops)

`op` strings are namespaced: `inst.get`, `inst.set`, `inst.create`,
`inst.delete`, `inst.duplicate`, `inst.find`, `inst.tree`, `script.read`,
`script.edit`, `script.grep`, `run.exec`, `play.start`, `play.stop`,
`play.stopSignal`, `play.status`, `play.hashes`, `wait.check`, `log.tail`,
`shot.capture`, `prof.micro`,
`prof.script`, `prof.memory`, `input.batch`, `asset.op`, `rbxm.export`,
`rbxm.import`, `hist.op`, `sel.get`, `sync.apply`, `sync.snapshot`,
`sync.hash`, `sync.conflicts`, `run.job`, `script.stage`, `inst.transform`.

Args/results per op mirror docs/TOOLS.md param/output contracts; the daemon
does arg validation + output formatting, the plugin returns raw structured
data (arrays/maps, not prose). Response data from plugin capped at 1 MB per
result — plugin truncates lists with `{truncated: true, total}` markers;
daemon renders `…more` cursors.

## Playtest lifecycle

The daemon keeps one state machine per place, driven by what the plugin
reports (`playtestState` heartbeats) plus play-server peer presence:
`idle → starting → running → stopping → idle`, `unknown` when heartbeats
stop. A start that is not reported running within 30 s returns to `idle`
with a warning.

- **Leases.** `play.start` records the calling client as owner; its 30 s
  start timeout counts from when the op reaches the plugin, not from
  admission. The agent is credited only when the plugin's result says it
  launched the test; `{already: true}` from the plugin means someone else did
  (no lease, `startedBy: "user"`). A second start by the owner answers
  `{already: true, yours: true}`, by anyone else `LEASE`. A stop while the
  owner's start is still queued cancels it (`{stopped: false, state: "idle",
  cancelledStart: true}`).
  `play.stop` by a non-owner, of a playtest no agent started (`startedBy:
  "user"`), or while `unknown`, is refused with `LEASE` unless `force: true`.
  Stop while idle answers `{stopped: false, state: "idle"}`.
- **Limits** (`[playtest]` in the starter's ogsync.toml): `max_clients`
  (default 2; a start that would spawn more is refused, and an agent-owned
  test whose player count exceeds it is stopped), `auto_end_s` (default 1800;
  agent-owned tests are stopped after it, 0 disables), `plugin_grace_s`
  (default 10).
- **Stale code.** 2 s after a play-server peer registers, the daemon runs
  `play.hashes` on it and on the edit peer (`{hashes: {path: hash}, total,
  truncated}`, chunked across frames) and reports scripts that differ or are
  missing in the test as `playtest.stale`.
- **Test-mode plugins.** An edit peer reporting a running play test with no
  play-server peer after `plugin_grace_s` sets `playtest.warning`: "Load User
  Plugins in Test Mode" is probably off.

## Runtime-context routing

`run.exec`, `run.job`, `log.tail`, `input.batch` and `shot.capture` carry
`context` (`ctx` accepted). `server`/`client` route to the play-server session
(`NOPLUGIN` when no playtest runs); the play server's dispatcher relays
`client` jobs over the broker to the player named by `player` (default: the
first). Anything else goes to the bound edit session.

## Eval jobs

- `run.exec {code, context, player?, vm?: "game"|"plugin", async?, key?}`.
  `vm` defaults to `game` for server/client and `plugin` for edit.
  Synchronous result: `{id, gen, key?, vm, context, status: "done", elapsed,
  output: [{level, text}], dropped, truncated, returns}`; a failed eval is an
  error whose message ends in ` [vm=game|plugin]` plus the captured output.
  `async: true` answers at once with `{job, gen, nonce, key?, vm, context,
  async: true}`. `nonce` is 8 hex chars generated per plugin load (so per play
  DataModel); the daemon puts it in the handle.
- `run.job {action: "poll"|"collect"|"cancel"|"list", id?, nonce?, wait_ms?,
  context, player?}` → the same snapshot shape (plus `nonce`); a `nonce` other
  than the session's is refused, because ids restart at 1 per DataModel. `list`
  answers `{jobs, nonce}`. Snapshot shape (`status`: `running`|`done`|`error`|
  `cancelled`, `err` for the last two), or `{jobs: [{id, gen, key, vm, context,
  status, elapsed}]}` for `list`. `collect` waits up to `wait_ms` and drops a
  settled job; the daemon sets the call timeout above `wait_ms`.
- Generations: ids are the per-session generation counter. A job started with
  the `key` of an earlier job cancels it; `ogsync.delay` timers and a late
  finish from a cancelled or superseded job are dropped. The bridge keeps the
  cancel switch of the 64 most recent game-VM evals, so a superseding job can
  still disarm timers armed by one that already returned.
- Recorded writes (see Place writes) run one at a time in the plugin, so one
  op's Cancel cannot roll back another op's write that landed while it yielded.
- Game-VM transport (plugin ⇄ injected bridge, same DataModel): one
  `BindableFunction` `Invoke` under the bridge script. Messages
  `{kind: "exec", id, gen, module}` (blocks until settled), `{kind: "peek", id}`
  and `{kind: "cancel", id}`; replies are one JSON string, because Bindable
  marshalling drops mixed tables and nil holes.

## Script text

Ops that carry script text (`script.edit` `old`/`new`/`source`, `inst.set`
targets' `source`) send field `F` as `F_b64` (base64 of the LF-normalized
UTF-8 bytes) or `F_upload` (a staged upload id), plus `F_hash`
(`contentHash` of the LF text). Plain `F` from older daemons is still accepted.
The plugin refuses text whose hash differs, and after writing reads it back
(`ScriptEditorService:GetEditorSource` when a document is open, `Source`
otherwise) and refuses a write that did not stick. `script.edit` answers
`{…, hash, verified: true, editor}`; `inst.set` adds
`sources: [{path, hash, editor}]`.

- `script.stage {upload, index, total, data}` → `{upload, received, total}`.
  `data` is a slice of the base64 text (64 KiB, whole 4-char groups). Chunks may
  arrive in any order; the consuming op fails when the upload is incomplete,
  unknown or expired (staged chunks live 120 s; at most 16 uploads per session).

## Place writes

`inst.set`, `inst.create`, `inst.delete`, `inst.duplicate`, `inst.transform`,
`script.edit` and `script.grep` with `replace` each run inside one
`ChangeHistoryService:TryBeginRecording`/`FinishRecording` pair (Commit on
success, Cancel when the op throws). `inst.delete` detaches with `Parent = nil`
in edit mode so Undo can restore it.

- `inst.transform {targets: [{path|paths, move?, rotate?, origin?, to?}],
  dryRun?}` → `{dryRun?, moved?, planned: [{path, from, to, rotFrom, rotTo}],
  truncated, total, skipped: [{path, ancestor}], errors}`. Positions are
  `[x,y,z]`, rotations Orientation degrees, rounded to 0.001. Targets are
  computed from original pivots, applied with `PivotTo`, then re-read; drift
  over 0.001 studs is an error entry.

## Capture and input

- `shot.capture {target, context, player?, frame?, camera_focus?, hide_ui?, size,
  capture_timeout_ms?}` → `{w, h, rgba, source: {w, h}, stride, viewport: {w, h},
  inset: {x, y}, scale, warnings: [string]}`. `scale = w / viewport.w`.
- `input.batch {actions, context, player?}`; click acks add `x, y, hit, layer,
  reached?, activated?`. Unsupported input is an ack with `ok: false, err:
  "… unsupported: <reason>"`.

## Play-mode specifics

- Play server session handshakes with `role: "server"`. Client-context ops
  (`run.exec` ctx=client, client logs, any op targeted at `:client-N`) are
  delivered to the play-server session with `ctx: "client"` (and `player`),
  which brokers to the target client over RemoteFunction
  `ReplicatedStorage.__OGSyncBroker` and relays results.
- `play.start` (edit session) prefers `StudioTestService:ExecutePlayModeAsync`
  for solo, tracked until the test ends, then the legacy play-solo probes, then
  `RunService:Run()`; the result says which (`started`, `requested`, `via`).
- `wait.check {kind: "instance"|"attribute", path, name?, value?}` →
  `{met, exists, value?}`: one non-yielding probe; the `wait` tool repeats it.
- `play.stop` routes to the play-server session, which calls
  `StudioTestService:EndTest` (else `RunService:Stop()`).
  Stopping tears down the session answering the job, so the daemon treats a
  `TIMEOUT`/`NOPLUGIN` on that call as success. Fallback for a wedged play
  session: `play.stopSignal` to the edit session writes
  `plugin:SetSetting("ogsync_stop_token", <guid>)`, which the play-mode instance
  polls every 0.5 s and acts on. Multi-client team test cannot be launched from
  plugin APIs — `playtest` exposes solo and server modes only.

## Sync ops

- `sync.snapshot {roots: [path]}` → full script/container listing under roots:
  `[{path, class, hash, runCtx}]` (no sources). Daemon diffs against FS+shadow.
- `sync.hash {paths}` → `[{path, hash}]`.
- `sync.conflicts {list: [{file, path, ts}]}` → `{ok: true}` — informational,
  daemon pushes current conflict list for the plugin panel to render.
- `sync.apply {changes: [{kind: "write", path, class, source, baseHash?} |
  {kind: "create", path, class, source?} | {kind: "delete", path} |
  {kind: "rename", path, newName}]}` → per-change `{ok, conflictHash?}`.
  Plugin applies via `ScriptEditorService:UpdateSourceAsync` (merges with open
  editors); `baseHash` mismatch ⇒ change rejected with current hash (daemon
  resolves per conflict policy). Applied hashes recorded for echo suppression.
