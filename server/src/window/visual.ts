// Pre-flight for visual tools: Studio only paints its viewport while its
// window is restored, uncovered, on the current virtual desktop and the session
// is unlocked. Screenshots then time out or come back stale and synthetic input
// is dropped, so check first and fail fast with the reason. Windows only; on
// other platforms, or when the native layer is unavailable, the check passes
// with a note instead of blocking.
//
// Wiring for the playtest start path: call
//   const visual = await checkVisual(bridge.bound()?.placeName, { restore });
//   if (!visual.ok) throw new BridgeError("STUDIO", `playtest start refused: ${visual.reason}`);
// before dispatching play.start, and append visual.warnings to its output.

import { nativeDesktop } from "./user32.ts";

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface WinWindow {
  hwnd: number;
  title: string;
  process: string;
  rect: Rect;
  minimized: boolean;
  cloaked: boolean;
  exStyle: number;
  /** Only filled for the foreground window. */
  monitor?: Rect;
}

export interface DesktopSnapshot {
  /** Visible top-level windows, topmost first. */
  windows: WinWindow[];
  foreground: number | null;
  locked: boolean;
}

export interface DesktopApi {
  snapshot(): DesktopSnapshot;
  showNoActivate(hwnd: number): void;
}

export interface StudioReport {
  locked: boolean;
  studio?: WinWindow;
  candidates: string[];
  coverage: number;
  coveredBy: string[];
  foreground?: WinWindow;
  foregroundFullscreen: boolean;
}

export interface VisualCheck {
  ok: boolean;
  reason?: string;
  warnings: string[];
  restored?: boolean;
  report?: StudioReport;
}

const STUDIO_PROCESS = "robloxstudiobeta.exe";
const PLAYER_PROCESS = "robloxplayerbeta.exe";
const OCCLUDED_AT = 0.95;
const GRID_X = 32;
const GRID_Y = 18;
const RESTORE_SETTLE_MS = 300;
const WS_EX_TRANSPARENT = 0x20;
const WS_EX_LAYERED = 0x80000;
const WS_EX_NOACTIVATE = 0x8000000;

const area = (r: Rect) => Math.max(r.right - r.left, 0) * Math.max(r.bottom - r.top, 0);
const isProcess = (w: WinWindow, name: string) => w.process.toLowerCase() === name;

/** Studio main windows are titled "<place> - Roblox Studio"; prefer the largest match. */
export function pickStudio(windows: readonly WinWindow[], placeName: string): { studio?: WinWindow; candidates: string[] } {
  const mains = windows.filter((w) => isProcess(w, STUDIO_PROCESS) && /roblox studio/i.test(w.title));
  const wanted = placeName.trim().toLowerCase();
  const matching = wanted ? mains.filter((w) => w.title.toLowerCase().includes(wanted)) : mains;
  const pool = matching.length ? matching : mains.length === 1 ? mains : [];
  const studio = [...pool].sort((a, b) => area(b.rect) - area(a.rect))[0];
  return { studio, candidates: mains.map((w) => w.title) };
}

/** Click-through overlays (game bars, GPU overlays) cover the screen without hiding anything. */
function occludes(w: WinWindow): boolean {
  if (w.minimized || w.cloaked || area(w.rect) === 0) return false;
  if (w.exStyle & WS_EX_TRANSPARENT) return false;
  if (w.exStyle & WS_EX_LAYERED && w.exStyle & WS_EX_NOACTIVATE) return false;
  // Studio's own floating panels sit above its main window without stopping it.
  return !isProcess(w, STUDIO_PROCESS);
}

/** Share of `target` hidden under `above`, sampled on a grid. */
export function coverage(target: Rect, above: readonly Rect[]): number {
  if (area(target) === 0 || above.length === 0) return 0;
  const w = target.right - target.left;
  const h = target.bottom - target.top;
  let covered = 0;
  for (let i = 0; i < GRID_X; i++) {
    const x = target.left + ((i + 0.5) * w) / GRID_X;
    for (let j = 0; j < GRID_Y; j++) {
      const y = target.top + ((j + 0.5) * h) / GRID_Y;
      if (above.some((r) => x >= r.left && x < r.right && y >= r.top && y < r.bottom)) covered++;
    }
  }
  return covered / (GRID_X * GRID_Y);
}

