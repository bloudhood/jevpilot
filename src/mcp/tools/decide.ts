import { requestSchema } from "../../decision/types.ts";
import { decideResultSchema } from "../schemas.ts";
import type { ToolHost } from "../host.ts";
import type { ToolModule } from "./index.ts";

const tool: ToolModule = {
  name: "jev_decide",
  requires: ["decisionPort"] as const,
  apply(host: ToolHost): void {
    host.registerTool(
      "jev_decide",
      {
        description:
          "Pass a state and typed questions directly to the configured decision port. This does not create or change a browser session.",
        inputSchema: { state: requestSchema.shape.state, questions: requestSchema.shape.questions },
        outputSchema: decideResultSchema,
      },
      (input) =>
        host.handle("jev_decide", async () => {
          const decision = await host.deps.decisionPort!.decide(input);
          return {
            answers: decision.answers,
            usage: decision.usage,
            model: decision.model,
            latency_ms: decision.latencyMs,
          };
        }),
    );
  },
};

export default tool;
