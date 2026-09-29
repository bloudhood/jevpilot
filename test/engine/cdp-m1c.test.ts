import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BrowserConfigError, DialogBlockingError } from "../../src/browser/errors.ts";
import { createCdpDriver } from "../../src/engine/cdp/driver.ts";
import { FrameGoneError, type PageEvents } from "../../src/engine/types.ts";
import { fakeCdp, type Message, type Send } from "../browser/fake-cdp.ts";
import { parseNetworkGuard } from "../../src/mcp/network-guard.ts";
import {
  blockedUrl,
  type AddressLookup,
  type NetworkGuard,
} from "../../src/security/address-guard.ts";

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("fake CDP event timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("CDP profile validation reports all zod issues", async () => {
  await assert.rejects(
    createCdpDriver().launch({
      kind: "desktop-chrome",
      userDataDir: "",
      windowSize: { width: 0, height: -1 },
      extraArgs: [1],
    }),
    (error: unknown) =>
      error instanceof BrowserConfigError &&
      error.problems.length === 4 &&
      error.cause !== undefined,
  );
  await assert.rejects(
    createCdpDriver().launch({ kind: "attach", cdpUrl: "file:///tmp/socket" }),
    (error: unknown) =>
      error instanceof BrowserConfigError &&
      error.problems.some((problem) => problem.includes("cdpUrl")),
  );
});

async function fixture(
  options: {
    autoAcceptAlerts?: boolean;
    inProcessFrames?: boolean;
    blockedClick?: boolean;
    blockedIsolated?: boolean;
    manageDownloads?: boolean;
    vanishOffset?: boolean;
    childFrameTree?: (message: Message, send: Send) => boolean;
    childSetup?: (message: Message, send: Send) => boolean;
    frameCall?: (message: Message, send: Send) => boolean;
    flatInProcessFrames?: boolean;
    networkGuard?: NetworkGuard;
    lookup?: AddressLookup;
  } = {},
) {
  const sent: Message[] = [];
  let sendEvent: Send = () => {};
  let heldMouseId: unknown;
  let heldIsolatedId: unknown;
  let childGone = false;
  const fake = await fakeCdp((message, send) => {
    sent.push(message);
    sendEvent = send;
    const method = String(message.method);
    if (childGone && message.sessionId === "child" && method === "Runtime.callFunctionOn") {
      send({
        id: message.id,
        error: { code: -32001, message: "Session with given id not found." },
      });
      return;
    }
    if (
      options.blockedClick &&
      method === "Input.dispatchMouseEvent" &&
      (message.params as { type?: string }).type === "mouseReleased"
    ) {
      heldMouseId = message.id;
      send({
        method: "Page.javascriptDialogOpening",
        sessionId: "s1",
        params: { type: "confirm", message: "from click", defaultPrompt: "" },
      });
      return;
    }
    if (
      options.blockedIsolated &&
      method === "Runtime.callFunctionOn" &&
      (message.params as { functionDeclaration: string }).functionDeclaration.includes("openDialog")
    ) {
      heldIsolatedId = message.id;
      send({
        method: "Page.javascriptDialogOpening",
        sessionId: "s1",
        params: { type: "confirm", message: "from isolated", defaultPrompt: "" },
      });
      return;
    }
    if (method === "Page.handleJavaScriptDialog" && heldMouseId !== undefined) {
      send({ id: heldMouseId, result: {} });
      heldMouseId = undefined;
    }
    if (method === "Page.handleJavaScriptDialog" && heldIsolatedId !== undefined) {
      send({ id: heldIsolatedId, result: { result: { value: true } } });
      heldIsolatedId = undefined;
    }
    if (options.vanishOffset && method === "DOM.resolveNode") {
      send({ id: message.id, error: { code: -32000, message: "Could not find node" } });
      return;
    }
    if (message.sessionId === "child" && options.childSetup?.(message, send)) return;
    if (options.frameCall?.(message, send)) return;
    if (
      method === "Page.getFrameTree" &&
      message.sessionId === "child" &&
      options.childFrameTree?.(message, send)
    )
      return;
    const result: Record<string, unknown> =
      method === "Target.createTarget"
        ? { targetId: "page" }
        : method === "Target.attachToTarget"
          ? {
              sessionId:
                (message.params as { targetId: string }).targetId === "page" ? "s1" : "popup",
            }
          : method === "Page.getFrameTree"
            ? {
                frameTree: {
                  frame: {
                    id:
                      message.sessionId === "child"
                        ? "child-frame"
                        : message.sessionId === "nested"
                          ? "nested-frame"
                          : "main",
                  },
                  ...(options.inProcessFrames && message.sessionId === "s1"
                    ? {
                        childFrames: [
                          {
                            frame: { id: "frame-one" },
                            ...(options.flatInProcessFrames
                              ? {}
                              : { childFrames: [{ frame: { id: "frame-two" } }] }),
                          },
                          ...(options.flatInProcessFrames ? [{ frame: { id: "frame-two" } }] : []),
                        ],
                      }
                    : {}),
                },
              }
            : method === "Page.createIsolatedWorld"
              ? {
                  executionContextId:
                    (message.params as { frameId: string }).frameId === "frame-two"
                      ? 32
                      : (message.params as { frameId: string }).frameId === "frame-one"
                        ? 31
                        : message.sessionId === "child"
                          ? 22
                          : 11,
                }
              : method === "Runtime.callFunctionOn"
                ? {
                    result: {
                      objectId: "object-1",
                      value: (
                        message.params as { functionDeclaration: string }
                      ).functionDeclaration.includes("getBoundingClientRect")
                        ? { x: 12, y: 24 }
                        : true,
                    },
                  }
                : method === "DOM.describeNode"
                  ? { node: { nodeName: "INPUT", backendNodeId: 7, attributes: ["type", "file"] } }
                  : method === "DOM.getFrameOwner"
                    ? { backendNodeId: 8 }
                    : method === "DOM.resolveNode"
                      ? { object: { objectId: "iframe-object" } }
                      : {};
    send({ id: message.id, result });
  });
  const driver = createCdpDriver({
    cdpOptions: { websocketFactory: () => new WebSocket(fake.url) },
    ...(options.lookup ? { lookup: options.lookup } : {}),
  });
  const browser = await driver.launch(
    { kind: "attach", cdpUrl: fake.url },
    {
      selfCheck: false,
      ...(options.networkGuard ? { networkGuard: options.networkGuard } : {}),
      ...(options.autoAcceptAlerts === undefined
        ? {}
        : { autoAcceptAlerts: options.autoAcceptAlerts }),
      ...(options.manageDownloads === undefined
        ? {}
        : { manageDownloads: options.manageDownloads }),
    },
  );
  const page = await browser.newPage();
  return {
    sent,
    event: (method: string, params: unknown, sessionId?: string) =>
      sendEvent({ method, params, ...(sessionId ? { sessionId } : {}) }),
    browser,
    page,
    goneChild: () => {
      childGone = true;
    },
    close: async () => {
      await browser.close();
      await fake.close();
    },
  };
}

