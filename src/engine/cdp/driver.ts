import { stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isAdFrame } from "../../util/ad-frames.ts";
import {
  blockedAddress,
  checkUrl,
  lookupWithResolverRules,
  type NetworkGuard,
  type AddressLookup,
} from "../../security/address-guard.ts";
import {
  BrowserConfigError,
  BrowserLaunchError,
  CdpProtocolError,
  CdpTimeoutError,
  DialogBlockingError,
} from "../../browser/errors.ts";
import {
  click,
  drag,
  hover,
  insertText,
  tapShift,
  keyPress,
  captureScreenshot,
  screenshot,
  selectAll,
} from "../../browser/input.ts";
import { IsolatedWorld } from "../../browser/isolated-world.ts";
import { sanitizeResponseHeaders } from "../../browser/response-headers.ts";
import { launchBrowser, type BrowserInstance, type LaunchDeps } from "../../browser/launcher.ts";
import type { BrowserProfile } from "../../browser/profiles.ts";
import type { BrowserSession } from "../../browser/session.ts";
import type {
  BrowserHandle,
  Capabilities,
  Capture,
  CaptureOptions,
  EngineDriver,
  FrameHandle,
  InputResult,
  LaunchOptions,
  PageEvents,
  PageHandle,
  StealthLevel,
} from "../types.ts";
import {
  EmptyCaptureError,
  FrameGoneError,
  NavigationInProgressError,
  PageUnresponsiveError,
} from "../types.ts";

function isGoneChildFrameError(error: unknown): boolean {
  if (error instanceof NavigationInProgressError) return isGoneChildFrameError(error.cause);
  return (
    error instanceof CdpProtocolError &&
    ((error.code === -32602 && error.method === "Page.createIsolatedWorld") ||
      (error.code === -32000 &&
        /^(?:DOM\.(?:getFrameOwner|resolveNode)|Page\.createIsolatedWorld|Runtime\.callFunctionOn)$/u.test(
          error.method,
        ) &&
        /node|context|frame|object|target|navigat/iu.test(error.message)) ||
      (error.code === -32001 && /session/iu.test(error.message)) ||
      /frame with given id was not found/iu.test(error.message))
  );
}

const nonempty = z.string().trim().min(1);
export const profileSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("server-plain"),
    userDataDir: nonempty,
    windowSize: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    display: z.enum(["xvfb", "headless"]),
    executable: z.string().optional(),
    extraArgs: z.array(z.string()).optional(),
    proxy: z.string().optional(),
    downloadPath: nonempty.optional(),
  }),
  z.object({
    kind: z.literal("desktop-chrome"),
    userDataDir: nonempty,
    windowSize: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    display: z.enum(["headless", "headed"]).optional(),
    executable: z.string().optional(),
    extraArgs: z.array(z.string()).optional(),
    proxy: z.string().optional(),
    downloadPath: nonempty.optional(),
  }),
  z.object({
    kind: z.literal("attach"),
    cdpUrl: z
      .string()
      .url()
      .refine((value) => {
        try {
          return ["http:", "https:", "ws:", "wss:"].includes(new URL(value).protocol);
        } catch {
          return false;
        }
      }, "expected http(s) or ws(s) URL"),
    downloadPath: nonempty.optional(),
  }),
]);

