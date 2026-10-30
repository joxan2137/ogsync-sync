# OGSync MCP tool contract

Conventions used by every tool:

- **path** — dot-path from `game` (`game.ServerScriptService.Main`). Bracket
  form for odd names: `game.Workspace["My.Part"]`. Pseudo-paths: `@selection`
  (Studio selection), `@game` (DataModel root). In a client context
  `game.Players.LocalPlayer…` names the local player without knowing its name
  (elsewhere it fails with a hint that LocalPlayer is client-only). Where a
  param is `paths`, an array is accepted and results are grouped per path.
- **Output** — plain text, compact. Trees are 2-space indented. Tabular data is
  one line per row: `path<TAB>field=value ...`. Truncated responses end with
  `…more: pass cursor=N`. Errors: `ERR <code>: <message>` (codes: NOPATH,
  NOPLUGIN, TIMEOUT, BADARG, STUDIO, TARGET, THROTTLED, LEASE, VERSION).
- **Property values** — Rojo-style JSON: `Vector3 [x,y,z]`, `Color3 [r,g,b]`,
  `CFrame [12 numbers]`, `UDim2 [[sx,ox],[sy,oy]]`, enums as `"Enum.Material.Neon"`
  or short `"Neon"` on input, instance refs as dot-paths.
- All tools accept `timeout_ms` (default 15000; playtest/profile ops 60000).
- All tools accept `target`: `<place>[:<role>]`, place = an `[aliases]` name
  from ogsync.toml, a place key, placeId or place name; role = `edit`,
  `server`, `client` or `client-N`. Default: `bind.target_place` from the
  ogsync.toml in the calling session's directory. With several places
  connected and no target, or a target matching several, the tool answers
  `ERR TARGET` listing the candidates; it never picks one.
- Tools run inside the machine-wide daemon; `ogsync serve` (MCP) and `ogsync
  call <tool> '<json>'` (shell; `-` in place of the JSON reads it from stdin,
  which large args such as script sources need on Windows) are both thin clients of it, so every agent
  sees the same places, queue and leases. Ops to one place run one at a time,
  round-robin across sessions.
- **Writes are one undo step** — `set`, `create`, `delete`, `duplicate`,
  `edit`, `grep replace` and `transform` each run inside one
  `ChangeHistoryService` recording. A call that throws part-way cancels its
  recording, which rolls the partial write back. Outside edit mode (or while
  another plugin holds a recording) the write still happens, ungrouped.
  Script text is the exception: Studio's undo history never records `Source`
  (checked live), so `history undo` cannot revert `edit`, `grep replace` or a
  `set` of `Source`; to revert, `read` first and write the old text back.
- **Visual pre-flight (Windows)** — `screenshot` and the key/click/move/scroll
  actions of `input` first check the bound place's Studio window. They refuse
  fast with the reason when it cannot paint: session locked, window minimized,
  on another virtual desktop, or ≥95% covered by windows above it (click-through
  overlays and Studio's own panels do not count). `restore=true` restores a
  minimized window with `SW_SHOWNOACTIVATE`, which never takes focus. A
  foreground `RobloxPlayerBeta` adds a warning: the user's real mouse and keys
  can reach the play client. No Studio window found, or another OS, means the
  check is skipped with a warning, never a refusal.

## run
Execute Luau. `code` (string, required), `context` (`edit`|`server`|`client`,
default `edit`; server/client require active playtest), `player` (name/index for
client context). Returns print output + serialized return values (tables
rendered compactly, depth-capped at 4, 2000-char cap with `…`).

- `vm` (`game`|`plugin`) — server/client code runs in the **game VM** by
  default: it requires the same module instances the game's scripts do, so a
  second `DataService`, duplicate packet handlers or non-replicating writes
  cannot happen. `vm=plugin` evaluates in the plugin's own VM (separate
  require cache); such results start with
  `[vm=plugin: separate require cache, not the game's module instances]`.
  `context=edit` always uses the plugin VM (there is no game VM in edit);
  `vm=game` there is `ERR BADARG`.
- `async=true` — returns `job <handle> started vm=… gen=…` at once; poll,
  collect or cancel it with `job`. Async jobs have no call timeout.
