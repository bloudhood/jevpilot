import { requestSchema } from "../../decision/types.ts";
import { decideResultSchema } from "../schemas.ts";
import { DecisionTransportError, InvalidAnswerError } from "../../decision/errors.ts";
import { McpUserError } from "../errors.ts";
import type { ToolHost } from "../host.ts";
import type { ToolModule } from "./index.ts";

const tool: ToolModule = {
  name: "jev_decide",
  requires: ["decisionPort"] as const,
  apply(host: ToolHost): void {
    host.registerTool(
      "jev_decide",
      {
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        description:
          "Pass a state and typed questions directly to the configured decision port. This does not create or change a browser session.",
        inputSchema: { state: requestSchema.shape.state, questions: requestSchema.shape.questions },
        outputSchema: decideResultSchema,
      },
      (input) =>
        host.handle("jev_decide", async () => {
          let decision;
          try {
            decision = await host.deps.decisionPort!.decide(input);
          } catch (error) {
            if (
              error instanceof DecisionTransportError &&
              error.status !== undefined &&
              error.status >= 400 &&
              error.status <= 499 &&
              ![401, 402, 403, 429].includes(error.status)
            ) {
              throw new McpUserError(
                `Jev rejected the request (HTTP ${error.status}): ${error.providerMessage ?? "no details"}`,
              );
            }
            if (error instanceof InvalidAnswerError) {
              throw new McpUserError(
                `Jev's answer did not match the questions: ${error.problems.join("; ")}`,
              );
            }
            throw error;
          }
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