export function parseCdpProfile(value: unknown): BrowserProfile {
  const parsed = profileSchema.safeParse(value);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "profile"}: ${issue.message}`,
    );
    throw new BrowserConfigError(`invalid CDP browser profile: ${problems.join("; ")}`, {
      cause: parsed.error,
      problems,
    });
  }
  return parsed.data as BrowserProfile;
}

export const cdpCapabilities: Capabilities = {
  isolatedContexts: true,
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

export function focusedSubmitTargetInPage(
  epoch: number,
  ref: string,
  expectedFormId: string | undefined,
  allowSearchbox: boolean,
): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) return false;
  if (active.disabled || active.readOnly || !active.value) return false;
  const type = active instanceof HTMLInputElement ? active.type : "textarea";
  if (["hidden", "file", "checkbox", "radio", "button", "submit", "reset"].includes(type))
    return false;
  const form = active.form;
  const registry = (
    globalThis as typeof globalThis & {
      __jevpilotObserverRegistry?: { epoch: number; refs: Map<string, WeakRef<Element>> };
    }
  ).__jevpilotObserverRegistry;
  const sameElement = registry?.epoch === epoch && registry.refs.get(ref)?.deref() === active;
  const currentFormId = form
    ? `form:${form.id || [...form.ownerDocument.forms].indexOf(form)}`
    : "implicit";
  return (
    sameElement ||
    (expectedFormId !== undefined &&
      expectedFormId !== "implicit" &&
      currentFormId === expectedFormId) ||
    (allowSearchbox && (type === "search" || active.getAttribute("role") === "searchbox"))
  );
}

class CdpPageHandle implements PageHandle {
  readonly id: string;
  readonly capabilities: Capabilities;
  private readonly listeners = new Map<keyof PageEvents, Set<(value: never) => void>>();
  private readonly children = new Map<
    string,
    { sessionId: string; parentSessionId: string; world: IsolatedWorld }
  >();
  private readonly inProcessFrames = new Map<string, { sessionId: string; world: IsolatedWorld }>();
  private readonly subscriptions: (() => void)[] = [];
  private readonly frameSubscriptions = new Map<string, (() => void)[]>();
  private readonly frameSetups = new Map<Promise<void>, string>();
  private readonly knownAdFrames = new Set<string>();
  private readonly knownFrames = new Map<string, { sessionId: string; parentId?: string }>();
  private readonly pendingFrameSessions = new Set<string>();
  private pendingDialog: PageEvents["dialog"] | undefined;
  private pendingDialogSessionId: string | undefined;
  private readonly blockers = new Set<(error: DialogBlockingError) => void>();
  private mainFrameId: string | undefined;
  private readonly documentResponses = new Map<
    string,
    { frameId: string; status: number; headers: Record<string, string> }
  >();
  private pendingNavigation:
    { loaderId: string; url: string; timer: ReturnType<typeof setTimeout> } | undefined;

  private readonly browser: BrowserInstance;
  private readonly networkGuard: NetworkGuard;
  private readonly lookup: AddressLookup | undefined;
  private readonly checkResponseAddress: boolean;
  private blockedMain: PageEvents["requestBlocked"] | undefined;
  private readonly session: BrowserSession;
  private readonly autoAcceptAlerts: boolean;
  private readonly activateForInput: () => Promise<void>;
  private readonly onClose: () => Promise<void>;
  constructor(
    browser: BrowserInstance,
    session: BrowserSession,
    autoAcceptAlerts: boolean,
    capabilities: Capabilities,
    activateForInput: () => Promise<void>,
    onClose: () => Promise<void> = async () => {},
    networkGuard: NetworkGuard = { mode: "metadata", extraBlocked: [] },
    lookup?: AddressLookup,
    checkResponseAddress = true,
  ) {
    this.browser = browser;
    this.session = session;
    this.autoAcceptAlerts = autoAcceptAlerts;
    this.capabilities = capabilities;
    this.activateForInput = activateForInput;
    this.onClose = onClose;
    this.networkGuard = networkGuard;
    this.lookup = lookup;
    this.checkResponseAddress = checkResponseAddress;
    this.id = session.targetId;
    const client = browser.client;
    this.subscriptions.push(
      client.on(
        "Page.frameRequestedNavigation",
        (value) => {
          const event = value as { frameId: string; url: string };
          if (event.frameId === this.mainFrameId)
            this.emit("navigationRequested", { url: event.url });
        },
        session.sessionId,
      ),
    );
    this.subscriptions.push(
      client.on(
        "Page.frameNavigated",
        (value) => {
          const event = value as {
            frame?: {
              url?: string;
              name?: string;
              id?: string;
              parentId?: string;
              loaderId?: string;
            };
          };
          if (event.frame?.id)
            this.rememberFrame({ ...event.frame, id: event.frame.id }, session.sessionId);
          if (event.frame && !event.frame.parentId) {
            this.mainFrameId = event.frame.id;
            if (event.frame.url) this.onFrameNavigated(event.frame.url, event.frame.loaderId);
          }
        },
        session.sessionId,
      ),
    );
    this.subscriptions.push(
      client.on(
        "Network.responseReceived",
        (value) => {
          const event = value as {
            type: string;
            frameId: string;
            loaderId: string;
            response: {
              status: number;
              headers: Record<string, unknown>;
              remoteIPAddress?: string;
              url?: string;
            };
          };
          if (event.type !== "Document" || !event.loaderId) return;
          if (
            this.checkResponseAddress &&
            event.response.remoteIPAddress &&
            blockedAddress(event.response.remoteIPAddress, this.networkGuard)
          ) {
            const frame = this.mainFrameId && event.frameId !== this.mainFrameId ? "child" : "main";
            this.blockDocument(
              { url: event.response.url ?? "", address: event.response.remoteIPAddress, frame },
              session.sessionId,
              event.frameId,
            );
            return;
          }
          if (this.mainFrameId && event.frameId !== this.mainFrameId) return;
          this.documentResponses.set(event.loaderId, {
            frameId: event.frameId,
            status: event.response.status,
            headers: sanitizeResponseHeaders(event.response.headers),
          });
          if (this.documentResponses.size > 32) {
            this.documentResponses.delete(this.documentResponses.keys().next().value!);
          }
          if (this.pendingNavigation?.loaderId === event.loaderId) {
            const { url, timer } = this.pendingNavigation;
            clearTimeout(timer);
            this.pendingNavigation = undefined;
            this.emitDocumentNavigation(url, event.loaderId);
          }
        },
        session.sessionId,
      ),
    );
    this.subscriptions.push(
      client.on(
        "Page.navigatedWithinDocument",
        (value) => {
          const event = value as { frameId: string; url: string };
          if (event.frameId === this.mainFrameId)
            this.emit("navigated", { url: event.url, sameDocument: true });
        },
        session.sessionId,
      ),
    );
    this.subscriptions.push(
      client.on(
        "Page.domContentEventFired",
        () => this.emit("domContentLoaded", { url: "" }),
        session.sessionId,
      ),
    );
    this.subscriptions.push(
      client.on(
        "Page.javascriptDialogOpening",
        (value) => this.onDialogOpening(value, session.sessionId),
        session.sessionId,
      ),
    );
    this.subscriptions.push(
      client.on(
        "Target.attachedToTarget",
        (value) => {
          const event = value as {
            sessionId: string;
            targetInfo: { targetId: string; type: string; url?: string; parentFrameId?: string };
          };
          if (event.targetInfo.type === "iframe") {
            this.rememberFrame(
              {
                id: event.targetInfo.targetId,
                url: event.targetInfo.url,
                parentId: event.targetInfo.parentFrameId,
              },
              event.sessionId,
              false,
            );
            const setup = this.attachFrame(
              event.sessionId,
              event.targetInfo.targetId,
              session.sessionId,
            );
            this.trackFrameSetup(setup, event.sessionId);
            void setup.catch((cause: unknown) => {
              this.detachFrame(event.sessionId);
              this.emit("error", new BrowserLaunchError("failed to attach iframe", { cause }));
            });
          }
        },
        session.sessionId,
      ),
    );
    this.subscriptions.push(
      client.on(
        "Target.detachedFromTarget",
        (value) => {
          const event = value as { sessionId: string };
          this.detachFrame(event.sessionId);
        },
        session.sessionId,
      ),
    );
    this.subscriptions.push(
      client.on(
        "Page.frameDetached",
        (value) => this.forgetFrame((value as { frameId: string }).frameId),
        session.sessionId,
      ),
    );
  }

  private emit<K extends keyof PageEvents>(event: K, value: PageEvents[K]): void {
    for (const handler of this.listeners.get(event) ?? []) handler(value as never);
  }

  private blockDocument(
    block: PageEvents["requestBlocked"],
    sessionId: string,
    frameId?: string,
  ): void {
    if (block.frame === "main") this.blockedMain = block;
    this.emit("requestBlocked", block);
    if (frameId)
      void this.browser.client
        .call("Page.navigate", { url: "about:blank", frameId }, sessionId)
        .catch(() => {});
  }

  blockedRequest(): PageEvents["requestBlocked"] | undefined {
    return this.blockedMain;
  }

  async enableNetworkGuard(
    sessionId = this.session.sessionId,
    frame: "main" | "child" = "main",
  ): Promise<void> {
    if (this.networkGuard.mode === "off" && this.networkGuard.extraBlocked.length === 0) return;
    const off = this.browser.client.on(
      "Fetch.requestPaused",
      (value) => {
        const event = value as { requestId: string; request: { url: string }; frameId?: string };
        void (async () => {
          const verdict = await checkUrl(event.request.url, this.networkGuard, this.lookup);
          const address = verdict.blocked;
          // Private mode does not load a host its lookup could not verify when the browser resolves names
          // itself. Behind a configured proxy the proxy resolves them and this lookup says nothing either way.
          const unverified =
            verdict.unverified === true &&
            this.networkGuard.mode === "private" &&
            this.checkResponseAddress;
          const method = address || unverified ? "Fetch.failRequest" : "Fetch.continueRequest";
          try {
            await this.browser.client.call(
              method,
              address
                ? { requestId: event.requestId, errorReason: "BlockedByClient" }
                : unverified
                  ? { requestId: event.requestId, errorReason: "NameNotResolved" }
                  : { requestId: event.requestId },
              sessionId,
            );
          } catch (error) {
            this.emit(
              "error",
              new BrowserLaunchError("failed to resolve paused request", { cause: error }),
            );
          }
          // An out-of-process iframe's first request is paused on its parent's session, so the
          // session alone does not tell the frame; before the first commit only the main frame exists.
          const blockedFrame =
            frame === "main" &&
            (!this.mainFrameId || !event.frameId || event.frameId === this.mainFrameId)
              ? "main"
              : "child";
          if (address)
            this.blockDocument(
              { url: event.request.url, address, frame: blockedFrame },
              sessionId,
              event.frameId,
            );
        })();
      },
      sessionId,
    );
    if (frame === "main") this.subscriptions.push(off);
    else this.frameSubscriptions.get(sessionId)?.push(off);
    // Awaited so that no navigation on this session can start before interception is active.
    try {
      await this.browser.client.call(
        "Fetch.enable",
        { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] },
        sessionId,
      );
    } catch (cause) {
      off();
      throw new BrowserLaunchError("failed to enable network guard", { cause });
    }
  }

  private onFrameNavigated(url: string, loaderId: string | undefined): void {
    if (this.pendingNavigation) clearTimeout(this.pendingNavigation.timer);
    this.pendingNavigation = undefined;
    if (!loaderId || this.documentResponses.has(loaderId)) {
      this.emitDocumentNavigation(url, loaderId);
      return;
    }
    const timer = setTimeout(() => {
      if (this.pendingNavigation?.loaderId !== loaderId) return;
      this.pendingNavigation = undefined;
      this.emitDocumentNavigation(url, loaderId);
    }, 75);
    this.pendingNavigation = { loaderId, url, timer };
  }

  private emitDocumentNavigation(url: string, loaderId: string | undefined): void {
    const response = loaderId ? this.documentResponses.get(loaderId) : undefined;
    if (loaderId) this.documentResponses.delete(loaderId);
    this.emit("navigated", {
      url,
      ...(response && response.frameId === this.mainFrameId
        ? { status: response.status, headers: response.headers }
        : {}),
    });
  }

  private trackFrameSetup(setup: Promise<void>, sessionId: string): void {
    this.frameSetups.set(setup, sessionId);
    this.pendingFrameSessions.add(sessionId);
    void setup.then(
      () => {
        this.frameSetups.delete(setup);
        this.pendingFrameSessions.delete(sessionId);
      },
      () => {
        this.frameSetups.delete(setup);
        this.pendingFrameSessions.delete(sessionId);
      },
    );
  }

  private rememberFrame(
    frame: {
      id: string;
      parentId?: string | undefined;
      name?: string | undefined;
      url?: string | undefined;
    },
    sessionId: string,
    // A Page.Frame (navigation event or frame tree) carries the frame's current name and URL, so it
    // can also clear an earlier classification; an attach event only has the target URL.
    complete = true,
  ): void {
    const parentId = frame.parentId ?? this.knownFrames.get(frame.id)?.parentId;
    this.knownFrames.set(frame.id, {
      sessionId: this.children.get(frame.id)?.sessionId ?? sessionId,
      ...(parentId ? { parentId } : {}),
    });
    if ((sessionId !== this.session.sessionId || parentId) && frame.id !== this.mainFrameId) {
      if (isAdFrame(frame.name, frame.url)) this.knownAdFrames.add(frame.id);
      else if (complete) this.knownAdFrames.delete(frame.id);
    }
  }

  private isKnownAdFrame(frameId: string, visited = new Set<string>()): boolean {
    if (visited.has(frameId)) return false;
    visited.add(frameId);
    if (this.knownAdFrames.has(frameId)) return true;
    const parentId = this.knownFrames.get(frameId)?.parentId;
    if (parentId && this.isKnownAdFrame(parentId, visited)) return true;
    const parentSessionId = this.children.get(frameId)?.parentSessionId;
    for (const [id, child] of this.children)
      if (child.sessionId === parentSessionId && this.isKnownAdFrame(id, visited)) return true;
    return false;
  }

  private isAdSession(sessionId: string): boolean {
    for (const [id, child] of this.children)
      if (child.sessionId === sessionId) return this.isKnownAdFrame(id);
    return false;
  }

  private forgetFrame(frameId: string): void {
    this.knownAdFrames.delete(frameId);
    this.knownFrames.delete(frameId);
    for (const [id, frame] of this.knownFrames)
      if (frame.parentId === frameId) this.forgetFrame(id);
  }

  private onDialogOpening(value: unknown, sessionId: string): void {
    const event = value as {
      type: PageEvents["dialog"]["kind"];
      message: string;
      defaultPrompt?: string;
      url?: string;
    };
    const dialog: PageEvents["dialog"] = {
      kind: event.type,
      message: event.message,
      defaultPrompt: event.defaultPrompt ?? "",
      ...(event.url ? { url: event.url } : {}),
      ...(sessionId === this.session.sessionId ? {} : { frame: "child" as const }),
    };
    this.emit("dialog", dialog);
    if (dialog.kind === "alert" && this.autoAcceptAlerts) {
      void this.answerDialog(sessionId, true).catch((cause: unknown) => {
        this.pendingDialog = dialog;
        this.pendingDialogSessionId = sessionId;
        for (const reject of this.blockers) reject(new DialogBlockingError(dialog.kind, { cause }));
        this.blockers.clear();
      });
      return;
    }
    this.pendingDialog = dialog;
    this.pendingDialogSessionId = sessionId;
    for (const reject of this.blockers) reject(new DialogBlockingError(dialog.kind));
    this.blockers.clear();
  }

  private detachFrame(sessionId: string): void {
    for (const [id, frame] of this.knownFrames)
      if (frame.sessionId === sessionId) this.forgetFrame(id);
    // A setup of a frame that went away can only end with its CDP timeout; frames() must not wait for it.
    for (const [setup, setupSessionId] of this.frameSetups)
      if (setupSessionId === sessionId) this.frameSetups.delete(setup);
    this.pendingFrameSessions.delete(sessionId);
    // Chrome dismisses a dialog whose frame goes away, and no answer can reach a session that is gone,
    // so a dialog kept for it would block every later call on this page.
    if (this.pendingDialogSessionId === sessionId) {
      this.pendingDialog = undefined;
      this.pendingDialogSessionId = undefined;
    }
    for (const [frameId, child] of this.children) {
      if (child.sessionId === sessionId || child.parentSessionId === sessionId) {
        this.children.delete(frameId);
        child.world.dispose();
        for (const unsubscribe of this.frameSubscriptions.get(child.sessionId) ?? []) unsubscribe();
        this.frameSubscriptions.delete(child.sessionId);
        this.detachFrame(child.sessionId);
      }
    }
  }

  private async attachFrame(
    sessionId: string,
    frameId: string,
    parentSessionId: string,
  ): Promise<void> {
    const world = new IsolatedWorld(this.browser.client, sessionId);
    this.children.set(frameId, { sessionId, parentSessionId, world });
    const attached = this.browser.client.on(
      "Target.attachedToTarget",
      (value) => {
        const event = value as {
          sessionId: string;
          targetInfo: { targetId: string; type: string; url?: string; parentFrameId?: string };
        };
        if (event.targetInfo.type === "iframe") {
          this.rememberFrame(
            {
              id: event.targetInfo.targetId,
              url: event.targetInfo.url,
              parentId: event.targetInfo.parentFrameId,
            },
            event.sessionId,
            false,
          );
          const setup = this.attachFrame(event.sessionId, event.targetInfo.targetId, sessionId);
          this.trackFrameSetup(setup, event.sessionId);
          void setup.catch((cause: unknown) => {
            this.detachFrame(event.sessionId);
            this.emit("error", new BrowserLaunchError("failed to attach iframe", { cause }));
          });
        }
      },
      sessionId,
    );
    const detached = this.browser.client.on(
      "Target.detachedFromTarget",
      (value) => {
        this.detachFrame((value as { sessionId: string }).sessionId);
      },
      sessionId,
    );
    const dialog = this.browser.client.on(
      "Page.javascriptDialogOpening",
      (value) => this.onDialogOpening(value, sessionId),
      sessionId,
    );
    const navigated = this.browser.client.on(
      "Page.frameNavigated",
      (value) =>
        this.rememberFrame(
          (value as { frame: { id: string; parentId?: string; name?: string; url?: string } })
            .frame,
          sessionId,
        ),
      sessionId,
    );
    const frameDetached = this.browser.client.on(
      "Page.frameDetached",
      (value) => this.forgetFrame((value as { frameId: string }).frameId),
      sessionId,
    );
    this.frameSubscriptions.set(sessionId, [attached, detached, dialog, navigated, frameDetached]);
    await this.browser.client.call("Page.enable", {}, sessionId);
    const response = this.browser.client.on(
      "Network.responseReceived",
      (value) => {
        const event = value as {
          type: string;
          frameId: string;
          response: { remoteIPAddress?: string; url?: string };
        };
        if (
          this.checkResponseAddress &&
          event.type === "Document" &&
          event.response.remoteIPAddress &&
          blockedAddress(event.response.remoteIPAddress, this.networkGuard)
        )
          this.blockDocument(
            {
              url: event.response.url ?? "",
              address: event.response.remoteIPAddress,
              frame: "child",
            },
            sessionId,
            event.frameId,
          );
      },
      sessionId,
    );
    this.frameSubscriptions.get(sessionId)?.push(response);
    try {
      await this.enableNetworkGuard(sessionId, "child");
    } catch (cause) {
      this.blockDocument(
        { url: "", address: "network guard unavailable", frame: "child" },
        parentSessionId,
        frameId,
      );
      await this.browser.client.call("Target.closeTarget", { targetId: frameId }).catch(() => {});
      throw cause;
    }
    await this.browser.client.call(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      sessionId,
    );
    await world.callFunction(() => true);
  }

  private ensureUnblocked(): void {
    if (this.pendingDialog) throw new DialogBlockingError(this.pendingDialog.kind);
  }

  private pageCallError(error: unknown): unknown {
    return error instanceof CdpTimeoutError && error.sessionId === this.session.sessionId
      ? new PageUnresponsiveError({ cause: error })
      : error;
  }

  private async whileUnblocked<T>(operation: () => Promise<T>): Promise<T> {
    this.ensureUnblocked();
    let rejectBlocking: (error: DialogBlockingError) => void = () => {};
    const blocked = new Promise<never>((_resolve, reject) => {
      rejectBlocking = reject;
    });
    this.blockers.add(rejectBlocking);
    try {
      return await Promise.race([Promise.resolve().then(operation), blocked]);
    } catch (error) {
      throw this.pageCallError(error);
    } finally {
      this.blockers.delete(rejectBlocking);
    }
  }

  private async runInput(operation: () => Promise<void>): Promise<InputResult> {
    this.ensureUnblocked();
    let resolveDialog: (result: InputResult) => void = () => {};
    const opened = new Promise<InputResult>((resolve) => {
      resolveDialog = resolve;
    });
    const handler = (dialog: PageEvents["dialog"]): void => {
      if (dialog.kind !== "alert" || !this.autoAcceptAlerts) resolveDialog({ dialog });
    };
    this.on("dialog", handler);
    try {
      return await Promise.race([
        this.activateForInput()
          .then(operation)
          .then(() => ({})),
        opened,
      ]);
    } catch (error) {
      throw this.pageCallError(error);
    } finally {
      this.off("dialog", handler);
    }
  }

  navigate(url: string, options: { timeoutMs?: number } = {}) {
    return this.whileUnblocked(() => this.session.navigate(url, options.timeoutMs));
  }
  targetUrl(): Promise<string> {
    return this.session.targetUrl();
  }
  callIsolated<A extends unknown[], R>(
    fn: (...args: A) => R | Promise<R>,
    args: A,
    options: { timeoutMs?: number } = {},
  ): Promise<R> {
    return this.whileUnblocked(() =>
      this.session.world.callFunction<R>(
        fn as unknown as (...args: never[]) => R,
        args,
        options.timeoutMs,
      ),
    );
  }

  async frames(
    options: { timeoutMs?: number; skipAdFrames?: boolean } = {},
  ): Promise<FrameHandle[] & { framesSkipped?: number }> {
    this.ensureUnblocked();
    const hasBudget = options.timeoutMs !== undefined;
    const bounded = async <T>(operation: (timeoutMs?: number) => Promise<T>): Promise<T> => {
      if (options.timeoutMs === undefined) return operation();
      const timeoutMs = Math.max(1, options.timeoutMs);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation(timeoutMs),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new CdpTimeoutError("frames operation timed out")),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const skipped = new Set<string>();
    const frames: FrameHandle[] & { framesSkipped?: number } = [];
    const finish = (): typeof frames => {
      if (hasBudget && skipped.size)
        Object.defineProperty(frames, "framesSkipped", { value: skipped.size });
      return frames;
    };
    const pendingSetups = () =>
      [...this.frameSetups]
        .filter(([, sessionId]) => !options.skipAdFrames || !this.isAdSession(sessionId))
        .map(([setup]) => setup);
    if (options.timeoutMs === undefined) {
      while (pendingSetups().length > 0) await Promise.allSettled(pendingSetups());
    } else if (pendingSetups().length > 0) {
      try {
        await bounded(() => Promise.allSettled(pendingSetups()));
      } catch (error) {
        if (!(error instanceof CdpTimeoutError)) throw error;
      }
    }
    type FrameNode = {
      frame: { id: string; parentId?: string; name?: string; url?: string };
      childFrames?: FrameNode[];
    };
    const trees: { sessionId: string; frameTree: FrameNode }[] = [];
    const roots = new Map<string, string>();
    const parents = new Map<string, string>();
    const visible = new Set<string>();
    const busySessions = new Set<string>();
    const adFrames = new Set<string>();
    const sessions = [
      this.session.sessionId,
      ...[...this.children.entries()]
        .filter(
          ([id, child]) =>
            (!options.skipAdFrames || !this.isKnownAdFrame(id)) &&
            (options.timeoutMs === undefined || !this.pendingFrameSessions.has(child.sessionId)),
        )
        .map(([, child]) => child.sessionId),
    ];
    const queryTree = async (sessionId: string): Promise<void> => {
      let tree;
      try {
        tree = await bounded((timeoutMs) =>
          this.browser.client.call("Page.getFrameTree", undefined, sessionId, timeoutMs),
        );
      } catch (error) {
        if (sessionId === this.session.sessionId && hasBudget && error instanceof CdpTimeoutError) {
          for (const id of [...this.children.keys(), ...this.inProcessFrames.keys()])
            skipped.add(id);
          return;
        }
        if (
          sessionId !== this.session.sessionId &&
          options.timeoutMs !== undefined &&
          error instanceof CdpTimeoutError
        ) {
          busySessions.add(sessionId);
          for (const [id, child] of this.inProcessFrames)
            if (child.sessionId === sessionId) skipped.add(id);
          return;
        }
        if (sessionId !== this.session.sessionId && isGoneChildFrameError(error)) return;
        throw this.pageCallError(error);
      }
      trees.push({ sessionId, frameTree: tree.frameTree });
      roots.set(sessionId, tree.frameTree.frame.id);
      if (tree.frameTree.frame.parentId)
        parents.set(tree.frameTree.frame.id, tree.frameTree.frame.parentId);
      const walk = (node: FrameNode, parentId?: string): void => {
        this.rememberFrame({ ...node.frame, parentId: parentId ?? node.frame.parentId }, sessionId);
        if (parentId) {
          visible.add(node.frame.id);
          parents.set(node.frame.id, parentId);
        }
        for (const child of node.childFrames ?? []) walk(child, node.frame.id);
      };
      walk(tree.frameTree);
    };
    if (!hasBudget) {
      for (const sessionId of sessions) await queryTree(sessionId);
    } else {
      await Promise.all(sessions.map(queryTree));
      if (!roots.has(this.session.sessionId)) return finish();
    }
    if (options.skipAdFrames) {
      const scan = (node: FrameNode): void => {
        if (
          node.frame.id !== roots.get(this.session.sessionId) &&
          this.isKnownAdFrame(node.frame.id)
        )
          adFrames.add(node.frame.id);
        for (const child of node.childFrames ?? []) scan(child);
      };
      for (const { frameTree } of trees) scan(frameTree);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [id, parentId] of parents) {
          if (adFrames.has(parentId) && !adFrames.has(id)) {
            adFrames.add(id);
            changed = true;
          }
        }
      }
      for (const id of adFrames) skipped.delete(id);
    }
    for (const [frameId, entry] of this.inProcessFrames) {
      if (busySessions.has(entry.sessionId)) continue;
      if (
        !visible.has(frameId) ||
        this.children.has(frameId) ||
        !sessions.includes(entry.sessionId)
      ) {
        entry.world.dispose();
        this.inProcessFrames.delete(frameId);
      }
    }
    const setupTasks: Promise<void>[] = [];
    for (const { sessionId, frameTree } of trees) {
      const walk = async (node: FrameNode): Promise<void> => {
        if (adFrames.has(node.frame.id)) return;
        const setupChild = async (child: FrameNode): Promise<void> => {
          const id = child.frame.id;
          if (adFrames.has(id)) return;
          if (!this.children.has(id) && !this.inProcessFrames.has(id)) {
            const world = new IsolatedWorld(this.browser.client, sessionId, "jevpilot", id);
            try {
              await bounded((timeoutMs) => world.callFunction(() => true, [], timeoutMs));
              this.inProcessFrames.set(id, { sessionId, world });
            } catch (cause) {
              world.dispose();
              if (hasBudget && cause instanceof CdpTimeoutError) {
                const markSkipped = (node: FrameNode): void => {
                  if (adFrames.has(node.frame.id)) return;
                  skipped.add(node.frame.id);
                  for (const descendant of node.childFrames ?? []) markSkipped(descendant);
                };
                markSkipped(child);
                return;
              }
              if (!isGoneChildFrameError(cause)) throw this.pageCallError(cause);
            }
          }
          await walk(child);
        };
        if (!hasBudget) {
          for (const child of node.childFrames ?? []) await setupChild(child);
        } else {
          await Promise.all((node.childFrames ?? []).map(setupChild));
        }
      };
      if (!hasBudget) await walk(frameTree);
      else setupTasks.push(walk(frameTree));
    }
    if (hasBudget) await Promise.all(setupTasks);
    const offsets = new Map<string, { x: number; y: number; scaleX?: number; scaleY?: number }>();
    const offsetTasks = new Map<
      string,
      Promise<{ x: number; y: number; scaleX?: number; scaleY?: number }>
    >();
    const offsetFor = async (
      id: string,
    ): Promise<{ x: number; y: number; scaleX?: number; scaleY?: number }> => {
      if (hasBudget) {
        const pending = offsetTasks.get(id);
        if (pending) return pending;
        const task = computeOffset(id);
        offsetTasks.set(id, task);
        return task;
      }
      return computeOffset(id);
    };
    const computeOffset = async (
      id: string,
    ): Promise<{ x: number; y: number; scaleX?: number; scaleY?: number }> => {
      const cached = offsets.get(id);
      if (cached) return cached;
      const child = this.children.get(id) ?? this.inProcessFrames.get(id);
      if (!child) return { x: 0, y: 0 };
      const parentSessionId = this.children.get(id)?.parentSessionId ?? child.sessionId;
      const parentId = parents.get(id) ?? roots.get(parentSessionId);
      const parentOffset = parentId && parentId !== id ? await offsetFor(parentId) : { x: 0, y: 0 };
      const parentWorld =
        (parentId
          ? (this.children.get(parentId)?.world ?? this.inProcessFrames.get(parentId)?.world)
          : undefined) ?? this.session.world;
      const owner = await bounded((timeoutMs) =>
        this.browser.client.call("DOM.getFrameOwner", { frameId: id }, parentSessionId, timeoutMs),
      );
      const contextId = await bounded((timeoutMs) => parentWorld.getContextId(timeoutMs));
      const resolved = await bounded((timeoutMs) =>
        this.browser.client.call(
          "DOM.resolveNode",
          { backendNodeId: owner.backendNodeId, executionContextId: contextId },
          parentSessionId,
          timeoutMs,
        ),
      );
      const objectId = resolved.object.objectId;
      if (!objectId) throw new BrowserLaunchError("iframe owner could not be resolved");
      let local: { x: number; y: number; scaleX?: number; scaleY?: number; valid?: boolean };
      let timedOut = false;
      try {
        const result = await bounded((timeoutMs) =>
          this.browser.client.call(
            "Runtime.callFunctionOn",
            {
              objectId,
              functionDeclaration:
                "function() { const rect = this.getBoundingClientRect(); const transform = getComputedStyle(this).transform; const matrix = transform === 'none' ? null : new DOMMatrixReadOnly(transform); const scaleX = rect.width / this.offsetWidth; const scaleY = rect.height / this.offsetHeight; return { x: rect.x + this.clientLeft * scaleX, y: rect.y + this.clientTop * scaleY, scaleX, scaleY, valid: this.offsetWidth > 0 && this.offsetHeight > 0 && Number.isFinite(scaleX) && Number.isFinite(scaleY) && (!matrix || (matrix.b === 0 && matrix.c === 0 && matrix.a > 0 && matrix.d > 0)) }; }",
              returnByValue: true,
            },
            parentSessionId,
            timeoutMs,
          ),
        );
        if (result.exceptionDetails)
          throw new BrowserLaunchError("iframe owner rect failed", {
            cause: result.exceptionDetails,
          });
        local = result.result.value as { x: number; y: number };
      } catch (error) {
        timedOut = error instanceof CdpTimeoutError;
        throw error;
      } finally {
        if (!timedOut)
          await bounded((timeoutMs) =>
            this.browser.client.call(
              "Runtime.releaseObject",
              { objectId },
              parentSessionId,
              timeoutMs,
            ),
          );
      }
      if (local.valid === false || !Number.isFinite(local.x) || !Number.isFinite(local.y))
        throw new BrowserLaunchError("iframe geometry cannot be mapped");
      const scaleX = (parentOffset.scaleX ?? 1) * (local.scaleX ?? 1);
      const scaleY = (parentOffset.scaleY ?? 1) * (local.scaleY ?? 1);
      const offset = {
        x: parentOffset.x + local.x * (parentOffset.scaleX ?? 1),
        y: parentOffset.y + local.y * (parentOffset.scaleY ?? 1),
        ...(scaleX === 1 ? {} : { scaleX }),
        ...(scaleY === 1 ? {} : { scaleY }),
      };
      offsets.set(id, offset);
      return offset;
    };
    const collect = async (
      id: string,
      child: { sessionId: string; world: IsolatedWorld },
    ): Promise<void> => {
      if (adFrames.has(id) || (options.skipAdFrames && this.isKnownAdFrame(id))) return;
      if (options.timeoutMs !== undefined && this.pendingFrameSessions.has(child.sessionId)) return;
      const ownerSessionId =
        this.children.get(id)?.parentSessionId ?? this.inProcessFrames.get(id)?.sessionId;
      if (ownerSessionId && busySessions.has(ownerSessionId)) return;
      if (skipped.has(id)) return;
      let offset;
      try {
        offset = await offsetFor(id);
      } catch (error) {
        if (hasBudget && error instanceof CdpTimeoutError) {
          skipped.add(id);
          return;
        }
        if (
          isGoneChildFrameError(error) ||
          (error instanceof BrowserLaunchError &&
            error.message === "iframe geometry cannot be mapped")
        )
          return;
        throw this.pageCallError(error);
      }
      frames.push({
        id,
        offset,
        callIsolated: <A extends unknown[], R>(
          fn: (...args: A) => R | Promise<R>,
          args: A,
          options: { timeoutMs?: number } = {},
        ) =>
          this.whileUnblocked(() =>
            child.world.callFunction<R>(
              fn as unknown as (...args: never[]) => R,
              args,
              options.timeoutMs,
            ),
          ).catch((error: unknown) => {
            if (isGoneChildFrameError(error)) throw new FrameGoneError({ cause: error });
            throw error;
          }),
      });
    };
    const entries = [...this.children, ...this.inProcessFrames];
    if (!hasBudget) {
      for (const [id, child] of entries) await collect(id, child);
    } else {
      await Promise.all(entries.map(([id, child]) => collect(id, child)));
      const order = new Map(entries.map(([id], index) => [id, index]));
      frames.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    }
    return finish();
  }

  async handleDialog(accept: boolean, promptText?: string): Promise<void> {
    try {
      await this.answerDialog(
        this.pendingDialogSessionId ?? this.session.sessionId,
        accept,
        promptText,
      );
    } catch (error) {
      throw this.pageCallError(error);
    }
  }

  private async answerDialog(
    sessionId: string,
    accept: boolean,
    promptText?: string,
  ): Promise<void> {
    await this.browser.client.call(
      "Page.handleJavaScriptDialog",
      { accept, ...(promptText === undefined ? {} : { promptText }) },
      sessionId,
    );
    if (this.pendingDialogSessionId === sessionId) {
      this.pendingDialog = undefined;
      this.pendingDialogSessionId = undefined;
    }
  }

  waitForDownload(
    predicate: (event: PageEvents["download"]) => boolean = (event) => event.state === "completed",
    timeoutMs = 10000,
  ): Promise<PageEvents["download"]> {
    if (!this.capabilities.downloads)
      return Promise.reject(
        new BrowserConfigError("downloads are not managed by this engine handle"),
      );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("download", handler);
        reject(new CdpTimeoutError("download timed out"));
      }, timeoutMs);
      const handler = (event: PageEvents["download"]) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        this.off("download", handler);
        resolve(event);
      };
      this.on("download", handler);
    });
  }

  async setInputFiles<A extends unknown[]>(
    find: (...args: A) => Element | null,
    args: A,
    files: string[],
  ): Promise<void> {
    this.ensureUnblocked();
    await Promise.all(
      files.map(async (file) => {
        try {
          if (!(await stat(file)).isFile()) throw new Error("not a regular file");
        } catch (cause) {
          throw new BrowserConfigError(`invalid upload file: ${file}`, { cause });
        }
      }),
    );
    try {
      const objectId = await this.session.world.callForObject(
        find as (...args: never[]) => unknown,
        args,
      );
      let timedOut = false;
      try {
        const node = await this.browser.client.call(
          "DOM.describeNode",
          { objectId },
          this.session.sessionId,
        );
        if (
          node.node.nodeName.toLowerCase() !== "input" ||
          !node.node.attributes?.some(
            (value, index, all) => index % 2 === 0 && value === "type" && all[index + 1] === "file",
          )
        ) {
          throw new BrowserConfigError("find must return an input[type=file]");
        }
        await this.browser.client.call(
          "DOM.setFileInputFiles",
          { files, backendNodeId: node.node.backendNodeId },
          this.session.sessionId,
        );
      } catch (error) {
        timedOut = error instanceof CdpTimeoutError;
        throw error;
      } finally {
        const cleanup = this.browser.client.call(
          "Runtime.releaseObject",
          { objectId },
          this.session.sessionId,
        );
        if (timedOut) void cleanup.catch(() => {});
        else await cleanup;
      }
    } catch (error) {
      throw this.pageCallError(error);
    }
  }

  click(x: number, y: number): Promise<InputResult> {
    return this.runInput(() => click(this.browser.client, this.session.sessionId, x, y));
  }
  hover(x: number, y: number): Promise<InputResult> {
    return this.runInput(() => hover(this.browser.client, this.session.sessionId, x, y));
  }
  drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<InputResult> {
    return this.runInput(() => drag(this.browser.client, this.session.sessionId, from, to));
  }
  wheel(x: number, y: number, deltaY: number): Promise<InputResult> {
    return this.runInput(async () => {
      await this.browser.client.call(
        "Input.dispatchMouseEvent",
        { type: "mouseWheel", x, y, deltaX: 0, deltaY },
        this.session.sessionId,
      );
    });
  }
  back(): Promise<InputResult> {
    return this.runInput(async () => {
      const history = await this.browser.client.call(
        "Page.getNavigationHistory",
        undefined,
        this.session.sessionId,
      );
      const previous = history.entries[history.currentIndex - 1];
      if (previous)
        await this.browser.client.call(
          "Page.navigateToHistoryEntry",
          { entryId: previous.id },
          this.session.sessionId,
        );
    });
  }
  insertText(text: string): Promise<InputResult> {
    return this.runInput(() => insertText(this.browser.client, this.session.sessionId, text));
  }
  tapShift(): Promise<InputResult> {
    return this.runInput(() => tapShift(this.browser.client, this.session.sessionId));
  }
  key(name: string): Promise<InputResult> {
    return this.runInput(() => keyPress(this.browser.client, this.session.sessionId, name));
  }
  selectAll(): Promise<InputResult> {
    return this.runInput(() => selectAll(this.browser.client, this.session.sessionId));
  }
  focusedSubmitTarget(
    epoch: number,
    ref: string,
    formId: string | undefined,
    searchbox: boolean,
  ): Promise<boolean> {
    return this.callIsolated(focusedSubmitTargetInPage, [epoch, ref, formId, searchbox]);
  }
  async screenshot(options: { quality?: number } = {}): Promise<Uint8Array> {
    this.ensureUnblocked();
    return screenshot(this.browser.client, this.session.sessionId, options.quality);
  }
  async capture(captureOptions: CaptureOptions = {}): Promise<Capture> {
    return this.whileUnblocked(async () => {
      const timeoutMs = captureOptions.timeoutMs ?? 5000;
      let metrics;
      try {
        metrics = await this.browser.client.call(
          "Page.getLayoutMetrics",
          undefined,
          this.session.sessionId,
          timeoutMs,
        );
      } catch (error) {
        throw this.pageCallError(error);
      }
      const css = metrics.cssVisualViewport;
      const dpr =
        metrics.visualViewport.clientWidth > 0 && css.clientWidth > 0
          ? metrics.visualViewport.clientWidth / css.clientWidth
          : 1;
      const scale = Number.isFinite(dpr) && dpr > 0 ? 1 / dpr : 1;
      let region: { x: number; y: number; width: number; height: number };
      if (captureOptions.clip) {
        const left = Math.max(captureOptions.clip.x, 0);
        const top = Math.max(captureOptions.clip.y, 0);
        const right = Math.min(captureOptions.clip.x + captureOptions.clip.width, css.clientWidth);
        const bottom = Math.min(
          captureOptions.clip.y + captureOptions.clip.height,
          css.clientHeight,
        );
        const width = right - left;
        const height = bottom - top;
        if (width <= 0 || height <= 0) throw new EmptyCaptureError();
        region = { x: left, y: top, width, height };
      } else {
        if (css.clientWidth <= 0 || css.clientHeight <= 0) throw new EmptyCaptureError();
        region = { x: 0, y: 0, width: css.clientWidth, height: css.clientHeight };
      }
      let data: Uint8Array;
      try {
        data = await captureScreenshot(this.browser.client, this.session.sessionId, {
          ...(captureOptions.quality !== undefined ? { quality: captureOptions.quality } : {}),
          clip: {
            x: css.pageX + region.x,
            y: css.pageY + region.y,
            width: region.width,
            height: region.height,
            scale,
          },
          timeoutMs,
        });
      } catch (error) {
        if (error instanceof EmptyCaptureError) throw error;
        throw this.pageCallError(error);
      }
      return {
        data,
        mimeType: "image/jpeg",
        width: Math.round(region.width),
        height: Math.round(region.height),
      };
    });
  }
  on<K extends keyof PageEvents>(event: K, handler: (value: PageEvents[K]) => void): void {
    const handlers = this.listeners.get(event) ?? new Set<(value: never) => void>();
    handlers.add(handler as (value: never) => void);
    this.listeners.set(event, handlers);
  }
  off<K extends keyof PageEvents>(event: K, handler: (value: PageEvents[K]) => void): void {
    this.listeners.get(event)?.delete(handler as (value: never) => void);
  }
  ownsFrame(frameId: string): boolean {
    return (
      frameId === this.mainFrameId ||
      frameId === this.id ||
      this.children.has(frameId) ||
      this.inProcessFrames.has(frameId)
    );
  }
  notifyDownload(value: PageEvents["download"]): void {
    this.emit("download", value);
  }
  notifyPopup(popup: PageHandle): void {
    this.emit("popup", popup);
  }
  notifyPopupOpening(targetId: string): void {
    this.emit("popupOpening", { targetId });
  }
  notifyError(error: Error): void {
    this.emit("error", error);
  }
  async close(): Promise<void> {
    if (this.pendingNavigation) clearTimeout(this.pendingNavigation.timer);
    this.pendingNavigation = undefined;
    this.documentResponses.clear();
    for (const unsubscribe of this.subscriptions) unsubscribe();
    for (const subscriptions of this.frameSubscriptions.values())
      for (const unsubscribe of subscriptions) unsubscribe();
    this.frameSubscriptions.clear();
    for (const child of this.children.values()) child.world.dispose();
    this.children.clear();
    for (const frame of this.inProcessFrames.values()) frame.world.dispose();
    this.inProcessFrames.clear();
    this.knownAdFrames.clear();
    this.knownFrames.clear();
    try {
      await this.session.close();
    } finally {
      await this.onClose();
    }
  }
}

export class ActivePageInput {
  private activePageId: string | undefined;
  private readonly client: BrowserInstance["client"];
  constructor(client: BrowserInstance["client"]) {
    this.client = client;
  }

  markActive(pageId: string): void {
    this.activePageId = pageId;
  }

  async activate(pageId: string): Promise<void> {
    if (this.activePageId === pageId) return;
    await this.client.call("Target.activateTarget", { targetId: pageId });
    this.activePageId = pageId;
  }
}

export function createCdpDriver(deps: LaunchDeps & { lookup?: AddressLookup } = {}): EngineDriver {
  return {
    kind: "cdp",
    async launch(value: unknown, options: LaunchOptions = {}): Promise<BrowserHandle> {
      const profile = parseCdpProfile(value);
      const networkGuard = options.networkGuard ?? { mode: "metadata", extraBlocked: [] };
      // A proxy's remoteIPAddress is its own address, so only pre-request DNS checks apply.
      const checkResponseAddress =
        profile.kind === "attach" ||
        (!profile.extraArgs?.some(
          (arg) => arg.startsWith("--proxy-server") || arg.startsWith("--proxy-pac-url"),
        ) &&
          !profile.proxy);
      // The guard must resolve hosts the way this browser does: mirror any
      // --host-resolver-rules MAP entries unless a caller supplied its own lookup.
      const effectiveLookup =
        deps.lookup ??
        lookupWithResolverRules(profile.kind === "attach" ? undefined : profile.extraArgs);
      const rejected = async (url: string): Promise<string | undefined> => {
        const verdict = await checkUrl(url, networkGuard, effectiveLookup);
        return (
          verdict.blocked ??
          (verdict.unverified && networkGuard.mode === "private" && checkResponseAddress
            ? "unverified"
            : undefined)
        );
      };
      const browser = await launchBrowser(profile, options, deps);
      const capabilities = {
        ...cdpCapabilities,
        isolatedContexts: profile.kind !== "attach",
        downloads: browser.downloadPath !== undefined,
      };
      const stealthLevel: StealthLevel =
        profile.kind === "attach"
          ? "medium"
          : profile.kind === "server-plain"
            ? "low"
            : profile.display !== "headed"
              ? browser.selfCheck?.stealth === "medium"
                ? "medium"
                : "low"
              : browser.selfCheck?.ok
                ? "high"
                : "degraded";
      const pages = new Map<string, CdpPageHandle>();
      const contexts = new Map<string, string>();
      const activePages = new ActivePageInput(browser.client);
      const register = (
        session: BrowserSession,
        contextId?: string,
        contextOwner = false,
      ): CdpPageHandle => {
        activePages.markActive(session.targetId);
        const page = new CdpPageHandle(
          browser,
          session,
          options.autoAcceptAlerts !== false,
          capabilities,
          () => activePages.activate(session.targetId),
          async () => {
            pages.delete(session.targetId);
            if (!contextId) return;
            contexts.delete(session.targetId);
            if (!contextOwner) return;
            for (const [targetId, popupContext] of [...contexts]) {
              if (popupContext !== contextId || targetId === session.targetId) continue;
              await pages
                .get(targetId)
                ?.close()
                .catch(() => {});
              contexts.delete(targetId);
            }
            await browser.disposeContext(contextId);
          },
          networkGuard,
          effectiveLookup,
          checkResponseAddress,
        );
        pages.set(page.id, page);
        if (contextId) contexts.set(page.id, contextId);
        return page;
      };
      const attachingPopups = new Set<string>();
      browser.client.on("Target.targetCreated", (value) => {
        const event = value as {
          targetInfo: { targetId: string; type: string; openerId?: string; url?: string };
        };
        const target = event.targetInfo;
        if (
          target.type !== "page" ||
          !target.openerId ||
          pages.has(target.targetId) ||
          attachingPopups.has(target.targetId)
        )
          return;
        const opener = pages.get(target.openerId);
        if (!opener || ![...browser.sessions].some((session) => session.targetId === opener.id))
          return;
        // Announce first (M6x): the executor only waits for popups it heard about during the action.
        // A blocked popup then just ends that wait as "pending".
        opener.notifyPopupOpening(target.targetId);
        attachingPopups.add(target.targetId);
        void (async () => {
          let popupSession: BrowserSession | undefined;
          let popupPage: CdpPageHandle | undefined;
          try {
            const initialBlocked = await rejected(target.url ?? "");
            if (initialBlocked) {
              await browser.client.call("Target.closeTarget", { targetId: target.targetId });
              return;
            }
            if (contexts.has(opener.id)) await browser.placeOffScreen(target.targetId);
            const sessionId = await browser.client.attach(target.targetId);
            popupSession = await browser.attachPage(target.targetId, sessionId);
            const page = register(popupSession, contexts.get(opener.id));
            popupPage = page;
            await page.enableNetworkGuard();
            const currentUrl = await popupSession.targetUrl().catch(() => "");
            if (page.blockedRequest() || (await rejected(currentUrl))) {
              await page.close();
              return;
            }
            await popupSession.world.callFunction(() => true);
            if (page.blockedRequest()) {
              await page.close();
              return;
            }
            opener.notifyPopup(page);
          } catch (cause) {
            if (popupPage) await popupPage.close().catch(() => {});
            else if (popupSession) await popupSession.close().catch(() => {});
            else
              await browser.client
                .call("Target.closeTarget", { targetId: target.targetId })
                .catch(() => {});
            throw cause;
          }
        })()
          .catch((cause: unknown) =>
            opener.notifyError(new BrowserLaunchError("failed to attach popup", { cause })),
          )
          .finally(() => attachingPopups.delete(target.targetId));
      });
      await browser.client.call("Target.setDiscoverTargets", { discover: true });
      if (browser.attached) browser.targetDiscoveryEnabled = true;
      const pendingDownloadProgress = new Map<
        string,
        { state: "completed" | "canceled"; filePath?: string }
      >();
      const downloads = new Map<
        string,
        { page: CdpPageHandle; url: string; suggestedFilename: string }
      >();
      browser.client.on("Browser.downloadWillBegin", (value) => {
        if (!capabilities.downloads) return;
        const event = value as {
          guid: string;
          frameId: string;
          url: string;
          suggestedFilename: string;
        };
        const page = [...pages.values()].find((candidate) => candidate.ownsFrame(event.frameId));
        if (!page) return;
        const browserContextId = contexts.get(page.id);
        void (async () => {
          if (await rejected(event.url)) {
            await browser.client
              .call("Browser.cancelDownload", {
                guid: event.guid,
                ...(browserContextId ? { browserContextId } : {}),
              })
              .catch(() => {});
            return;
          }
          downloads.set(event.guid, {
            page,
            url: event.url,
            suggestedFilename: event.suggestedFilename,
          });
          page.notifyDownload({
            id: event.guid,
            url: event.url,
            suggestedFilename: event.suggestedFilename,
            state: "started",
          });
          const progress = pendingDownloadProgress.get(event.guid);
          if (progress) {
            pendingDownloadProgress.delete(event.guid);
            page.notifyDownload({
              id: event.guid,
              url: event.url,
              suggestedFilename: event.suggestedFilename,
              state: progress.state,
              ...(progress.state === "completed"
                ? { path: progress.filePath ?? join(browser.downloadPath ?? "", event.guid) }
                : {}),
            });
            downloads.delete(event.guid);
          }
        })().catch((cause: unknown) =>
          page.notifyError(new BrowserLaunchError("failed to check download", { cause })),
        );
      });
      browser.client.on("Browser.downloadProgress", (value) => {
        const event = value as {
          guid: string;
          state: "inProgress" | "completed" | "canceled";
          filePath?: string;
        };
        const download = downloads.get(event.guid);
        if (event.state === "inProgress") return;
        if (!download) {
          if (pendingDownloadProgress.size >= 128 && !pendingDownloadProgress.has(event.guid))
            pendingDownloadProgress.delete(pendingDownloadProgress.keys().next().value!);
          pendingDownloadProgress.set(event.guid, {
            state: event.state,
            ...(event.filePath ? { filePath: event.filePath } : {}),
          });
          return;
        }
        download.page.notifyDownload({
          id: event.guid,
          url: download.url,
          suggestedFilename: download.suggestedFilename,
          state: event.state,
          ...(event.state === "completed"
            ? { path: event.filePath ?? join(browser.downloadPath ?? "", event.guid) }
            : {}),
        });
        downloads.delete(event.guid);
      });
      return {
        engine: { name: "cdp", driver: "cdp", stealthLevel },
        capabilities,
        selfCheck: browser.selfCheck,
        get connected() {
          return browser.connected;
        },
        onDisconnected: (listener) => browser.onDisconnected(listener),
        newPage: async (pageOptions) => {
          const session = await browser.newPage(pageOptions);
          const page = register(
            session,
            session.browserContextId,
            Boolean(session.browserContextId),
          );
          try {
            await page.enableNetworkGuard();
            return page;
          } catch (cause) {
            await page.close().catch(() => {});
            throw cause;
          }
        },
        pages: () => {
          const targets = new Set([...browser.sessions].map((session) => session.targetId));
          for (const targetId of pages.keys()) {
            if (targets.has(targetId)) continue;
            pages.delete(targetId);
            contexts.delete(targetId);
          }
          return [...pages.values()];
        },
        close: () => browser.close(),
      };
    },
  };
}
