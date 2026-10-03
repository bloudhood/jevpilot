import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BrowserSession } from "../../src/browser/session.ts";
import { sanitizeResponseHeaders } from "../../src/browser/response-headers.ts";
import { fakeCdp } from "./fake-cdp.ts";

describe("browser session", () => {
  test("R10: response headers named like tokens, secrets or keys are removed while detector headers are kept", () => {
    const headers = Object.fromEntries(
      Array.from({ length: 70 }, (_, index) => [`X-Header-${index}`, "x".repeat(3000)]),
    );
    const selected = sanitizeResponseHeaders({
      Authorization: "secret",
      "Proxy-Authorization": "secret",
      "Set-Cookie2": "secret",
      "X-Api-Token": "secret",
      "X-Session-Token": "secret",
      "Private-Token": "secret",
      "X-Secret": "secret",
      "X-Access-Key": "secret",
      "Cf-Mitigated": "challenge",
      "X-Amzn-Waf-Action": "captcha",
      "Content-Type": "text/html",
      ...headers,
    });
    assert.equal(Object.keys(selected).length, 64);
    assert.equal(selected["x-header-0"]?.length, 2048);
    assert.equal(selected["x-header-69"], undefined);
    assert.equal(selected.authorization, undefined);
    assert.equal(selected["proxy-authorization"], undefined);
    assert.equal(selected["set-cookie2"], undefined);
    assert.equal(selected["x-api-token"], undefined);
    assert.equal(selected["x-session-token"], undefined);
    assert.equal(selected["private-token"], undefined);
    assert.equal(selected["x-secret"], undefined);
    assert.equal(selected["x-access-key"], undefined);
    assert.equal(selected["cf-mitigated"], "challenge");
    assert.equal(selected["x-amzn-waf-action"], "captcha");
    assert.equal(selected["content-type"], "text/html");
  });
  test("creates, attaches flattened and closes a page target", async () => {
    const methods: string[] = [];
    const fake = await fakeCdp((message, send) => {
      const method = String(message.method);
      methods.push(method);
      const result =
        method === "Target.createTarget"
          ? { targetId: "page" }
          : method === "Target.attachToTarget"
            ? { sessionId: "s1" }
            : {};
      send({ id: message.id, result });
    });
    try {
      const page = await BrowserSession.create(fake.client, () => {});
      await page.close();
      assert.deepEqual(methods, [
        "Target.createTarget",
        "Target.attachToTarget",
        "Page.enable",
        "Network.enable",
        "Page.setLifecycleEventsEnabled",
        "Target.setAutoAttach",
        "Target.closeTarget",
      ]);
    } finally {
      await fake.close();
    }
  });

  test("navigation selects the main-frame document and lowercases headers", async () => {
    const fake = await fakeCdp((message, send) => {
      const method = String(message.method);
      if (method === "Target.createTarget") send({ id: message.id, result: { targetId: "page" } });
      else if (method === "Target.attachToTarget")
        send({ id: message.id, result: { sessionId: "s1" } });
      else if (method === "Page.getFrameTree")
        send({ id: message.id, result: { frameTree: { frame: { id: "main" } } } });
      else {
        send({ id: message.id, result: {} });
        if (method === "Page.navigate") {
          send({
            method: "Network.responseReceived",
            sessionId: "s1",
            params: {
              type: "Document",
              frameId: "child",
              response: { url: "http://test/child", status: 404, headers: {} },
            },
          });
          send({
            method: "Network.responseReceived",
            sessionId: "s1",
            params: {
              type: "Document",
              frameId: "main",
              response: {
                url: "http://test/",
                status: 200,
                headers: {
                  "Content-Type": "text/html",
                  "Cf-Mitigated": "challenge",
                  "X-Amzn-Waf-Action": "captcha",
                  "Set-Cookie": "secret",
                  Authorization: "secret",
                },
              },
            },
          });
          send({
            method: "Page.lifecycleEvent",
            sessionId: "s1",
            params: { name: "DOMContentLoaded", frameId: "main" },
          });
        }
      }
    });
    try {
      const page = await BrowserSession.create(fake.client, () => {});
      const result = await page.navigate("http://test/");
      assert.equal(result.status, 200);
      assert.equal(result.headers["cf-mitigated"], "challenge");
      assert.equal(result.headers["content-type"], "text/html");
      assert.equal(result.headers["x-amzn-waf-action"], "captcha");
      assert.equal(result.headers["set-cookie"], undefined);
      assert.equal(result.headers.authorization, undefined);
      await page.close();
    } finally {
      await fake.close();
    }
  });

  test("late Page.navigate reply after event timeout returns timeout without unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    const fake = await fakeCdp((message, send) => {
      const method = String(message.method);
      if (method === "Target.createTarget") send({ id: message.id, result: { targetId: "page" } });
      else if (method === "Target.attachToTarget")
        send({ id: message.id, result: { sessionId: "s1" } });
      else if (method === "Page.getFrameTree")
        send({ id: message.id, result: { frameTree: { frame: { id: "main" } } } });
      else if (method === "Page.navigate")
        setTimeout(() => send({ id: message.id, result: {} }), 40);
      else send({ id: message.id, result: {} });
    });
    try {
      const page = await BrowserSession.create(fake.client, () => {});
      const result = await page.navigate("http://slow.test/", 15);
      assert.deepEqual(result, { url: "http://slow.test/", headers: {}, failure: "timeout" });
      await new Promise((resolve) => setTimeout(resolve, 45));
      assert.deepEqual(unhandled, []);
      await page.close();
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await fake.close();
    }
  });

  test("missing document response is nonfatal after DOMContentLoaded", async () => {
    const fake = await fakeCdp((message, send) => {
      const method = String(message.method);
      if (method === "Target.createTarget") send({ id: message.id, result: { targetId: "page" } });
      else if (method === "Target.attachToTarget")
        send({ id: message.id, result: { sessionId: "s1" } });
      else if (method === "Page.getFrameTree")
        send({ id: message.id, result: { frameTree: { frame: { id: "main" } } } });
      else {
        send({ id: message.id, result: {} });
        if (method === "Page.navigate")
          send({
            method: "Page.lifecycleEvent",
            sessionId: "s1",
            params: { name: "DOMContentLoaded", frameId: "main" },
          });
      }
    });
    try {
      const page = await BrowserSession.create(fake.client, () => {});
      assert.deepEqual(await page.navigate("http://test/", 5000), {
        url: "http://test/",
        headers: {},
      });
      await page.close();
    } finally {
      await fake.close();
    }
  });

  test("DOMContentLoaded timeout preserves document response and reports failure", async () => {
    const fake = await fakeCdp((message, send) => {
      const method = String(message.method);
      if (method === "Target.createTarget") send({ id: message.id, result: { targetId: "page" } });
      else if (method === "Target.attachToTarget")
        send({ id: message.id, result: { sessionId: "s1" } });
      else if (method === "Page.getFrameTree")
        send({ id: message.id, result: { frameTree: { frame: { id: "main" } } } });
      else {
        send({ id: message.id, result: {} });
        if (method === "Page.navigate")
          send({
            method: "Network.responseReceived",
            sessionId: "s1",
            params: {
              type: "Document",
              frameId: "main",
              response: {
                url: "http://slow.test/final",
                status: 200,
                headers: { "Content-Type": "text/html" },
              },
            },
          });
      }
    });
    try {
      const page = await BrowserSession.create(fake.client, () => {});
      assert.deepEqual(await page.navigate("http://slow.test/", 500), {
        url: "http://slow.test/final",
        status: 200,
        headers: { "content-type": "text/html" },
        failure: "timeout",
      });
      await page.close();
    } finally {
      await fake.close();
    }
  });
});
