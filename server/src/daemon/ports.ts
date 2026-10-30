// Port choice for the daemon. Hyper-V/WSL reserve blocks of TCP ports on
// Windows (`netsh int ipv4 show excludedportrange`), and the blocks move across
// reboots; binding inside one fails, so excluded candidates are skipped before
// anything tries them. The daemon only ever binds CANDIDATE_PORTS, which is the
// list the plugin scans.

import { spawnSync } from "node:child_process";
import { CANDIDATE_PORTS } from "../proto/types.ts";
import { log } from "../log.ts";

const NETSH_TIMEOUT_MS = 3_000;

export type PortRange = readonly [start: number, end: number];

/** Rows of `Start Port  End Port` pairs; headers, dashes and `*` markers are ignored. */
export function parseExcludedRanges(text: string): PortRange[] {
  const ranges: PortRange[] = [];
  for (const line of text.split(/\r?\n/)) {
    const row = /^\s*(\d+)\s+(\d+)\b/.exec(line);
    if (!row) continue;
    const start = Number(row[1]);
    const end = Number(row[2]);
    if (start <= end && end <= 65535) ranges.push([start, end]);
  }
  return ranges;
}

export function readExcludedRanges(platform: NodeJS.Platform = process.platform): PortRange[] {
  if (platform !== "win32") return [];
  try {
    const result = spawnSync("netsh", ["int", "ipv4", "show", "excludedportrange", "protocol=tcp"], {
      encoding: "utf8",
      timeout: NETSH_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return [];
    return parseExcludedRanges(result.stdout);
  } catch (err) {
    log.debug("netsh excludedportrange unavailable:", err);
    return [];
  }
}

export function isExcluded(port: number, ranges: readonly PortRange[]): boolean {
  return ranges.some(([start, end]) => port >= start && port <= end);
}

/**
 * Ports to try in order: an explicit preference first (--port, OGSYNC_PORT,
 * daemon.port), then the candidate list; excluded ones dropped.
 */
export function portCandidates(preferred: number | null, ranges: readonly PortRange[]): number[] {
  if (preferred !== null && !CANDIDATE_PORTS.includes(preferred)) {
    log.warn(
      `port ${preferred} is not one the plugin scans (${CANDIDATE_PORTS.join(", ")}); Studio finds the daemon there only if its OGSync panel is set to ${preferred}`,
    );
  }
  const ordered = preferred === null ? [...CANDIDATE_PORTS] : [preferred, ...CANDIDATE_PORTS];
  const usable = [...new Set(ordered)].filter((port) => !isExcluded(port, ranges));
  const dropped = ordered.filter((port) => isExcluded(port, ranges));
  if (dropped.length > 0) log.info(`skipping ports inside Windows excluded ranges: ${[...new Set(dropped)].join(", ")}`);
  return usable;
}
