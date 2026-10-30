# Plugin module contract (Luau)

All modules `--!strict`. No external packages. JSON via `HttpService:JSONEncode/Decode`.
`plugin/src/Util/Hash.luau` is pre-written and bit-locked to the server — do not modify.

## Layout & ownership

```
plugin/src/
  init.server.luau        core  entry: role detect, toolbar, wiring, stop-monitor
  Net.luau                core  handshake/pull/push loops, port discovery, backoff, queues
  Lifecycle.luau          core  playtest state heartbeat (edit + play-server roles)
  Dispatcher.luau         core  op registry; requires all Ops/* and Sync/Ops
  Broker.luau             core  RemoteFunction broker (play server⇄clients)
  Sync/Watcher.luau       core  studio-side change detection → events
  Sync/Applier.luau       core  sync.apply/snapshot/hash ops, echo suppression
  Util/Hash.luau          (locked)
  Util/Path.luau          core  dot-path grammar resolve/serialize
  Util/Serde.luau         core  property value encode/decode
  Util/Output.luau        core  size-capped list/table builders
  Util/Ports.luau         core  daemon candidate ports (mirror of CANDIDATE_PORTS)
  Util/JobLog.luau        core  seen job ids, so redelivered jobs never run twice
  Util/PlayState.luau     core  playtest intent + StudioTestService activity, state derivation
  Util/ScriptHashes.luau  core  chunked path→hash map of every script (stale-code check)
  Ops/Inst.luau           ops   inst.get/set/create/delete/duplicate/find/tree
  Ops/Script.luau         ops   script.read/edit/grep
  Ops/Run.luau            ops   run.exec (edit ctx direct; server/client via daemon routing)
  Ops/Play.luau           core  play.start/stop/status/hashes
  Ops/Log.luau            ops   log.tail + log event forwarding
  Ops/Shot.luau           ops   shot.capture
  Ops/Prof.luau           ops   prof.micro/script/memory
  Ops/Input.luau          ops   input.batch (incl. nav)
  Ops/Asset.luau          ops   asset.op
  Ops/Rbxm.luau           ops   rbxm.export/import (base64 payloads)
  Ops/Hist.luau           ops   hist.op (undo/redo/waypoint)
  Ops/Sel.luau            ops   sel.get + selection events
  Ops/Wait.luau           core  wait.check (one non-yielding probe per call)
```

"core" = plugin-core agent; "ops" = ops agent. Ops modules must not require
core modules except `Util/*`.

## Module APIs (exact)

```lua
-- Util/Path.luau
Path.resolve(path: string): (Instance?, string?)      -- instance or (nil, err); supports @selection (returns first), @game, bracket names
Path.resolveMulti(path: string): ({Instance}, string?) -- @selection returns all selected
Path.of(inst: Instance): string                        -- dot-path with bracket escaping
Path.SERVICES: {[string]: boolean}                     -- top-level service allowlist for delete-refusal

-- Util/Serde.luau
Serde.encode(value: any): any        -- roblox value → JSON-safe (Rojo-style: Vector3 [x,y,z], Color3 [r,g,b] 0-1 floats, CFrame [12], UDim2 [[sx,ox],[sy,oy]], EnumItem "Enum.Material.Neon", Instance ref → dot-path string, BrickColor name, NumberSequence/ColorSequence keypoint arrays)
Serde.decode(value: any, targetType: string): (any, string?)  -- inverse; enum accepts short "Neon" when targetType known
Serde.readProp(inst: Instance, name: string): (boolean, any)  -- pcall'd read+encode
Serde.writeProp(inst: Instance, name: string, jsonValue: any): string?  -- nil ok / err msg

-- Util/Output.luau
Output.capList(items: {any}, maxBytes: number?): (list, truncated: boolean, total: number)  -- default 1 MB wire cap per PROTOCOL.md

-- Dispatcher.luau
Dispatcher.register(opName: string, handler: (args: any) -> any)  -- handler throws on error (error(msg)); Dispatcher pcalls
Dispatcher.dispatch(job): JobResult
-- Every Ops/X.luau returns `function(register) ... end` and registers its ops.

-- Net.luau
Net.start(config: {port: number, session: string, role: string})  -- port = preferred, see Util/Ports
Net.stop()                           -- pushes {ev:"goodbye"} first when accepted
Net.pushEvent(ev: table)             -- queued, flushed with next push (≤300 ms)
Net.pushPartial(jobId: string, data: any)
Net.setConnectedHook(fn: (() -> ())?)  -- called after every accepted handshake

-- Lifecycle.luau
Lifecycle.start(config: {role: string, pushEvent: (ev) -> ()}): () -> ()  -- returns stop
Lifecycle.connected()                -- report state now (fresh daemon state)

-- Util/PlayState.luau
PlayState.setIntent("idle"|"starting"|"stopping")
PlayState.setTestActive(active: boolean)   -- a StudioTestService play test is running
PlayState.derive(running, active, intent): {state, mode?}   -- pure
PlayState.snapshot(running: boolean): {state, mode?}
PlayState.onChange(fn): () -> ()
```

