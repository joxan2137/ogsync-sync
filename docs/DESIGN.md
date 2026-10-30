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
┌────────────┐ stdio ┌──────────────┐           ┌─────────────────────────────┐  HTTP     ┌──────────────┐
│ MCP client │──────►│ ogsync serve │──/rpc────►│ ogsync daemon (one/machine) │◄─────────►│ Studio plugin │
│ (Claude)   │       │ thin proxy   │  node:http│  · HTTP hub, every place     │ long-poll │ (edit, server │
└────────────┘       └──────────────┘           │  · tools execute here        │           │  per place)   │
┌────────────┐                                  │  · sync engine per project   │           └──────────────┘
│ shell/hook │── ogsync call / status ─────────►│  · playtest state + leases   │
└────────────┘                                  └─────────────────────────────┘
```

- **One daemon per machine, outliving sessions.** `ogsync serve` (what each
  Claude session runs) never owns the bridge: it ensures the daemon is up
  (spawning `ogsync daemon run` detached through a short-lived `daemon detach`
  hop, so a Windows process-tree kill of the session cannot reach it; guarded
  by `~/.ogsync/daemon.lock`) and forwards every MCP tool call over `POST /rpc`. A session ending, or
  crashing, leaves Studio connected for everyone else. The daemon serves
  every place at once; peers are keyed by place key + role.
- **Uniform clients.** Sessions, `ogsync call <tool> '<json>'` (agents with
  only a shell) and `ogsync status [--json]` (hooks) all speak the same
  `/rpc`/`/state` surface. Tools execute in the daemon, so partial results and
  plugin events reach them directly; clients relay only the final
  `CallToolResult` (MCP progress notifications are not forwarded).
- **Ports.** The daemon binds the first free port of a fixed candidate list,
  skipping Windows excluded port ranges, and publishes it in
  `~/.ogsync/daemon.json`; the plugin scans the same list
  (docs/PROTOCOL.md § Ports and discovery). Bound to 127.0.0.1 only.
- **Per-project state.** Each call carries its client id and working
  directory; that directory's ogsync.toml supplies the default target,
  `[aliases]` and `[playtest]` limits, and the daemon runs one sync engine per
  attached project directory.

## Bridge protocol (daemon ⇄ plugin)

Exact wire spec: `docs/PROTOCOL.md`. Summary: JSON over HTTP, loopback-only,
plugin is always the client (Studio plugins ignore HttpEnabled; locally
installed plugins skip permission prompts entirely). 25 s long-poll `GET /pull`
delivering **batched** jobs (the community server delivers one request per
0.5 s poll — its ~2 req/s ceiling is a key weakness we remove), `POST /push`
for results + watcher events, `POST /handshake` with proto/version negotiation.
Play-mode clients cannot use HttpService even at plugin security level — the
play-server plugin brokers client ops over a RemoteFunction
(`ReplicatedStorage.__OGSyncBroker`); playtest stop is signaled cross-DataModel
via `plugin:SetSetting`, not HTTP.

Op execution on the plugin side is a dispatcher: `Ops/<Domain>.luau` modules
keyed by op name. One job queue, results correlated by id. Long ops (playtest,
profiling) stream partial results via events.

**Targeting:** every place that connects is served. Each tool call resolves a
`target` (`<alias|key|placeId|name>[:edit|server|client-N]`, default
`bind.target_place` of the caller's ogsync.toml) to exactly one place; with
several candidates and no target, or an ambiguous one, it answers `ERR
TARGET` with the list — never "first connected". Sync follows the same rule.
Ops are never broadcast. (Dev/testing on this machine: `target_place` must be
`"Place2"`.)

**Fairness and survival:** ops to one place run one at a time, round-robin
across calling sessions; status polls repeated within 1 s are throttled. A
plugin reconnect does not lose calls: the same session re-handshaking gets its
unanswered jobs again (its job log skips ones it ran), and a dropped peer's
calls wait 30 s for the place to re-attach.

**Playtest lifecycle:** a per-place state machine fed by plugin heartbeats
(`unknown` when they stop), leases recorded on start (stop by another session,
or of a user-started test, needs `force`), client cap and auto-end from
`[playtest]`, stale-code detection by comparing play-server and edit script
hashes, and a warning when "Load User Plugins in Test Mode" looks off. `GET
/state` exposes all of it without auth for hooks that must fail closed.

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
  daemon start: byte-compare then write `OGSync.rbxm` into the Studio plugins
  dir — Windows `%LOCALAPPDATA%/Roblox/Plugins`; mac tries
  `~/Documents/Roblox/Plugins` then `~/Library/Application Support/Roblox/Plugins`
  (whichever exists, else first); `OGSYNC_PLUGINS_DIR` overrides; Linux without
  override ⇒ skip with notice, never error. If a connected session later
  reports an older pluginVersion, daemon prints a "reload plugins in Studio"
  notice (hot-reload of local plugin files is not guaranteed).
- **Binary update:** Argon-pattern. State file `~/.ogsync/update.json`
  (`lastChecked`, `etag`) throttles checks to 1/h; check on start + every 6 h
  during serve. GET `api.github.com/repos/<owner>/ogsync/releases/latest` with
  `If-None-Match`; 403/429/network ⇒ "unknown", never "no update"; optional
  `GITHUB_TOKEN` honored. Newer semver ⇒ download platform asset, verify
  sha256 against `checksums.txt`, swap via rename dance (Windows: rename
  running exe → `ogsync.exe.old`, write new at original path, delete `.old`
  on next boot; Unix: plain rename over). Update requires exe dir writable —
  else print "reinstall via your package manager" and skip. `ogsync update`
  forces; `update.auto=false` in `ogsync.toml` opts out.
- **Version lockstep:** one version string (from package.json) stamped into
  binary and plugin at build; handshake enforces compatibility.

## Tech decisions (research-locked, 2026-07-26)

- **Runtime:** Bun **1.3.14 pinned** (CI + local). `bun build --compile`
  targets: `bun-windows-x64-baseline`, `bun-linux-x64-baseline`,
  `bun-darwin-arm64`. No `--bytecode` v1. Windows icon/metadata flags skipped
  (can't cross-compile them).
- **MCP SDK:** `@modelcontextprotocol/sdk@1.29.0` (v1 line) + zod v3. v2
  (`@modelcontextprotocol/server`) stabilizes 2026-07-28 with unverified host
  support — migrate later via codemod. stdout is JSON-RPC only: all logging to
  stderr, EPIPE guard on stdout writes.
- **Local clients:** node:http with `agent: false` + `connection: close`, never
  fetch/undici keep-alive (short-lived Windows processes asserted on exit with
  pooled sockets); loopback is added to `NO_PROXY` because Bun applies
  `HTTP(S)_PROXY` to 127.0.0.1 as well.
- **HTTP hub:** `Bun.serve` (native), not node:http (Bun buffers outgoing
  request bodies; irrelevant for serve but avoid the module wholesale).
- **Plugin embedding:** `import pluginRbxm from "../assets/OGSync.rbxm" with
  { type: "file" }` → read via `Bun.file(pluginRbxm)` ($bunfs virtual path —
  never treat as real path).
- **FS watcher:** hybrid — `fs.watch` fast path + 700 ms mtime polling sweep
  as authority (Bun `fs.watch` on Windows has open recursive-watch issues).
  Dirty paths union both sources; correctness never depends on fs.watch.
- **Targets covered:** official archived MCP (6 tools), built-in Studio MCP
  (script_*, execute_luau 3-context, screenshot, input, character_navigation →
  our `input` nav action), community robloxstudio-mcp 88-tool surface.
  Out of scope v1: Roblox-internal AI generation (generate_mesh/material/
  procedural_model) — no public API; `create`+`asset`+`rbxm` are the
  equivalents.
- **Known pitfalls designed around:** Rojo 7.5 two-way sync echo loops (issue
  #1273 — write-while-typing): we suppress echoes by hash and apply patches
  via `ScriptEditorService:UpdateSourceAsync`; unbounded message queues (Rojo)
  — ours drop acked jobs by cursor; version drift (community fork) — handshake
  carries proto + semver and daemon rewrites the plugin file on update.

## Repo layout

```
server/           TypeScript (Bun) — CLI, MCP, hub, sync, updater
  src/index.ts        CLI entry (serve, daemon, call, status, init, update, plugin, doctor)
  src/daemon/         daemon lock + daemon.json, port choice, node:http client, per-project state
  src/mcp/            MCP server + tools/<name>.ts (one module per tool)
  src/hub/            HTTP hub, places + peers, fair scheduler, playtest tracker, targets
  src/sync/           project mapping, watcher, shadow store, conflict
  src/update/         github releases client, self-replace, plugin installer
  src/window/         Studio window state (Win32 via Bun FFI): checkVisual pre-flight
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
- `release.yml`: on push to main — job "check": `package.json` version ≠
  latest tag ⇒ job "draft": create tag `vX.Y.Z` + **draft** release ⇒ matrix
  build jobs upload assets into the draft (race-free) ⇒ job "publish": attach
  self-generated `checksums.txt` (sha256 of every asset) and flip draft →
  published. Assets: `ogsync-windows-x64.exe.zip`, `ogsync-linux-x64.zip`,
  `ogsync-darwin-arm64.zip`, `OGSync.rbxm`, `checksums.txt`.
