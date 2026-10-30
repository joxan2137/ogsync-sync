import { describe, expect, test } from "bun:test";
import {
  analyze,
  checkVisual,
  coverage,
  pickStudio,
  verdict,
  type DesktopApi,
  type DesktopSnapshot,
  type WinWindow,
} from "./visual.ts";

const SCREEN = { left: 0, top: 0, right: 1920, bottom: 1080 };
const LEFT_HALF = { left: 0, top: 0, right: 960, bottom: 1080 };

function win(over: Partial<WinWindow> & Pick<WinWindow, "hwnd">): WinWindow {
  return { title: "", process: "app.exe", rect: SCREEN, minimized: false, cloaked: false, exStyle: 0, ...over };
}

const studio = win({ hwnd: 10, title: "Place2 - Roblox Studio", process: "RobloxStudioBeta.exe" });

function desk(windows: WinWindow[], foreground: number | null = null, locked = false): DesktopSnapshot {
  return { windows, foreground, locked };
}

describe("pickStudio", () => {
  test("matches the place name in the main window title, case-insensitively", () => {
    const other = win({ hwnd: 11, title: "Other - Roblox Studio", process: "RobloxStudioBeta.exe" });
    const panel = win({ hwnd: 12, title: "Output", process: "RobloxStudioBeta.exe" });
    const picked = pickStudio([panel, other, studio], "place2");
    expect(picked.studio).toBe(studio);
    expect(picked.candidates).toEqual(["Other - Roblox Studio", "Place2 - Roblox Studio"]);
  });

  test("falls back to the only Studio window when the title does not carry the name", () => {
    expect(pickStudio([studio], "Unpublished").studio).toBe(studio);
  });

  test("refuses to guess between several non-matching Studio windows", () => {
    const other = win({ hwnd: 11, title: "Other - Roblox Studio", process: "RobloxStudioBeta.exe" });
    expect(pickStudio([other, studio], "Nope").studio).toBeUndefined();
  });
});

describe("coverage", () => {
  test("measures the share hidden under the given rects", () => {
    expect(coverage(SCREEN, [])).toBe(0);
    expect(coverage(SCREEN, [SCREEN])).toBe(1);
    expect(coverage(SCREEN, [LEFT_HALF])).toBe(0.5);
    expect(coverage(SCREEN, [LEFT_HALF, { left: 960, top: 0, right: 1920, bottom: 1080 }])).toBe(1);
  });
});

describe("analyze + verdict", () => {
  test("an uncovered Studio passes", () => {
    const check = verdict(analyze(desk([studio], 10), "Place2"), "Place2");
    expect(check).toMatchObject({ ok: true, warnings: [] });
  });

  test("a minimized Studio fails and suggests restore", () => {
    const check = verdict(analyze(desk([{ ...studio, minimized: true }]), "Place2"), "Place2");
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("minimized");
    expect(check.reason).toContain("restore=true");
  });

  test("a locked session fails before anything else", () => {
    const check = verdict(analyze(desk([{ ...studio, minimized: true }], null, true), "Place2"), "Place2");
    expect(check.reason).toContain("locked");
  });

  test("a window on another virtual desktop fails", () => {
    expect(verdict(analyze(desk([{ ...studio, cloaked: true }]), "Place2"), "Place2").reason).toContain("virtual desktop");
  });

  test("a full cover fails and names the coverer; a half cover passes", () => {
    const editor = win({ hwnd: 1, title: "Code", process: "Code.exe" });
    const covered = verdict(analyze(desk([editor, studio], 1), "Place2"), "Place2");
    expect(covered.ok).toBe(false);
    expect(covered.reason).toContain("100% covered by Code [Code.exe]");
    const half = verdict(analyze(desk([{ ...editor, rect: LEFT_HALF }, studio], 1), "Place2"), "Place2");
    expect(half.ok).toBe(true);
  });

  test("click-through overlays, minimized windows and Studio's own panels do not occlude", () => {
    const overlay = win({ hwnd: 1, title: "Overlay", exStyle: 0x20 | 0x80000 });
    const toast = win({ hwnd: 2, title: "Toast", exStyle: 0x80000 | 0x8000000 });
    const parked = win({ hwnd: 3, title: "Parked", minimized: true });
    const panel = win({ hwnd: 4, title: "Explorer", process: "RobloxStudioBeta.exe" });
    const check = verdict(analyze(desk([overlay, toast, parked, panel, studio], 10), "Place2"), "Place2");
    expect(check.ok).toBe(true);
  });

  test("windows below Studio never count as covering it", () => {
    const below = win({ hwnd: 1, title: "Below" });
    expect(analyze(desk([studio, below]), "Place2").coverage).toBe(0);
  });

  test("a fullscreen RobloxPlayerBeta on top fails and warns that real input leaks", () => {
    const player = win({ hwnd: 1, title: "Roblox", process: "RobloxPlayerBeta.exe", monitor: SCREEN });
    const check = verdict(analyze(desk([player, studio], 1), "Place2"), "Place2");
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("a fullscreen Roblox player");
    expect(check.warnings[0]).toContain("RobloxPlayerBeta is in the foreground (fullscreen)");
  });

  test("a missing Studio window warns instead of blocking", () => {
    const check = verdict(analyze(desk([win({ hwnd: 1, title: "Notepad" })]), "Place2"), "Place2");
    expect(check.ok).toBe(true);
    expect(check.warnings[0]).toContain("no Roblox Studio window titled 'Place2'");
  });
});

describe("checkVisual", () => {
  function fakeDesktop(snapshots: DesktopSnapshot[]) {
    const restored: number[] = [];
    let index = 0;
    const api: DesktopApi = {
      snapshot: () => snapshots[Math.min(index++, snapshots.length - 1)]!,
      showNoActivate: (hwnd) => restored.push(hwnd),
    };
    return { api, restored };
  }

  test("restore=true un-minimizes without activation, then re-checks", async () => {
    const { api, restored } = fakeDesktop([desk([{ ...studio, minimized: true }]), desk([studio])]);
    const check = await checkVisual("Place2", { restore: true }, api);
    expect(restored).toEqual([10]);
    expect(check).toMatchObject({ ok: true, restored: true });
  });

  test("without restore a minimized Studio is reported, never touched", async () => {
    const { api, restored } = fakeDesktop([desk([{ ...studio, minimized: true }])]);
    const check = await checkVisual("Place2", {}, api);
    expect(check.ok).toBe(false);
    expect(restored).toEqual([]);
  });

  test("no bound place or no native layer skips the check", async () => {
    const { api } = fakeDesktop([desk([{ ...studio, minimized: true }])]);
    expect((await checkVisual(undefined, {}, api)).ok).toBe(true);
    expect((await checkVisual("Place2", {}, null)).ok).toBe(true);
  });

  test("a failing native layer degrades to a warning", async () => {
    const api: DesktopApi = {
      snapshot: () => {
        throw new Error("boom");
      },
      showNoActivate: () => {},
    };
    expect(await checkVisual("Place2", {}, api)).toEqual({ ok: true, warnings: ["window check unavailable: boom"] });
  });

  test.if(process.platform === "win32")("the native snapshot runs against the real desktop", async () => {
    // Read-only: no restore. The verdict depends on the live desktop, so only
    // assert that the FFI layer answered instead of degrading to a warning.
    const check = await checkVisual("__ogsync_no_such_place__");
    expect(typeof check.ok).toBe("boolean");
    expect(check.warnings.some((w) => w.startsWith("window check unavailable"))).toBe(false);
  });
});
