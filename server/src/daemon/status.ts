// `ogsync status`: the daemon's /state in a few human lines. Hooks and scripts
// use `ogsync status --json` (the same /state body) instead of curl.

import type { PlaceState, StateResponse } from "../proto/types.ts";

export function formatState(state: StateResponse, now = Date.now()): string {
  const d = state.daemon;
  const out = [`ogsync ${d.version} daemon pid ${d.pid} on 127.0.0.1:${d.port} (proto ${d.proto}), up ${duration(now - d.startedAt)}`];
  if (state.places.length === 0) {
    out.push("places: none (open a place in Studio with the OGSync plugin enabled)");
    return out.join("\n");
  }
  out.push("places:");
  for (const place of state.places) out.push(...formatPlace(place));
  return out.join("\n");
}

function formatPlace(place: PlaceState): string[] {
  const peers = place.peers.length === 0
    ? "no peers (gone; state kept until it ages out)"
    : place.peers.map((peer) => `${peer.role} ${duration(peer.ageMs)}`).join(", ");
  const p = place.playtest;
  const facts = [
    `playtest ${p.state}`,
    p.mode ? `mode=${p.mode}` : "",
    p.owner ? `owner=${p.owner}` : p.startedBy === "user" ? "started in Studio" : "",
    p.state === "idle" ? "" : `for ${duration(Date.now() - p.since)}`,
    `heartbeat ${p.heartbeatAgeMs === null ? "none" : duration(p.heartbeatAgeMs)}`,
    p.players > 0 ? `players=${p.players}` : "",
  ].filter(Boolean);
  const lines = [`  ${place.key} (${place.name})  peers: ${peers}`, `    ${facts.join(" ")}`];
  if (p.stale) lines.push(`    STALE CODE: ${p.stale.changed} changed, ${p.stale.missing} missing (${p.stale.sample.join(", ")})`);
  if (p.warning) lines.push(`    WARNING: ${p.warning}`);
  return lines;
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}
