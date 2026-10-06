export type StealthLevel = "high" | "medium" | "low" | "degraded";

export class NavigationInProgressError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NavigationInProgressError";
  }
}

export class PageUnresponsiveError extends Error {
  constructor(options?: ErrorOptions) {
    super("page is not responding", options);
    this.name = "PageUnresponsiveError";
  }
}

export class FrameGoneError extends Error {
  constructor(options?: ErrorOptions) {
    super("child frame is gone", options);
    this.name = "FrameGoneError";
  }
}

export type Capabilities = {
  isolatedContexts: boolean;
  isolatedExecution: boolean;
  trustedInput: boolean;
  responseHeaders: boolean;
  crossOriginFrames: boolean;
  dialogs: boolean;
  popups: boolean;
  downloads: boolean;
  fileUpload: boolean;
  screenshots: boolean;
};

export type SelfCheckReport = {
  ok: boolean;
  checks: { name: string; ok: boolean; required?: boolean; value: unknown }[];
  stealth?: "high" | "medium" | "low";
};

export type NavigationResult = {
  url: string;
  status?: number;
  headers: Record<string, string | undefined>;
  failure?: string;
};

export type PageEvents = {
  error: Error;
  requestBlocked: { url: string; address: string; frame: "main" | "child" };
  navigationRequested: { url: string };
  navigated: {
    url: string;
    sameDocument?: boolean;
    status?: number;
    headers?: Record<string, string | undefined>;
  };
  domContentLoaded: { url: string };
  dialog: {
    kind: "alert" | "confirm" | "prompt" | "beforeunload";
    message: string;
    defaultPrompt: string;
    url?: string;
    frame?: "main" | "child";
  };
  popupOpening: { targetId: string };
  popup: PageHandle;
  download: {
    id: string;
    url: string;
    suggestedFilename: string;
    state: "started" | "completed" | "canceled";
    path?: string;
  };
};
export type InputResult = { dialog?: PageEvents["dialog"] };

export type CaptureOptions = {
  quality?: number; // JPEG quality, default 70.
  /** Region in CSS pixels relative to the top-level viewport; the whole viewport when absent. */
  clip?: { x: number; y: number; width: number; height: number };
  timeoutMs?: number; // Default 5000.
};
export type Capture = {
  data: Uint8Array;
  mimeType: "image/jpeg";
  width: number; // CSS pixels.
  height: number; // CSS pixels.
};

/** The capture region does not intersect the visual viewport. */
export class EmptyCaptureError extends Error {
  constructor() {
    super("capture region is outside the viewport");
    this.name = "EmptyCaptureError";
  }
}

export interface FrameHandle {
  readonly id: string;
  readonly offset: { x: number; y: number; scaleX?: number; scaleY?: number };
  callIsolated<A extends unknown[], R>(
    fn: (...args: A) => R | Promise<R>,
    args: A,
    options?: { timeoutMs?: number },
  ): Promise<R>;
}

export interface PageHandle {
  readonly id: string;
  readonly capabilities: Capabilities;
  targetUrl?(): Promise<string>;
  blockedRequest?(): PageEvents["requestBlocked"] | undefined;
  navigate(url: string, options?: { timeoutMs?: number }): Promise<NavigationResult>;
  callIsolated<A extends unknown[], R>(
    fn: (...args: A) => R | Promise<R>,
    args: A,
    options?: { timeoutMs?: number },
  ): Promise<R>;
  click(x: number, y: number): Promise<InputResult>;
  hover(x: number, y: number): Promise<InputResult>;
  drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<InputResult>;
  wheel(x: number, y: number, deltaY: number): Promise<InputResult>;
  back(): Promise<InputResult>;
  insertText(text: string): Promise<InputResult>;
  /** Press and release Shift: gives keyup listeners the field value after insertText. */
  tapShift(): Promise<InputResult>;
  key(name: string): Promise<InputResult>;
  selectAll(): Promise<InputResult>;
  focusedSubmitTarget(
    epoch: number,
    ref: string,
    formId: string | undefined,
    searchbox: boolean,
  ): Promise<boolean>;
  screenshot(options?: { quality?: number }): Promise<Uint8Array>;
  capture?(options?: CaptureOptions): Promise<Capture>;
  frames(options?: {
    timeoutMs?: number;
    skipAdFrames?: boolean;
  }): Promise<FrameHandle[] & { framesSkipped?: number }>;
  handleDialog(accept: boolean, promptText?: string): Promise<void>;
  waitForDownload(
    predicate?: (event: PageEvents["download"]) => boolean,
    timeoutMs?: number,
  ): Promise<PageEvents["download"]>;
  setInputFiles<A extends unknown[]>(
    find: (...args: A) => Element | null,
    args: A,
    files: string[],
  ): Promise<void>;
  on<K extends keyof PageEvents>(event: K, handler: (value: PageEvents[K]) => void): void;
  off<K extends keyof PageEvents>(event: K, handler: (value: PageEvents[K]) => void): void;
  close(): Promise<void>;
}

export interface BrowserHandle {
  readonly engine: { name: string; driver: string; stealthLevel: StealthLevel };
  readonly capabilities: Capabilities;
  readonly selfCheck: SelfCheckReport | undefined;
  readonly connected: boolean;
  readonly downloadPath?: string | undefined;
  onDisconnected(listener: () => void): () => void;
  newPage(options?: { isolated?: { copyCookies: boolean } }): Promise<PageHandle>;
  pages(): PageHandle[];
  close(): Promise<void>;
}

export type LaunchOptions = {
  networkGuard?: { mode: "metadata" | "private" | "off"; extraBlocked: string[] };
  allowDegraded?: boolean;
  selfCheck?: boolean;
  timeoutMs?: number;
  autoAcceptAlerts?: boolean;
  manageDownloads?: boolean;
};

export interface EngineDriver {
  readonly kind: string;
  launch(profile: unknown, options?: LaunchOptions): Promise<BrowserHandle>;
}
