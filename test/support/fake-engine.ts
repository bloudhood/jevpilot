import type {
  Capabilities,
  NavigationResult,
  FrameHandle,
  InputResult,
  PageEvents,
  PageHandle,
} from "../../src/engine/types.ts";

const capabilities: Capabilities = {
  isolatedContexts: false,
  isolatedExecution: true,
  trustedInput: true,
  responseHeaders: true,
  crossOriginFrames: true,
  dialogs: true,
  popups: true,
  downloads: true,
  fileUpload: true,
  screenshots: true,
};

export class FakePageHandle implements PageHandle {
  readonly id = "fake-page";
  readonly capabilities = capabilities;
  readonly calls: { name: string; args: unknown[] }[] = [];
  readonly results: unknown[];
  private readonly handlers = new Map<keyof PageEvents, Set<(value: never) => void>>();
  frameHandles: FrameHandle[] = [];
  inputResult: InputResult = {};
  focusedSubmit = false;
  navigationResult: Omit<NavigationResult, "url"> = { status: 200, headers: {} };

  constructor(...results: unknown[]) {
    this.results = results;
  }

  async navigate(url: string, _options?: { timeoutMs?: number }): Promise<NavigationResult> {
    const result = { url, ...this.navigationResult };
    this.emit("navigated", result);
    return result;
  }

  async callIsolated<A extends unknown[], R>(
    fn: (...args: A) => R | Promise<R>,
    args: A,
    _options: { timeoutMs?: number } = {},
  ): Promise<R> {
    if (fn.name === "installObserverLibrary") return undefined as R;
    this.calls.push({ name: fn.name, args });
    if (fn.name === "waitForNavigationQuiet") return 0 as R;
    if (this.results.length === 0) throw new Error("no scripted isolated result");
    return this.results.shift() as R;
  }

  async click(_x: number, _y: number): Promise<InputResult> {
    this.calls.push({ name: "click", args: [_x, _y] });
    return this.inputResult;
  }
  async hover(x: number, y: number): Promise<InputResult> {
    this.calls.push({ name: "hover", args: [x, y] });
    return this.inputResult;
  }
  async drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<InputResult> {
    this.calls.push({ name: "drag", args: [from, to] });
    return this.inputResult;
  }
  async wheel(x: number, y: number, deltaY: number): Promise<InputResult> {
    this.calls.push({ name: "wheel", args: [x, y, deltaY] });
    return this.inputResult;
  }
  async back(): Promise<InputResult> {
    this.calls.push({ name: "back", args: [] });
    return this.inputResult;
  }
  async insertText(_text: string): Promise<InputResult> {
    this.calls.push({ name: "insertText", args: [_text] });
    return this.inputResult;
  }
  async key(_name: string): Promise<InputResult> {
    this.calls.push({ name: "key", args: [_name] });
    return this.inputResult;
  }
  async tapShift(): Promise<InputResult> {
    this.calls.push({ name: "tapShift", args: [] });
    return this.inputResult;
  }
  async selectAll(): Promise<InputResult> {
    return this.inputResult;
  }
  async focusedSubmitTarget(
    epoch: number,
    ref: string,
    formId: string | undefined,
    searchbox: boolean,
  ): Promise<boolean> {
    this.calls.push({ name: "focusedSubmitTarget", args: [epoch, ref, formId, searchbox] });
    return this.focusedSubmit;
  }
  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  captureResult: { data: Uint8Array; width: number; height: number } | Error | undefined;
  async capture(options?: {
    quality?: number;
    clip?: { x: number; y: number; width: number; height: number };
    timeoutMs?: number;
  }): Promise<{ data: Uint8Array; mimeType: "image/jpeg"; width: number; height: number }> {
    this.calls.push({ name: "capture", args: [options] });
    if (this.captureResult instanceof Error) throw this.captureResult;
    const result = this.captureResult ?? {
      data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
      width: 800,
      height: 600,
    };
    return { ...result, mimeType: "image/jpeg" as const };
  }
  async frames(_options?: { timeoutMs?: number }): Promise<FrameHandle[]> {
    return this.frameHandles;
  }
  async handleDialog(_accept: boolean, _promptText?: string): Promise<void> {}
  async setInputFiles<A extends unknown[]>(
    _find: (...args: A) => Element | null,
    args: A,
    files: string[],
  ): Promise<void> {
    this.calls.push({ name: "setInputFiles", args: [args, files] });
  }
  waitForDownload(
    predicate: (event: PageEvents["download"]) => boolean = (event) => event.state === "completed",
    timeoutMs = 10000,
  ): Promise<PageEvents["download"]> {
    return new Promise((resolve, reject) => {
      const handler = (event: PageEvents["download"]) => {
        if (predicate(event)) {
          clearTimeout(timer);
          this.off("download", handler);
          resolve(event);
        }
      };
      const timer = setTimeout(() => {
        this.off("download", handler);
        reject(new Error("download timed out"));
      }, timeoutMs);
      this.on("download", handler);
    });
  }
  emit<K extends keyof PageEvents>(event: K, value: PageEvents[K]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(value as never);
  }
  on<K extends keyof PageEvents>(event: K, handler: (value: PageEvents[K]) => void): void {
    const handlers = this.handlers.get(event) ?? new Set<(value: never) => void>();
    handlers.add(handler as (value: never) => void);
    this.handlers.set(event, handlers);
  }
  off<K extends keyof PageEvents>(event: K, handler: (value: PageEvents[K]) => void): void {
    this.handlers.get(event)?.delete(handler as (value: never) => void);
  }
  async close(): Promise<void> {}
}