## Behavior requirements

- **Role detection** (init): `RunService:IsRunning()` false → role `edit`.
  Running + `IsServer()` → `server`; running + `IsClient()` → `client`.
  Client role: DO NOT start Net (HttpService is forbidden there even for
  plugins) — instead wait on Broker RemoteFunction invocations.
- **Server role**: starts Net + Broker host: creates RemoteFunction
  `ReplicatedStorage.__OGSyncBroker`, relays `run.exec` ctx=client and client
  log collection to the right player, tags results.
- **Stop monitor** (init, play-mode server role): poll
  `plugin:GetSetting("ogsync_stop_token")` every 0.5 s (plugin settings are
  shared across DataModels of one Studio); on change to an unseen value call
  `RunService:Stop()`. This is the fallback stop path that works even if the
  play session's Net loop is wedged.
- **Ops/Play**: idempotent. `play.start` (edit role) answers `{already: true}`
  when a test is already running. `mode="server"` → `RunService:Run()`.
  `mode="solo"` → `StudioTestService:ExecutePlayModeAsync` in its own thread
  (marks `PlayState.setTestActive` until it returns; a call that fails within
  0.5 s counts as unsupported), then the legacy plugin-security pcall chain,
  then run mode marked `{started: "run", requested: "solo"}` so the daemon
  reports the degradation honestly. `play.stop` answers `{stopped: false}`
  when nothing runs; otherwise `StudioTestService:EndTest`, else
  `RunService:Stop()`. Primary path — daemon routes the op to the play-server
  session; secondary — `play.stopSignal` to the edit session, which writes
  `plugin:SetSetting("ogsync_stop_token", GUID)` for the monitor above.
  `play.hashes` → `ScriptHashes.collect(game)`.
- **Transport (Net)**: never pinned to a port. A handshake that cannot connect
  scans `Ports.order(lastGood)` with `GET /id` and follows the daemon; a pull
  that cannot connect, or a pull/push answered 400/404/409, falls back to the
  handshake (same session id and token, so the daemon re-adopts the peer).
  Pull/push carry `X-OGSync-Token` from the handshake; `Net.start` begins a
  new registration (no token). Throttled HttpService calls only back off.
  Daemons answering `/id` with another proto are skipped; a handshake
  mismatch shows "Update required" and retries every 30 s. Jobs arriving on
  push responses run like pulled ones. Jobs pass through `JobLog`: an id
  already running or done is skipped (running ids are never evicted), so jobs
  the daemon redelivers after a reconnect never run twice.
- **Role detection** also treats `RunService:IsRunMode()` (F8 Run simulates in
  the edit DataModel) as `edit`.
- **Lifecycle**: edit and play-server roles push `{ev: "playtestState",
  state, mode?, players?, hb: true}` within 1 s of a change and every 5 s
  regardless; edit state is `PlayState.snapshot(RunService:IsRunning())`, the
  play server always reports `running` with its player count. The daemon reads
  a missing heartbeat as `unknown`.
