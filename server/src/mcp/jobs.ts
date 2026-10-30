// Eval job handles and the result rendering `run` and `job` share. A handle
// names the session that owns the job, so `job` can route back to it, plus that
// session's registry nonce, because job ids restart at 1 in every play
// DataModel: `server:7.1a2b3c4d`, `client@Player1:2.1a2b3c4d`.

import { clip, fmtValue, moreLine } from "./fmt.ts";

const RETURN_CAP = 2000;

export type RunContext = "edit" | "server" | "client";

export interface JobHandle {
  context: RunContext;
  player?: string;
  id: string;
  nonce: string;
}

export interface RunResult {
  output?: Array<{ level?: string; text?: string } | string>;
  returns?: unknown[];
  truncated?: boolean;
  dropped?: number;
  vm?: string;
  context?: string;
  job?: string;
  gen?: number;
  nonce?: string;
  key?: string;
  status?: string;
  elapsed?: number;
  err?: string;
}

export function formatHandle(handle: JobHandle): string {
  const owner = handle.player === undefined ? handle.context : `${handle.context}@${handle.player}`;
  return `${owner}:${handle.id}.${handle.nonce}`;
}

export function parseHandle(text: string): JobHandle | null {
  const m = /^(edit|server|client)(?:@([^:]+))?:(\d+)\.([0-9a-z]+)$/.exec(text.trim());
  if (!m) return null;
  const [, context, player, id, nonce] = m;
  if (player !== undefined && context !== "client") return null;
  return { context: context as RunContext, ...(player === undefined ? {} : { player }), id: id!, nonce: nonce! };
}

/** Print output, `=> value` returns, then drop/truncation notes. */
export function renderRun(data: RunResult): string[] {
  const out = (data.output ?? []).map((entry) => {
    if (typeof entry === "string") return entry;
    const text = entry.text ?? "";
    return entry.level && entry.level !== "info" ? `[${entry.level}] ${text}` : text;
  });
  const returns = (data.returns ?? []).map((v) => `=> ${clip(fmtValue(v), RETURN_CAP)}`);
  const notes = [
    data.dropped ? `${data.dropped} output lines dropped` : undefined,
    data.truncated ? moreLine() : undefined,
  ].filter((n): n is string => n !== undefined);
  return [...out, ...returns, ...notes];
}

/** Only plugin-VM results in a play context are labelled: that is the surprising case. */
export function vmLabel(context: string, vm: string | undefined): string | undefined {
  return context !== "edit" && vm === "plugin"
    ? "[vm=plugin: separate require cache, not the game's module instances]"
    : undefined;
}
