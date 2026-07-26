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
`cursor` is a monotonically increasing ack counter; plugin echoes it back so
daemon can drop acked jobs (redelivery on reconnect if unacked).

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
`play.status`, `log.tail`, `shot.capture`, `prof.micro`, `prof.script`,
`prof.memory`, `input.batch`, `asset.op`, `rbxm.export`, `rbxm.import`,
`hist.op`, `sel.get`, `sync.apply`, `sync.snapshot`, `sync.hash`.

Args/results per op mirror docs/TOOLS.md param/output contracts; the daemon
does arg validation + output formatting, the plugin returns raw structured
data (arrays/maps, not prose). Response data from plugin capped at 1 MB per
result — plugin truncates lists with `{truncated: true, total}` markers;
daemon renders `…more` cursors.

## Play-mode specifics

- Play server session handshakes with `role: "server"`. Client-context ops
  (`run.exec` ctx=client, client logs) are delivered to the play-server
  session, which brokers to the target client over RemoteFunction
  `ReplicatedStorage.__OGSyncBroker` and relays results.
- `play.stop` is signaled via `plugin:SetSetting("ogsync_stop", token)` from
  the edit-mode plugin instance; play-mode instance watches the setting each
  Heartbeat (~0.5 s) and calls `StopAllPlayModeSolo`/equivalent. Daemon also
  marks the session stale.

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