- **Frame budget**: work that can exceed a few seconds in one frame trips
  Studio's "plugin is not responding" — yield between batches (`task.wait()`),
  as `ScriptHashes.collect` does every 100 scripts / 256 KB.
- **Echo suppression** (Applier): keep `lastApplied[path] = hash` — Watcher
  drops a scriptChanged whose new content hash equals `lastApplied[path]`
  (then clears the entry). Applier uses
  `ScriptEditorService:UpdateSourceAsync(script, fn)` returning the new source
  so open editors merge; never sets `.Source` directly on scripts open in the
  editor.
- **Watcher**: `ScriptEditorService.TextDocumentDidChange` (debounce 300 ms
  per script) + `game.DescendantAdded/DescendantRemoving` filtered to synced
  roots (daemon supplies roots at handshake response via first `sync.snapshot`
  job; before that, buffer nothing) + per-script
  `GetPropertyChangedSignal("Source")` fallback for Team Create collaborator
  edits (TextDocumentDidChange only fires for locally open documents) and
  `GetPropertyChangedSignal("Name")`/`AncestryChanged` for renames/moves.
  Only LuaSourceContainers + Folders under synced roots produce events.
- **run.exec** (edit ctx): `loadstring` the code chunk; sandbox output capture
  by shadowing `print/warn/error` via `setfenv`; collect return values through
  `table.pack`; encode via Serde with depth cap 4; cap combined output at
  100 kB before Output.capList. Errors → `error()` with traceback line.
- **shot.capture**: try `CaptureService:CaptureScreenshot` → contentId →
  `AssetService:CreateEditableImageAsync` → `ReadPixels` → return
  `{w, h, rgba: base64}`. Any step unsupported in current context →
  error("screenshot unsupported: <step>"). Daemon converts RGBA→PNG.
- **JSON safety**: results must be JSONEncodable — Serde.encode everything;
  `nil`s in arrays forbidden (use false/omit).
- **No busy loops**: all polling via `task.wait`, heartbeat-driven; Net pull
  loop reconnects with backoff 1 s ×1.5 → max 10 s on transport errors,
  immediately on 204.
- **UI**: toolbar button "OGSync" toggles the connection panel (DockWidget).

## Connection panel (plugin/src/UI/Panel.luau + UI/Theme.luau)

DockWidgetPluginGui (`plugin:CreateDockWidgetPluginGui`, default float
320×260, InitialDockState Right allowed). Edit role only (play roles: no UI).
Studio-theme aware: colors from `settings().Studio.Theme:GetColor(...)`,
re-applied on `ThemeChanged`. Plain Frames/TextLabels/TextButtons — no
external UI libs.

Sections top→bottom:
1. **Status header** — dot + text: `Connected` (green, shows daemon version +
   project name) / `Connecting…` (amber, retry countdown) / `Disconnected`
   (grey) / `Rejected` (red, shows handshake `reason` verbatim, e.g. bound to
   another place) / `Update required` (red, when proto mismatch or
   `updatePlugin`).
2. **Connect controls** — Connect/Disconnect button (drives Net start/stop +
   persists `ogsync_enabled`); port TextBox (persists `ogsync_port`, default
   3667, reconnects on commit) — the preferred port; Net still scans the
   candidate list when it stops answering and shows the port it found.
3. **Sync row** — `Sync: on (N pending)` / `paused` / `off`; Pause/Resume
   button (sends event `{ev:"syncToggle", paused}` — daemon honors via
   SyncControl).
4. **Conflicts list** — scrolling, one row per conflict pushed by daemon job
   `sync.conflicts` (daemon → plugin informational job; args
   `{list: [{file, path, ts}]}`, plugin acks `{ok:true}` and renders); each
   row: shortened path + two buttons `Keep FS` / `Keep Studio` → event
   `{ev:"resolveConflict", file, keep}`.
5. **Footer** — plugin version; when `updatePlugin` true show
   "Daemon has newer plugin — reload plugins" hint.

State flows through a tiny observer: `UI.setState(partial)` merges + re-renders
affected rows only. Net calls `UI.setState` on connect/disconnect/handshake;
Applier on sync counts. Panel never blocks Net (all UI updates task.defer).
