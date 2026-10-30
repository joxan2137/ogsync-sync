// MCP server over stdio. stdout belongs to the JSON-RPC transport alone —
// anything this layer wants to say goes to stderr.
//
// Tools execute in the daemon (executeTool, reached over /rpc); a session's
// `ogsync serve` registers the same schemas and forwards every call there.
// Every tool also takes `target`, resolved by the daemon, so it lives here
// instead of in each tool's schema.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import type { Bridge } from "@proto/types";
import { errText } from "./fmt.ts";
import type { McpDeps, ToolModule, ToolOutput } from "./tool.ts";
import { TOOLS } from "./tools/index.ts";

export type ToolForwarder = (tool: string, args: unknown) => Promise<CallToolResult>;

export const TARGET_ARG = z
  .union([z.string(), z.number()])
  .optional()
  .describe("place alias, key or name, optional :edit|:server|:client-N; default from ogsync.toml");

export function toolShape(tool: ToolModule): ZodRawShape {
  return { ...tool.schema, target: TARGET_ARG };
}

/** Validates and runs one tool; Studio-side failures come back as ERR text, not throws. */
export async function executeTool(bridge: Bridge, deps: McpDeps, name: string, args: unknown): Promise<CallToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return asResult(`ERR BADARG: unknown tool '${name}'`);
  const parsed = z.object(toolShape(tool)).safeParse(args ?? {});
  if (!parsed.success) {
    return asResult(`ERR BADARG: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  try {
    return asResult(await tool.handler(bridge, deps, parsed.data as never));
  } catch (e) {
    return asResult(errText(e));
  }
}

/** Executes locally against `bridge`; the daemon-less path tests drive. */
export function createMcpServer(bridge: Bridge, deps: McpDeps): McpServer {
  return register(new McpServer({ name: "ogsync", version: deps.version }), (name, args) =>
    executeTool(bridge, deps, name, args),
  );
}

export function createForwardingMcpServer(version: string, forward: ToolForwarder): McpServer {
  return register(new McpServer({ name: "ogsync", version }), async (name, args) => {
    try {
      return await forward(name, args);
    } catch (e) {
      return asResult(errText(e));
    }
  });
}

export async function startForwardingMcp(version: string, forward: ToolForwarder): Promise<void> {
  await createForwardingMcpServer(version, forward).connect(new StdioServerTransport());
}

function register(server: McpServer, run: (name: string, args: unknown) => Promise<CallToolResult>): McpServer {
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: toolShape(tool) },
      async (args: unknown) => run(tool.name, args),
    );
  }
  return server;
}

function asResult(out: ToolOutput): CallToolResult {
  return typeof out === "string" ? { content: [{ type: "text", text: out }] } : out;
}