test("O3: a paused document request is failed when its host resolves to a blocked address and continued otherwise", async () => {
  const guard = parseNetworkGuard("metadata");
  const lookup: AddressLookup = async (host) => {
    if (host === "error.test") throw new Error("lookup failed");
    if (host === "slow.test") return new Promise(() => {});
    return host === "metadata.test"
      ? [{ address: "169.254.1.1", family: 4 }]
      : [{ address: "127.0.0.1", family: 4 }];
  };
  assert.equal(await blockedUrl("http://metadata.test/", guard, lookup), "169.254.1.1");
  assert.equal(await blockedUrl("http://safe.test/", guard, lookup), undefined);
  assert.equal(await blockedUrl("http://error.test/", guard, lookup), undefined);
  const slowStarted = Date.now();
  assert.equal(await blockedUrl("http://slow.test/", guard, lookup), undefined);
  assert.ok(Date.now() - slowStarted < 3000, "a hanging lookup continues after its bound");

  const host = await fixture({ networkGuard: guard, lookup });
  try {
    const blocks: PageEvents["requestBlocked"][] = [];
    host.page.on("requestBlocked", (event) => blocks.push(event));
    // Fetch.enable is not awaited by newPage; wait until the fake browser has received it.
    await waitUntil(() =>
      host.sent.some(
        (message) =>
          message.method === "Fetch.enable" &&
          message.sessionId === "s1" &&
          JSON.stringify(message.params).includes('"resourceType":"Document"'),
      ),
    );
    const urls: Record<string, string> = {
      r1: "http://metadata.test/",
      r2: "http://safe.test/",
      r3: "http://error.test/",
      r4: "http://169.254.169.254/latest/",
    };
    for (const [requestId, url] of Object.entries(urls))
      host.event(
        "Fetch.requestPaused",
        { requestId, frameId: "main", resourceType: "Document", request: { url } },
        "s1",
      );
    const answered = () =>
      host.sent.filter(
        (message) =>
          message.method === "Fetch.failRequest" || message.method === "Fetch.continueRequest",
      );
    await waitUntil(() => answered().length >= 4);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(answered().length, 4, "each paused request is answered exactly once");
    const byRequest = new Map(
      answered().map((message) => [(message.params as { requestId: string }).requestId, message]),
    );
    assert.deepEqual(byRequest.get("r1")?.params, {
      requestId: "r1",
      errorReason: "BlockedByClient",
    });
    assert.equal(byRequest.get("r2")?.method, "Fetch.continueRequest");
    assert.equal(byRequest.get("r3")?.method, "Fetch.continueRequest");
    assert.equal(byRequest.get("r4")?.method, "Fetch.failRequest");
    // After the main document commits, an iframe request paused on the page's session is a child block.
    host.event(
      "Page.frameNavigated",
      { frame: { id: "main", loaderId: "l1", url: "http://safe.test/" } },
      "s1",
    );
    host.event(
      "Fetch.requestPaused",
      {
        requestId: "r5",
        frameId: "sub-frame",
        resourceType: "Document",
        request: { url: "http://169.254.169.254/frame" },
      },
      "s1",
    );
    await waitUntil(() => blocks.length === 3);
    assert.deepEqual(blocks.map((block) => `${block.frame} ${block.address} ${block.url}`).sort(), [
      "child 169.254.169.254 http://169.254.169.254/frame",
      "main 169.254.1.1 http://metadata.test/",
      "main 169.254.169.254 http://169.254.169.254/latest/",
    ]);
  } finally {
    await host.close();
  }
});

