// MCP server over stdio. stdout belongs to the JSON-RPC transport alone —
// anything this layer wants to say goes to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Bridge } from "@proto/types";
import { errText } from "./fmt.ts";
import type { McpDeps, ToolOutput } from "./tool.ts";
import { TOOLS } from "./tools/index.ts";

export async function startMcp(bridge: Bridge, deps: McpDeps): Promise<void> {
  await createMcpServer(bridge, deps).connect(new StdioServerTransport());
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
