import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DecisionAbortedError,
  DecisionTimeoutError,
  DecisionTransportError,
  sendWithRetry,
} from "../../src/index.ts";
import type { FetchLike, TransportDeps } from "../../src/index.ts";
import { defaultDeps } from "../../src/decision/transport.ts";
import { fixture, jsonResponse } from "./helpers.ts";

function deps(fetch: FetchLike, sleep: TransportDeps["sleep"] = async () => {}): TransportDeps {
  return { fetch, sleep, clock: { now: () => 0 }, random: () => 0 };
}

function send(
  transport: TransportDeps,
  options: {
    retries?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    maxRetryAfterMs?: number;
  } = {},
) {
  return sendWithRetry(
    "https://example.test/decide",
    { state: "page" },
    "test-secret",
    options.timeoutMs ?? 20,
    options.retries ?? 2,
    transport,
    options.signal,
    options.maxRetryAfterMs,
  );
}

describe("HTTP retries", () => {
  for (const status of [429, 500, 502, 503, 504, 529]) {
    test(`retries on ${status} and then succeeds`, async () => {
      let calls = 0;
      const transport = deps(async () => {
        calls++;
        return calls === 1 ? jsonResponse({}, status) : jsonResponse(fixture("typesafe"));
      });
      const result = await send(transport);
      assert.equal(result.attempts, 2);
      assert.equal(calls, 2);
    });
  }

  test("retries a network error and then succeeds", async () => {
    let calls = 0;
    const transport = deps(async () => {
      calls++;
      if (calls === 1) throw new Error("offline");
      return jsonResponse(fixture("typesafe"));
    });
    assert.equal((await send(transport)).attempts, 2);
  });

  for (const status of [400, 401, 402, 403, 404, 422]) {
    test(`does not retry HTTP ${status}`, async () => {
      let calls = 0;
      const transport = deps(async () => {
        calls++;
        return jsonResponse({}, status);
      });
      await assert.rejects(
        send(transport),
        (error: unknown) =>
          error instanceof DecisionTransportError && error.status === status && !error.retryable,
      );
      assert.equal(calls, 1);
    });
  }

  test("times out each attempt and exhausts retries", async () => {
    let calls = 0;
    const transport = deps(async (_url, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    });
    await assert.rejects(send(transport, { timeoutMs: 1, retries: 1 }), DecisionTimeoutError);
    assert.equal(calls, 2);
  });
});

describe("caller cancellation", () => {
  test("an already-aborted signal sends no request", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const transport = deps(async () => {
      calls++;
      return jsonResponse(fixture("typesafe"));
    });
    await assert.rejects(send(transport, { signal: controller.signal }), DecisionAbortedError);
    assert.equal(calls, 0);
  });

  test("aborting during fetch stops without retrying", async () => {
    const controller = new AbortController();
    let calls = 0;
    const transport = deps(async () => {
      calls++;
      return new Promise<Response>(() => {});
    });
    const pending = send(transport, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, DecisionAbortedError);
    assert.equal(calls, 1);
  });

  test("aborting during backoff stops without another request", async () => {
    const controller = new AbortController();
    let calls = 0;
    let sleeping = false;
    const transport = deps(
      async () => {
        calls++;
        return jsonResponse({}, 429);
      },
      async () => {
        sleeping = true;
        controller.abort();
      },
    );
    await assert.rejects(send(transport, { signal: controller.signal }), DecisionAbortedError);
    assert.equal(sleeping, true);
    assert.equal(calls, 1);
  });

  test("aborting a pending exponential backoff rejects promptly", { timeout: 1000 }, async () => {
    const controller = new AbortController();
    let announceSleep: (() => void) | undefined;
    const sleepStarted = new Promise<void>((resolve) => {
      announceSleep = resolve;
    });
    let calls = 0;
    const transport = deps(
      async () => {
        calls++;
        return jsonResponse({}, 503);
      },
      async (milliseconds) => {
        assert.ok(milliseconds > 0);
        announceSleep?.();
        return new Promise<void>(() => {});
      },
    );

    const pending = send(transport, { signal: controller.signal });
    await sleepStarted;
    controller.abort();
    await assertPromptAbort(pending);
    assert.equal(calls, 1);
  });
});