- `key` — starting a job with the key of a previous job cancels that job and
  makes it stale. Code sees an `ogsync` table: `id`, `gen`, `alive()` (false
  once cancelled or superseded) and `delay(seconds, fn, ...)`, a `task.delay`
  that does nothing if the job is no longer current. Use it for samplers and
  watchdogs so an old timer cannot stop a re-armed one.
- Limits: a synchronous `context=client` eval is relayed by the play server
  over a RemoteFunction that gives up after 10 s; use `async=true` for longer
  client work. Game-VM eval needs Studio to run scripts created at runtime (see
  PLUGIN_CONTRACT.md); when it cannot, the call fails with
  `game-VM eval unsupported: …` rather than silently using the plugin VM.

## job
Async eval jobs from `run async=true`. `action`: `poll` (default — status and
output so far, job kept), `collect` (waits up to `wait_ms`, default 10000, then
returns the result and forgets a finished job; a still-running job answers
`still running; collect again`), `cancel`, `list` (jobs in `context`).
`handle` is what `run` printed: `edit:3.<nonce>`, `server:7.<nonce>` or
`client@Player1:2.<nonce>` — it names the session that owns the job, and the
nonce identifies that session's job registry: ids restart at 1 in every play
DataModel, so a handle from an earlier playtest is refused with
`job N is from an earlier playtest or plugin load` instead of reaching a
different job. Client collects
wait at most 8000 ms per call (broker relay cap). Finished, uncollected jobs are
kept per session, newest 32. Output:
`job <handle> <status><TAB>vm=… gen=… elapsed_s=…` then output, `=> returns`, and
`ERR <reason>` for failed or cancelled jobs.

## read
`path` (script), `offset` (1-based line, default 1), `limit` (default 200).
Output: `cat -n` style numbered lines. Header line: `<path> <lineCount>L <hash8>`.

## edit
Script editing, three modes (exactly one):
- `old`/`new` string replace (must match exactly once; `all=true` for every match)
- `lines={start,end?}` + `new` — replace/delete (`new=""`) line range; `insert_after=N` + `new` — insert
- `source` — full overwrite (creates script if missing with `class`, default ModuleScript)
Returns `ok <path> <newLineCount>L <hash8> verified` + ±3 context lines around
the change (`verified(editor)` when the script was open in a Script Editor tab).

All text (`old`, `new`, `source`) is LF-normalized and sent as base64 of its
UTF-8 bytes, so NULs, lone CRs and long brackets arrive intact; a source over
64 KiB of base64 is staged in chunks first, so there is no size ceiling. The
plugin checks the decoded text against the daemon's hash, writes through
`ScriptEditorService:UpdateSourceAsync` (which merges into an open editor
document instead of being overridden by it), then reads the result back —
`GetEditorSource` when a document is open, `Source` otherwise — and fails if
its hash differs.

## grep
`pattern` (Lua string patterns off; RE2-style regex), `root` (path, default
`@game`), `glob` (name filter e.g. `*.Handler`), `mode` (`content`|`files`|`count`),
`context` (lines), `limit` (default 50 matches), `replace` (optional — rewrite
matches; returns per-script change counts; requires `mode=content`).
Output: `path:line: text`.

## tree
`path` (default `@game`), `depth` (default 2), `filter` (class name(s) or
`scripts`), `counts` (bool — child counts instead of listing). Output: indented
`Name ClassName [nChildren]`; scripts get `#lines`. Services with 0 relevant
children are skipped.

## get
`paths` (array), `props` (names array, or `*` for all non-default, default:
class-typical summary set), `attrs` (bool|names), `tags` (bool), `refs` (bool —
incoming/outgoing ObjectValue/weld/attachment references). Output per instance:
`path (Class)` then `  prop=value` lines. The summary set covers UI fully:
`AbsolutePosition`/`AbsoluteSize`, `AnchorPoint`, `AutomaticSize`, `LayoutOrder`,
`SizeConstraint`, text `FontFace`/`LineHeight`, image `SliceCenter` (Rect),
ScreenGui `DisplayOrder`/`ScreenInsets`, and every UI layout, constraint and
modifier class (UIListLayout incl. flex, UIGridLayout, UITableLayout,
UIPageLayout, UIAspectRatio/Size/TextSize constraints, UICorner, UIStroke,
UIGradient with ColorSequence/NumberSequence, UIScale, UIFlexItem). Values:
`UDim2 [[sx,ox],[sy,oy]]`, `Vector2 [x,y]`, `Rect [[minx,miny],[maxx,maxy]]`,
`ColorSequence [{time,color}]`, `NumberSequence [{time,value,envelope}]`, enums
`"Enum.X.Y"`, `Font {family,weight,style}`, `Content` as its URI. Special: `get game` includes place
id/name/game settings summary.

