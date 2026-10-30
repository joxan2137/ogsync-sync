# OGSync bridge protocol v1

JSON over HTTP, daemon binds `127.0.0.1:3667` (`OGSYNC_PORT` overrides). The
Studio plugin is always the HTTP client. Wire version: `proto: 1` — plugin and
daemon exchange it in handshake; mismatch ⇒ plugin shows update banner and
stops polling (except the version fields themselves).

All bodies are JSON. All daemon responses carry `serverVersion`. Non-2xx with
JSON body `{error: string, code?: string}`.

## Identity

- `session` — GUID generated per plugin load (per DataModel). Key for polling.
- `place` — `{placeId, placeName}` reported at handshake; daemon binds ops to
  ONE session per `target_place` config (dev machine: `"Place2"`). Never
  broadcasts.
- `role` — `edit` | `server` | `client` (play-mode DataModels handshake
  separately; clients are proxied by the play server via the RemoteFunction
  broker, they never HTTP directly).

## Endpoints

### POST /handshake
Plugin → `{proto: 1, session, role, pluginVersion, placeId, placeName}`.
Daemon → `{proto: 1, serverVersion, accepted: bool, reason?, updatePlugin:
bool, syncEnabled: bool, projectName?}`.
`accepted:false` when another session already bound for this place-role, or
place doesn't match `target_place`. Rejected sessions re-handshake every 5 s.

### GET /pull?session=S&cursor=N
Long-poll, 25 s server timeout. Immediately returns queued jobs if any, else
parks. On timeout → `204 No Content` (plugin re-polls immediately; on network
error, backoff 1 s → ×1.5 → max 10 s).
Response 200: `{cursor, jobs: [{id, op, args}]}` — **all** queued jobs, not one.
`cursor` is a monotonically increasing per-session counter. The plugin stores it
on receipt and echoes it on the next pull, which acks every job up to that
point — delivery is at-most-once, not at-least-once: a job whose plugin-side
handler dies is answered by the call's TIMEOUT, never redelivered (re-running
`inst.delete` or `sync.apply` would be worse than failing).
A cursor **above** the daemon's own counter is ignored and logged (stale plugin
state after a daemon restart); both sides reset to 0 on every handshake.

Only requests carrying `X-OGSync-Plugin: 1` reach these endpoints, and any
request carrying `Origin` or `Sec-Fetch-*` is refused outright. Loopback is not
a trust boundary — a web page the user visits can reach 127.0.0.1, but cannot
set a custom header without a preflight the daemon never answers. Studio's
`HttpService` sends the header and none of the browser metadata.

### POST /push
Plugin → `{session, results?: [{id, ok: bool, data?, err?, partial?: bool}],
events?: [Event]}`. `partial:true` streams incremental output for long jobs
(playtest logs, profiling); final result has `partial` absent.
Daemon → `{ok: true}`.

Events (plugin → daemon, fire-and-forget):
- `{ev: "scriptChanged", path, source?, hash, ts}` — source omitted when hash
  matches daemon shadow (daemon asks via job if it needs content).
- `{ev: "instAdded"|"instRemoved"|"instRenamed", path, class?, oldPath?}`
- `{ev: "log", ctx: "edit"|"server"|"client", level, msg, ts}`
- `{ev: "playtestState", state: "starting"|"running"|"stopped", mode?}`
- `{ev: "selection", paths}`
- `{ev: "syncToggle", paused}` — user hit Pause/Resume in the plugin panel
- `{ev: "resolveConflict", file, keep: "fs"|"studio"}` — panel conflict button

### GET /health
`{service: "ogsync", version, proto: 1, sessions: [{session, role, placeName,
age}], bound: session|null, sync: {enabled, pending, conflicts}}`.
Used by second instances to detect a live daemon (then proxy) and by
diagnostics. Never authenticated.

### POST /rpc  (daemon-internal clients: proxy instances, CLI)
`{tool, args}` → MCP tool executed as if called over stdio, result envelope
returned. Guarded by token: `Authorization: Bearer <~/.ogsync/token>`; token
auto-generated 0600 on first run. Plugin endpoints (`/handshake`, `/pull`,
`/push`) are localhost-trust (Studio can't read the token file) — bind stays
loopback-only, non-loopback bind refused (no override).

## Jobs (daemon → plugin ops)

`op` strings are namespaced: `inst.get`, `inst.set`, `inst.create`,
`inst.delete`, `inst.duplicate`, `inst.find`, `inst.tree`, `script.read`,
`script.edit`, `script.grep`, `run.exec`, `play.start`, `play.stop`,
`play.stopSignal`, `play.status`, `log.tail`, `shot.capture`, `prof.micro`,
`prof.script`, `prof.memory`, `input.batch`, `asset.op`, `rbxm.export`,
`rbxm.import`, `hist.op`, `sel.get`, `sync.apply`, `sync.snapshot`,
`sync.hash`, `sync.conflicts`, `run.job`, `script.stage`, `inst.transform`.

Args/results per op mirror docs/TOOLS.md param/output contracts; the daemon
does arg validation + output formatting, the plugin returns raw structured
data (arrays/maps, not prose). Response data from plugin capped at 1 MB per
result — plugin truncates lists with `{truncated: true, total}` markers;
daemon renders `…more` cursors.

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
  `async: true` answers at once with `{job, gen, key?, vm, context, async: true}`.
- `run.job {action: "poll"|"collect"|"cancel"|"list", id?, wait_ms?, context,
  player?}` → the same snapshot shape (`status`: `running`|`done`|`error`|
  `cancelled`, `err` for the last two), or `{jobs: [{id, gen, key, vm, context,
  status, elapsed}]}` for `list`. `collect` waits up to `wait_ms` and drops a
  settled job; the daemon sets the call timeout above `wait_ms`.
- Generations: ids are the per-session generation counter. A job started with
  the `key` of an earlier job cancels it; `ogsync.delay` timers and a late
  finish from a cancelled or superseded job are dropped.
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
  (`run.exec` ctx=client, client logs) are delivered to the play-server
  session, which brokers to the target client over RemoteFunction
  `ReplicatedStorage.__OGSyncBroker` and relays results.
- `play.stop` routes to the play-server session, which calls `RunService:Stop()`.
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
