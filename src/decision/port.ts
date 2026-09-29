import { parseResponse, prepareRequest } from "./adapters.ts";
import { CircuitBreaker } from "./breaker.ts";
import type { DecisionConfig } from "./config.ts";
import { DecisionAbortedError, DecisionConfigError, DecisionRequestError } from "./errors.ts";
import { enforceLimits } from "./limits.ts";
import { defaultDeps, sendWithRetry } from "./transport.ts";
import type { TransportDeps } from "./transport.ts";
import { requestSchema } from "./types.ts";
import type { DecisionPort, DecisionRequest, DecisionResult } from "./types.ts";
import { tagAnswers, validateAnswers } from "./validate.ts";

export type CallMetric = {
  provider: string;
  model: string;
  latencyMs: number;
  inputTokens: number;
  attempts: number;
  outcome: "success" | "error";
};

export function createDecisionPort(
  config: DecisionConfig,
  deps: Partial<TransportDeps> & { onCall?: (metric: CallMetric) => void } = {},
): DecisionPort {
  if (config.provider === "vercel") {
    throw new DecisionConfigError("vercel adapter pending: HTTP shape unconfirmed");
  }

  const transport = { ...defaultDeps, ...deps };
  const breaker = new CircuitBreaker(
    transport.clock,
    config.breakerThreshold,
    config.breakerCooldownMs,
  );

  return {
    async decide(
      request: DecisionRequest,
      options?: { signal?: AbortSignal },
    ): Promise<DecisionResult> {
      const startedAt = transport.clock.now();
      let attempts = 0;
      let inputTokens = 0;
      let model = config.model;
      let success = false;

      try {
        if (options?.signal?.aborted) {
          throw new DecisionAbortedError("decision request aborted");
        }
        const parsedRequest = requestSchema.safeParse(request);
        if (!parsedRequest.success) {
          throw new DecisionRequestError("invalid decision request", {
            cause: parsedRequest.error,
          });
        }
        const resolvedRequest = {
          ...parsedRequest.data,
          model: parsedRequest.data.model ?? config.model,
        };
        model = resolvedRequest.model;
        enforceLimits(resolvedRequest, config.provider, config.contextLimit);
        const wire = prepareRequest(config, resolvedRequest);

        const response = await breaker.run(async () => {
          const sent = await sendWithRetry(
            wire.url,
            wire.body,
            config.apiKey,
            config.timeoutMs,
            config.maxRetries,
            transport,
            options?.signal,
            config.maxRetryAfterMs ?? 30000,
            config.firstTimeoutMs,
          );
          attempts = sent.attempts;
          const providerResponse = parseResponse(config, sent.body);
          validateAnswers(resolvedRequest.questions, providerResponse.answers);
          return providerResponse;
        });

        inputTokens = response.usage.input_tokens;
        model = response.model;
        const taggedAnswers = tagAnswers(resolvedRequest.questions, response.answers);
        success = true;
        return {
          answers: taggedAnswers,
          usage: {
            inputTokens,
            outputTokens: response.usage.output_tokens,
          },
          model,
          provider: config.provider,
          latencyMs: transport.clock.now() - startedAt,
          attempts,
        };
      } finally {
        deps.onCall?.({
          provider: config.provider,
          model,
          latencyMs: transport.clock.now() - startedAt,
          inputTokens,
          attempts,
          outcome: success ? "success" : "error",
        });
      }
    },
  };
}