test("main document metadata matches loader ID in either event order", async () => {
  const host = await fixture();
  try {
    const navigations: PageEvents["navigated"][] = [];
    host.page.on("navigated", (event) => navigations.push(event));
    const response = (loaderId: string, status: number) =>
      host.event(
        "Network.responseReceived",
        {
          type: "Document",
          frameId: "main",
          loaderId,
          response: {
            status,
            headers: {
              "X-Amzn-Waf-Action": "captcha",
              "Set-Cookie": "secret",
              Authorization: "secret",
            },
          },
        },
        "s1",
      );
    host.event(
      "Page.frameNavigated",
      { frame: { id: "main", loaderId: "first", url: "http://test/first" } },
      "s1",
    );
    response("first", 405);
    await waitUntil(() => navigations.length === 1);
    assert.deepEqual(navigations[0], {
      url: "http://test/first",
      status: 405,
      headers: { "x-amzn-waf-action": "captcha" },
    });
    response("second", 404);
    host.event(
      "Page.frameNavigated",
      { frame: { id: "main", loaderId: "second", url: "http://test/second" } },
      "s1",
    );
    await waitUntil(() => navigations.length === 2);
    assert.equal(navigations[1]?.status, 404);
    assert.equal(
      host.sent.some((message) => message.method === "Runtime.enable"),
      false,
    );
    assert.equal(
      host.sent.some((message) => message.method === "Console.enable"),
      false,
    );
  } finally {
    await host.close();
  }
});

test("pushState emits navigation without response metadata", async () => {
  const host = await fixture();
  try {
    const navigations: PageEvents["navigated"][] = [];
    host.page.on("navigated", (event) => navigations.push(event));
    host.event("Page.frameNavigated", { frame: { id: "main", url: "http://test/" } }, "s1");
    await waitUntil(() => navigations.length === 1);
    host.event("Page.navigatedWithinDocument", { frameId: "main", url: "http://test/#next" }, "s1");
    await waitUntil(() => navigations.length === 2);
    assert.deepEqual(navigations[1], { url: "http://test/#next", sameDocument: true });
  } finally {
    await host.close();
  }
});

test("redirect chain reports final document response", async () => {
  const host = await fixture();
  try {
    const navigations: PageEvents["navigated"][] = [];
    host.page.on("navigated", (event) => navigations.push(event));
    host.event(
      "Network.requestWillBeSent",
      { loaderId: "redirect", redirectResponse: { status: 302 } },
      "s1",
    );
    host.event(
      "Network.responseReceived",
      {
        type: "Document",
        frameId: "main",
        loaderId: "redirect",
        response: { status: 200, headers: { "Content-Type": "text/html" } },
      },
      "s1",
    );
    host.event(
      "Page.frameNavigated",
      { frame: { id: "main", loaderId: "redirect", url: "http://test/final" } },
      "s1",
    );
    await waitUntil(() => navigations.length === 1);
    assert.deepEqual(navigations[0], {
      url: "http://test/final",
      status: 200,
      headers: { "content-type": "text/html" },
    });
  } finally {
    await host.close();
  }
});

