import assert from "node:assert/strict";
import { test } from "node:test";
import { createCdpDriver } from "../../src/engine/cdp/driver.ts";
import { fakeCdp } from "../browser/fake-cdp.ts";

test("O9d: the CDP driver reports a browser whose connection closed as disconnected", async () => {
  const fake = await fakeCdp((message, send) => send({ id: message.id, result: {} }));
  const browser = await createCdpDriver({
    cdpOptions: { websocketFactory: () => new WebSocket(fake.url) },
  }).launch({ kind: "attach", cdpUrl: fake.url }, { selfCheck: false });
  let notified = 0;
  let resolveNotified: () => void = () => {};
  const firstNotice = new Promise<void>((resolve) => (resolveNotified = resolve));
  const off = browser.onDisconnected(() => {
    notified++;
    resolveNotified();
  });
  try {
    assert.equal(browser.connected, true);
    fake.closeConnections();
    // Wait for the notice itself (bounded generously); a fixed short sleep fails under load.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      firstNotice,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("no disconnect notice")), 5000);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(browser.connected, false);
    assert.equal(notified, 1);
    off();
  } finally {
    await browser.close();
    await fake.close();
  }
});