describe("Retry-After", () => {
  test("honors seconds", async () => {
    let calls = 0;
    const delays: number[] = [];
    const transport = deps(
      async () => {
        calls++;
        return calls === 1
          ? jsonResponse({}, 429, { "retry-after": "2" })
          : jsonResponse(fixture("typesafe"));
      },
      async (milliseconds) => {
        delays.push(milliseconds);
      },
    );
    await send(transport);
    assert.deepEqual(delays, [2000]);
  });

  test("honors an HTTP-date", async () => {
    let calls = 0;
    const delays: number[] = [];
    const date = new Date(5000).toUTCString();
    const transport = deps(
      async () => {
        calls++;
        return calls === 1
          ? jsonResponse({}, 429, { "retry-after": date })
          : jsonResponse(fixture("typesafe"));
      },
      async (milliseconds) => {
        delays.push(milliseconds);
      },
    );
    await send(transport);
    assert.deepEqual(delays, [5000]);
  });

  test("aborting a pending Retry-After wait rejects promptly", { timeout: 1000 }, async () => {
    const controller = new AbortController();
    let announceSleep: (() => void) | undefined;
    const sleepStarted = new Promise<void>((resolve) => {
      announceSleep = resolve;
    });
    let calls = 0;
    const transport = deps(
      async () => {
        calls++;
        return jsonResponse({}, 429, { "retry-after": "2" });
      },
      async (milliseconds) => {
        assert.equal(milliseconds, 2000);
        announceSleep?.();
        return new Promise<void>(() => {});
      },
    );

    const pending = send(transport, { signal: controller.signal });
    await sleepStarted;
    controller.abort();
    await assertPromptAbort(pending);
    assert.equal(calls, 1);
  });

  test("fails immediately when the requested delay exceeds the cap", async () => {
    let calls = 0;
    let slept = false;
    const transport = deps(
      async () => {
        calls++;
        return jsonResponse({}, 429, { "retry-after": "35" });
      },
      async () => {
        slept = true;
      },
    );
    await assert.rejects(
      send(transport, { maxRetryAfterMs: 30000 }),
      (error: unknown) =>
        error instanceof DecisionTransportError && error.retryAfterMs === 35000 && !error.retryable,
    );
    assert.equal(calls, 1);
    assert.equal(slept, false);
  });
});

async function assertPromptAbort(pending: Promise<unknown>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      assert.rejects(pending, DecisionAbortedError),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("cancellation was not prompt")), 250);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

describe("HTTP error details", () => {
  test("extracts OpenRouter error message and code", async () => {
    const transport = deps(async () =>
      jsonResponse({ error: { message: "quota exceeded", code: "quota" } }, 400),
    );
    await assert.rejects(
      send(transport),
      (error: unknown) =>
        error instanceof DecisionTransportError &&
        error.providerMessage === "quota exceeded" &&
        error.providerCode === "quota",
    );
  });

  test("extracts TypeSafe error and message", async () => {
    const transport = deps(async () =>
      jsonResponse({ error: "bad request", message: "invalid state" }, 400),
    );
    await assert.rejects(
      send(transport),
      (error: unknown) =>
        error instanceof DecisionTransportError && error.providerMessage === "bad request",
    );
  });

  test("extracts Cloudflare errors array", async () => {
    const transport = deps(async () =>
      jsonResponse({ errors: [{ code: 10001, message: "billing required" }] }, 402),
    );
    await assert.rejects(
      send(transport),
      (error: unknown) =>
        error instanceof DecisionTransportError &&
        error.providerMessage === "billing required" &&
        error.providerCode === "10001" &&
        error.message.includes("prepaid credits are required"),
    );
  });

  test("redacts a key echoed in a provider message", async () => {
    const transport = deps(async () =>
      jsonResponse({ error: { message: "bad test-secret", code: "test-secret" } }, 400),
    );
    await assert.rejects(
      send(transport),
      (error: unknown) =>
        error instanceof DecisionTransportError &&
        !error.message.includes("test-secret") &&
        !error.providerMessage?.includes("test-secret") &&
        !error.providerCode?.includes("test-secret"),
    );
  });

  test("cancels an oversized error body after retaining at most 2 KB", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(4096)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const transport = deps(async () => new Response(stream, { status: 400 }));
    await assert.rejects(send(transport), DecisionTransportError);
    assert.equal(cancelled, true);
  });

  test("reads no more than two 1 KB chunks from an error body", async () => {
    let reads = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++;
          controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const transport = deps(async () => new Response(stream, { status: 400 }));
    await assert.rejects(send(transport), DecisionTransportError);
    assert.equal(reads, 2);
    assert.equal(cancelled, true);
  });

  test("consumes a short error body", async () => {
    const failed = jsonResponse({ error: "small" }, 400);
    const transport = deps(async () => failed);
    await assert.rejects(send(transport), DecisionTransportError);
    assert.equal(failed.bodyUsed, true);
  });
});

describe("default transport dependencies", () => {
  test("R8: the default retry sleep keeps the process alive until it has finished", async () => {
    // A retry waiting between attempts is work in progress: an unref'd timer lets a one-shot process
    // (jevpilot-mcp doctor) exit in the middle of it, silently and with status 0.
    const original = globalThis.setTimeout;
    let created: NodeJS.Timeout | undefined;
    globalThis.setTimeout = ((handler: () => void, delay?: number, ...rest: unknown[]) => {
      const timer = original(handler, delay, ...rest) as unknown as NodeJS.Timeout;
      if (delay === 7) created = timer;
      return timer;
    }) as typeof setTimeout;
    try {
      const pending = defaultDeps.sleep(7);
      assert.ok(created, "the sleep starts a timer");
      assert.equal(created.hasRef(), true);
      await pending;
    } finally {
      globalThis.setTimeout = original;
    }
  });
});
