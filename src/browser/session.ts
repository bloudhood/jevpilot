import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js";
import { CdpClient } from "./cdp/client.ts";
import { CdpTimeoutError } from "./errors.ts";
import { IsolatedWorld } from "./isolated-world.ts";
import { sanitizeResponseHeaders } from "./response-headers.ts";

export type NavigationResult = {
  url: string;
  status?: number;
  headers: Record<string, string | undefined>;
  failure?: string;
};

export class BrowserSession {
  private readonly client: CdpClient;
  readonly targetId: string;
  readonly sessionId: string;
  readonly browserContextId: string | undefined;
  private readonly onClose: () => void;
  readonly world: IsolatedWorld;
  private closed = false;
  private constructor(
    client: CdpClient,
    targetId: string,
    sessionId: string,
    onClose: () => void,
    browserContextId?: string,
  ) {
    this.client = client;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.browserContextId = browserContextId;
    this.onClose = onClose;
    this.world = new IsolatedWorld(client, sessionId);
  }
  static async create(
    client: CdpClient,
    onClose: () => void,
    browserContextId?: string,
    windowSize?: { width: number; height: number },
    windowPosition: { left: number; top: number } = { left: -3000, top: -3000 },
  ): Promise<BrowserSession> {
    const target = await client.call("Target.createTarget", {
      url: "about:blank",
      ...(browserContextId ? { browserContextId } : {}),
      ...(browserContextId && windowSize
        ? { ...windowPosition, width: windowSize.width, height: windowSize.height }
        : {}),
    });
    const sessionId = await client.attach(target.targetId);
    return BrowserSession.attached(client, target.targetId, sessionId, onClose, browserContextId);
  }
  static async attached(
    client: CdpClient,
    targetId: string,
    sessionId: string,
    onClose: () => void,
    browserContextId?: string,
  ): Promise<BrowserSession> {
    await client.call("Page.enable", {}, sessionId);
    await client.call("Network.enable", {}, sessionId);
    await client.call("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId);
    await client.call(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      sessionId,
    );
    return new BrowserSession(client, targetId, sessionId, onClose, browserContextId);
  }
  async navigate(url: string, timeoutMs = 10000): Promise<NavigationResult> {
    const tree = await this.client
      .call("Page.getFrameTree", undefined, this.sessionId, Math.min(timeoutMs, 2000))
      .catch((error: unknown) => {
        if (error instanceof CdpTimeoutError) return undefined;
        throw error;
      });
    const frameId = tree?.frameTree.frame.id;
    let response: ProtocolMapping.Events["Network.responseReceived"][0] | undefined;
    const offResponse = this.client.on(
      "Network.responseReceived",
      (event) => {
        const received = event as ProtocolMapping.Events["Network.responseReceived"][0];
        if (received.type === "Document" && (!frameId || received.frameId === frameId))
          response = received;
      },
      this.sessionId,
    );
    const lifecycle = this.client
      .waitForEvent(
        "Page.lifecycleEvent",
        (event) => event.name === "DOMContentLoaded" && (!frameId || event.frameId === frameId),
        timeoutMs,
        this.sessionId,
      )
      .then(
        () => true,
        (error: unknown) => {
          if (error instanceof CdpTimeoutError) return false;
          throw error;
        },
      );
    try {
      const [loaded, navigation] = await Promise.all([
        lifecycle,
        this.client.call("Page.navigate", { url }, this.sessionId, timeoutMs).then(
          (result) => ({ failure: result.errorText ? "navigation_error" : undefined }),
          (error: unknown) => {
            if (error instanceof CdpTimeoutError) return { failure: "timeout" };
            throw error;
          },
        ),
      ]);
      const interactive =
        !loaded && navigation.failure !== "timeout"
          ? await this.world
              .evaluate<boolean>(
                "document.readyState === 'interactive' || document.readyState === 'complete' || document.body?.children.length > 0",
                1000,
              )
              .then(
                (state) => Boolean(state),
                () => false,
              )
          : false;
      return {
        url: response?.response.url ?? url,
        ...(response ? { status: response.response.status } : {}),
        headers: response ? sanitizeResponseHeaders(response.response.headers) : {},
        ...((navigation.failure && !(navigation.failure === "timeout" && interactive)) ||
        (!loaded && !interactive)
          ? { failure: navigation.failure ?? "timeout" }
          : {}),
      };
    } finally {
      offResponse();
    }
  }
  async targetUrl(): Promise<string> {
    const info = await this.client.call("Target.getTargetInfo", { targetId: this.targetId });
    return info.targetInfo.url;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.call("Target.closeTarget", { targetId: this.targetId });
    } finally {
      this.world.dispose();
      this.onClose();
    }
  }
}
