import type { DecisionConfig } from "./config.ts";
import { DecisionConfigError, DecisionTransportError, InvalidAnswerError } from "./errors.ts";
import { responseSchema } from "./types.ts";
import type { DecisionRequest, ProviderResponse } from "./types.ts";

export type PreparedRequest = { url: string; body: unknown };
export type ProviderErrorDetail = { providerMessage?: string; providerCode?: string };

function endpointUrl(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${endpoint.replace(/^\//, "")}`;
  return url.toString();
}

export function prepareRequest(config: DecisionConfig, request: DecisionRequest): PreparedRequest {
  const model = request.model ?? config.model;
  const canonicalBody = { model, state: request.state, questions: request.questions };

  switch (config.provider) {
    case "typesafe":
      return {
        url: endpointUrl(config.baseUrl ?? "https://api.typesafe.ai", "v1/systemone"),
        body: canonicalBody,
      };
    case "openrouter": {
      const modelMap: Record<string, string> = {
        "jev-latest": "typesafe/jev-1.13",
        ...config.modelMap,
      };
      const fullModel =
        modelMap[model] ?? (model.startsWith("typesafe/") ? model : `typesafe/${model}`);
      return {
        url: endpointUrl(config.baseUrl ?? "https://openrouter.ai", "api/alpha/decisions"),
        body: { ...canonicalBody, model: fullModel },
      };
    }
    case "cloudflare":
      return {
        url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
          config.accountId ?? "",
        )}/ai/run`,
        body: {
          model: config.cloudflareModel ?? "typesafe/jev",
          input: { state: request.state, questions: request.questions },
        },
      };
    case "custom":
      return { url: config.baseUrl ?? "", body: canonicalBody };
    case "vercel":
      throw new DecisionConfigError("vercel adapter pending: HTTP shape unconfirmed");
    default: {
      const exhaustive: never = config.provider;
      throw new DecisionConfigError(`unknown provider: ${exhaustive}`);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asText(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return undefined;
}

export function extractProviderError(raw: unknown): ProviderErrorDetail {
  const envelope = asRecord(raw);
  if (!envelope) return {};

  if (Array.isArray(envelope.errors)) {
    const errors = envelope.errors.map(asRecord).filter((error) => error !== undefined);
    const messages = errors
      .map((error) => asText(error.message))
      .filter((message) => message !== undefined);
    const codes = errors.map((error) => asText(error.code)).filter((code) => code !== undefined);
    return {
      ...(messages.length ? { providerMessage: messages.join("; ") } : {}),
      ...(codes.length ? { providerCode: codes.join(",") } : {}),
    };
  }

  if (typeof envelope.detail === "string") return { providerMessage: envelope.detail };
  if (Array.isArray(envelope.detail)) {
    const messages: string[] = [];
    for (const item of envelope.detail) {
      const record = asRecord(item);
      const message = asText(record?.msg);
      if (!message) continue;
      const location = Array.isArray(record?.loc)
        ? record.loc
            .slice(1)
            .map((part) => String(part))
            .join(".")
        : "detail";
      const formatted = `${location}: ${message}`;
      if (!messages.includes(formatted)) messages.push(formatted);
      if (messages.length === 3) break;
    }
    if (messages.length) return { providerMessage: messages.join("; ") };
  }

  const nestedError = asRecord(envelope.error);
  const providerMessage =
    asText(nestedError?.message) ?? asText(envelope.error) ?? asText(envelope.message);
  const providerCode = asText(nestedError?.code) ?? asText(envelope.code);
  return {
    ...(providerMessage ? { providerMessage } : {}),
    ...(providerCode ? { providerCode } : {}),
  };
}

function redactProviderDetail(details: ProviderErrorDetail, key: string): ProviderErrorDetail {
  return {
    ...(details.providerMessage
      ? { providerMessage: details.providerMessage.replaceAll(key, "[REDACTED]") }
      : {}),
    ...(details.providerCode
      ? { providerCode: details.providerCode.replaceAll(key, "[REDACTED]") }
      : {}),
  };
}

export function parseResponse(config: DecisionConfig, raw: unknown): ProviderResponse {
  let value = raw;
  if (config.provider === "cloudflare") {
    const envelope = asRecord(raw);
    const details = redactProviderDetail(extractProviderError(raw), config.apiKey);
    if (!envelope || envelope.success !== true) {
      throw new DecisionTransportError("cloudflare response failed", undefined, false, details);
    }
    const result = asRecord(envelope.result);
    if (!result) {
      throw new DecisionTransportError("cloudflare result missing", undefined, false, details);
    }
    if ("state" in result && result.state !== "Completed") {
      throw new DecisionTransportError("cloudflare result incomplete", undefined, false, details);
    }
    value = "result" in result ? result.result : result;
  }

  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) {
    const answerIssues = parsed.error.issues.filter((issue) => issue.path[0] === "answers");
    if (answerIssues.length > 0) {
      throw new InvalidAnswerError(
        answerIssues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      );
    }
    throw new DecisionTransportError("invalid provider response", undefined, false, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}
