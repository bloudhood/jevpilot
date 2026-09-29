import { DecisionConfigError } from "./errors.ts";

export type Provider = "typesafe" | "openrouter" | "cloudflare" | "vercel" | "custom";

export type DecisionConfig = {
  provider: Provider;
  apiKey: string;
  baseUrl?: string;
  accountId?: string;
  model: string;
  timeoutMs: number;
  firstTimeoutMs: number;
  maxRetries: number;
  maxRetryAfterMs?: number;
  contextLimit?: number;
  modelMap?: Record<string, string>;
  cloudflareModel?: string;
  breakerThreshold?: number;
  breakerCooldownMs?: number;
};

const providers: Provider[] = ["typesafe", "openrouter", "cloudflare", "vercel", "custom"];

function integerSetting(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new DecisionConfigError(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

export function loadDecisionConfig(env: Record<string, string | undefined>): DecisionConfig {
  const provider = env.JEV_PROVIDER;
  if (!providers.includes(provider as Provider)) {
    throw new DecisionConfigError(`JEV_PROVIDER required: ${providers.join(" | ")}`);
  }

  const selectedProvider = provider as Provider;
  let apiKey = env.JEV_API_KEY;
  if (!apiKey && selectedProvider === "typesafe") apiKey = env.TYPESAFE_API_KEY;
  if (!apiKey && selectedProvider === "openrouter") apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey && selectedProvider === "cloudflare") {
    apiKey = env.JEV_CLOUDFLARE_API_TOKEN ?? env.CLOUDFLARE_API_TOKEN;
  }
  if (!apiKey) throw new DecisionConfigError("API key required");
  if (selectedProvider === "cloudflare" && !env.CLOUDFLARE_ACCOUNT_ID) {
    throw new DecisionConfigError("CLOUDFLARE_ACCOUNT_ID required");
  }
  if (selectedProvider === "custom" && !env.JEV_BASE_URL) {
    throw new DecisionConfigError("JEV_BASE_URL required for custom");
  }

  const timeoutMs = integerSetting("JEV_TIMEOUT_MS", env.JEV_TIMEOUT_MS, 20000, 1);
  const firstTimeoutMs = integerSetting(
    "JEV_FIRST_TIMEOUT_MS",
    env.JEV_FIRST_TIMEOUT_MS,
    Math.min(5000, timeoutMs),
    1,
  );
  if (firstTimeoutMs > timeoutMs) {
    throw new DecisionConfigError("JEV_FIRST_TIMEOUT_MS must not exceed JEV_TIMEOUT_MS");
  }
  const config = {
    provider: selectedProvider,
    model: env.JEV_MODEL ?? "jev-latest",
    timeoutMs,
    firstTimeoutMs,
    maxRetries: integerSetting("JEV_MAX_RETRIES", env.JEV_MAX_RETRIES, 2, 0),
    maxRetryAfterMs: integerSetting("JEV_MAX_RETRY_AFTER_MS", env.JEV_MAX_RETRY_AFTER_MS, 30000, 0),
    ...(env.JEV_BASE_URL ? { baseUrl: env.JEV_BASE_URL } : {}),
    ...(env.CLOUDFLARE_ACCOUNT_ID ? { accountId: env.CLOUDFLARE_ACCOUNT_ID } : {}),
    ...(env.JEV_CONTEXT_LIMIT
      ? { contextLimit: integerSetting("JEV_CONTEXT_LIMIT", env.JEV_CONTEXT_LIMIT, 0, 1) }
      : {}),
    // Optional circuit-breaker tuning (defaults live in decision/breaker.ts: 3 failures / 30s).
    ...(env.JEV_BREAKER_THRESHOLD
      ? {
          breakerThreshold: integerSetting(
            "JEV_BREAKER_THRESHOLD",
            env.JEV_BREAKER_THRESHOLD,
            1,
            1,
          ),
        }
      : {}),
    ...(env.JEV_BREAKER_COOLDOWN_MS
      ? {
          breakerCooldownMs: integerSetting(
            "JEV_BREAKER_COOLDOWN_MS",
            env.JEV_BREAKER_COOLDOWN_MS,
            0,
            0,
          ),
        }
      : {}),
  } as DecisionConfig;

  // The getter stays available to the transport but outside ordinary object enumeration.
  Object.defineProperty(config, "apiKey", { value: apiKey, enumerable: false });
  Object.defineProperty(config, "toJSON", {
    value: () => redactDecisionConfig(config),
    enumerable: false,
  });
  Object.defineProperty(config, "toString", {
    value: () => JSON.stringify(redactDecisionConfig(config)),
    enumerable: false,
  });
  return config;
}

export function redactDecisionConfig(config: DecisionConfig): Record<string, unknown> {
  const visible = { ...config };
  delete (visible as Partial<DecisionConfig>).apiKey;
  return { ...visible, apiKey: "[REDACTED]" };
}