function covers(outer: Rect | undefined, inner: Rect): boolean {
  return (
    outer !== undefined &&
    area(outer) > 0 &&
    inner.left <= outer.left &&
    inner.top <= outer.top &&
    inner.right >= outer.right &&
    inner.bottom >= outer.bottom
  );
}

export function analyze(snapshot: DesktopSnapshot, placeName: string): StudioReport {
  const { studio, candidates } = pickStudio(snapshot.windows, placeName);
  const foreground = snapshot.windows.find((w) => w.hwnd === snapshot.foreground);
  const report: StudioReport = {
    locked: snapshot.locked,
    studio,
    candidates,
    coverage: 0,
    coveredBy: [],
    foreground,
    foregroundFullscreen: foreground !== undefined && covers(foreground.monitor, foreground.rect),
  };
  if (!studio) return report;
  const index = snapshot.windows.indexOf(studio);
  const above = snapshot.windows.slice(0, index).filter(occludes);
  const hiding = above.filter((w) => coverage(studio.rect, [w.rect]) > 0);
  report.coverage = coverage(studio.rect, hiding.map((w) => w.rect));
  report.coveredBy = hiding
    .sort((a, b) => coverage(studio.rect, [b.rect]) - coverage(studio.rect, [a.rect]))
    .map((w) => `${w.title || "(untitled)"} [${w.process}]`);
  return report;
}

export function verdict(report: StudioReport, placeName: string): VisualCheck {
  const warnings: string[] = [];
  const fg = report.foreground;
  const playerForeground = fg !== undefined && isProcess(fg, PLAYER_PROCESS);
  if (playerForeground) {
    warnings.push(
      `RobloxPlayerBeta is in the foreground${report.foregroundFullscreen ? " (fullscreen)" : ""}: the user's real mouse and keys can reach Studio's play client`,
    );
  }
  if (report.locked) {
    return { ok: false, reason: "the Windows session is locked; Studio does not paint until it is unlocked", warnings, report };
  }
  const studio = report.studio;
  if (!studio) {
    const seen = report.candidates.length ? ` (open: ${report.candidates.join(" | ")})` : "";
    warnings.push(`no Roblox Studio window titled '${placeName}' found${seen}; window state unchecked`);
    return { ok: true, warnings, report };
  }
  if (studio.minimized) {
    return {
      ok: false,
      reason: `Studio window "${studio.title}" is minimized and does not paint; pass restore=true to restore it without taking focus`,
      warnings,
      report,
    };
  }
  if (studio.cloaked) {
    return { ok: false, reason: `Studio window "${studio.title}" is on another virtual desktop and does not paint there`, warnings, report };
  }
  if (report.coverage >= OCCLUDED_AT) {
    const by = report.coveredBy[0] ?? "other windows";
    const player = playerForeground && report.foregroundFullscreen ? " (a fullscreen Roblox player)" : "";
    return {
      ok: false,
      reason: `Studio window "${studio.title}" is ${Math.round(report.coverage * 100)}% covered by ${by}${player} and stops painting; uncover it or minimize what is on top`,
      warnings,
      report,
    };
  }
  return { ok: true, warnings, report };
}

/**
 * Fails fast when Studio cannot paint. restore=true restores a minimized
 * Studio with SW_SHOWNOACTIVATE, which never takes focus from the user.
 */
export async function checkVisual(
  placeName: string | null | undefined,
  opts: { restore?: boolean } = {},
  desktop: DesktopApi | null = nativeDesktop(),
): Promise<VisualCheck> {
  // No bound session means no place to look for; the bridge call reports that.
  if (!desktop || !placeName) return { ok: true, warnings: [] };
  const place = placeName;
  let check: VisualCheck;
  try {
    check = verdict(analyze(desktop.snapshot(), place), place);
    const studio = check.report?.studio;
    if (!check.ok && opts.restore && studio?.minimized) {
      desktop.showNoActivate(studio.hwnd);
      await Bun.sleep(RESTORE_SETTLE_MS);
      check = { ...verdict(analyze(desktop.snapshot(), place), place), restored: true };
    }
  } catch (e) {
    return { ok: true, warnings: [`window check unavailable: ${e instanceof Error ? e.message : String(e)}`] };
  }
  return check;
}
