import { CdpClient } from "./cdp/client.ts";
import { CdpProtocolError, EvaluationError } from "./errors.ts";
import { NavigationInProgressError } from "../engine/types.ts";

export function isNavigationContextError(error: unknown): boolean {
  return (
    error instanceof CdpProtocolError &&
    /Inspected target navigated or closed|Execution context was destroyed|Cannot find context with specified id|Cannot find context|Cannot find object with given id|frame with given id was not found/i.test(
      error.message,
    )
  );
}

function isStaleIsolatedWorldFrameError(error: unknown): boolean {
  return (
    error instanceof CdpProtocolError &&
    /Page\.createIsolatedWorld returned code -32602|frame with given id was not found/i.test(
      error.message,
    )
  );
}

export class IsolatedWorld {
  private readonly client: CdpClient;
  private readonly sessionId: string;
  private readonly worldName: string;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeLoaded: () => void;
  private readonly fixedFrameId: string | undefined;
  private contextId: number | undefined;
  private frameId: string | undefined;
  private recreating: Promise<void> | undefined;
  private navigationGeneration = 0;
  private loadedGeneration = -1;
  constructor(client: CdpClient, sessionId: string, worldName = "jevpilot", frameId?: string) {
    this.client = client;
    this.sessionId = sessionId;
    this.worldName = worldName;
    this.fixedFrameId = frameId;
    this.unsubscribe = client.on(
      "Page.frameNavigated",
      (params) => {
        const event = params as { frame?: { id?: string; parentId?: string } };
        if (
          event.frame &&
          (this.fixedFrameId ? event.frame.id === this.fixedFrameId : !event.frame.parentId)
        ) {
          this.navigationGeneration++;
          this.contextId = undefined;
        }
      },
      sessionId,
    );
    this.unsubscribeLoaded = client.on(
      "Page.domContentEventFired",
      () => {
        this.loadedGeneration = this.navigationGeneration;
      },
      sessionId,
    );
  }
  dispose(): void {
    this.unsubscribe();
    this.unsubscribeLoaded();
  }
  private async waitForNavigation(generation: number, timeoutMs = 10000): Promise<void> {
    if (
      this.navigationGeneration !== generation &&
      this.loadedGeneration === this.navigationGeneration
    )
      return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      };
      const unsubscribe = this.client.on("Page.domContentEventFired", done, this.sessionId);
      const timer = setTimeout(done, timeoutMs);
      if (
        this.navigationGeneration !== generation &&
        this.loadedGeneration === this.navigationGeneration
      )
        done();
    });
  }
  async evaluate<T>(expression: string, timeoutMs?: number): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const generation = this.navigationGeneration;
      try {
        await this.ensureContext(timeoutMs);
        const contextId = this.contextId;
        if (contextId === undefined) {
          if (attempt === 0) continue;
          throw new EvaluationError(
            "isolated execution context unavailable",
            "context missing after creation",
          );
        }
        const result = await this.client.call(
          "Runtime.evaluate",
          { expression, contextId, returnByValue: true, awaitPromise: true },
          this.sessionId,
          timeoutMs,
        );
        const value = result.result.value as T | undefined;
        if (result.exceptionDetails) {
          const exceptionText =
            result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
          throw new EvaluationError("page script evaluation failed", exceptionText);
        }
        return value as T;
      } catch (cause) {
        if (attempt === 0 && isNavigationContextError(cause)) {
          this.contextId = undefined;
          if (cause instanceof CdpProtocolError && !/^Cannot find context$/iu.test(cause.message))
            await this.waitForNavigation(generation, timeoutMs);
          continue;
        }
        if (isNavigationContextError(cause))
          throw new NavigationInProgressError("navigation interrupted isolated evaluation", {
            cause,
          });
        throw cause;
      }
    }
    throw new Error("unreachable");
  }
  async callFunction<T>(
    fn: (...args: never[]) => T,
    args: unknown[] = [],
    timeoutMs?: number,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const generation = this.navigationGeneration;
      try {
        await this.ensureContext(timeoutMs);
        const executionContextId = this.contextId;
        if (executionContextId === undefined) {
          if (attempt === 0) continue;
          throw new EvaluationError(
            "isolated execution context unavailable",
            "context missing after creation",
          );
        }
        const result = await this.client.call(
          "Runtime.callFunctionOn",
          {
            functionDeclaration: fn.toString(),
            executionContextId,
            arguments: args.map((value) => ({ value })),
            returnByValue: true,
            awaitPromise: true,
          },
          this.sessionId,
          timeoutMs,
        );
        if (result.exceptionDetails) {
          const exceptionText =
            result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
          throw new EvaluationError("page function call failed", exceptionText, {
            functionName: fn.name,
            ...(result.exceptionDetails.exception?.className
              ? { exceptionClass: result.exceptionDetails.exception.className }
              : {}),
          });
        }
        return result.result.value as T;
      } catch (cause) {
        if (attempt === 0 && !this.fixedFrameId && isNavigationContextError(cause)) {
          this.contextId = undefined;
          if (cause instanceof CdpProtocolError && !/^Cannot find context$/iu.test(cause.message))
            await this.waitForNavigation(generation, timeoutMs);
          continue;
        }
        if (isNavigationContextError(cause))
          throw new NavigationInProgressError("navigation interrupted isolated call", { cause });
        throw cause;
      }
    }
    throw new Error("unreachable");
  }
  async callForObject(fn: (...args: never[]) => unknown, args: unknown[]): Promise<string> {
    await this.ensureContext();
    const executionContextId = this.contextId;
    if (executionContextId === undefined)
      throw new EvaluationError(
        "isolated execution context unavailable",
        "context missing after creation",
      );
    const result = await this.client.call(
      "Runtime.callFunctionOn",
      {
        functionDeclaration: fn.toString(),
        executionContextId,
        arguments: args.map((value) => ({ value })),
        returnByValue: false,
        awaitPromise: true,
      },
      this.sessionId,
    );
    if (result.exceptionDetails)
      throw new EvaluationError("page function call failed", result.exceptionDetails.text);
    if (!result.result.objectId)
      throw new EvaluationError("file input not found", "function returned no DOM object");
    return result.result.objectId;
  }
  async getContextId(timeoutMs?: number): Promise<number> {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.ensureContext(timeoutMs);
      if (this.contextId !== undefined) return this.contextId;
    }
    throw new EvaluationError(
      "isolated execution context unavailable",
      "context missing after creation",
    );
  }
  private async ensureContext(timeoutMs?: number): Promise<void> {
    if (this.contextId !== undefined) return;
    if (this.recreating) return this.recreating;
    this.recreating = (async () => {
      const generation = this.navigationGeneration;
      if (this.fixedFrameId) this.frameId = this.fixedFrameId;
      else {
        const tree = await this.client.call(
          "Page.getFrameTree",
          undefined,
          this.sessionId,
          timeoutMs,
        );
        this.frameId = tree.frameTree.frame.id;
      }
      let result: { executionContextId: number } | undefined;
      const findFrame = (node: {
        frame: { id: string };
        childFrames?: Array<{ frame: { id: string }; childFrames?: unknown[] }>;
      }): string | undefined => {
        if (!this.fixedFrameId || node.frame.id === this.fixedFrameId) return node.frame.id;
        for (const child of node.childFrames ?? []) {
          const found = findFrame(child as typeof node);
          if (found) return found;
        }
        return undefined;
      };
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          result = await this.client.call(
            "Page.createIsolatedWorld",
            {
              frameId: this.frameId,
              worldName: this.worldName,
              grantUniveralAccess: false,
            },
            this.sessionId,
            timeoutMs,
          );
          break;
        } catch (error) {
          if (this.fixedFrameId || !isStaleIsolatedWorldFrameError(error) || attempt === 3)
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
          const tree = await this.client.call(
            "Page.getFrameTree",
            undefined,
            this.sessionId,
            timeoutMs,
          );
          this.frameId = findFrame(tree.frameTree) ?? tree.frameTree.frame.id;
        }
      }
      if (generation === this.navigationGeneration) {
        this.contextId = result?.executionContextId;
      }
    })().finally(() => {
      this.recreating = undefined;
    });
    return this.recreating;
  }
}
