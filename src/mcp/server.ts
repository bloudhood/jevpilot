import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { builtinTools } from "./tools/index.ts";
import { ToolHost, type McpDeps } from "./host.ts";

export type { McpDeps } from "./host.ts";

const mountTools = (host: ToolHost, deps: McpDeps): void => {
  for (const tool of builtinTools) {
    if (tool.requires?.includes("decisionPort") && !deps.decisionPort) continue;
    tool.apply(host);
  }
};

export function createServer(deps: McpDeps): {
  server: McpServer;
  createMcpServer: () => McpServer;
  close: () => Promise<void>;
} {
  const host = new ToolHost(deps);
  mountTools(host, deps);
  const server = host.mcpServer;

  return {
    server,
    // HTTP transport builds one McpServer per connection, replaying all registrations while
    // sharing the same host state (sessions, browser, dispatch), as before the split.
    createMcpServer: () => host.createMcpServer(),
    close: () => host.close(),
  };
}
