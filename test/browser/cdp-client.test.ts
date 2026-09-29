import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CdpDisconnectedError,
  CdpProtocolError,
  CdpTimeoutError,
} from "../../src/browser/errors.ts";
import { fakeCdp, type Message } from "./fake-cdp.ts";

describe("CDP client", () => {
  test("routes OOPIF events and calls by child session ID", async () => {
    const calls: Message[] = [];
    const fake = await fakeCdp((message, send) => {
      calls.push(message);
      send({
        method: "Page.frameNavigated",
        sessionId: "sibling",
        params: { frame: { id: "other" } },
      });
      send({
        method: "Page.frameNavigated",
        sessionId: "child",
        params: { frame: { id: "iframe" } },
      });
      send({ id: message.id, result: { frameTree: { frame: { id: "iframe" } } } });
    });
    try {
      const event = fake.client.waitForEvent("Page.frameNavigated", () => true, 500, "child");
      const tree = await fake.client.call("Page.getFrameTree", undefined, "child");
      assert.equal((await event).frame.id, "iframe");
      assert.equal(tree.frameTree.frame.id, "iframe");
      assert.equal(calls[0]?.sessionId, "child");
    } finally {
      await fake.close();
    }
  });
  test("correlates out-of-order responses and routes flattened session events", async () => {
    const calls: Message[] = [];
    const fake = await fakeCdp((message, send) => {
      calls.push(message);
      if (calls.length === 2) {
        send({ id: calls[1]?.id, result: { product: "second" } });
        send({ method: "Page.loadEventFired", sessionId: "s1", params: { timestamp: 1 } });
        send({ id: calls[0]?.id, result: { product: "first" } });
      }
    });
    try {
      const event = fake.client.waitForEvent("Page.loadEventFired", () => true, 500, "s1");
      const first = fake.client.call("Browser.getVersion", undefined, "s1");
      const second = fake.client.call("Browser.getVersion", undefined, "s2");
      assert.equal((await first).product, "first");
      assert.equal((await second).product, "second");
      assert.equal((await event).timestamp, 1);
      assert.deepEqual(
        calls.map((call) => call.sessionId),
        ["s1", "s2"],
      );
    } finally {
      await fake.close();
    }
  });

  test("returns typed protocol errors", async () => {
    const fake = await fakeCdp((message, send) =>
      send({ id: message.id, error: { code: -32000, message: "bad" } }),
    );
    try {
      await assert.rejects(
        fake.client.call("Browser.getVersion", undefined),
        (error: unknown) =>
          error instanceof CdpProtocolError &&
          error.code === -32000 &&
          error.method === "Browser.getVersion",
      );
    } finally {
      await fake.close();
    }
  });

  test("times out pending calls", async () => {
    const fake = await fakeCdp(() => {});
    try {
      await assert.rejects(
        fake.client.call("Browser.getVersion", undefined, undefined, 10),
        CdpTimeoutError,
      );
    } finally {
      await fake.close();
    }
  });

  test("rejects calls and event waits on close", async () => {
    const fake = await fakeCdp(() => {});
    const call = fake.client.call("Browser.getVersion", undefined);
    const event = fake.client.waitForEvent("Page.loadEventFired");
    fake.client.close();
    await assert.rejects(call, CdpDisconnectedError);
    await assert.rejects(event, CdpDisconnectedError);
    await fake.close();
  });
});
