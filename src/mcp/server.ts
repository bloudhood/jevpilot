import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { builtinTools } from "./tools/index.ts";
import { ToolHost, type McpDeps } from "./host.ts";
import { McpUserError } from "./errors.ts";

export type { McpDeps } from "./host.ts";

const mountTools = (host: ToolHost, deps: McpDeps): void => {
  for (const tool of builtinTools) {
    if (tool.requires?.includes("decisionPort") && !deps.decisionPort) continue;
    if (deps.disabledTools?.includes(tool.name)) continue;
    tool.apply(host);
  }
};

function validateDisabledTools(deps: McpDeps): void {
  const disabled = deps.disabledTools;
  if (!disabled?.length) return;
  for (const name of disabled) {
    if (name === "browser_run" || name === "browser_close")
      throw new McpUserError("browser_run and browser_close cannot be disabled.");
    if (!builtinTools.some((tool) => tool.name === name))
      throw new McpUserError(`Unknown tool in JEVPILOT_DISABLED_TOOLS: ${name}.`);
  }
}

export function createServer(deps: McpDeps): {
  server: McpServer;
  createMcpServer: () => McpServer;
  close: () => Promise<void>;
} {
  validateDisabledTools(deps);
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
