import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ContextLimitError,
  createDecisionPort,
  CircuitOpenError,
  DecisionAbortedError,
  DecisionRequestError,
  DecisionTransportError,
  InvalidAnswerError,
  loadDecisionConfig,
} from "../../src/index.ts";
import type { DecisionRequest } from "../../src/index.ts";
import { answers, config, fixture, jsonResponse, request } from "./helpers.ts";

test("R1: invalid answers and aborts do not open the decision circuit", async () => {
  let calls = 0;
  const port = createDecisionPort(
    { ...config("typesafe"), breakerThreshold: 2, maxRetries: 0 },
    {
      fetch: async () => {
        calls++;
        return jsonResponse({ ...(fixture("typesafe") as object), answers: {} });
      },
    },
  );
  await assert.rejects(port.decide(request), InvalidAnswerError);
  await assert.rejects(port.decide(request), InvalidAnswerError);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(port.decide(request, { signal: controller.signal }), DecisionAbortedError);
  await assert.rejects(port.decide(request), InvalidAnswerError);
  assert.equal(calls, 3);

  let abortCalls = 0;
  let entered = () => {};
  const abortPort = createDecisionPort(
    { ...config("typesafe"), breakerThreshold: 2, maxRetries: 0 },
    {
      fetch: async (_url, init) => {
        abortCalls++;
        if (abortCalls > 2) return jsonResponse(fixture("typesafe"));
        entered();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      },
    },
  );
  for (let index = 0; index < 2; index++) {
    const controller = new AbortController();
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = abortPort.decide(request, { signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(pending, DecisionAbortedError);
  }
  assert.equal((await abortPort.decide(request)).attempts, 1);
  assert.equal(abortCalls, 3);

  let clientErrors = 0;
  const clientErrorPort = createDecisionPort(
    { ...config("typesafe"), breakerThreshold: 2, maxRetries: 0 },
    {
      fetch: async () =>
        jsonResponse(++clientErrors <= 2 ? {} : fixture("typesafe"), clientErrors <= 2 ? 401 : 200),
    },
  );
  await assert.rejects(clientErrorPort.decide(request), DecisionTransportError);
  await assert.rejects(clientErrorPort.decide(request), DecisionTransportError);
  assert.equal((await clientErrorPort.decide(request)).attempts, 1);

  let serverErrors = 0;
  const serverErrorPort = createDecisionPort(
    { ...config("typesafe"), breakerThreshold: 2, maxRetries: 0 },
    {
      fetch: async () => {
        serverErrors++;
        return jsonResponse({}, 503);
      },
    },
  );
  await assert.rejects(serverErrorPort.decide(request), DecisionTransportError);
  await assert.rejects(serverErrorPort.decide(request), DecisionTransportError);
  await assert.rejects(serverErrorPort.decide(request), CircuitOpenError);
  assert.equal(serverErrors, 2);
});

describe("createDecisionPort", () => {
  test("fills a missing request model from config before sending", async () => {
    const withoutModel: DecisionRequest = {
      state: request.state,
      questions: request.questions,
    };
    let wireBody: unknown;
    const port = createDecisionPort(
      { ...config("typesafe"), model: "configured" },
      {
        fetch: async (_url, init) => {
          wireBody = JSON.parse(String(init?.body));
          return jsonResponse(fixture("typesafe"));
        },
      },
    );
    await port.decide(withoutModel);
    assert.deepEqual(wireBody, { ...withoutModel, model: "configured" });
  });

  for (const provider of ["typesafe", "openrouter"] as const) {
    test(`uses non-default JEV_MODEL in ${provider} wire body and result`, async () => {
      const loaded = loadDecisionConfig({
        JEV_PROVIDER: provider,
        JEV_API_KEY: "test-secret",
        JEV_MODEL: "jev-1.13",
      });
      const withoutModel: DecisionRequest = {
        state: request.state,
        questions: request.questions,
      };
      const expectedModel = provider === "openrouter" ? "typesafe/jev-1.13" : "jev-1.13";
      const responseBody = {
        ...(fixture("typesafe") as Record<string, unknown>),
        model: expectedModel,
      };
      let wireBody: unknown;
      const port = createDecisionPort(loaded, {
        fetch: async (_url, init) => {
          wireBody = JSON.parse(String(init?.body));
          return jsonResponse(responseBody);
        },
      });

      const result = await port.decide(withoutModel);
      assert.deepEqual(wireBody, {
        model: expectedModel,
        state: withoutModel.state,
        questions: withoutModel.questions,
      });
      assert.equal(result.model, expectedModel);
    });
  }

  test("a non-enumerable loaded key still reaches Authorization", async () => {
    const loaded = loadDecisionConfig({
      JEV_PROVIDER: "typesafe",
      JEV_API_KEY: "hidden-key",
    });
    const port = createDecisionPort(loaded, {
      fetch: async (_url, init) => {
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer hidden-key");
        return jsonResponse(fixture("typesafe"));
      },
    });
    await port.decide(request);
  });

  test("validates a malformed request before applying limits or sending", async () => {
    let called = false;
    const port = createDecisionPort(config("typesafe"), {
      fetch: async () => {
        called = true;
        return jsonResponse(fixture("typesafe"));
      },
    });
    const malformed = {
      model: "jev-latest",
      questions: { pick: { type: "choice", criteria: null } },
    } as unknown as DecisionRequest;
    await assert.rejects(port.decide(malformed), DecisionRequestError);
    assert.equal(called, false);
  });

  test("rejects 256 options before sending", async () => {
    let called = false;
    const criteria = Object.fromEntries(
      Array.from({ length: 256 }, (_value, index) => [String(index), "option"]),
    );
    const oversized: DecisionRequest = {
      ...request,
      questions: { pick: { type: "choice", instructions: "Pick", criteria } },
    };
    const port = createDecisionPort(config("typesafe"), {
      fetch: async () => {
        called = true;
        return jsonResponse(fixture("typesafe"));
      },
    });
    await assert.rejects(port.decide(oversized), ContextLimitError);
    assert.equal(called, false);
  });

  test("returns tagged answers and usage after validation", async () => {
    const port = createDecisionPort(config("typesafe"), {
      fetch: async () => jsonResponse(fixture("typesafe")),
    });
    const result = await port.decide(request);
    assert.deepEqual(result.answers.pick, { ...answers.pick, type: "choice" });
    assert.equal(result.usage.inputTokens, 10);
    assert.equal(result.usage.outputTokens, 3);
    assert.equal(result.attempts, 1);
  });

  test("rejects invalid answers and reports an error metric", async () => {
    const metrics: { outcome: string }[] = [];
    const invalid = {
      answers: {
        pick: { choice: "other", probabilities: { yes: 0.8, no: 0.2 }, confidence: 0.8 },
      },
      usage: { input_tokens: 10, output_tokens: 3 },
      model: "jev-latest",
    };
    const port = createDecisionPort(config("typesafe"), {
      fetch: async () => jsonResponse(invalid),
      onCall: (metric) => metrics.push(metric),
    });
    await assert.rejects(port.decide(request), InvalidAnswerError);
    assert.equal(metrics[0]?.outcome, "error");
  });

  test("reports successful metrics without payloads", async () => {
    const metrics: Record<string, unknown>[] = [];
    const port = createDecisionPort(config("typesafe"), {
      fetch: async () => jsonResponse(fixture("typesafe")),
      onCall: (metric) => metrics.push(metric),
    });
    await port.decide(request);
    assert.equal(metrics[0]?.outcome, "success");
    assert.equal(metrics[0]?.inputTokens, 10);
    assert.equal(metrics[0]?.attempts, 1);
    assert.deepEqual(Object.keys(metrics[0] ?? {}).sort(), [
      "attempts",
      "inputTokens",
      "latencyMs",
      "model",
      "outcome",
      "provider",
    ]);
  });

  test("does not send when its signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const port = createDecisionPort(config("typesafe"), {
      fetch: async () => {
        called = true;
        return jsonResponse(fixture("typesafe"));
      },
    });
    await assert.rejects(port.decide(request, { signal: controller.signal }), DecisionAbortedError);
    assert.equal(called, false);
  });

  test("passes the configured Retry-After cap to transport", async () => {
    let calls = 0;
    const port = createDecisionPort(
      { ...config("typesafe"), maxRetryAfterMs: 1000 },
      {
        fetch: async () => {
          calls++;
          return jsonResponse({}, 429, { "retry-after": "2" });
        },
        sleep: async () => {
          assert.fail("must not sleep beyond the cap");
        },
      },
    );
    await assert.rejects(port.decide(request), (error: unknown) => {
      return error instanceof Error && "retryAfterMs" in error && error.retryAfterMs === 2000;
    });
    assert.equal(calls, 1);
  });
});
