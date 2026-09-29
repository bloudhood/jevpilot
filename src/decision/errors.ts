export class DecisionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

export class InvalidAnswerError extends DecisionError {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`invalid answers: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

export class ContextLimitError extends DecisionError {
  reductions: string[] = [];
}
export class DecisionTimeoutError extends DecisionError {
  attempts = 0;
}
export class DecisionAbortedError extends DecisionError {}
export class DecisionConfigError extends DecisionError {}
export class DecisionRequestError extends DecisionError {}
export class CircuitOpenError extends DecisionError {}
export class MockScriptExhaustedError extends DecisionError {}

export type TransportErrorDetails = {
  providerMessage?: string;
  providerCode?: string;
  retryAfterMs?: number;
  cause?: unknown;
};

export class DecisionTransportError extends DecisionError {
  attempts = 0;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly providerMessage: string | undefined;
  readonly providerCode: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    status: number | undefined,
    retryable: boolean,
    details: TransportErrorDetails = {},
  ) {
    super(message, { cause: details.cause });
    this.status = status;
    this.retryable = retryable;
    this.providerMessage = details.providerMessage;
    this.providerCode = details.providerCode;
    this.retryAfterMs = details.retryAfterMs;
  }
}
