# OGSync — Design Spec

AI agent framework for Roblox Studio. One binary, three jobs:

1. **MCP server** — replaces the official Roblox Studio MCP and the community
   `robloxstudio-mcp`, covering their combined method surface with ~20
   consolidated, token-lean tools instead of ~100.
2. **Two-way live script sync** — filesystem ⇄ Studio, including changes made
   by Team Create collaborators.
3. **Self-managing distribution** — GitHub Releases hosting, auto-update of the
   CLI binary, auto-install + auto-update of the Studio plugin.

## Components

```
┌────────────┐ stdio  ┌─────────────────────────────┐  HTTP :3667   ┌──────────────┐
│ MCP client │───────►│ ogsync daemon                │◄─────────────►│ Studio plugin │
│ (Claude)   │        │  · MCP server (stdio)        │  long-poll    │  (Luau)       │
└────────────┘        │  · HTTP hub (localhost only) │               └──────────────┘
                      │  · sync engine + fs watcher  │
                      │  · updater (binary + plugin) │
                      └─────────────────────────────┘
```

- **Single process.** `ogsync serve` runs MCP-over-stdio, the HTTP hub, and the
  sync engine together. `--no-mcp` for sync-only use.
- **Port 3667** (configurable, `OGSYNC_PORT`). Bound to 127.0.0.1 only.
- **Second-instance handling:** if the port is taken and `/health` identifies an
  ogsync daemon, the new process becomes a thin proxy: MCP tool calls forward to
  the running daemon over HTTP. Two Claude sessions can share one Studio.

## Bridge protocol (daemon ⇄ plugin)

JSON over HTTP, localhost. Plugin is always the HTTP client (Studio plugins may
call localhost regardless of the game's HttpEnabled setting).

- `POST /handshake` — plugin sends `{pluginVersion, placeId, placeName, sessionId}`.
  Response: `{serverVersion, syncEnabled, projectName}`. Version mismatch ⇒
  response carries `updatePlugin: true`.
- `GET /pull?cursor=N&session=S` — long-poll (25 s timeout). Response:
  `{cursor, jobs: [{id, op, args}]}`. Jobs are MCP tool ops and sync patches.
- `POST /push` — plugin delivers `{results: [{id, ok, data|err}], events: [...]}`.
  Events carry watcher notifications (script edited, instance added/removed,
  playtest output, logs).
- Payloads gzipped when > 16 KB (plugin uses `HttpService:RequestAsync` with
  raw bodies; daemon handles both).

Op execution on the plugin side is a dispatcher: `Ops/<Domain>.luau` modules
keyed by op name. One job queue, results correlated by id. Long ops (playtest,
profiling) stream partial results via events.

## MCP tool surface (~20 tools)

Design rules: batch-first (paths are arrays where sensible), field selection,
compact text output (indented trees / `path\tclass\tdetail` lines, not pretty
JSON), pagination defaults (~100 lines), every response ends with a cursor when
truncated. Paths are dot-paths from `game` (`game.ServerScriptService.Main`);
pseudo-path `@selection` expands to current Studio selection; names containing
dots use bracket form `game.Workspace["My.Part"]`.

| Tool | Covers (old surface) |
|---|---|
| `run` | execute_luau, eval_server_runtime, eval_client_runtime |
| `read` | get_script_source |
| `edit` | set_script_source, edit/insert/delete_script_lines (Claude-style old/new string match + line ops + full write) |
| `grep` | grep_scripts, search_files, find_and_replace_in_scripts (`replace` param) |
| `tree` | get_file_tree, get_project_structure, get_descendants, get_instance_children, get_services, get_scene_analysis |
| `get` | get_instance_properties, get_attributes, get_tags, mass_get_property, get_connected_instances, compare_instances, get_place_info, get_selection |
| `set` | set_property, set_properties, mass_set_property, set_attribute, bulk_set_attributes, delete_attribute, add_tag, remove_tag, manage_instance |
| `create` | create_object, mass_create_objects, create_build, generate_build (nested children spec, count+offset for mass) |
| `delete` | delete_object |
| `duplicate` | clone_object, mass_duplicate, smart_duplicate |
| `find` | search_objects, search_by_property, get_tagged, search_materials |
| `playtest` | solo_playtest, multiplayer_playtest, get/reset_simulation_state |
| `logs` | get_runtime_logs |
| `screenshot` | capture_screenshot |
| `profile` | capture_micro_profiler, capture_script_profiler, get_memory_breakdown |
| `input` | simulate_keyboard_input, simulate_mouse_input, set_device_simulator, get_device_simulator_state, set_network_profile, capture_device_matrix |
| `asset` | search_assets, get_asset_details, get_asset_thumbnail, insert_asset, upload_asset, preview_asset, list_library |
| `rbxm` | import_rbxm, export_rbxm, import_build, export_build, import_scene, generate_model |
| `docs` | get_class_info, get_roblox_docs, get_roblox_skills |
| `history` | undo, redo |
| `sync` | (new) status, pause/resume, conflicts, force pull/push |

Official Roblox MCP (`run_code`, `insert_model`) ⊂ `run` + `asset`/`rbxm`.

Property serialization uses Rojo's property JSON conventions (`Vector3` as
`[x,y,z]`, `CFrame` as 12 numbers, enums by name, refs by path) so values are
portable between sync files and tool output.

