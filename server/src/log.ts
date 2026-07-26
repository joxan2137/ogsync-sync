// Every diagnostic goes to stderr: stdout carries MCP JSON-RPC framing only.
// Level from OGSYNC_LOG (debug|info|warn|error), default info.

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function parseLevel(raw: string | undefined): LogLevel | null {
  const value = raw?.trim().toLowerCase();
  return value !== undefined && value in RANK ? (value as LogLevel) : null;
}

let threshold: LogLevel = parseLevel(process.env["OGSYNC_LOG"]) ?? "info";

function render(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    return threshold === "debug" && value.stack ? value.stack : value.message;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function write(level: LogLevel, parts: unknown[]): void {
  if (RANK[level] < RANK[threshold]) return;
  try {
    process.stderr.write(`ogsync ${level}: ${parts.map(render).join(" ")}\n`);
  } catch {
    // stderr gone (closed pipe); dropping the line is the only safe action
  }
}

export const log = {
  debug: (...parts: unknown[]): void => write("debug", parts),
  info: (...parts: unknown[]): void => write("info", parts),
  warn: (...parts: unknown[]): void => write("warn", parts),
  error: (...parts: unknown[]): void => write("error", parts),
  setLevel: (level: LogLevel): void => {
    threshold = level;
  },
  get level(): LogLevel {
    return threshold;
  },
};

function isEpipe(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "EPIPE";
}

// An MCP client that exits mid-write must not take the daemon down with it.
process.stdout.on("error", (err: unknown) => {
  if (!isEpipe(err)) write("error", ["stdout write failed:", err]);
});
process.stderr.on("error", () => {});
process.on("uncaughtException", (err: unknown) => {
  if (isEpipe(err)) return;
  throw err;
});
