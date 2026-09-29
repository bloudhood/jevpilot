import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createDecisionPort,
  DecisionConfigError,
  DecisionTransportError,
  parseResponse,
  prepareRequest,
} from "../../src/index.ts";
import { answers, config, fixture, jsonResponse, request } from "./helpers.ts";

describe("adapter wire contracts", () => {
  const cases = [
    {
      provider: "typesafe" as const,
      url: "https://api.typesafe.ai/v1/systemone",
      body: request,
    },
    {
      provider: "openrouter" as const,
      url: "https://openrouter.ai/api/alpha/decisions",
      body: { ...request, model: "typesafe/jev-1.13" },
    },
    {
      provider: "cloudflare" as const,
      url: "https://api.cloudflare.com/client/v4/accounts/account/ai/run",
      body: {
        model: "typesafe/jev",
        input: { state: request.state, questions: request.questions },
      },
    },
    {
      provider: "custom" as const,
      url: "https://custom.example/decide",
      body: request,
    },
  ];

  for (const contract of cases) {
    test(`${contract.provider} sends its exact URL, body and Authorization header`, async () => {
      const adapterConfig = config(contract.provider);
      const wire = prepareRequest(adapterConfig, request);
      assert.equal(wire.url, contract.url);
      assert.deepEqual(wire.body, contract.body);

      let calls = 0;
      const port = createDecisionPort(adapterConfig, {
        fetch: async (url, init) => {
          calls++;
          assert.equal(String(url), contract.url);
          assert.deepEqual(JSON.parse(String(init?.body)), contract.body);
          assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-secret");
          return jsonResponse(fixture(contract.provider));
        },
      });
      const result = await port.decide(request);
      assert.equal(calls, 1);
      assert.equal(result.provider, contract.provider);
      assert.equal(result.usage.inputTokens, 10);
    });
  }

  for (const provider of ["typesafe", "openrouter"] as const) {
    const path = provider === "typesafe" ? "v1/systemone" : "api/alpha/decisions";
    for (const baseUrl of ["https://gw.example/prefix", "https://gw.example/prefix/"]) {
      test(`${provider} preserves a base path for ${baseUrl}`, () => {
        const wire = prepareRequest({ ...config(provider), baseUrl }, request);
        assert.equal(wire.url, `https://gw.example/prefix/${path}`);
      });
    }
  }

  test("custom uses the configured full endpoint without joining a path", () => {
    const wire = prepareRequest(
      { ...config("custom"), baseUrl: "https://gw.example/prefix/decide" },
      request,
    );
    assert.equal(wire.url, "https://gw.example/prefix/decide");
  });

  test("custom preserves a full endpoint with a trailing slash", () => {
    const wire = prepareRequest(
      { ...config("custom"), baseUrl: "https://gw.example/prefix/decide/" },
      request,
    );
    assert.equal(wire.url, "https://gw.example/prefix/decide/");
  });

  test("OpenRouter normalizes model slugs and allows a configured mapping", () => {
    const mapped = prepareRequest(
      { ...config("openrouter"), modelMap: { "jev-latest": "typesafe/custom" } },
      request,
    );
    assert.deepEqual(mapped.body, { ...request, model: "typesafe/custom" });
    const prefixed = prepareRequest(config("openrouter"), { ...request, model: "jev-2" });
    assert.deepEqual(prefixed.body, { ...request, model: "typesafe/jev-2" });
  });

  test("Cloudflare uses a configured model", () => {
    const wire = prepareRequest(
      { ...config("cloudflare"), cloudflareModel: "typesafe/jev-next" },
      request,
    );
    assert.deepEqual(wire.body, {
      model: "typesafe/jev-next",
      input: { state: request.state, questions: request.questions },
    });
  });
});

describe("adapter responses", () => {
  for (const provider of ["typesafe", "openrouter", "cloudflare", "custom"] as const) {
    test(`${provider} parses its fixture answers`, () => {
      assert.deepEqual(parseResponse(config(provider), fixture(provider)).answers, answers);
    });
  }

  test("Cloudflare accepts an unnested result", () => {
    const raw = { success: true, errors: [], result: fixture("typesafe") };
    assert.deepEqual(parseResponse(config("cloudflare"), raw).answers, answers);
  });

  test("Cloudflare failure carries every envelope error", () => {
    const raw = {
      success: false,
      errors: [
        { code: 1001, message: "first failure" },
        { code: 1002, message: "second failure" },
      ],
    };
    assert.throws(
      () => parseResponse(config("cloudflare"), raw),
      (error: unknown) =>
        error instanceof DecisionTransportError &&
        error.providerCode === "1001,1002" &&
        error.providerMessage === "first failure; second failure",
    );
  });

  test("Cloudflare incomplete result carries envelope errors", () => {
    const raw = {
      success: true,
      errors: [{ code: 44, message: "still processing" }],
      result: { state: "Pending" },
    };
    assert.throws(
      () => parseResponse(config("cloudflare"), raw),
      (error: unknown) =>
        error instanceof DecisionTransportError &&
        error.providerCode === "44" &&
        error.providerMessage === "still processing",
    );
  });

  test("Cloudflare envelope errors redact a reflected API key", () => {
    const raw = {
      success: false,
      errors: [{ code: "test-secret", message: "invalid test-secret" }],
    };
    assert.throws(
      () => parseResponse(config("cloudflare"), raw),
      (error: unknown) =>
        error instanceof DecisionTransportError &&
        !error.providerMessage?.includes("test-secret") &&
        !error.providerCode?.includes("test-secret"),
    );
  });

  test("Vercel rejects construction with the confirmed pending error", () => {
    assert.throws(
      () => createDecisionPort(config("vercel")),
      (error: unknown) =>
        error instanceof DecisionConfigError &&
        error.message === "vercel adapter pending: HTTP shape unconfirmed",
    );
  });
});