## Two-way sync

- **Mapping:** Rojo-compatible `default.project.json` subset (`$path`,
  `$className`, `$properties`, `$ignoreUnknownInstances`) + Rojo file
  conventions (`init.server.luau`, `*.server.luau` / `*.client.luau` /
  `*.luau`, `.meta.json`). Existing Rojo projects work unchanged.
- **Shadow state:** daemon keeps `path → {sourceHash, meta}` of last-synced
  state. Both sides diff against shadow, not against each other.
- **FS → Studio:** watcher (debounced 100 ms) → changed files hashed → patch
  jobs queued to plugin → `Sync/Applier.luau` applies via ScriptEditorService
  (keeps open editors in sync), records applied hash for echo suppression.
- **Studio → FS:** plugin `Sync/Watcher.luau` hooks
  `ScriptEditorService.TextDocumentDidChange` (local edits),
  `GetPropertyChangedSignal("Source")` + `DescendantAdded/Removing` under
  synced roots (covers Team Create collaborator edits, which replicate into the
  DataModel), debounces 300 ms, pushes events. Daemon writes files, updates
  shadow.
- **Conflicts:** both sides differ from shadow ⇒ policy `prefer-newest`
  (default): losing version saved as `<file>.conflict-<ts>.luau`, `sync`
  tool + plugin widget surface it. Policy configurable to `prefer-studio` /
  `prefer-fs` / `manual`.
- **Echo suppression:** every applied change records its content hash on both
  sides; a change event whose hash equals the last applied hash is dropped.
- **Initial connect:** three-way merge per script (shadow as base); missing
  shadow ⇒ interactive default `prefer-fs` with backup, controlled by
  `sync init` answers stored in `ogsync.toml`.

## Auto-install / auto-update

- **Plugin install:** plugin `.rbxm` embedded in the binary at build time. On
  daemon start: write to `%LOCALAPPDATA%/Roblox/Plugins/OGSync.rbxm` (mac:
  `~/Documents/Roblox/Plugins`) when content hash differs. Studio hot-reloads
  local plugin files.
- **Binary update:** on start + every 6 h, GET
  `api.github.com/repos/<owner>/ogsync/releases/latest` (ETag-cached, silent on
  rate-limit). Newer semver ⇒ download platform asset, verify sha256 from
  `checksums.txt`, swap: rename running exe → `.old`, write new, cleanup on
  next boot. `ogsync update` forces it; `update.auto = false` in config opts out.
- **Version lockstep:** one version string (from package.json) stamped into
  binary and plugin at build; handshake enforces compatibility.

## Repo layout

```
server/           TypeScript (Bun) — CLI, MCP, hub, sync, updater
  src/index.ts        CLI entry (serve, init, update, plugin, status)
  src/mcp/            MCP server + tools/<name>.ts (one module per tool)
  src/hub/            HTTP hub, job queue, long-poll, session mgmt
  src/sync/           project mapping, watcher, shadow store, conflict
  src/update/         github releases client, self-replace, plugin installer
  src/proto/          shared types, property serde, path grammar
plugin/           Luau — Studio plugin (built with rojo)
  default.project.json
  src/init.server.luau
  src/Net.luau  src/Ops/*.luau  src/Sync/*.luau  src/Util/*.luau
scripts/          build scripts (lune/ts): embed plugin, stamp version
.github/workflows/ci.yml         lint + typecheck + tests on PR
.github/workflows/release.yml    autorelease: version-change detect on main → tag → matrix build → release
docs/
```

## Build & release

- `bun build --compile` → `ogsync-windows-x64.exe`, `ogsync-linux-x64`,
  `ogsync-darwin-arm64`. Plugin built with `rojo build plugin -o OGSync.rbxm`,
  embedded via generated `plugin_blob.ts` (base64) before compile.
- `release.yml`: on push to main — if `package.json` version ≠ latest tag ⇒
  create tag `vX.Y.Z` ⇒ matrix build ⇒ GitHub Release with binaries,
  `OGSync.rbxm`, `checksums.txt`, generated notes.
