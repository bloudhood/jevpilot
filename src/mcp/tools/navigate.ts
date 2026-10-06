import { sessionResultSchema } from "../../orchestrator/result.ts";
import { httpUrl, requireHttpUrl, session } from "../schemas.ts";
import type { ToolHost } from "../host.ts";
import type { ToolModule } from "./index.ts";

const tool: ToolModule = {
  name: "browser_navigate",
  apply(host: ToolHost): void {
    host.registerTool(
      "browser_navigate",
      {
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        description: "Navigate the selected session tab within its domain allowlist.",
        inputSchema: { ...session, url: httpUrl },
        outputSchema: sessionResultSchema.shape,
      },
      (input) =>
        host.handle("browser_navigate", () => {
          requireHttpUrl(input.url);
          const instance = host.requireSession(input.session);
          return host.inSession(instance, () => instance.navigate(input.url));
        }),
    );
  },
};

export default tool;
