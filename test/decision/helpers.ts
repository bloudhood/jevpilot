import { readFileSync } from "node:fs";
import type { Answers, DecisionConfig, DecisionRequest, Provider } from "../../src/index.ts";

export const request: DecisionRequest = {
  model: "jev-latest",
  state: "page",
  questions: {
    pick: {
      type: "choice",
      instructions: "Pick",
      criteria: { yes: "yes", no: "no" },
    },
  },
};

export const answers: Answers = {
  pick: {
    choice: "yes",
    probabilities: { yes: 0.8, no: 0.2 },
    confidence: 0.8,
  },
};

export function fixture(name: string): unknown {
  const url = new URL(`../fixtures/decision/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

export function config(provider: Provider): DecisionConfig {
  return {
    provider,
    apiKey: "test-secret",
    model: "jev-latest",
    timeoutMs: 20,
    firstTimeoutMs: 5,
    maxRetries: 2,
    ...(provider === "cloudflare" ? { accountId: "account" } : {}),
    ...(provider === "custom" ? { baseUrl: "https://custom.example/decide" } : {}),
  };
}

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    ...(headers ? { headers } : {}),
  });
}
