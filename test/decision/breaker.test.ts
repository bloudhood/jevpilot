import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CircuitBreaker, CircuitOpenError } from "../../src/index.ts";

describe("CircuitBreaker", () => {
  test("opens after consecutive failures and closes after a successful half-open probe", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ now: () => now }, 2, 100);
    for (let failure = 0; failure < 2; failure++) {
      await assert.rejects(
        breaker.run(async () => {
          throw new Error("failed");
        }),
      );
    }
    await assert.rejects(
      breaker.run(async () => 1),
      CircuitOpenError,
    );
    now = 100;
    assert.equal(await breaker.run(async () => 42), 42);
    assert.equal(await breaker.run(async () => 43), 43);
  });

  test("allows only one half-open probe at a time", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ now: () => now }, 1, 100);
    await assert.rejects(
      breaker.run(async () => {
        throw new Error("failed");
      }),
    );
    now = 100;
    let release: (value: number) => void = () => {};
    const probe = breaker.run(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );
    await assert.rejects(
      breaker.run(async () => 1),
      CircuitOpenError,
    );
    release(2);
    assert.equal(await probe, 2);
  });

  test("reopens after a failed half-open probe", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ now: () => now }, 1, 100);
    await assert.rejects(
      breaker.run(async () => {
        throw new Error("first");
      }),
    );
    now = 100;
    await assert.rejects(
      breaker.run(async () => {
        throw new Error("probe");
      }),
    );
    await assert.rejects(
      breaker.run(async () => 1),
      CircuitOpenError,
    );
  });
});