test("dialog events map fields and pending confirm rejects isolated calls", async () => {
  const host = await fixture();
  try {
    const dialogs: unknown[] = [];
    host.page.on("dialog", (dialog) => dialogs.push(dialog));
    host.event(
      "Page.javascriptDialogOpening",
      { type: "confirm", message: "Proceed?", defaultPrompt: "" },
      "s1",
    );
    await waitUntil(() => dialogs.length === 1);
    assert.deepEqual(dialogs, [{ kind: "confirm", message: "Proceed?", defaultPrompt: "" }]);
    await assert.rejects(
      host.page.callIsolated(() => true, []),
      (error: unknown) => error instanceof DialogBlockingError && error.dialog === "confirm",
    );
    await host.page.handleDialog(false);
    host.event("Page.javascriptDialogOpening", { type: "alert", message: "Hi" }, "s1");
    await waitUntil(() =>
      host.sent.some(
        (message) =>
          message.method === "Page.handleJavaScriptDialog" &&
          (message.params as { accept: boolean }).accept,
      ),
    );
    assert.ok(
      host.sent.some(
        (message) =>
          message.method === "Page.handleJavaScriptDialog" &&
          (message.params as { accept: boolean }).accept,
      ),
    );
  } finally {
    await host.close();
  }
});

test("alerts can be left for the caller to handle", async () => {
  const host = await fixture({ autoAcceptAlerts: false });
  try {
    const opened = new Promise<void>((resolve) => host.page.on("dialog", () => resolve()));
    host.event("Page.javascriptDialogOpening", { type: "alert", message: "manual" }, "s1");
    await opened;
    assert.equal(
      host.sent.some((message) => message.method === "Page.handleJavaScriptDialog"),
      false,
    );
    await assert.rejects(
      host.page.callIsolated(() => true, []),
      DialogBlockingError,
    );
    await host.page.handleDialog(true);
  } finally {
    await host.close();
  }
});

test("popup attaches only with matching opener and becomes a managed page", async () => {
  const host = await fixture();
  try {
    const popups: string[] = [];
    host.page.on("popup", (popup) => popups.push(popup.id));
    host.event("Target.targetCreated", {
      targetInfo: { type: "page", targetId: "foreign", openerId: "other" },
    });
    host.event("Target.targetCreated", {
      targetInfo: { type: "service_worker", targetId: "worker", openerId: "page" },
    });
    host.event("Target.targetCreated", {
      targetInfo: { type: "page", targetId: "opened", openerId: "page" },
    });
    await waitUntil(() => popups.length === 1);
    assert.deepEqual(popups, ["opened"]);
    assert.deepEqual(
      host.browser.pages().map((page) => page.id),
      ["page", "opened"],
    );
    assert.ok(
      host.sent.some(
        (message) => message.method === "Target.setAutoAttach" && message.sessionId === "popup",
      ),
    );
    assert.ok(
      host.sent.some(
        (message) =>
          message.method === "Target.setDiscoverTargets" && message.sessionId === undefined,
      ),
    );
    assert.deepEqual(
      host.sent
        .filter((message) => message.method === "Target.attachToTarget")
        .map((message) => (message.params as { targetId: string }).targetId),
      ["page", "opened"],
    );
  } finally {
    await host.close();
  }
});

test("attach defaults to downloads unavailable without changing browser settings", async () => {
  const host = await fixture();
  try {
    assert.equal(host.browser.capabilities.downloads, false);
    assert.equal(host.page.capabilities.downloads, false);
    assert.equal(
      host.sent.some((message) => message.method === "Browser.setDownloadBehavior"),
      false,
    );
    await assert.rejects(host.page.waitForDownload(), BrowserConfigError);
  } finally {
    await host.close();
  }
});

test("download events map started and completed with managed file path", async () => {
  const host = await fixture({ manageDownloads: true });
  try {
    const events: unknown[] = [];
    host.page.on("download", (event) => events.push(event));
    host.event("Page.frameNavigated", { frame: { id: "main", url: "http://example.test" } }, "s1");
    host.event("Browser.downloadWillBegin", {
      guid: "guid",
      frameId: "main",
      url: "http://example.test/file",
      suggestedFilename: "file.txt",
    });
    host.event("Browser.downloadProgress", { guid: "guid", state: "completed" });
    await waitUntil(() => events.length === 2);
    const configured = host.sent.find((message) => message.method === "Browser.setDownloadBehavior")
      ?.params as { downloadPath: string } | undefined;
    const completed = events[1] as { path: string };
    assert.equal(dirname(completed.path), configured?.downloadPath);
    assert.equal(events.length, 2);
    assert.equal((events[0] as { state: string }).state, "started");
    assert.match(completed.path, /guid$/);
  } finally {
    await host.close();
  }
});