## set
`targets`: array of `{path|paths, props?, attrs?, tags_add?, tags_remove?,
name?, parent?}`. Setting `attrs.X=null` deletes attribute X. `parent` moves the
instance (covers reparent op of manage_instance). Batch, one undo step for the
call. `props.Source` on a script takes the same binary-safe, staged,
hash-verified path as `edit` and adds a `<path><TAB>source=<hash8> verified=editor|source`
row. Returns `ok N instances, M properties`.

## create
`items`: array of `{class, parent, name?, props?, attrs?, tags?, children?}`
(children recursive, same shape). `count` + `offset` (CFrame/Vector3 delta per
copy) on any item for mass creation. Returns created paths (grouped/compacted
for mass: `parent.Name[1..50]`).

## delete
`paths` (array). Returns `ok N deleted`. Refuses services. In edit mode
instances are detached (`Parent = nil`) inside the call's recording, the way
Studio's own Delete works, so Undo restores them; `Destroy()` would lock
`Parent` and make the delete permanent. Play-mode deletes still `Destroy()`.

## duplicate
`path`, `count` (default 1), `parent?`, `name?` (`{n}` placeholder),
`offset?` (CFrame/Vector3 per copy), `props_per_copy?` (array of prop overrides).
Covers smart/mass duplicate. Returns created paths compacted.

## transform
Move/rotate many Models and BaseParts as one undo step. `targets`: array of
`{path|paths, move?: [x,y,z], rotate?: [rx,ry,rz] (degrees, Y-X-Z like
Orientation), origin?: "pivot"|"center"|[x,y,z], to?: [x,y,z] | 12-number CFrame}`
— `to` sets an absolute pivot (a position keeps the current rotation) and
cannot be combined with `move`/`rotate`. `origin=pivot` (default) rotates each
instance about its own pivot, `center` about the centroid of the target's
pivots. `dry_run=true` returns the plan without writing.

Every target pivot is computed from the **original** pivots before anything
moves, then applied with `PivotTo` (never by writing `WorldPivot`). Moving one
member of a welded assembly drags its partners; precomputed absolute targets
mean nothing compounds. An instance under a listed **Model** is skipped
(`skip <path> (moves with <ancestor>)`), since Model:PivotTo carries its
descendants; a part under a listed BasePart still gets its own step, because
BasePart:PivotTo moves only that part and what is welded to it. After applying, any instance more than
0.001 studs off its target (dragged by a weld to something moved later) is
reported as an `ERR` line.
Output: `ok N moved` or `dry-run N planned`, then
`<path><TAB>from=[x,y,z] to=[x,y,z] rot=[from]→[to]` rows.

## find
`root` (default `@game`), `class?` (with `inherit=true` default),
`name?` (glob), `tag?`, `prop?` `{name, op(`eq`|`ne`|`lt`|`gt`|`contains`), value}`,
`limit` (default 100). Conditions AND-combined. Output: `path (Class)` lines.
Covers material search via `class=MaterialVariant` / prop queries.

