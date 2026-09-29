import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserInstance } from "../../src/browser/launcher.ts";
import { createCdpDriver } from "../../src/engine/cdp/driver.ts";
import { fakeCdp, type Message } from "../browser/fake-cdp.ts";

function isolatedCdp() {
  const sent: Message[] = [];
  let nextTarget = 0;
  return fakeCdp((message, send) => {
    sent.push(message);
    const method = String(message.method);
    const result =
      method === "Target.createBrowserContext"
        ? { browserContextId: "isolated-1" }
        : method === "Storage.getCookies"
          ? { cookies: [{ name: "shared", value: "yes", domain: "example.com", path: "/" }] }
          : method === "Target.createTarget"
            ? { targetId: `target-${++nextTarget}` }
            : method === "Target.attachToTarget"
              ? { sessionId: `session-${nextTarget}` }
              : method === "Browser.getWindowForTarget"
                ? { windowId: 7, bounds: { left: 0, top: 0, width: 100, height: 100 } }
                : {};
    send({ id: message.id, result });
  }).then((fake) => ({ ...fake, sent }));
}

test("M6k: isolated pages use their own browser context, copy cookies when asked, and dispose it on close", async () => {
  const fake = await isolatedCdp();
  const browser = await createCdpDriver({
    cdpOptions: { websocketFactory: () => new WebSocket(fake.url) },
  }).launch({ kind: "attach", cdpUrl: fake.url }, { selfCheck: false });
  try {
    const page = await browser.newPage({ isolated: { copyCookies: true } });
    assert.ok(
      fake.sent.some(
        (message) =>
          message.method === "Target.createTarget" &&
          (message.params as { browserContextId?: string }).browserContextId === "isolated-1",
      ),
    );
    assert.ok(fake.sent.some((message) => message.method === "Storage.getCookies"));
    assert.ok(
      fake.sent.some(
        (message) =>
          message.method === "Storage.setCookies" &&
          (message.params as { browserContextId?: string }).browserContextId === "isolated-1",
      ),
    );
    await page.close();
    assert.ok(fake.sent.some((message) => message.method === "Target.disposeBrowserContext"));
  } finally {
    await browser.close();
    await fake.close();
  }
});

test("M6k: an isolated-context window is moved to the profile's off-screen position and size", async () => {
  const fake = await isolatedCdp();
  const browser = new BrowserInstance(fake.client, undefined, undefined, {}, undefined, {
    width: 1000,
    height: 700,
  });
  try {
    const page = await browser.newPage({ isolated: { copyCookies: false } });
    const creation = fake.sent.find((message) => message.method === "Target.createTarget")
      ?.params as { left?: number; top?: number; width?: number; height?: number };
    assert.deepEqual(
      { left: creation.left, top: creation.top, width: creation.width, height: creation.height },
      { left: -3000, top: -3000, width: 1000, height: 700 },
    );
    const bounds = fake.sent.find((message) => message.method === "Browser.setWindowBounds")
      ?.params as { bounds?: { left: number; top: number; width: number; height: number } };
    assert.deepEqual(bounds.bounds, {
      left: -3000,
      top: -3000,
      width: 1000,
      height: 700,
      windowState: "normal",
    });
    await page.close();
  } finally {
    await browser.close();
    await fake.close();
  }
});
