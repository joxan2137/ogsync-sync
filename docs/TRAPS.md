# Studio MCP traps OGSync must handle natively

Collected from months of use of the community robloxstudio MCP (hub on :58741). Each line: symptom | root cause | what OGSync should do.

## Hub, plugin, connectivity
1. Studio tools return no instances / "no plugin connected", sometimes only for some roles | every Claude session spawns its own hub, plugin attaches to one, edit and play peers land on different hubs | ONE daemon per machine, independent of sessions, single-instance lock; sessions are thin proxies; all peers of a place (edit, server, client-N) register with that daemon.
2. "fetch failed" / ~10 s outage, in-flight calls lost | hub dies with the Claude session that owns it | daemon outlives sessions; request journal so a call survives a plugin reconnect; idempotent op ids.
3. Plugin keeps calling a dead port forever | plugin pins its last remembered URL and never scans | on connect failure fall back to a fixed candidate port list / discovery; never pin a URL that is down.
4. HTTP 426 plugin version mismatch | two installers overwrite the plugin file with different builds | exactly one component installs the plugin; handshake on protocol version, not build; clear mismatch error.
5. After a hub restart the plugin loops on 404 unknown peer | plugin caches its ready state across reconnects | re-handshake on any unknown-session / 404; daemon can re-adopt a peer by token.
6. Hub bind fails silently and falls into proxy mode with nothing to poll | Windows Hyper-V excluded port ranges (e.g. 58706-58805), shifting across reboots | at startup read `netsh int ipv4 show excludedportrange protocol=tcp`, pick a free port outside them, publish it.
7. Localhost probes lie (curl empty reply, child fetch fails, undici libuv assert on exit) | HTTP_PROXY / a local proxy bridge on :7890; undici keep-alive on Windows | strip proxy env, set NO_PROXY for localhost; ship a `status` CLI/tool so nobody needs curl.
8. Wrong or ambiguous target (stale instance id after restart, new id for playtest peers, several places/Studios with the same placeId, placeId 0 unsaved places) | instance ids ephemeral; many places on one hub | bind by placeId (+ place name for unsaved) + role, with stable aliases in config; never "whatever connected first" when more than one candidate; explicit error listing candidates.
9. Parallel agents stall Studio's renderer, plugin drops off | one shared bridge, fan-out starves Studio | per-place queue, concurrency 1, fair scheduling across sessions, rate limits on polls, batch tools.
10. A sampler sent "in parallel" with a click runs after it | hub serializes per peer | first-class recorder / async job: start returns a handle, collect later.
11. Some agent types (no MCP) cannot reach Studio | MCP-only access | a shell CLI (`ogsync call <tool> <json>`) to the daemon.

## Rendering, capture, input
12. "no frame in N s", playtest start not ready, input refused; minimized = black 3D view; stale frames | Studio does not paint when minimized, occluded, or screen locked | before visual tools or playtest start check minimized/occluded/foreground/lock state; fail fast with the reason; restore with SW_SHOWNOACTIVATE, never steal focus; short capture timeout.
13. Clicks read off a screenshot miss | capture downscaled; GuiInset (+58 px top bar); edit-time AbsolutePosition off by inset | click(instancePath) resolving AbsolutePosition + inset at runtime; screenshots return their scale factor; after a click report the object hit (GetGuiObjectsAtPosition).
14. Synthetic clicks never fire ClickDetector / MouseEnter; some clicks dropped | synthesized input without cursor move; VirtualInputManager blocked | report "unsupported" explicitly; verify the click reached its target.
15. Capture omits AlwaysOnTop billboards; fullscreen opaque ScreenGui blacks out capture | capture path limits; drafts left Enabled | warn about fullscreen opaque GUIs; document the AlwaysOnTop limit in the result.
16. Captures leave the user's camera moved or UI hidden; Team Create saves those edits | agents toggle Visible/Enabled and move CurrentCamera | capture takes hideUi and frame arguments and restores camera and UI state in a finally.
17. User's real mouse in a fullscreen Roblox game reaches Studio's play client | Studio still receives input | detect a foreground RobloxPlayerBeta and report it.
18. Desktop control needed to restore/focus Studio | no tool for window state | window restore and capture go through the daemon.

## Playtest lifecycle
19. Stopping or blocking someone else's playtest (another agent or the user) | no ownership | leases with owner session, queue / wait-turn; stop requires the owner (or force); a playtest the user started is never stopped by an agent without force.
20. start says "did not become ready" while the game runs; "previous test still in progress"; teardown never settles | state inferred from peer registration | state machine driven by plugin-reported RunService/StudioTestService state; idempotent start/stop; truthful status.
21. Write guard reports "clear" during live playtests | guard reads an outdated status shape and a stale presence tail | plugin pushes authoritative playtest state with heartbeat; daemon exposes it on a cheap local endpoint; consumers fail closed when unknown.
22. Code inside a Local Server test is stale | test loads a copy saved at launch | each peer reports a script-hash snapshot so the tool flags stale code.
23. Multi-client tests drive CPU to 100% and crash Studio | every client is a process | hard client cap and auto-end timeout.
24. No user plugins in playtests | "Load User Plugins in Test Mode" off | detect (edit session playing but no server peer within N s) and say so.
25. "plugin is not responding" at playtest start | plugin work over 10 s in one frame | plugin chunks work across frames.
26. Playtests write the real profile / DataStores | owner account, resetData false | out of scope for now.

## Eval VM semantics
27. Eval require gives a second copy of game modules (second DataService steals the profile session, duplicate packets, server writes that do not replicate, cached module errors) | eval runs in the plugin VM with its own require cache | runtime eval runs in the GAME VM by default during a playtest (injected bridge Script/LocalScript that requires a fresh ModuleScript holding the code, so it shares the game's require cache without loadstring); plugin-VM eval only on request and labelled.
28. Eval waiter caps at 30 s; a long busy-wait disconnects the bridge; an old task.delay kills a re-armed sampler | synchronous request/response | async jobs with handles and generation tokens.
29. Identical retries and rapid log polls fail the same way | no wait primitives | wait_for(log pattern / playtest state / attribute / instance exists) long-poll tool.

## Script writes and sync
30. Pushed source differs from disk (escaped newlines, size limits ~6-16 KB, CRLF/LF, long-bracket newline drop, open editor document overrides Source) | transport escaping, size limits, Script Editor documents | binary-safe chunked upload, LF-normalize, hash-verify after write, write via ScriptEditorService:UpdateSourceAsync and compare GetEditorSource.
31-33. Argon sync traps | out of scope for these branches (Argon stays; a Claude hook will report overwritten agent edits).

## Place edits
34. Bulk moves accumulate on welded assemblies; Undo does not restore Destroy()ed instances; WorldPivot writes no-op or drift; property reads miss AnchorPoint/layout/UDim2 | engine semantics, missing ChangeHistory recording | every write wrapped in ChangeHistoryService:TryBeginRecording/FinishRecording; transform op computes targets from originals first, applies via PivotTo, deletes last, supports dry-run; full property serialization in get.
