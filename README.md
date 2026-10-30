# OGSync

AI agent framework for Roblox Studio: a token-lean MCP server, two-way live
script sync, and a self-installing Studio plugin — one binary.

- **MCP server** — replaces the official Roblox Studio MCP (and covers the
  ~100-method community surface) with ~20 consolidated, batch-first tools
  designed for minimal token usage.
- **Two-way sync** — filesystem ⇄ Studio, live, including Team Create
  collaborator edits. Rojo-compatible project format.
- **Zero-friction install** — the CLI installs and hot-updates the Studio
  plugin automatically; the CLI updates itself from GitHub Releases.

## Install

Download the binary for your platform from
[Releases](https://github.com/joxan2137/ogsync-sync/releases/latest), unzip it,
and put it on your PATH. It updates itself from then on.

## Quick start

```sh
cd my-roblox-project
ogsync init      # scaffold ogsync.toml + default.project.json + src/ (skip if you already use Rojo)
ogsync serve     # MCP over stdio; starts the shared daemon (bridge + sync) if needed
```

`serve` installs the Studio plugin on first run. **Restart Studio** so it picks
the plugin up, then open your place — the OGSync button in the Plugins tab shows
the connection panel.

`serve` is a thin per-session proxy: one daemon per machine owns the Studio
bridge and outlives every session, so several Claude sessions (and shells)
share the same places, queue and playtest leases. Agents without MCP use
`ogsync call <tool> '<json-args>'`; `ogsync status` shows daemon, places,
peers and playtest state (`--json` for hooks; same body as `GET /state`).

Register it with Claude Code:

```sh
claude mcp add ogsync -- ogsync serve
```

or by hand:

```json
{ "mcpServers": { "ogsync": { "command": "ogsync", "args": ["serve"] } } }
```

## When something is not connected

```sh
ogsync doctor
```

Checks the project file, the installed plugin, the daemon, the Studio binding
and sync state, and tells you the next action for anything failing.

## Choosing which Studio instance to drive

The daemon serves every open place. Each tool takes `target`
(`<alias|placeId|name>[:edit|server|client-N]`); the default comes from the
`ogsync.toml` in the session's directory. With several places open and no
target, tools answer `ERR TARGET` with the candidates instead of guessing:

```toml
[bind]
target_place = "main"      # alias, place name or place id

[aliases]
main = 1234567890          # stable names for places

[playtest]
max_clients = 2            # agent playtests never spawn more clients
auto_end_s = 1800          # agent-started playtests stop after this
```

## Commands

| | |
|---|---|
| `ogsync serve` | MCP session proxy; ensures the daemon (`--no-mcp` keeps sync attached, `--port N`) |
| `ogsync daemon run\|start\|stop` | foreground daemon / ensure one runs / stop it |
| `ogsync call <tool> '<json>'` | one tool call from a shell, result JSON on stdout (`--as <id>` lease identity) |
| `ogsync status [--json]` | daemon, places, peers, playtest state |
| `ogsync init` | scaffold config and project files |
| `ogsync doctor` | diagnose the setup |
| `ogsync plugin install\|uninstall` | manage the Studio plugin file |
| `ogsync update` | check GitHub Releases now |

## Docs

- `docs/DESIGN.md` — architecture
- `docs/TOOLS.md` — the MCP tool contract
- `docs/PROTOCOL.md` — daemon ⇄ plugin wire protocol
- `docs/PLUGIN_CONTRACT.md` — plugin module contract
