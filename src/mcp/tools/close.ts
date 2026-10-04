import { closeResultSchema, session } from "../schemas.ts";
import type { ToolHost } from "../host.ts";
import type { ToolModule } from "./index.ts";

const tool: ToolModule = {
  name: "browser_close",
  apply(host: ToolHost): void {
    host.registerTool(
      "browser_close",
      {
        description:
          "Close a browser session and its tab, and delete its temporary handoff files. The shared browser remains available for other sessions.",
        inputSchema: session,
        outputSchema: closeResultSchema,
      },
      (input) =>
        host.handle("browser_close", async () => {
          await host.closeSession(input.session);
          return { session: input.session, closed: true as const };
        }),
    );
  },
};

export default tool;
