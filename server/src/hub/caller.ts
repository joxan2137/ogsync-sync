// Who is asking. Tool handlers only see a Bridge, but the daemon needs the
// calling session for queue fairness and playtest leases, so /rpc runs each
// tool inside an async context that every bridge call can read.

import { AsyncLocalStorage } from "node:async_hooks";
import { CONFIG_DEFAULTS, type OgsyncConfig } from "../proto/types.ts";

export interface Caller {
  /** Stable per client process, e.g. `serve-1234`; lease owner and fairness key. */
  id: string;
  /** Human hint shown next to the id (project directory name). */
  label?: string;
  playtest: OgsyncConfig["playtest"];
}

export const DAEMON_CALLER: Caller = { id: "daemon", playtest: CONFIG_DEFAULTS.playtest };

const storage = new AsyncLocalStorage<Caller>();

export function runAs<T>(caller: Caller, fn: () => T): T {
  return storage.run(caller, fn);
}

export function currentCaller(): Caller {
  return storage.getStore() ?? DAEMON_CALLER;
}

export function describeCaller(caller: { id: string; label?: string }): string {
  return caller.label ? `${caller.id} (${caller.label})` : caller.id;
}
