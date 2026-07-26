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
ogsync serve     # daemon: MCP over stdio + Studio bridge + two-way sync
```

`serve` installs the Studio plugin on first run. **Restart Studio** so it picks
the plugin up, then open your place — the OGSync button in the Plugins tab shows
the connection panel.

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

With several places open, pin one in `ogsync.toml` — the daemon binds to exactly
that session and never touches the others:

```toml
[bind]
target_place = "MyPlace"   # place name or place id
```

## Commands

| | |
|---|---|
| `ogsync serve` | daemon: MCP + bridge + sync (`--no-mcp`, `--port N`) |
| `ogsync init` | scaffold config and project files |
| `ogsync doctor` | diagnose the setup |
| `ogsync status` | query the running daemon |
| `ogsync plugin install\|uninstall` | manage the Studio plugin file |
| `ogsync update` | check GitHub Releases now |

## Docs

- `docs/DESIGN.md` — architecture
- `docs/TOOLS.md` — the MCP tool contract
- `docs/PROTOCOL.md` — daemon ⇄ plugin wire protocol
- `docs/PLUGIN_CONTRACT.md` — plugin module contract
