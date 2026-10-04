import { z } from "zod";
import type { ManualOp } from "../../orchestrator/session.ts";
import { sessionResultSchema } from "../../orchestrator/result.ts";
import { op, session } from "../schemas.ts";
import type { ToolHost } from "../host.ts";
import type { ToolModule } from "./index.ts";

const tool: ToolModule = {
  name: "browser_act",
  apply(host: ToolHost): void {
    host.registerTool(
      "browser_act",
      {
        description:
          "Perform manual browser operations against current element refs in an existing session. Returns a fresh snapshot, so a separate browser_observe is not needed after it. The orchestrator rechecks targets and applies the same domain and irreversible-action gates.",
        inputSchema: {
          ...session,
          ops: z.array(op).min(1),
          allow_irreversible: z.boolean().optional(),
        },
        outputSchema: sessionResultSchema.shape,
      },
      (input) =>
        host.handle("browser_act", () => {
          const instance = host.requireSession(input.session);
          const operations: ManualOp[] = input.ops.map((item) => ({
            action: item.action as ManualOp["action"],
            ...(item.ref ? { ref: item.ref } : {}),
            ...(item.value_key ? { value_key: item.value_key } : {}),
            ...(item.text !== undefined ? { text: item.text } : {}),
            ...(item.submit !== undefined ? { submit: item.submit } : {}),
            ...(item.to_ref ? { to_ref: item.to_ref } : {}),
            ...(item.paths ? { paths: item.paths } : {}),
            ...(item.condition ? { condition: item.condition } : {}),
            ...(item.timeout_ms !== undefined ? { timeout_ms: item.timeout_ms } : {}),
            ...(item.delay_ms !== undefined ? { delay_ms: item.delay_ms } : {}),
            ...(item.option_label !== undefined ? { option_label: item.option_label } : {}),
            ...(item.direction ? { direction: item.direction } : {}),
            ...(item.name !== undefined ? { name: item.name } : {}),
            ...(item.key !== undefined ? { key: item.key } : {}),
            ...(item.accept !== undefined ? { accept: item.accept } : {}),
          }));
          return host.inSession(instance, () =>
            instance.act(operations, {
              ...(input.allow_irreversible !== undefined
                ? { allow_irreversible: input.allow_irreversible }
                : {}),
            }),
          );
        }),
    );
  },
};

export default tool;
