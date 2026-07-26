// Output helpers shared by every tool. Rules from docs/TOOLS.md: plain compact
// text, 2-space indented trees, `path<TAB>field=value` rows, `ERR <code>: <msg>`
// errors, truncation ends with `…more: pass cursor=N`.

import { BridgeError, errLine } from "@proto/types";

export const MAX_RESPONSE_CHARS = 10_000;

export function moreLine(cursorHint?: number | string): string {
  return cursorHint === undefined ? "…more" : `…more: pass cursor=${cursorHint}`;
}

export function capText(
  text: string,
  maxChars = MAX_RESPONSE_CHARS,
  cursorHint?: number | string,
): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  const lastBreak = head.lastIndexOf("\n");
  const body = lastBreak > maxChars / 2 ? head.slice(0, lastBreak) : head;
  return `${body}\n${moreLine(cursorHint)}`;
}

export function numberLines(src: string | readonly string[], offset = 1): string {
  const lines = typeof src === "string" ? src.split("\n") : src;
  const width = String(offset + Math.max(lines.length - 1, 0)).length;
  return lines.map((line, i) => `${String(offset + i).padStart(width)}\t${line}`).join("\n");
}

export function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** `path<TAB>field=value ...`; fields with undefined values are dropped. */
export function row(path: string, fields: Record<string, unknown> = {}): string {
  const pairs = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${fmtValue(v)}`);
  return pairs.length ? `${path}\t${pairs.join(" ")}` : path;
}

/** `path (Class)` header followed by 2-space indented `key=value` lines. */
export function instBlock(
  path: string,
  className: string | undefined,
  entries: Record<string, unknown>,
): string[] {
  const head = className ? `${path} (${className})` : path;
  const lines = [head];
  for (const [k, v] of Object.entries(entries)) {
    if (v === undefined) continue;
    lines.push(`  ${k}=${fmtValue(v)}`);
  }
  return lines;
}

export interface TreeNode {
  name: string;
  class?: string;
  lines?: number;
  count?: number;
  children?: TreeNode[];
}

export function renderTree(node: TreeNode, indent = 0): string[] {
  const bits = [node.name];
  if (node.class) bits.push(node.class);
  if (node.lines !== undefined) bits.push(`#${node.lines}`);
  if (node.count !== undefined) bits.push(`[${node.count}]`);
  const out = [`${"  ".repeat(indent)}${bits.join(" ")}`];
  for (const child of node.children ?? []) out.push(...renderTree(child, indent + 1));
  return out;
}

/** `Part1 Part2 Part3` → `Part[1..3]`; only consecutive runs collapse. */
export function compactPaths(paths: readonly string[]): string[] {
  const out: string[] = [];
  let stem: string | null = null;
  let first = 0;
  let last = 0;
  const flush = () => {
    if (stem === null) return;
    out.push(first === last ? `${stem}${first}` : `${stem}[${first}..${last}]`);
    stem = null;
  };
  for (const path of paths) {
    const m = /^(.*?)(\d+)$/.exec(path);
    if (!m) {
      flush();
      out.push(path);
      continue;
    }
    const prefix = m[1] ?? "";
    const n = Number(m[2]);
    if (stem === prefix && n === last + 1) {
      last = n;
      continue;
    }
    flush();
    stem = prefix;
    first = n;
    last = n;
  }
  flush();
  return out;
}

export function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

export function lines(...parts: Array<string | string[] | undefined>): string {
  return parts
    .flat()
    .filter((p): p is string => p !== undefined)
    .join("\n");
}

export function badArg(message: string): BridgeError {
  return new BridgeError("BADARG", message);
}

export function errText(e: unknown): string {
  return errLine(e);
}
