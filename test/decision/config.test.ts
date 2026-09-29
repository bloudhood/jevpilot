import assert from "node:assert/strict";
import { inspect } from "node:util";
import { describe, test } from "node:test";
import { DecisionConfigError, loadDecisionConfig, redactDecisionConfig } from "../../src/index.ts";

describe("loadDecisionConfig", () => {
  test("requires an explicit supported provider", () => {
    assert.throws(() => loadDecisionConfig({}), /typesafe.*openrouter.*cloudflare.*vercel.*custom/);
    assert.throws(() => loadDecisionConfig({ JEV_PROVIDER: "unknown" }), DecisionConfigError);
  });

  test("uses generic or provider-specific key fallbacks", () => {
    assert.equal(
      loadDecisionConfig({ JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "a" }).apiKey,
      "a",
    );
    assert.equal(
      loadDecisionConfig({ JEV_PROVIDER: "openrouter", OPENROUTER_API_KEY: "b" }).apiKey,
      "b",
    );
    assert.equal(
      loadDecisionConfig({
        JEV_PROVIDER: "cloudflare",
        CLOUDFLARE_API_TOKEN: "c",
        CLOUDFLARE_ACCOUNT_ID: "account",
      }).apiKey,
      "c",
    );
    assert.equal(
      loadDecisionConfig({
        JEV_PROVIDER: "cloudflare",
        JEV_CLOUDFLARE_API_TOKEN: "d",
        CLOUDFLARE_ACCOUNT_ID: "account",
      }).apiKey,
      "d",
    );
    assert.equal(
      loadDecisionConfig({
        JEV_PROVIDER: "typesafe",
        JEV_API_KEY: "generic",
        TYPESAFE_API_KEY: "fallback",
      }).apiKey,
      "generic",
    );
  });

  test("rejects missing Cloudflare account and custom endpoint", () => {
    assert.throws(
      () => loadDecisionConfig({ JEV_PROVIDER: "cloudflare", JEV_API_KEY: "key" }),
      /CLOUDFLARE_ACCOUNT_ID/,
    );
    assert.throws(
      () => loadDecisionConfig({ JEV_PROVIDER: "custom", JEV_API_KEY: "key" }),
      /JEV_BASE_URL/,
    );
  });

  test("parses numeric settings and defaults", () => {
    const loaded = loadDecisionConfig({
      JEV_PROVIDER: "typesafe",
      JEV_API_KEY: "key",
      JEV_TIMEOUT_MS: "55",
      JEV_MAX_RETRIES: "0",
      JEV_CONTEXT_LIMIT: "1000",
      JEV_MAX_RETRY_AFTER_MS: "5000",
      JEV_MODEL: "chosen",
    });
    assert.equal(loaded.timeoutMs, 55);
    assert.equal(loaded.maxRetries, 0);
    assert.equal(loaded.contextLimit, 1000);
    assert.equal(loaded.model, "chosen");
    assert.equal(loaded.maxRetryAfterMs, 5000);
    assert.equal(
      loadDecisionConfig({ JEV_PROVIDER: "typesafe", JEV_API_KEY: "key" }).maxRetryAfterMs,
      30000,
    );
    assert.throws(
      () =>
        loadDecisionConfig({
          JEV_PROVIDER: "typesafe",
          JEV_API_KEY: "key",
          JEV_TIMEOUT_MS: "invalid",
        }),
      DecisionConfigError,
    );
  });

  test("hides the key from string, JSON, inspect and object spread", () => {
    const secret = "private-secret";
    const loaded = loadDecisionConfig({ JEV_PROVIDER: "typesafe", JEV_API_KEY: secret });
    assert.equal(loaded.apiKey, secret);
    for (const representation of [
      String(loaded),
      JSON.stringify(loaded),
      inspect(loaded),
      inspect({ ...loaded }),
      JSON.stringify({ ...loaded }),
      JSON.stringify(redactDecisionConfig(loaded)),
    ]) {
      assert.ok(!representation.includes(secret));
    }
    assert.equal(Object.keys(loaded).includes("apiKey"), false);
  });
});
