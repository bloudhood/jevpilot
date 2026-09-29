import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ContextLimitError, enforceLimits, estimateTokens } from "../../src/index.ts";
import type { DecisionRequest, Provider } from "../../src/index.ts";
import { request } from "./helpers.ts";

function choiceRequest(optionCount: number): DecisionRequest {
  const criteria = Object.fromEntries(
    Array.from({ length: optionCount }, (_value, index) => [String(index), "option"]),
  );
  return {
    ...request,
    questions: { pick: { type: "choice", instructions: "Pick", criteria } },
  };
}

describe("context limits", () => {
  test("accepts 255 choice options", () => {
    assert.doesNotThrow(() => enforceLimits(choiceRequest(255), "typesafe"));
  });

  test("rejects 256 choice options", () => {
    assert.throws(() => enforceLimits(choiceRequest(256), "typesafe"), ContextLimitError);
  });

  test("counts CJK characters conservatively for each provider", () => {
    assert.ok(estimateTokens("汉".repeat(100)) >= 100);
    for (const provider of ["typesafe", "openrouter", "cloudflare"] as Provider[]) {
      assert.throws(
        () => enforceLimits({ ...request, state: "汉".repeat(40000) }, provider),
        ContextLimitError,
      );
    }
  });

  test("TypeSafe accepts multiple questions when state plus the longest fits", () => {
    const questions: DecisionRequest["questions"] = Object.fromEntries(
      Array.from({ length: 3 }, (_value, index) => [
        String(index),
        { type: "noul", instructions: "b".repeat(18000) },
      ]),
    );
    const longRequest = { ...request, state: "a".repeat(80000), questions };
    assert.doesNotThrow(() => enforceLimits(longRequest, "typesafe"));
    assert.throws(() => enforceLimits(longRequest, "openrouter"), ContextLimitError);
  });

  test("an override restricts total request tokens", () => {
    assert.throws(() => enforceLimits(request, "typesafe", 1), ContextLimitError);
  });

  test("an override cannot raise the provider state-plus-longest-question cap", () => {
    const longRequest = { ...request, state: "x".repeat(132000) };
    assert.throws(
      () => enforceLimits(longRequest, "typesafe", 50000),
      (error: unknown) =>
        error instanceof ContextLimitError && error.message.includes("longest question"),
    );
  });
});
