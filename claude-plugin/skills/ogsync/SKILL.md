---
name: ogsync
description: How to drive Roblox Studio through the OGSync tools (mcp__ogsync__* or `ogsync call` from a shell) - targeting a place, playtests and their ownership, running code in the game VM, async jobs, waiting instead of polling, screenshots, clicks, place edits, and what each error code asks you to do. Read before the first OGSync call in a session, and whenever an OGSync call returns an ERR code.
---

# Driving Roblox Studio with OGSync

OGSync is one daemon per machine. Every Claude session, subagent and shell reaches the same daemon, so all callers see the same places, one queue per place and the same playtest owners. The full contract is `docs/TOOLS.md` in the ogsync repo; this page is what you need to use it well.

## Reaching Studio

- MCP tools are `mcp__ogsync__<tool>`. An agent without MCP access runs the same tools from a shell: `ogsync call <tool> '<json-args>'`. `ogsync status` prints connected places, peers and playtest state.
- Every tool takes `target`: `<place>[:<role>]`. The place is an alias from `ogsync.toml`, a place id, a place key or the place name; the role is `edit`, `server`, `client` or `client-N`. Without `target` the call goes to `bind.target_place` from the `ogsync.toml` in your working directory.
- `ERR TARGET` lists the candidates. Pick one and pass it; never guess.

## Scripts on disk win

In a project synced from disk (Argon or Rojo), change scripts by editing the files. Never write script source through OGSync there: the next sync overwrites it, or it overwrites the disk. Use OGSync `read`/`grep` to inspect what Studio actually runs, and `edit` only in places with no disk sync.

When Studio sync replaces a file you wrote this session, a hook tells you which file and where your version was saved. Studio wins: keep the current file, diff it against your saved copy and re-apply only what is still needed.

## Playtests

- `playtest` start/stop/status. The caller that starts a test owns it. Stopping someone else's test, or a test the user started in Studio, needs `force: true`; do not pass it unless the user asked.
- Start refuses when Studio is minimized, covered or the screen is locked, and says which. Do not work around it with desktop control; report it.
- Edits to synced files are refused while the place is in a playtest. Wait with `wait {"for":"playtest","state":"idle"}` and retry.
- A warning about stale code means the running test loaded scripts older than the edit session's. Restart the test before trusting results.

## Running code

- `run` with `context: "server"` or `"client"` runs in the GAME VM during a playtest: `require` returns the game's own module instances, writes replicate, and nothing is loaded twice. `vm: "plugin"` runs in the plugin's separate VM; its result is labelled, and requiring game modules there creates second copies (a second data service, duplicate packets). Use it only for edit-time inspection.
- Anything longer than a few seconds, or anything that samples over time, runs with `async: true`. It returns a handle at once; collect or cancel it with `job`. Starting a job with the same `key` cancels the older one, and timers from a cancelled job stop firing.

## Waiting instead of polling

Use `wait` for: a log line (`for: "log"`, regex `pattern`), a playtest state, an attribute value, or an instance appearing. Repeating the same `logs` or `playtest status` call within a second returns `ERR THROTTLED`.

## Seeing and clicking

- `screenshot` returns the scale factor between the image and the real viewport. Pass `hide_ui` to hide GUIs and `frame` with an instance path to point the camera at it; both are restored after the capture. AlwaysOnTop billboards may be missing from captures; the result says so when that applies.
- `input` clicks by instance path, not by pixel coordinates from a screenshot. The result reports which GUI object was hit and whether a button activated. ClickDetectors and hover events cannot be driven; the tool says so instead of failing silently.

## Changing the place

- Each write call (`set`, `create`, `delete`, `duplicate`, `transform`, `edit`) is one undo step, and a call that fails rolls back.
- Move or rotate several models with `transform`; it plans every target from the original pivots first. Run it with `dry_run` first on anything large.
- The place autosaves through Team Create. Never tell the user a place is unsaved.

## Errors

| Code | Meaning | Do |
|---|---|---|
| NOPLUGIN | No Studio plugin connected for that place and role | `ogsync status`; tell the user if Studio is closed or the plugin is off |
| TARGET | No place, or several places, match | Pass `target` from the listed candidates |
| LEASE | Another caller or the user owns the playtest | Wait for it to end (`wait`), or ask the user |
| THROTTLED | Same poll repeated too fast | Use `wait` |
| VERSION | Plugin and daemon protocol differ | Tell the user to run `ogsync plugin install` and reload Studio plugins |
| TIMEOUT | Studio did not answer in time | Check `ogsync status` before retrying; never retry the same call in a loop |
