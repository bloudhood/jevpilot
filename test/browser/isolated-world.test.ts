import assert from "node:assert/strict";
import { test } from "node:test";
import { CdpProtocolError, EvaluationError } from "../../src/browser/errors.ts";
import { NavigationInProgressError } from "../../src/engine/types.ts";
import { IsolatedWorld, isNavigationContextError } from "../../src/browser/isolated-world.ts";
import { fakeCdp } from "./fake-cdp.ts";

test("classifies CDP navigation context failures", () => {
  for (const message of [
    "Inspected target navigated or closed",
    "Execution context was destroyed.",
    "Cannot find context with specified id",
  ])
    assert.equal(
      isNavigationContextError(new CdpProtocolError(-32000, message, "Runtime.callFunctionOn")),
      true,
    );
  assert.equal(
    isNavigationContextError(
      new CdpProtocolError(-32000, "Permission denied", "Runtime.callFunctionOn"),
    ),
    false,
  );
});

test("isolated call retries once in the new document context", async () => {
  let calls = 0;
  let worlds = 0;
  const fake = await fakeCdp((message, send) => {
    if (message.method === "Page.getFrameTree")
      send({ id: message.id, result: { frameTree: { frame: { id: "main" } } } });
    else if (message.method === "Page.createIsolatedWorld")
      send({ id: message.id, result: { executionContextId: ++worlds } });
    else if (message.method === "Runtime.callFunctionOn") {
      calls++;
      if (calls === 1) {
        send({ method: "Page.frameNavigated", sessionId: "s1", params: { frame: { id: "main" } } });
        send({ method: "Page.domContentEventFired", sessionId: "s1", params: { timestamp: 1 } });
        send({
          id: message.id,
          error: { code: -32000, message: "Inspected target navigated or closed" },
        });
      } else send({ id: message.id, result: { result: { value: "new page" } } });
    }
  });
  const world = new IsolatedWorld(fake.client, "s1");
  try {
    assert.equal(await world.callFunction(() => "new page"), "new page");
    assert.equal(calls, 2);
    assert.equal(worlds, 2);
  } finally {
    world.dispose();
    await fake.close();
  }
});

test("M6d: stale isolated-world frame is retried with backoff", async () => {
  let attempts = 0;
  let trees = 0;
  const fake = await fakeCdp((message, send) => {
    if (message.method === "Page.getFrameTree") {
      trees++;
      send({ id: message.id, result: { frameTree: { frame: { id: `frame-${trees}` } } } });
    } else if (message.method === "Page.createIsolatedWorld") {
      attempts++;
      send(
        attempts < 4
          ? {
              id: message.id,
              error: { code: -32602, message: "frame with given id was not found" },
            }
          : { id: message.id, result: { executionContextId: 7 } },
      );
    }
  });
  const world = new IsolatedWorld(fake.client, "s1");
  try {
    assert.equal(await world.getContextId(), 7);
    assert.equal(attempts, 4);
    assert.equal(trees, 4);
  } finally {
    world.dispose();
    await fake.close();
  }
});

test("second navigation context failure is typed", async () => {
  const fake = await fakeCdp((message, send) => {
    if (message.method === "Page.getFrameTree")
      send({ id: message.id, result: { frameTree: { frame: { id: "main" } } } });
    else if (message.method === "Page.createIsolatedWorld")
      send({ id: message.id, result: { executionContextId: 1 } });
    else if (message.method === "Runtime.callFunctionOn") {
      send({ method: "Page.frameNavigated", sessionId: "s1", params: { frame: { id: "main" } } });
      send({ method: "Page.domContentEventFired", sessionId: "s1", params: { timestamp: 1 } });
      send({ id: message.id, error: { code: -32000, message: "Execution context was destroyed" } });
    }
  });
  const world = new IsolatedWorld(fake.client, "s1");
  try {
    await assert.rejects(
      world.callFunction(() => true),
      NavigationInProgressError,
    );
  } finally {
    world.dispose();
    await fake.close();
  }
});

test("callFunction sends isolated context and by-value arguments, recreating stale context", async () => {
  let worlds = 0;
  const calls: Record<string, unknown>[] = [];
  const fake = await fakeCdp((message, send) => {
    const method = String(message.method);
    if (method === "Page.getFrameTree")
      send({ id: message.id, result: { frameTree: { frame: { id: "main" } } } });
    else if (method === "Page.createIsolatedWorld")
      send({ id: message.id, result: { executionContextId: ++worlds } });
    else if (method === "Runtime.callFunctionOn") {
      calls.push(message.params as Record<string, unknown>);
      if (worlds === 1)
        send({ id: message.id, error: { code: -32000, message: "Cannot find context" } });
      else send({ id: message.id, result: { result: { value: 42 } } });
    }
  });
  try {
    assert.equal(
      await new IsolatedWorld(fake.client, "s1").callFunction((value: number) => value * 2, [21]),
      42,
    );
    assert.equal(worlds, 2);
    assert.deepEqual(
      calls.map((call) => call.executionContextId),
      [1, 2],
    );
    assert.deepEqual(calls[1]?.arguments, [{ value: 21 }]);
    assert.equal(calls[1]?.returnByValue, true);
    assert.equal(calls[1]?.awaitPromise, true);
    assert.equal("objectId" in (calls[1] ?? {}), false);
  } finally {
    await fake.close();
  }
});

