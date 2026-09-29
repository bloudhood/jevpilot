import assert from "node:assert/strict";
import { test } from "node:test";
import { loadDecisionConfig } from "../../src/decision/config.ts";
import { DecisionConfigError, DecisionTimeoutError } from "../../src/decision/errors.ts";
import { createDecisionPort } from "../../src/decision/port.ts";
import { sendWithRetry } from "../../src/decision/transport.ts";
import type { TransportDeps } from "../../src/decision/transport.ts";
import { request } from "./helpers.ts";

const stalled = async (_url: string | URL, init?: RequestInit): Promise<Response> =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

// Delays of the timers created while `run` is pending. With `sleep` injected, sendWithRetry's only timers are
// the per-attempt timeouts, so this is the exact timeout schedule (elapsed-time bounds would not catch a
// schedule that is too long).
async function attemptTimeouts(run: () => Promise<void>): Promise<number[]> {
  const original = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((handler: () => void, delay?: number) => {
    delays.push(delay ?? 0);
    return original(handler, delay);
  }) as unknown as typeof setTimeout;
  try {
    await run();
  } finally {
    globalThis.setTimeout = original;
  }
  return delays;
}

test("O9a: a stalled first attempt is retried after the short first timeout without a backoff", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const deps: TransportDeps = {
    fetch: async (url, init) => (++calls === 1 ? stalled(url, init) : new Response("{}")),
    clock: Date,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
  };
  let attempts = 0;
  const timeouts = await attemptTimeouts(async () => {
    const result = await sendWithRetry(
      "https://example.test",
      {},
      "key",
      5000,
      1,
      deps,
      undefined,
      30000,
      5,
    );
    attempts = result.attempts;
  });
  assert.equal(attempts, 2);
  assert.deepEqual(timeouts, [5, 10]);
  assert.deepEqual(sleeps, []);
});

test("O9a: attempt timeouts double from JEV_FIRST_TIMEOUT_MS up to JEV_TIMEOUT_MS", async () => {
  // From the environment through the port, so the setting has to reach the transport.
  const port = createDecisionPort(
    loadDecisionConfig({
      JEV_PROVIDER: "typesafe",
      JEV_API_KEY: "key",
      JEV_FIRST_TIMEOUT_MS: "2",
      JEV_TIMEOUT_MS: "12",
      JEV_MAX_RETRIES: "4",
    }),
    {
      fetch: (url, init) => stalled(url, init),
      sleep: async () => {
        throw new Error("timeout retries must not sleep");
      },
      random: () => 0,
    },
  );
  const timeouts = await attemptTimeouts(() =>
    assert.rejects(
      port.decide(request),
      (error: unknown) => error instanceof DecisionTimeoutError && error.attempts === 5,
    ),
  );
  assert.deepEqual(timeouts, [2, 4, 8, 12, 12]);
});

test("O9a: retryable HTTP errors keep their backoff and Retry-After handling", async () => {
  const delays: number[] = [];
  let calls = 0;
  const deps: TransportDeps = {
    fetch: async () => {
      calls++;
      if (calls === 1) return new Response("{}", { status: 503 });
      if (calls === 2)
        return new Response("{}", { status: 429, headers: { "retry-after": "0.007" } });
      return new Response("{}");
    },
    clock: Date,
    sleep: async (ms) => {
      delays.push(ms);
    },
    random: () => 0,
  };
  const result = await sendWithRetry(
    "https://example.test",
    {},
    "key",
    100,
    2,
    deps,
    undefined,
    30000,
    5,
  );
  assert.equal(result.attempts, 3);
  assert.deepEqual(delays, [500, 7]);
});

test("O9a: JEV_FIRST_TIMEOUT_MS is validated against JEV_TIMEOUT_MS", () => {
  const base = { JEV_PROVIDER: "typesafe", JEV_API_KEY: "key" };
  assert.equal(loadDecisionConfig(base).firstTimeoutMs, 5000);
  assert.equal(loadDecisionConfig({ ...base, JEV_TIMEOUT_MS: "3" }).firstTimeoutMs, 3);
  assert.equal(
    loadDecisionConfig({ ...base, JEV_TIMEOUT_MS: "8", JEV_FIRST_TIMEOUT_MS: "3" }).firstTimeoutMs,
    3,
  );
  for (const first of ["0", "1.5", "nope", "9"]) {
    assert.throws(
      () => loadDecisionConfig({ ...base, JEV_TIMEOUT_MS: "8", JEV_FIRST_TIMEOUT_MS: first }),
      DecisionConfigError,
    );
  }
});
