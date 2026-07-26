# OGSync MCP tool contract

Conventions used by every tool:

- **path** — dot-path from `game` (`game.ServerScriptService.Main`). Bracket
  form for odd names: `game.Workspace["My.Part"]`. Pseudo-paths: `@selection`
  (Studio selection), `@game` (DataModel root). Where a param is `paths`, an
  array is accepted and results are grouped per path.
- **Output** — plain text, compact. Trees are 2-space indented. Tabular data is
  one line per row: `path<TAB>field=value ...`. Truncated responses end with
  `…more: pass cursor=N`. Errors: `ERR <code>: <message>` (codes: NOPATH,
  NOPLUGIN, TIMEOUT, BADARG, STUDIO).
- **Property values** — Rojo-style JSON: `Vector3 [x,y,z]`, `Color3 [r,g,b]`,
  `CFrame [12 numbers]`, `UDim2 [[sx,ox],[sy,oy]]`, enums as `"Enum.Material.Neon"`
  or short `"Neon"` on input, instance refs as dot-paths.
- All tools accept `timeout_ms` (default 15000; playtest/profile ops 60000).

## run
Execute Luau. `code` (string, required), `context` (`edit`|`server`|`client`,
default `edit`; server/client require active playtest), `player` (name/index for
client context). Returns print output + serialized return values (tables
rendered compactly, depth-capped at 4, 2000-char cap with `…`).

## read
`path` (script), `offset` (1-based line, default 1), `limit` (default 200).
Output: `cat -n` style numbered lines. Header line: `<path> <lineCount>L <hash8>`.

## edit
Script editing, three modes (exactly one):
- `old`/`new` string replace (must match exactly once; `all=true` for every match)
- `lines={start,end?}` + `new` — replace/delete (`new=""`) line range; `insert_after=N` + `new` — insert
- `source` — full overwrite (creates script if missing with `class`, default ModuleScript)
Returns `ok <path> <newLineCount>L <hash8>` + ±3 context lines around the change.

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
`path (Class)` then `  prop=value` lines. Special: `get game` includes place
id/name/game settings summary.

## set
`targets`: array of `{path|paths, props?, attrs?, tags_add?, tags_remove?,
name?, parent?}`. Setting `attrs.X=null` deletes attribute X. `parent` moves the
instance (covers reparent op of manage_instance). Batch, transactional per
target, one undo waypoint for the call. Returns `ok N instances, M properties`.

## create
`items`: array of `{class, parent, name?, props?, attrs?, tags?, children?}`
(children recursive, same shape). `count` + `offset` (CFrame/Vector3 delta per
copy) on any item for mass creation. Returns created paths (grouped/compacted
for mass: `parent.Name[1..50]`).

## delete
`paths` (array). Returns `ok N deleted`. Refuses services.

## duplicate
`path`, `count` (default 1), `parent?`, `name?` (`{n}` placeholder),
`offset?` (CFrame/Vector3 per copy), `props_per_copy?` (array of prop overrides).
Covers smart/mass duplicate. Returns created paths compacted.

## find
`root` (default `@game`), `class?` (with `inherit=true` default),
`name?` (glob), `tag?`, `prop?` `{name, op(`eq`|`ne`|`lt`|`gt`|`contains`), value}`,
`limit` (default 100). Conditions AND-combined. Output: `path (Class)` lines.
Covers material search via `class=MaterialVariant` / prop queries.

## playtest
`action`: `start` (`mode`=`solo`|`server`), `stop`, `status`. Status reports
mode, uptime and player list. Multi-client team test is not launchable from
plugin APIs, so there is no `players` parameter; `solo` degrades to `server`
(run mode) when Studio refuses play-solo, and the result says which started.
Code inside a live playtest runs via `run` with `context=server|client`.

## logs
`context` (`edit`|`server`|`client`|`all`, default `all`), `level`
(`info`|`warn`|`error`, min), `since` (cursor from previous call), `pattern?`,
`limit` (default 100). Output: `[ctx][level] message (xN)` — consecutive dupes
collapsed with count. Returns next cursor.
Served from the daemon's own buffer, fed by plugin log events from every
connected session, so output survives a playtest ending and costs no Studio
round trip. The first call for a context also backfills the plugin's ring
buffer. A solo playtest shares one DataModel, so its client output arrives
tagged `server`.

## screenshot
`target` (`viewport` default), `camera_focus?` (path — frame instance before
capture), `size?` (`WxH`, default 960x540). Returns image (MCP image content).

## profile
`kind`: `script` (`duration_s`, max 15), `memory`. Returns top-N
hotspots/allocations as `name  ms|MB  %` lines, not raw dumps. `top` (default 25).
MicroProfiler capture has no plugin API and is not exposed.

## input
`actions`: array of `{type: key|click|move|scroll|device|network|nav, ...}` —
`key {code, hold_ms?}`, `click {x,y,button?}`, `move {x,y,duration_ms?}`,
`device {name|reset}` (device emulation), `network {profile}` (throttle),
`nav {to: path|[x,y,z], timeout_ms?}` (walk character via Humanoid/PathfindingService,
covers built-in MCP character_navigation). Requires active playtest for
key/click/nav. Returns per-action ack.

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
