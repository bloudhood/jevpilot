import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { sessionResultSchema } from "../../orchestrator/result.ts";
import { session } from "../schemas.ts";
import type { ToolHost } from "../host.ts";
import type { ToolModule } from "./index.ts";

const tool: ToolModule = {
  name: "browser_observe",
  apply(host: ToolHost): void {
    host.registerTool(
      "browser_observe",
      {
        description:
          "Read the current page in an existing session without taking action. Use full detail when the compact snapshot omits needed content. A screenshot path may be returned for handoffs when safe.",
        inputSchema: {
          ...session,
          detail: z.enum(["compact", "full"]).optional(),
          screenshot: z.boolean().optional(),
        },
        outputSchema: sessionResultSchema.shape,
      },
      (input) =>
        host.handle("browser_observe", async () => {
          const instance = host.requireSession(input.session);
          return host.inSession(instance, async () => {
            const observed = await instance.observe(input.detail);
            if (
              input.screenshot &&
              instance.page.capabilities.screenshots &&
              instance.screenshotAllowed()
            ) {
              try {
                const directory = await host.sessionDir(input.session);
                if (!directory) return observed;
                const path = join(directory, `observation-${randomUUID()}.jpg`);
                await writeFile(path, await instance.page.screenshot());
                if (host.sessionOpen(input.session)) observed.screenshot_path = path;
              } catch {
                // Screenshots are optional; the observation remains useful.
              }
            }
            return observed;
          });
        }),
    );
  },
};

export default tool;
