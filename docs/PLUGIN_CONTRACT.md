# Plugin module contract (Luau)

All modules `--!strict`. No external packages. JSON via `HttpService:JSONEncode/Decode`.
`plugin/src/Util/Hash.luau` is pre-written and bit-locked to the server — do not modify.

## Layout & ownership

```
plugin/src/
  init.server.luau        core  entry: role detect, toolbar, wiring, stop-monitor
  Net.luau                core  handshake/pull/push loops, backoff, queues
  Dispatcher.luau         core  op registry; requires all Ops/* and Sync/Ops
  Broker.luau             core  RemoteFunction broker (play server⇄clients)
  Sync/Watcher.luau       core  studio-side change detection → events
  Sync/Applier.luau       core  sync.apply/snapshot/hash ops, echo suppression
  Util/Hash.luau          (locked)
  Util/Path.luau          core  dot-path grammar resolve/serialize
  Util/Serde.luau         core  property value encode/decode
  Util/Output.luau        core  size-capped list/table builders
  Ops/Inst.luau           ops   inst.get/set/create/delete/duplicate/find/tree
  Ops/Script.luau         ops   script.read/edit/grep
  Ops/Run.luau            ops   run.exec (edit ctx direct; server/client via daemon routing)
  Ops/Play.luau           ops   play.start/stop/status
  Ops/Log.luau            ops   log.tail + log event forwarding
  Ops/Shot.luau           ops   shot.capture
  Ops/Prof.luau           ops   prof.micro/script/memory
  Ops/Input.luau          ops   input.batch (incl. nav)
  Ops/Asset.luau          ops   asset.op
  Ops/Rbxm.luau           ops   rbxm.export/import (base64 payloads)
  Ops/Hist.luau           ops   hist.op (undo/redo/waypoint)
  Ops/Sel.luau            ops   sel.get + selection events
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
Net.start(config: {baseUrl: string, session: string, role: string})
Net.pushEvent(ev: table)             -- queued, flushed with next push (≤300 ms)
Net.pushPartial(jobId: string, data: any)
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
- **Ops/Play**: `play.start` (edit role): `mode="server"` →
  `RunService:Run()`. `mode="solo"` → attempt play-solo via available
  plugin-security APIs (pcall chain; if only run-mode is possible, start that
  and mark result `{started: "run", requested: "solo"}` so the daemon reports
  the degradation honestly). `play.stop`: primary path — daemon routes the op
  to the play-server session which calls `RunService:Stop()`; secondary —
  daemon also sends `play.stopSignal` to the edit session, which writes
  `plugin:SetSetting("ogsync_stop_token", GUID)` for the monitor above.
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
   3667, reconnects on commit).
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