## playtest
`action`: `start` (`mode`=`solo`|`server`), `stop` (`force?`), `status`.
State comes from the daemon's plugin-reported state machine
(`idle|starting|running|stopping|unknown`), never from guessing at which
peers are registered; `status` costs no Studio round trip. Output:
`state=… mode= owner= started_by= for_s= players= heartbeat_ms=`, plus
`STALE CODE: N changed, M missing …` when the running test loaded scripts
that differ from the edit DataModel, and `WARNING: …` (e.g. "Load User
Plugins in Test Mode" is probably off, a start that never came up, an
auto-end).
- `start` records the calling session as lease owner and answers once the
  playtest is usable: for `solo`, the play server has attached and a client
  is reachable through it; for run mode (`server`), it is running. Bounded by
  `plugin_grace_s`; past it the answer says "not confirmed yet" with the "Load
  User Plugins in Test Mode" warning.
  Starting again as the owner answers `already running (yours)`; anyone else
  gets `ERR LEASE`. `solo` uses StudioTestService when available, degrades to
  `server` (run mode) when Studio refuses play-solo, and the result says which.
  `solo` is refused (`ERR STUDIO`) when the Studio window is minimized, covered
  or the screen is locked, since its client never renders; `server` starts
  anyway and lists that state as a warning.
- `stop` refuses (`ERR LEASE`) a playtest another session owns, one the user
  started in Studio, or one whose state is `unknown`, unless `force=true`.
  Stopping an idle place answers `playtest not running`.
- Limits from `[playtest]` in ogsync.toml: `max_clients` (default 2),
  `auto_end_s` (default 1800, agent-started tests only), `plugin_grace_s`
  (default 10). Multi-client team test is not launchable from plugin APIs.
Code inside a live playtest runs via `run` with `context=server|client`, or
any tool with `target=<place>:server|client-N`.

## logs
`context` (`edit`|`server`|`client`|`all`, default `all`), `level`
(`info`|`warn`|`error`, min), `since` (cursor from previous call), `pattern?`,
`limit` (default 100). Output: `[ctx][level] message (xN)` — consecutive dupes
collapsed with count. Returns next cursor.
Served from the daemon's own buffer, fed by plugin log events from every
connected session, so output survives a playtest ending and costs no Studio
round trip. The first call for a context also backfills the plugin's ring
buffer. A solo playtest shares one DataModel, so its client output arrives
tagged `server`. An identical call repeated within 1 s answers `ERR THROTTLED:
… retry after N ms`; block on `wait for=log` instead of polling.

## wait
Long-poll until a condition holds, instead of retrying a tool. `for`:
- `log` — `pattern` (regex, required), `context?`, `since?` (logs cursor;
  default: only lines after the call). Returns the matching lines + cursor.
