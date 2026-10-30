// Win32 desktop snapshot through Bun FFI: every top-level window in z-order
// with its title, owning process, frame rect and visibility flags, plus the
// foreground window and whether the session is locked. In-process calls take
// microseconds; a PowerShell round trip would cost a process spawn plus an
// Add-Type compile (~1 s) on every check and is at the mercy of execution
// policy and AV hooks, which is too slow and too fragile for a pre-flight that
// runs before every screenshot and input batch.

import { dlopen, FFIType, type Pointer } from "bun:ffi";
import type { DesktopApi, DesktopSnapshot, Rect, WinWindow } from "./visual.ts";

const GWL_EXSTYLE = -20;
const SW_SHOWNOACTIVATE = 4;
const MONITOR_DEFAULTTONEAREST = 2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const DESKTOP_READOBJECTS = 0x0001;
const UOI_NAME = 2;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;
const TITLE_CHARS = 512;
const PATH_CHARS = 1024;

const { ptr: P, i32, u32, i64 } = FFIType;

function load() {
  const user32 = dlopen("user32.dll", {
    FindWindowExW: { args: [P, P, P, P], returns: P },
    IsWindowVisible: { args: [P], returns: i32 },
    IsIconic: { args: [P], returns: i32 },
    GetWindowTextW: { args: [P, P, i32], returns: i32 },
    GetWindowThreadProcessId: { args: [P, P], returns: u32 },
    GetWindowRect: { args: [P, P], returns: i32 },
    GetWindowLongPtrW: { args: [P, i32], returns: i64 },
    GetForegroundWindow: { args: [], returns: P },
    ShowWindow: { args: [P, i32], returns: i32 },
    MonitorFromWindow: { args: [P, u32], returns: P },
    GetMonitorInfoW: { args: [P, P], returns: i32 },
    OpenInputDesktop: { args: [u32, i32, u32], returns: P },
    GetUserObjectInformationW: { args: [P, i32, P, u32, P], returns: i32 },
    CloseDesktop: { args: [P], returns: i32 },
    // DPI_AWARENESS_CONTEXT is a pseudo-handle (small negative values), so it
    // travels as a signed integer rather than a pointer.
    SetThreadDpiAwarenessContext: { args: [i64], returns: i64 },
  });
  const kernel32 = dlopen("kernel32.dll", {
    OpenProcess: { args: [u32, i32, u32], returns: P },
    QueryFullProcessImageNameW: { args: [P, u32, P, P], returns: i32 },
    CloseHandle: { args: [P], returns: i32 },
  });
  const dwmapi = dlopen("dwmapi.dll", {
    DwmGetWindowAttribute: { args: [P, u32, P, u32], returns: i32 },
  });
  return { user32: user32.symbols, kernel32: kernel32.symbols, dwm: dwmapi.symbols };
}

type Libs = ReturnType<typeof load>;

let libs: Libs | null = null;

function rectOf(buf: Int32Array): Rect {
  return { left: buf[0]!, top: buf[1]!, right: buf[2]!, bottom: buf[3]! };
}

function wide(buf: Uint16Array, length: number): string {
  return Buffer.from(buf.buffer, buf.byteOffset, length * 2).toString("utf16le");
}

function processName({ kernel32 }: Libs, pid: number): string {
  const handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!handle) return "";
  try {
    const path = new Uint16Array(PATH_CHARS);
    const size = new Uint32Array([PATH_CHARS]);
    if (!kernel32.QueryFullProcessImageNameW(handle, 0, path, size)) return "";
    const full = wide(path, size[0]!);
    return full.slice(full.lastIndexOf("\\") + 1);
  } finally {
    kernel32.CloseHandle(handle);
  }
}

function frameRect({ user32, dwm }: Libs, hwnd: Pointer): Rect {
  const buf = new Int32Array(4);
  // The DWM frame excludes the invisible resize borders GetWindowRect includes.
  if (dwm.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, buf, 16) === 0) return rectOf(buf);
  user32.GetWindowRect(hwnd, buf);
  return rectOf(buf);
}

function monitorRect({ user32 }: Libs, hwnd: Pointer): Rect | undefined {
  const monitor = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
  if (!monitor) return undefined;
  // MONITORINFO: cbSize, rcMonitor, rcWork, dwFlags (40 bytes).
  const info = new Int32Array(10);
  info[0] = 40;
  if (!user32.GetMonitorInfoW(monitor, info)) return undefined;
  return rectOf(info.subarray(1, 5));
}

function isLocked({ user32 }: Libs): boolean {
  // The lock screen owns the input desktop ("Winlogon"); a user process cannot
  // open it at all, which is the common case.
  const desktop = user32.OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
  if (!desktop) return true;
  try {
    const name = new Uint16Array(64);
    const needed = new Uint32Array(1);
    if (!user32.GetUserObjectInformationW(desktop, UOI_NAME, name, name.byteLength, needed)) return false;
    return wide(name, Math.max(needed[0]! / 2 - 1, 0)).toLowerCase() !== "default";
  } finally {
    user32.CloseDesktop(desktop);
  }
}

// DWM frame bounds are always physical pixels, while GetWindowRect and
// GetMonitorInfo answer in the calling thread's DPI space. Per-monitor-v2
// awareness for the walk puts every rect in physical pixels.
function snapshot(l: Libs): DesktopSnapshot {
  const previous = l.user32.SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  try {
    return walk(l);
  } finally {
    if (previous) l.user32.SetThreadDpiAwarenessContext(previous);
  }
}

function walk(l: Libs): DesktopSnapshot {
  const { user32, dwm } = l;
  const windows: WinWindow[] = [];
  const names = new Map<number, string>();
  const title = new Uint16Array(TITLE_CHARS);
  const pid = new Uint32Array(1);
  const cloaked = new Uint32Array(1);
  // FindWindowExW over the desktop's children walks top-level windows in
  // z-order, topmost first, without a JS callback.
  let hwnd = user32.FindWindowExW(null, null, null, null);
  while (hwnd) {
    if (user32.IsWindowVisible(hwnd)) {
      user32.GetWindowThreadProcessId(hwnd, pid);
      const owner = pid[0]!;
      if (!names.has(owner)) names.set(owner, processName(l, owner));
      cloaked[0] = 0;
      dwm.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, cloaked, 4);
      windows.push({
        hwnd: Number(hwnd),
        title: wide(title, user32.GetWindowTextW(hwnd, title, TITLE_CHARS)),
        process: names.get(owner) ?? "",
        rect: frameRect(l, hwnd),
        minimized: user32.IsIconic(hwnd) !== 0,
        cloaked: cloaked[0] !== 0,
        exStyle: Number(user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)),
      });
    }
    hwnd = user32.FindWindowExW(null, hwnd, null, null);
  }
  const foreground = user32.GetForegroundWindow();
  const foregroundWindow = foreground ? windows.find((w) => w.hwnd === Number(foreground)) : undefined;
  if (foregroundWindow && foreground) foregroundWindow.monitor = monitorRect(l, foreground);
  return { windows, foreground: foreground ? Number(foreground) : null, locked: isLocked(l) };
}

/** null when user32 cannot be loaded (not Windows, or FFI unavailable). */
export function nativeDesktop(): DesktopApi | null {
  if (process.platform !== "win32") return null;
  try {
    libs ??= load();
  } catch {
    return null;
  }
  const loaded = libs;
  return {
    snapshot: () => snapshot(loaded),
    showNoActivate: (hwnd) => {
      loaded.user32.ShowWindow(hwnd as Pointer, SW_SHOWNOACTIVATE);
    },
  };
}
