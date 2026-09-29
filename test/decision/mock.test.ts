import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DecisionAbortedError,
  InvalidAnswerError,
  MockDecider,
  MockScriptExhaustedError,
} from "../../src/index.ts";
import { answers, request } from "./helpers.ts";

describe("MockDecider", () => {
  test("returns scripted tagged answers and records calls", async () => {
    let waited = 0;
    const mock = new MockDecider([{ answers, latencyMs: 5 }], async (milliseconds) => {
      waited = milliseconds;
    });
    const result = await mock.decide(request);
    assert.equal(result.answers.pick?.type, "choice");
    assert.equal(result.latencyMs, 5);
    assert.equal(waited, 5);
    assert.deepEqual(mock.calls, [request]);
  });

  test("uses a function script", async () => {
    const mock = new MockDecider((incoming) => ({
      answers: incoming.questions.pick ? answers : {},
    }));
    assert.equal((await mock.decide(request)).answers.pick?.type, "choice");
  });

  test("throws a scripted error or invalid answer", async () => {
    const mock = new MockDecider([
      { error: new Error("scripted") },
      { answers: { pick: { noul: 2 } } },
    ]);
    await assert.rejects(mock.decide(request), /scripted/);
    await assert.rejects(mock.decide(request), InvalidAnswerError);
  });

  test("throws MockScriptExhaustedError when the queue runs out", async () => {
    const mock = new MockDecider([]);
    await assert.rejects(mock.decide(request), MockScriptExhaustedError);
  });

  test("an already-aborted signal leaves the queue and calls untouched", async () => {
    const controller = new AbortController();
    controller.abort();
    const mock = new MockDecider([{ answers }]);
    await assert.rejects(mock.decide(request, { signal: controller.signal }), DecisionAbortedError);
    assert.equal(mock.calls.length, 0);
    assert.equal((await mock.decide(request)).answers.pick?.type, "choice");
  });

  test("aborting during simulated latency stops the call", async () => {
    const controller = new AbortController();
    const mock = new MockDecider([{ answers, latencyMs: 100 }], async () => {
      controller.abort();
    });
    await assert.rejects(mock.decide(request, { signal: controller.signal }), DecisionAbortedError);
    assert.equal(mock.calls.length, 1);
  });
});
