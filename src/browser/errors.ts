export class BrowserError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

export class BrowserConfigError extends BrowserError {
  readonly problems: string[];
  constructor(message: string, options?: ErrorOptions & { problems?: string[] }) {
    super(message, options);
    this.problems = options?.problems ?? [message];
  }
}
export class DialogBlockingError extends BrowserError {
  readonly dialog: string;
  constructor(dialog: string, options?: ErrorOptions) {
    super(`JavaScript ${dialog} dialog blocks the page`, options);
    this.dialog = dialog;
  }
}
export class BrowserLaunchError extends BrowserError {}
export class BrowserSelfCheckError extends BrowserError {
  readonly failedChecks: string[];
  constructor(failedChecks: string[], options?: ErrorOptions) {
    super(`browser self-check failed: ${failedChecks.join(", ")}`, options);
    this.failedChecks = failedChecks;
  }
}
export class CdpTimeoutError extends BrowserError {
  readonly sessionId: string | undefined;
  constructor(message: string, sessionId?: string) {
    super(message);
    this.sessionId = sessionId;
  }
}
export class CdpDisconnectedError extends BrowserError {}
export class EvaluationError extends BrowserError {
  readonly exceptionText: string;
  /** Name of our page function and the thrown class (e.g. TypeError): code identifiers, never page text. */
  readonly functionName: string | undefined;
  readonly exceptionClass: string | undefined;

  constructor(
    message: string,
    exceptionText: string,
    options?: ErrorOptions & { functionName?: string; exceptionClass?: string },
  ) {
    super(message, options);
    this.exceptionText = exceptionText;
    this.functionName = options?.functionName;
    this.exceptionClass = options?.exceptionClass;
  }
}
export class CdpProtocolError extends BrowserError {
  readonly code: number;
  readonly method: string;
  constructor(code: number, message: string, method: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.method = method;
  }
}