test("O3: a download from a blocked address is cancelled and never reported", async () => {
  const host = await fixture({ manageDownloads: true });
  try {
    const events: PageEvents["download"][] = [];
    host.page.on("download", (event) => events.push(event));
    host.event("Page.frameNavigated", { frame: { id: "main", url: "http://example.test" } }, "s1");
    host.event("Browser.downloadWillBegin", {
      guid: "blocked",
      frameId: "main",
      url: "http://169.254.169.254/latest/meta-data/iam",
      suggestedFilename: "iam.txt",
    });
    host.event("Browser.downloadProgress", { guid: "blocked", state: "completed" });
    host.event("Browser.downloadWillBegin", {
      guid: "allowed",
      frameId: "main",
      url: "http://127.0.0.1/file",
      suggestedFilename: "file.txt",
    });
    host.event("Browser.downloadProgress", { guid: "allowed", state: "completed" });
    await waitUntil(() => events.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      events.map((event) => `${event.id} ${event.state}`),
      ["allowed started", "allowed completed"],
    );
    assert.deepEqual(
      host.sent.find((message) => message.method === "Browser.cancelDownload")?.params,
      { guid: "blocked" },
    );
  } finally {
    await host.close();
  }
});

test("file upload resolves input object and releases it", async () => {
  const host = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "jevpilot-upload-"));
  const file = join(directory, "sample.txt");
  try {
    await writeFile(file, "content");
    await host.page.setInputFiles(() => document.querySelector("input[type=file]"), [], [file]);
    const methods = host.sent.map((message) => message.method);
    assert.ok(methods.indexOf("Runtime.callFunctionOn") < methods.indexOf("DOM.describeNode"));
    assert.ok(methods.indexOf("DOM.describeNode") < methods.indexOf("DOM.setFileInputFiles"));
    assert.ok(methods.indexOf("DOM.setFileInputFiles") < methods.indexOf("Runtime.releaseObject"));
    assert.equal(methods.includes("Runtime.enable"), false);
    assert.equal(methods.includes("Console.enable"), false);
  } finally {
    await rm(directory, { recursive: true });
    await host.close();
  }
});

test("OOPIF calls and events stay on the child flattened session", async () => {
  const host = await fixture();
  try {
    host.event(
      "Target.attachedToTarget",
      { sessionId: "child", targetInfo: { type: "iframe", targetId: "child-frame" } },
      "s1",
    );
    await waitUntil(() =>
      host.sent.some(
        (message) => message.method === "Page.createIsolatedWorld" && message.sessionId === "child",
      ),
    );
    host.event(
      "Target.attachedToTarget",
      { sessionId: "nested", targetInfo: { type: "iframe", targetId: "nested-frame" } },
      "child",
    );
    await waitUntil(() =>
      host.sent.some(
        (message) => message.method === "Page.enable" && message.sessionId === "nested",
      ),
    );
    const frames = await host.page.frames();
    assert.deepEqual(
      frames.map((frame) => frame.offset),
      [
        { x: 12, y: 24 },
        { x: 24, y: 48 },
      ],
    );
    await frames[0]?.callIsolated(() => true, []);
    assert.ok(
      host.sent.some(
        (message) => message.method === "Page.enable" && message.sessionId === "child",
      ),
    );
    assert.ok(
      host.sent.some(
        (message) => message.method === "Page.createIsolatedWorld" && message.sessionId === "child",
      ),
    );
    assert.ok(
      host.sent.some(
        (message) => message.method === "Runtime.callFunctionOn" && message.sessionId === "child",
      ),
    );
    const dialogs: string[] = [];
    host.page.on("dialog", (dialog) => dialogs.push(dialog.message));
    host.event(
      "Page.javascriptDialogOpening",
      { type: "confirm", message: "iframe confirm" },
      "child",
    );
    await waitUntil(() => dialogs.length === 1);
    await host.page.handleDialog(true);
    assert.ok(
      host.sent.some(
        (message) =>
          message.method === "Page.handleJavaScriptDialog" && message.sessionId === "child",
      ),
    );
  } finally {
    await host.close();
  }
});

test("M6s-2: frames() does not wait for a child session that does not answer", async () => {
  let treeCalls = 0;
  const host = await fixture({
    inProcessFrames: true,
    childFrameTree: (message, send) => {
      if (treeCalls++ === 0)
        send({ id: message.id, result: { frameTree: { frame: { id: "child-frame" } } } });
      return true;
    },
  });
  try {
    host.event(
      "Target.attachedToTarget",
      { sessionId: "child", targetInfo: { type: "iframe", targetId: "child-frame" } },
      "s1",
    );
    await waitUntil(() =>
      host.sent.some(
        (message) => message.method === "Page.createIsolatedWorld" && message.sessionId === "child",
      ),
    );
    const started = Date.now();
    const frames = await host.page.frames({ timeoutMs: 50 });
    assert.ok(Date.now() - started < 500);
    assert.deepEqual(
      frames.map((frame) => frame.id),
      ["child-frame", "frame-one", "frame-two"],
    );
    assert.deepEqual(frames[0]?.offset, { x: 12, y: 24 });
  } finally {
    await host.close();
  }
});

