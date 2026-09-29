import { extractProviderError } from "./adapters.ts";
import { DecisionAbortedError, DecisionTimeoutError, DecisionTransportError } from "./errors.ts";
import type { Clock, FetchLike, Sleep } from "./types.ts";

export type TransportDeps = {
  fetch: FetchLike;
  clock: Clock;
  sleep: Sleep;
  random: () => number;
};

export const defaultDeps: TransportDeps = {
  fetch: globalThis.fetch,
  clock: Date,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  random: Math.random,
};

const retryStatuses = new Set([429, 500, 502, 503, 504, 529]);
const maxErrorBytes = 2048;

function parsedRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function abortError(): DecisionAbortedError {
  return new DecisionAbortedError("decision request aborted");
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function sleepUnlessAborted(
  milliseconds: number,
  sleep: Sleep,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw abortError();
  const pending = sleep(milliseconds);
  if (signal) await raceAbort(pending, signal);
  else await pending;
}

async function readErrorBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let finished = false;
  try {
    while (bytes < maxErrorBytes) {
      const next = await raceAbort(reader.read(), signal);
      if (next.done) {
        finished = true;
        break;
      }
      const remaining = maxErrorBytes - bytes;
      const chunk = next.value.subarray(0, remaining);
      chunks.push(chunk);
      bytes += chunk.length;
      if (next.value.length > remaining || bytes === maxErrorBytes) {
        await reader.cancel();
        finished = true;
        break;
      }
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

function safeDetail(value: string | undefined, key: string): string | undefined {
  return value?.replaceAll(key, "[REDACTED]");
}

async function httpError(
  response: Response,
  key: string,
  signal: AbortSignal,
): Promise<DecisionTransportError> {
  const body = await readErrorBody(response, signal);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const providerError = extractProviderError(parsed);
  const providerMessage = safeDetail(providerError.providerMessage, key);
  const providerCode = safeDetail(providerError.providerCode, key);
  const retryable = retryStatuses.has(response.status);
  const message =
    response.status === 402
      ? "prepaid credits are required"
      : providerMessage
        ? `decision HTTP request failed: ${providerMessage}`
        : "decision HTTP request failed";
  return new DecisionTransportError(message, response.status, retryable, {
    ...(providerMessage ? { providerMessage } : {}),
    ...(providerCode ? { providerCode } : {}),
  });
}

export async function sendWithRetry(
  url: string,
  body: unknown,
  key: string,
  timeoutMs: number,
  maxRetries: number,
  deps: TransportDeps,
  signal?: AbortSignal,
  maxRetryAfterMs = 30000,
  firstTimeoutMs = timeoutMs,
): Promise<{ body: unknown; attempts: number }> {
  if (signal?.aborted) throw abortError();

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortError();
    const controller = new AbortController();
    let timedOut = false;
    const attemptTimeoutMs = Math.min(firstTimeoutMs * 2 ** attempt, timeoutMs);
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, attemptTimeoutMs);
    const onCallerAbort = () => controller.abort();
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (signal?.aborted) controller.abort();

    try {
      const response = await raceAbort(
        deps.fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        controller.signal,
      );
      if (!response.ok) {
        const error = await httpError(response, key, controller.signal);
        const retryAfterMs = parsedRetryAfter(
          response.headers.get("retry-after"),
          deps.clock.now(),
        );
        if (retryAfterMs !== undefined && retryAfterMs > maxRetryAfterMs) {
          throw new DecisionTransportError(error.message, response.status, false, {
            ...(error.providerMessage ? { providerMessage: error.providerMessage } : {}),
            ...(error.providerCode ? { providerCode: error.providerCode } : {}),
            retryAfterMs,
          });
        }
        if (!error.retryable || attempt >= maxRetries) throw error;
        const backoff = Math.min(1000 * 2 ** attempt, 10000) * (0.5 + deps.random() / 2);
        clearTimeout(timeout);
        await sleepUnlessAborted(retryAfterMs ?? backoff, deps.sleep, signal);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = await raceAbort(response.json(), controller.signal);
      } catch (cause) {
        if (controller.signal.aborted) throw cause;
        throw new DecisionTransportError("invalid JSON response", response.status, false, {
          cause,
        });
      }
      return { body: parsed, attempts: attempt + 1 };
    } catch (cause) {
      if (cause instanceof DecisionTransportError) cause.attempts = attempt + 1;
      if (signal?.aborted) throw new DecisionAbortedError("decision request aborted", { cause });
      if (timedOut) {
        const timeoutError = new DecisionTimeoutError("decision request timed out", { cause });
        timeoutError.attempts = attempt + 1;
        if (attempt >= maxRetries) throw timeoutError;
        continue;
      } else if (cause instanceof DecisionTransportError) {
        throw cause;
      } else if (cause instanceof DecisionAbortedError) {
        throw cause;
      } else if (attempt >= maxRetries) {
        const error = new DecisionTransportError("decision network error", undefined, true, {
          cause,
        });
        error.attempts = attempt + 1;
        throw error;
      }
      const backoff = Math.min(1000 * 2 ** attempt, 10000) * (0.5 + deps.random() / 2);
      await sleepUnlessAborted(backoff, deps.sleep, signal);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onCallerAbort);
    }
  }
}
