// Tool module contract: every tools/<name>.ts exports one of these and
// tools/index.ts collects them into the static array server.ts registers.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import type { Bridge, CallOpts, SyncControl } from "@proto/types";

export const DEFAULT_TIMEOUT_MS = 15_000;
export const LONG_TIMEOUT_MS = 60_000;

export interface McpDeps {
  sync: SyncControl | null;
  version: string;
}

export type ToolOutput = string | CallToolResult;

export interface ToolModule<S extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  schema: S;
  handler(bridge: Bridge, deps: McpDeps, args: z.infer<z.ZodObject<S>>): Promise<ToolOutput>;
}

export function defineTool<S extends ZodRawShape>(tool: ToolModule<S>): ToolModule {
  return tool as unknown as ToolModule;
}

/** Every tool accepts timeout_ms (docs/TOOLS.md global convention). */
export const TIMEOUT_ARG = z.number().int().positive().optional();

export function callOpts(
  args: { timeout_ms?: number | undefined },
  fallbackMs = DEFAULT_TIMEOUT_MS,
  extra?: Omit<CallOpts, "timeoutMs">,
): CallOpts {
  return { ...extra, timeoutMs: args.timeout_ms ?? fallbackMs };
}