test("M6s-2: a busy child session keeps its frame worlds", async () => {
  let busy = false;
  const host = await fixture({
    childFrameTree: (message, send) => {
      if (!busy) {
        send({
          id: message.id,
          result: {
            frameTree: {
              frame: { id: "child-frame" },
              childFrames: [{ frame: { id: "child-inner" } }],
            },
          },
        });
      }
      return true;
    },
  });
  try {
    host.event(
      "Target.attachedToTarget",
      { sessionId: "child", targetInfo: { type: "iframe", targetId: "child-frame" } },
      "s1",
    );
    await waitUntil(() =>
      host.sent.some(
        (message) => message.method === "Page.createIsolatedWorld" && message.sessionId === "child",
      ),
    );
    assert.deepEqual(
      (await host.page.frames()).map((frame) => frame.id),
      ["child-frame", "child-inner"],
    );
    const worldCalls = () =>
      host.sent.filter(
        (message) =>
          message.method === "Page.createIsolatedWorld" &&
          (message.params as { frameId: string }).frameId === "child-inner",
      ).length;
    assert.equal(worldCalls(), 1);
    busy = true;
    assert.deepEqual(
      (await host.page.frames({ timeoutMs: 50 })).map((frame) => frame.id),
      ["child-frame"],
    );
    busy = false;
    assert.deepEqual(
      (await host.page.frames()).map((frame) => frame.id),
      ["child-frame", "child-inner"],
    );
    assert.equal(worldCalls(), 1);
  } finally {
    await host.close();
  }
});