- `playtest` — `state` (`idle|starting|running|stopping|unknown`).
- `attribute` — `path`, `name`, `value?` (omitted: until the attribute exists).
- `instance` — `path` (until it exists).
`timeoutMs` (default 30000, max 300000). Log and playtest waits read daemon
state; attribute/instance re-check through the plugin, starting at 500 ms and
backing off ×1.5 to every 4 s (Studio's HttpService budget). Those probes run
in `context` (`edit` default, `server`, or `client` with `player?`), skip the
place queue (the awaited change is often made by the op holding it), and a
client probe gets at least 5 s so the play server's relay can answer. A probe
that times out counts as not-yet; only the wait's own deadline ends it.
Returns `wait ok: …`, or `ERR TIMEOUT: …` naming the last state seen
(`last check timed out` when the final probe never answered).

## screenshot
Always the viewport (the shared `target` arg picks the place, as for every
tool). `context` (`edit` default; `client` captures
the play client during a playtest, `server` the play server), `player?`,
`frame?` (path — point the camera at a Model/BasePart/Attachment;
`camera_focus` is an alias), `hide_ui?` (play client: disables the enabled
PlayerGui ScreenGuis; edit: turns off `StarterGui.ShowDevelopmentGui`, Studio's
own UI toggle, so no ScreenGui in the place is touched), `restore?` (see
visual pre-flight), `size?` (`WxH` box the image is scaled to fit, aspect
kept, never upscaled; default 960x540; capped at 1920x1080 = 2,073,600 pixels,
and a clamped size says so in a `warn:` line), `capture_timeout_ms?`
(default 4000, max 30000). Camera (CFrame, Focus, FieldOfView, CameraType) and
UI state are restored after every capture, including failed ones.
Returns the image plus
`<context> WxH png NB<TAB>viewport=WxH scale=S inset=X,Y`: `scale` is image pixels
per viewport pixel — divide an image coordinate by it to get the x/y `input`
expects; `inset` is the top-bar GUI inset. `warn:` lines report a fullscreen
opaque GuiObject covering the 3D view (only checked when `hide_ui` is off),
`AlwaysOnTop` BillboardGui/SurfaceGui present (CaptureService captures can omit
them), and pre-flight warnings. A capture that does not arrive in time fails
with the reason (viewport not painting) instead of hanging.

Play captures take two steps: the play DataModel captures (CaptureService) and
returns only the temporary content id, because a running game may not turn a
temporary texture into an EditableImage; the edit DataModel, which may, reads
the pixels (`shot.read`). Pixels larger than one 1 MB result stay in the edit
session and are fetched in 768 KiB base64 chunks. A fully black result adds
`warn: capture is a fully black frame` (CaptureService misses the renderer on
some Studio builds during playtests).

## profile
`kind`: `script` (`duration_s`, max 15), `memory`. Returns top-N
hotspots/allocations as `name  ms|MB  %` lines, not raw dumps. `top` (default 25).
MicroProfiler capture has no plugin API and is not exposed.

## input
`context` (`client` default — input goes to the play client, relayed by the
play server; `edit`/`server` also accepted), `player?`, `restore?` (see visual
pre-flight).
`actions`: array of `{type: key|text|click|move|scroll|device|network|nav, ...}` —
`key {code, hold_ms?}`, `text {text}` (typed into the focused TextBox),
`click {path | x,y, button?}`, `move {x,y,duration_ms?}`, `scroll {delta, x?, y?}`,
`device {name|reset}` (device emulation), `network {profile}` (throttle),
`nav {to: path|[x,y,z], timeout_ms?}` (walk character via Humanoid/PathfindingService,
covers built-in MCP character_navigation). Requires active playtest for
key/click/nav. Returns per-action ack.

`click {path}` resolves the target at click time: a GuiObject's
`AbsolutePosition + AbsoluteSize/2 + GuiService:GetGuiInset()` (AbsolutePosition
is measured below the top bar, input coordinates are not), or a part/model's
`WorldToViewportPoint`. The cursor is moved there before pressing so hover
handlers see it. Every click ack carries `x y hit=<path> layer=gui|world` — the
topmost GuiObject at the point (`PlayerGui:GetGuiObjectsAtPosition`), else the
part under the cursor — and for path clicks `reached=true|false`, plus
`activated=true|false` when the target is a GuiButton. Input that cannot land
is an `ERR … unsupported: <reason>` ack, never a silent ok: a ClickDetector
target (synthetic clicks do not fire `MouseClick`/`MouseHoverEnter`), a hidden
or disabled GUI, a SurfaceGui/BillboardGui button, a point outside the
viewport, a cursor move on a touch-emulated client (it has no mouse), or a
virtual-input call Studio refused (it refuses input that would hit
interactive CoreGui).

Input goes through `UserInputService:CreateVirtualInput()`, which plugins may
call in play DataModels and which feeds the real input pipeline (UIS events,
control modules, GUI activation). `VirtualInputManager`'s `Send*Event` methods
need RobloxScript capability that no plugin has, so they are only a fallback
for a Studio without `CreateVirtualInput`. `nav` does not use simulated input:
it drives the local character's Humanoid along a PathfindingService path.

## asset
`op`: `search {query, category?, limit}`, `details {ids}`, `thumbnail {id}`,
`insert {id, parent?}`, `upload {path|file, name, type}`, `library {category?}`.
Search output: `id  name  by creator  type` lines.

## rbxm
`op`: `export {path, file}` | `import {file, parent}`. Files relative to
project root, `.rbxm`/`.rbxmx`. Covers scene/build import-export and
model generation payloads.

## docs
`query`: class name (`Humanoid`), member (`Humanoid.WalkSpeed`), or free text.
`kind` (`api`|`guide`, default api). API output: member signatures + one-line
descriptions, security/replication flags. Sourced from bundled API dump +
Studio reflection, no network.

## history
`op`: `undo` | `redo` | `waypoint {name}`. Returns acted waypoint name.

## sync
`op`: `status` (mapping, connected place, pending/conflict counts),
`conflicts` (list), `resolve {file, keep: fs|studio}`, `pause`|`resume`,
`pull`|`push` (force full one-way pass). Returns compact status block.
