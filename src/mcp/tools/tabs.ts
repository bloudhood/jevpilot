import { z } from "zod";
import { nonempty, tabsResult } from "../schemas.ts";
import type { ToolHost } from "../host.ts";
import type { ToolModule } from "./index.ts";
import { McpUserError } from "../errors.ts";

const tool: ToolModule = {
  name: "browser_tabs",
  apply(host: ToolHost): void {
    host.registerTool(
      "browser_tabs",
      {
        description: "List, select, or close tabs owned by a browser session.",
        inputSchema: {
          session: nonempty.describe("Session ID returned by browser_run."),
          action: z.enum(["list", "select", "close"]),
          tab_id: nonempty.optional(),
        },
        outputSchema: tabsResult.shape,
      },
      (input) =>
        host.handle("browser_tabs", async () => {
          const instance = host.requireSession(input.session);
          return host.inSession(instance, async () => {
            if (input.action === "list")
              return { session: input.session, tabs: await instance.listTabs() };
            if (!input.tab_id) throw new McpUserError("tab_id is required for select or close.");
            if (input.action === "select") {
              const result = await instance.selectTab(input.tab_id);
              return { session: input.session, status: result.status, reason: result.reason };
            }
            const result = await instance.closeTab(input.tab_id);
            return {
              session: input.session,
              closed: result.status === "RUNNING",
              status: result.status,
              reason: result.reason,
            };
          });
        }),
    );
  },
};

export default tool;
