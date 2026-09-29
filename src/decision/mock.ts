import { DecisionAbortedError, MockScriptExhaustedError } from "./errors.ts";
import type { Answers, DecisionPort, DecisionRequest, DecisionResult, Sleep } from "./types.ts";
import { tagAnswers, validateAnswers } from "./validate.ts";

export type MockStep = {
  answers?: Answers;
  error?: Error;
  latencyMs?: number;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
};

async function unlessAborted<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) throw new DecisionAbortedError("decision request aborted");

  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DecisionAbortedError("decision request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export class MockDecider implements DecisionPort {
  readonly calls: DecisionRequest[] = [];
  private index = 0;
  private readonly script:
    MockStep[] | ((request: DecisionRequest) => MockStep | Promise<MockStep>);
  private readonly sleep: Sleep;

  constructor(
    script: MockStep[] | ((request: DecisionRequest) => MockStep | Promise<MockStep>),
    sleep: Sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {
    this.script = script;
    this.sleep = sleep;
  }

  async decide(
    request: DecisionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<DecisionResult> {
    const signal = options?.signal;
    if (signal?.aborted) throw new DecisionAbortedError("decision request aborted");
    this.calls.push(request);

    const step =
      typeof this.script === "function"
        ? await unlessAborted(Promise.resolve(this.script(request)), signal)
        : this.script[this.index++];
    if (!step) throw new MockScriptExhaustedError("mock script exhausted");
    if (step.latencyMs) await unlessAborted(this.sleep(step.latencyMs), signal);
    if (signal?.aborted) throw new DecisionAbortedError("decision request aborted");
    if (step.error) throw step.error;

    const answers = step.answers ?? {};
    validateAnswers(request.questions, answers);
    return {
      answers: tagAnswers(request.questions, answers),
      usage: step.usage ?? { inputTokens: 0, outputTokens: 0 },
      model: step.model ?? request.model ?? "jev-latest",
      provider: "mock",
      latencyMs: step.latencyMs ?? 0,
      attempts: 1,
    };
  }
}