test("recreates a stale context once without enabling Runtime", async () => {
  const methods: string[] = [];
  let worlds = 0;
  const fake = await fakeCdp((message, send) => {
    const method = String(message.method);
    methods.push(method);
    if (method === "Page.getFrameTree")
      send({ id: message.id, result: { frameTree: { frame: { id: "frame" } } } });
    else if (method === "Page.createIsolatedWorld")
      send({ id: message.id, result: { executionContextId: ++worlds } });
    else if (worlds === 1)
      send({ id: message.id, error: { code: -32000, message: "Cannot find context" } });
    else send({ id: message.id, result: { result: { value: 42 } } });
  });
  try {
    const world = new IsolatedWorld(fake.client, "s1");
    assert.equal(await world.evaluate<number>("21*2"), 42);
    assert.equal(worlds, 2);
    assert.equal(methods.includes("Runtime.enable"), false);
  } finally {
    await fake.close();
  }
});

test("retries a stale Page.createIsolatedWorld frame exactly once", async () => {
  let creates = 0;
  const fake = await fakeCdp((message, send) => {
    if (message.method === "Page.getFrameTree")
      send({ id: message.id, result: { frameTree: { frame: { id: "main" } } } });
    else if (message.method === "Page.createIsolatedWorld") {
      creates++;
      if (creates === 1)
        send({
          id: message.id,
          error: { code: -32602, message: "Page.createIsolatedWorld returned code -32602" },
        });
      else send({ id: message.id, result: { executionContextId: 7 } });
    } else if (message.method === "Runtime.evaluate")
      send({ id: message.id, result: { result: { value: 7 } } });
  });
  try {
    assert.equal(await new IsolatedWorld(fake.client, "s1").evaluate<number>("7"), 7);
    assert.equal(creates, 2);
  } finally {
    await fake.close();
  }
});

test("does not retry unrelated Page.createIsolatedWorld errors", async () => {
  let creates = 0;
  const fake = await fakeCdp((message, send) => {
    if (message.method === "Page.getFrameTree")
      send({ id: message.id, result: { frameTree: { frame: { id: "main" } } } });
    else if (message.method === "Page.createIsolatedWorld") {
      creates++;
      send({ id: message.id, error: { code: -32000, message: "Permission denied" } });
    }
  });
  try {
    await assert.rejects(new IsolatedWorld(fake.client, "s1").evaluate("7"), CdpProtocolError);
    assert.equal(creates, 1);
  } finally {
    await fake.close();
  }
});

test("never evaluates without context when main-frame navigation races world creation", async () => {
  const contextIds: number[] = [];
  let worlds = 0;
  const fake = await fakeCdp((message, send) => {
    const method = String(message.method);
    if (method === "Page.getFrameTree")
      send({ id: message.id, result: { frameTree: { frame: { id: "main" } } } });
    else if (method === "Page.createIsolatedWorld") {
      worlds++;
      if (worlds === 1)
        send({ method: "Page.frameNavigated", sessionId: "s1", params: { frame: { id: "main" } } });
      send({ id: message.id, result: { executionContextId: worlds } });
    } else if (method === "Runtime.evaluate") {
      const params = message.params as { contextId?: number };
      assert.equal(typeof params.contextId, "number");
      contextIds.push(params.contextId as number);
      send({ id: message.id, result: { result: { value: 7 } } });
    }
  });
  try {
    assert.equal(await new IsolatedWorld(fake.client, "s1").evaluate<number>("7"), 7);
    assert.deepEqual(contextIds, [2]);
  } finally {
    await fake.close();
  }
});

test("child-frame navigation preserves the main world", async () => {
  let worlds = 0;
  const fake = await fakeCdp((message, send) => {
    const method = String(message.method);
    if (method === "Page.getFrameTree")
      send({ id: message.id, result: { frameTree: { frame: { id: "main" } } } });
    else if (method === "Page.createIsolatedWorld")
      send({ id: message.id, result: { executionContextId: ++worlds } });
    else if (method === "Runtime.evaluate") {
      const params = message.params as { contextId: number };
      send({ id: message.id, result: { result: { value: params.contextId } } });
    } else if (method === "Browser.getVersion") {
      send({
        method: "Page.frameNavigated",
        sessionId: "s1",
        params: { frame: { id: "child", parentId: "main" } },
      });
      send({ id: message.id, result: {} });
    }
  });
  try {
    const world = new IsolatedWorld(fake.client, "s1");
    assert.equal(await world.evaluate<number>("1"), 1);
    const navigated = fake.client.waitForEvent("Page.frameNavigated", () => true, 500, "s1");
    await fake.client.call("Browser.getVersion", undefined, "s1");
    await navigated;
    assert.equal(await world.evaluate<number>("1"), 1);
    assert.equal(worlds, 1);
  } finally {
    await fake.close();
  }
});

test("throws EvaluationError for script exceptions", async () => {
  const fake = await fakeCdp((message, send) => {
    const method = String(message.method);
    if (method === "Page.getFrameTree")
      send({ id: message.id, result: { frameTree: { frame: { id: "main" } } } });
    else if (method === "Page.createIsolatedWorld")
      send({ id: message.id, result: { executionContextId: 1 } });
    else
      send({
        id: message.id,
        result: {
          result: {},
          exceptionDetails: { text: "Uncaught", exception: { description: "Error: boom" } },
        },
      });
  });
  try {
    await assert.rejects(
      new IsolatedWorld(fake.client, "s1").evaluate("throw new Error('boom')"),
      (error: unknown) => error instanceof EvaluationError && error.exceptionText === "Error: boom",
    );
  } finally {
    await fake.close();
  }
});
