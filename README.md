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

## Quick start

```sh
ogsync init      # scaffold ogsync.toml + project mapping in current dir
ogsync serve     # start daemon: MCP (stdio) + sync + plugin bridge
```

Claude Code MCP config:

```json
{ "mcpServers": { "ogsync": { "command": "ogsync", "args": ["serve"] } } }
```

See `docs/DESIGN.md` for architecture.
