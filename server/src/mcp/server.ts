// MCP server over stdio. stdout belongs to the JSON-RPC transport alone —
// anything this layer wants to say goes to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Bridge } from "@proto/types";
import { errText } from "./fmt.ts";
import type { McpDeps, ToolOutput } from "./tool.ts";
import { TOOLS } from "./tools/index.ts";

export interface McpHandle {
  /** Executes a tool by name for HTTP /rpc clients (proxy instances, CLI). */
  callTool(tool: string, args: unknown): Promise<CallToolResult>;
}

export async function startMcp(bridge: Bridge, deps: McpDeps): Promise<McpHandle> {
  await createMcpServer(bridge, deps).connect(new StdioServerTransport());
  return {
    async callTool(name, args) {
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return asResult(`ERR BADARG: unknown tool '${name}'`);
      const parsed = z.object(tool.schema).safeParse(args ?? {});
      if (!parsed.success) {
        return asResult(`ERR BADARG: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      }
      try {
        return asResult(await tool.handler(bridge, deps, parsed.data as never));
      } catch (e) {
        return asResult(errText(e));
      }
    },
  };
}

export function createMcpServer(bridge: Bridge, deps: McpDeps): McpServer {
  const server = new McpServer({ name: "ogsync", version: deps.version });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      async (args: unknown) => {
        try {
          return asResult(await tool.handler(bridge, deps, args as never));
        } catch (e) {
          // Studio-side failures are answers, not protocol errors.
          return asResult(errText(e));
        }
      },
    );
  }

  return server;
}

function asResult(out: ToolOutput): CallToolResult {
  return typeof out === "string" ? { content: [{ type: "text", text: out }] } : out;
}
