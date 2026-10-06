import { z } from "zod";
import { sessionResultSchema } from "../../orchestrator/result.ts";
import { nonempty, session, values } from "../schemas.ts";
import type { ToolHost } from "../host.ts";
import type { ToolModule } from "./index.ts";

const tool: ToolModule = {
  name: "browser_resume",
  apply(host: ToolHost): void {
    host.registerTool(
      "browser_resume",
      {
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        description:
          "Continue an existing session after a handoff. Supply missing values, refine the goal, or approve one pending irreversible action; approval is scoped to that action.",
        inputSchema: {
          ...session,
          values: values.optional(),
          goal_update: nonempty.optional(),
          allow_irreversible: z.boolean().optional(),
          allowed_domains: z.array(nonempty).optional(),
          dialog: z.object({ accept: z.boolean(), value_key: nonempty.optional() }).optional(),
        },
        outputSchema: sessionResultSchema.shape,
      },
      (input, extra) =>
        host.handle("browser_resume", () => {
          const startedAt = host.deps.clock?.() ?? Date.now();
          const deadlineAt =
            host.deps.callDeadlineMs && host.deps.callDeadlineMs > 0
              ? startedAt + host.deps.callDeadlineMs
              : undefined;
          if (
            host.deps.allowedDomains?.length &&
            input.allowed_domains?.some(
              (domain) =>
                !host.deps.allowedDomains!.some(
                  (allowed) =>
                    domain.toLowerCase() === allowed.toLowerCase() ||
                    domain.toLowerCase().endsWith(`.${allowed.toLowerCase()}`),
                ),
            )
          )
            throw new McpUserError("Requested domain is outside the server allowlist.");
          const instance = host.requireSession(input.session);
          return host.inSession(instance, () =>
            instance.resume(
              {
                ...(input.values ? { values: input.values } : {}),
                ...(input.goal_update ? { goal_update: input.goal_update } : {}),
                ...(input.allow_irreversible !== undefined
                  ? { allow_irreversible: input.allow_irreversible }
                  : {}),
                ...(input.allowed_domains ? { allowed_domains: input.allowed_domains } : {}),
                ...(input.dialog
                  ? {
                      dialog: {
                        accept: input.dialog.accept,
                        ...(input.dialog.value_key ? { value_key: input.dialog.value_key } : {}),
                      },
                    }
                  : {}),
              },
              { signal: extra.signal, ...(deadlineAt !== undefined ? { deadlineAt } : {}) },
            ),
          );
        }),
    );
  },
};

import { McpUserError } from "../errors.ts";

export default tool;