test("M6s-2: frames() without a timeout behaves as before", async () => {
  let answer: (() => void) | undefined;
  let treeCalls = 0;
  const host = await fixture({
    childFrameTree: (message, send) => {
      const reply = () =>
        send({ id: message.id, result: { frameTree: { frame: { id: "child-frame" } } } });
      if (treeCalls++ === 0) reply();
      else answer = reply;
      return true;
    },
  });
  try {
    host.event(
      "Target.attachedToTarget",
      { sessionId: "child", targetInfo: { type: "iframe", targetId: "child-frame" } },
      "s1",
    );
    await waitUntil(() =>
      host.sent.some(
        (message) => message.method === "Page.createIsolatedWorld" && message.sessionId === "child",
      ),
    );
    let resolved = false;
    const framesPromise = host.page.frames().then((frames) => {
      resolved = true;
      return frames;
    });
    await waitUntil(() => answer !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(resolved, false);
    answer!();
    assert.deepEqual(
      (await framesPromise).map((frame) => frame.id),
      ["child-frame"],
    );
  } finally {
    await host.close();
  }
});

test("M6v: a stalled main-session frame tree query does not stall frames()", async () => {
  let stall = false;
  const host = await fixture({
    inProcessFrames: true,
    frameCall: (message) =>
      stall && message.method === "Page.getFrameTree" && message.sessionId === "s1",
  });
  try {
    stall = true;
    const started = performance.now();
    const frames = await host.page.frames({ timeoutMs: 50 });
    assert.ok(performance.now() - started < 250);
    assert.deepEqual(
      frames.map((frame) => frame.id),
      [],
    );
  } finally {
    await host.close();
  }
});

test("M6v: a stalled world setup for a new in-process frame skips only that frame", async () => {
  const host = await fixture({
    inProcessFrames: true,
    flatInProcessFrames: true,
    frameCall: (message) =>
      message.method === "Page.createIsolatedWorld" &&
      (message.params as { frameId: string }).frameId === "frame-two",
  });
  try {
    const started = performance.now();
    const frames = await host.page.frames({ timeoutMs: 50 });
    assert.ok(performance.now() - started < 250);
    assert.deepEqual(
      frames.map((frame) => frame.id),
      ["frame-one"],
    );
    assert.equal(frames.framesSkipped, 1);
    assert.deepEqual(
      (await host.page.frames({ timeoutMs: 50 })).map((frame) => frame.id),
      ["frame-one"],
    );
    assert.equal(
      host.sent.filter(
        (message) =>
          message.method === "Page.createIsolatedWorld" &&
          (message.params as { frameId: string }).frameId === "frame-two",
      ).length,
      2,
    );
  } finally {
    await host.close();
  }
});

test("M6v: a stalled iframe owner lookup skips only that frame", async () => {
  const host = await fixture({
    inProcessFrames: true,
    flatInProcessFrames: true,
    frameCall: (message) =>
      message.method === "DOM.getFrameOwner" &&
      (message.params as { frameId: string }).frameId === "frame-two",
  });
  try {
    const started = performance.now();
    const frames = await host.page.frames({ timeoutMs: 50 });
    assert.ok(performance.now() - started < 250);
    assert.deepEqual(
      frames.map((frame) => frame.id),
      ["frame-one"],
    );
    assert.equal(frames.framesSkipped, 1);
  } finally {
    await host.close();
  }
});

test("M6v: frames() without a budget still waits for a slow owner lookup", async () => {
  let answer: (() => void) | undefined;
  const host = await fixture({
    inProcessFrames: true,
    frameCall: (message, send) => {
      if (
        message.method !== "DOM.getFrameOwner" ||
        (message.params as { frameId: string }).frameId !== "frame-one"
      )
        return false;
      answer = () => send({ id: message.id, result: { backendNodeId: 8 } });
      return true;
    },
  });
  try {
    let resolved = false;
    const promise = host.page.frames().then((frames) => {
      resolved = true;
      return frames;
    });
    await waitUntil(() => answer !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(resolved, false);
    answer!();
    assert.deepEqual(
      (await promise).map((frame) => frame.id),
      ["frame-one", "frame-two"],
    );
  } finally {
    await host.close();
  }
});

test("M6s-3: frames() does not wait for iframe setups beyond its budget", async () => {
  let completeSetup: (() => void) | undefined;
  const host = await fixture({
    childSetup: (message, send) => {
      if (message.method !== "Page.enable") return false;
      completeSetup = () => send({ id: message.id, result: {} });
      return true;
    },
  });
  try {
    host.event(
      "Target.attachedToTarget",
      { sessionId: "child", targetInfo: { type: "iframe", targetId: "child-frame" } },
      "s1",
    );
    await waitUntil(() => completeSetup !== undefined);
    const started = performance.now();
    assert.deepEqual(await host.page.frames({ timeoutMs: 50 }), []);
    assert.ok(performance.now() - started < 500);
    let resolved = false;
    const unbounded = host.page.frames().then((frames) => {
      resolved = true;
      return frames;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(resolved, false);
    completeSetup!();
    assert.deepEqual(
      (await unbounded).map((frame) => frame.id),
      ["child-frame"],
    );
  } finally {
    await host.close();
  }
});

test("M6h: a call into a child target that has gone rejects with FrameGoneError", async () => {
  const host = await fixture();
  try {
    host.event(
      "Target.attachedToTarget",
      { sessionId: "child", targetInfo: { type: "iframe", targetId: "child-frame" } },
      "s1",
    );
    await waitUntil(() =>
      host.sent.some(
        (message) => message.method === "Page.createIsolatedWorld" && message.sessionId === "child",
      ),
    );
    const frames = await host.page.frames();
    assert.equal(frames.length, 1);
    host.goneChild();
    await assert.rejects(
      frames[0]!.callIsolated(() => true, []),
      FrameGoneError,
    );
  } finally {
    await host.close();
  }
});

test("M6h: a child frame that vanishes during offset computation is skipped", async () => {
  const host = await fixture({ inProcessFrames: true, vanishOffset: true });
  try {
    assert.deepEqual(await host.page.frames(), []);
    assert.ok(host.sent.some((message) => message.method === "DOM.resolveNode"));
  } finally {
    await host.close();
  }
});

test("same-process frame tree creates a context per frame and accumulates nested offsets", async () => {
  const host = await fixture({ inProcessFrames: true });
  try {
    const frames = await host.page.frames();
    assert.deepEqual(
      frames.map((frame) => [frame.id, frame.offset]),
      [
        ["frame-one", { x: 12, y: 24 }],
        ["frame-two", { x: 24, y: 48 }],
      ],
    );
    const worldCalls = host.sent.filter((message) => message.method === "Page.createIsolatedWorld");
    assert.deepEqual(
      worldCalls
        .filter((message) =>
          ["frame-one", "frame-two"].includes((message.params as { frameId: string }).frameId),
        )
        .map((message) => [(message.params as { frameId: string }).frameId, message.sessionId]),
      [
        ["frame-one", "s1"],
        ["frame-two", "s1"],
      ],
    );
    assert.deepEqual(
      host.sent
        .filter((message) => message.method === "DOM.resolveNode")
        .map((message) => (message.params as { executionContextId: number }).executionContextId),
      [11, 31],
    );
    host.event("Page.frameNavigated", { frame: { id: "frame-two", parentId: "frame-one" } }, "s1");
    await host.page.frames();
    await frames[1]?.callIsolated(() => true, []);
    assert.equal(
      host.sent.filter(
        (message) =>
          message.method === "Page.createIsolatedWorld" &&
          (message.params as { frameId: string }).frameId === "frame-two",
      ).length,
      2,
    );
    assert.equal(
      host.sent.filter(
        (message) =>
          message.method === "Page.createIsolatedWorld" &&
          (message.params as { frameId: string }).frameId === "frame-one",
      ).length,
      1,
    );
    assert.equal(
      host.sent.some(
        (message) => message.method === "Runtime.enable" || message.method === "Console.enable",
      ),
      false,
    );
  } finally {
    await host.close();
  }
});

test("trusted click returns a dialog while mouse release remains unanswered", async () => {
  const host = await fixture({ blockedClick: true });
  try {
    const result = await host.page.click(10, 20);
    assert.deepEqual(result.dialog, { kind: "confirm", message: "from click", defaultPrompt: "" });
    assert.equal(
      host.sent.some((message) => message.method === "Page.handleJavaScriptDialog"),
      false,
    );
    await assert.rejects(
      host.page.callIsolated(() => true, []),
      DialogBlockingError,
    );
    await host.page.handleDialog(true);
  } finally {
    await host.close();
  }
});

test("isolated call opening its own dialog rejects promptly and settles later CDP response", async () => {
  const host = await fixture({ blockedIsolated: true });
  try {
    const blocked = assert.rejects(
      host.page.callIsolated(function openDialog() {
        return true;
      }, []),
      DialogBlockingError,
    );
    await blocked;
    await host.page.handleDialog(true);
    assert.equal(
      host.sent.some((message) => message.method === "Runtime.enable"),
      false,
    );
  } finally {
    await host.close();
  }
});

test("R1: a failed Fetch.enable closes the page instead of leaving it unguarded", async () => {
  const sent: Message[] = [];
  const fake = await fakeCdp((message, send) => {
    sent.push(message);
    const method = String(message.method);
    if (method === "Fetch.enable")
      send({ id: message.id, error: { code: -32000, message: "Fetch unavailable" } });
    else if (method === "Target.createTarget")
      send({ id: message.id, result: { targetId: "unguarded" } });
    else if (method === "Target.attachToTarget")
      send({ id: message.id, result: { sessionId: "s1" } });
    else send({ id: message.id, result: {} });
  });
  const browser = await createCdpDriver().launch(
    { kind: "attach", cdpUrl: fake.url },
    { selfCheck: false, networkGuard: { mode: "metadata", extraBlocked: [] } },
  );
  try {
    await assert.rejects(browser.newPage(), /failed to enable network guard/u);
    assert.ok(
      sent.some(
        (message) =>
          message.method === "Target.closeTarget" &&
          (message.params as { targetId?: string }).targetId === "unguarded",
      ),
    );
    assert.equal(browser.pages().length, 0);
  } finally {
    await browser.close();
    await fake.close();
  }
});

test("R1: a popup that fails to attach leaves no page behind", async () => {
  const host = await fixture({
    frameCall: (message, send) => {
      if (message.sessionId === "popup" && message.method === "Runtime.callFunctionOn") {
        send({ id: message.id, error: { code: -32000, message: "popup world failed" } });
        return true;
      }
      return false;
    },
  });
  try {
    host.event("Target.targetCreated", {
      targetInfo: { targetId: "popup", type: "page", openerId: "page" },
    });
    await waitUntil(() =>
      host.sent.some(
        (message) =>
          message.method === "Target.closeTarget" &&
          (message.params as { targetId?: string }).targetId === "popup",
      ),
    );
    assert.equal(host.browser.pages().length, 1);
    host.event(
      "Page.javascriptDialogOpening",
      { type: "alert", message: "late popup alert", defaultPrompt: "" },
      "popup",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      host.sent.some(
        (message) =>
          message.method === "Page.handleJavaScriptDialog" && message.sessionId === "popup",
      ),
      false,
      "a failed popup must not retain its dialog subscription",
    );
  } finally {
    await host.close();
  }
});

test("R1: download progress without a managed start is not kept forever", async () => {
  const host = await fixture({
    manageDownloads: true,
    networkGuard: { mode: "off", extraBlocked: [] },
  });
  const states: string[] = [];
  try {
    host.page.on("download", (event) => states.push(event.state));
    host.event("Page.frameNavigated", { frame: { id: "main", url: "http://fixture.test/" } }, "s1");
    for (let index = 0; index < 129; index++)
      host.event("Browser.downloadProgress", { guid: `orphan-${index}`, state: "completed" });
    host.event("Browser.downloadWillBegin", {
      guid: "orphan-0",
      frameId: "main",
      url: "http://fixture.test/file",
      suggestedFilename: "file",
    });
    await waitUntil(() => states.length > 0);
    assert.deepEqual(states, ["started"]);
  } finally {
    await host.close();
  }
});
