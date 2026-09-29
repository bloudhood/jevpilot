import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  click,
  drag,
  insertText,
  keyPress,
  screenshot,
  selectAll,
} from "../../src/browser/input.ts";
import { ActivePageInput } from "../../src/engine/cdp/driver.ts";
import { fakeCdp } from "./fake-cdp.ts";

describe("trusted input methods", () => {
  test("M6g: key syntax maps printable characters, named keys and modifier combinations", async () => {
    const events: Record<string, unknown>[] = [];
    const fake = await fakeCdp((message, send) => {
      events.push(message.params as Record<string, unknown>);
      send({ id: message.id, result: {} });
    });
    try {
      for (const key of [
        "1",
        "a",
        "Space",
        "Insert",
        "F12",
        "Control+a",
        "ControlOrMeta+A",
        "Shift+Alt+1",
      ])
        await keyPress(fake.client, "s1", key);
      assert.deepEqual(
        events
          .slice(0, 2)
          .map((event) => [event.type, event.code, event.text, event.windowsVirtualKeyCode]),
        [
          ["keyDown", "Digit1", "1", 49],
          ["keyUp", "Digit1", undefined, 49],
        ],
      );
      assert.equal(events[2]?.code, "KeyA");
      assert.equal(events[2]?.text, "a");
      assert.equal(events[4]?.code, "Space");
      assert.equal(events[6]?.code, "Insert");
      assert.equal(events[8]?.code, "F12");
      const selected = events.filter((event) => Array.isArray(event.commands));
      assert.equal(selected.length, 2);
      assert.deepEqual(
        selected.map((event) => event.modifiers),
        [2, process.platform === "darwin" ? 4 : 2],
      );
      assert.ok(events.some((event) => event.key === "1" && event.modifiers === 9));
      assert.deepEqual(
        events.slice(-2).map((event) => event.modifiers),
        [8, 0],
      );
      await keyPress(fake.client, "s1", "+");
      assert.deepEqual(
        [events.at(-2)?.type, events.at(-2)?.code, events.at(-2)?.text],
        ["keyDown", "Equal", "+"],
      );
    } finally {
      await fake.close();
    }
  });
  test("input activates a background page once and skips activation for the active page", async () => {
    const methods: string[] = [];
    const fake = await fakeCdp((message, send) => {
      methods.push(String(message.method));
      send({ id: message.id, result: {} });
    });
    try {
      const active = new ActivePageInput(fake.client);
      active.markActive("new-page");
      await active.activate("old-page");
      await click(fake.client, "old-session", 10, 10);
      await active.activate("old-page");
      await click(fake.client, "old-session", 10, 10);
      assert.deepEqual(methods, [
        "Target.activateTarget",
        ...Array(6).fill("Input.dispatchMouseEvent"),
      ]);
    } finally {
      await fake.close();
    }
  });

  test("HTML5 drag uses intercepted drag events and always disables interception", async () => {
    for (const failDrop of [false, true]) {
      const calls: { method: string; params: Record<string, unknown> }[] = [];
      const fake = await fakeCdp((message, send) => {
        const method = String(message.method);
        const params = message.params as Record<string, unknown>;
        calls.push({ method, params });
        if (
          method === "Input.dispatchMouseEvent" &&
          params.type === "mouseMoved" &&
          params.buttons === 1
        )
          send({
            method: "Input.dragIntercepted",
            sessionId: "s1",
            params: {
              data: { items: [{ mimeType: "text/plain", data: "Alpha" }], dragOperationsMask: 16 },
            },
          });
        send(
          failDrop && method === "Input.dispatchDragEvent" && params.type === "drop"
            ? { id: message.id, error: { code: -32000, message: "drop failed" } }
            : { id: message.id, result: {} },
        );
      });
      try {
        const operation = drag(fake.client, "s1", { x: 10, y: 10 }, { x: 90, y: 90 });
        if (failDrop) await assert.rejects(operation, /drop failed/u);
        else await operation;
        assert.deepEqual(
          calls
            .filter((call) => call.method === "Input.dispatchDragEvent")
            .map((call) => [call.params.type, call.params.x, call.params.y]),
          [
            ["dragEnter", 90, 90],
            ["dragOver", 90, 90],
            ["drop", 90, 90],
          ],
        );
        assert.deepEqual(
          calls
            .filter((call) => call.method === "Input.setInterceptDrags")
            .map((call) => call.params.enabled),
          [true, false],
        );
      } finally {
        await fake.close();
      }
    }
  });
  test("click sends move, press and release in order", async () => {
    const calls: { method: string; params: unknown }[] = [];
    const fake = await fakeCdp((message, send) => {
      calls.push({ method: String(message.method), params: message.params });
      send({ id: message.id, result: {} });
    });
    try {
      await click(fake.client, "s1", 12, 34);
      assert.deepEqual(
        calls.map((call) => (call.params as { type: string }).type),
        ["mouseMoved", "mousePressed", "mouseReleased"],
      );
      assert.equal(
        calls.every((call) => call.method === "Input.dispatchMouseEvent"),
        true,
      );
      assert.deepEqual(
        calls.map((call) => (call.params as { buttons: number }).buttons),
        [0, 1, 0],
      );
      assert.equal(
        calls.every((call) => (call.params as { pointerType: string }).pointerType === "mouse"),
        true,
      );
      assert.equal(
        calls.every((call) => {
          const point = call.params as { x: number; y: number };
          return point.x === 12 && point.y === 34;
        }),
        true,
      );
    } finally {
      await fake.close();
    }
  });

  test("inserts text and selects all using CDP commands", async () => {
    const calls: { method: string; params: unknown }[] = [];
    const fake = await fakeCdp((message, send) => {
      calls.push({ method: String(message.method), params: message.params });
      send({ id: message.id, result: {} });
    });
    try {
      await selectAll(fake.client, "s1");
      await insertText(fake.client, "s1", "replacement");
      assert.deepEqual((calls[1]?.params as { commands: string[] }).commands, ["selectAll"]);
      assert.deepEqual(
        calls.map((call) => call.method),
        [
          "Input.dispatchKeyEvent",
          "Input.dispatchKeyEvent",
          "Input.dispatchKeyEvent",
          "Input.dispatchKeyEvent",
          "Input.insertText",
        ],
      );
      assert.deepEqual(
        calls.slice(0, 4).map((call) => {
          const params = call.params as {
            type: string;
            key: string;
            modifiers: number;
            windowsVirtualKeyCode: number;
          };
          return [params.type, params.key, params.modifiers, params.windowsVirtualKeyCode];
        }),
        [
          ["rawKeyDown", "Control", 2, 17],
          ["rawKeyDown", "a", 2, 65],
          ["keyUp", "a", 2, 65],
          ["keyUp", "Control", 0, 17],
        ],
      );
    } finally {
      await fake.close();
    }
  });

  test("sends key down and up", async () => {
    const events: {
      type: string;
      key: string;
      code: string;
      windowsVirtualKeyCode: number;
      nativeVirtualKeyCode: number;
      text?: string;
    }[] = [];
    const fake = await fakeCdp((message, send) => {
      events.push(message.params as (typeof events)[number]);
      send({ id: message.id, result: {} });
    });
    try {
      await keyPress(fake.client, "s1", "Enter");
      await keyPress(fake.client, "s1", "ArrowDown");
      assert.deepEqual(
        events.map((event) => event.type),
        ["keyDown", "keyUp", "rawKeyDown", "keyUp"],
      );
      assert.deepEqual(
        events.map((event) => [
          event.key,
          event.code,
          event.windowsVirtualKeyCode,
          event.nativeVirtualKeyCode,
        ]),
        [
          ["Enter", "Enter", 13, 13],
          ["Enter", "Enter", 13, 13],
          ["ArrowDown", "ArrowDown", 40, 40],
          ["ArrowDown", "ArrowDown", 40, 40],
        ],
      );
      assert.equal(events[0]?.text, "\r");
    } finally {
      await fake.close();
    }
  });

  test("decodes a JPEG screenshot", async () => {
    const fake = await fakeCdp((message, send) =>
      send({
        id: message.id,
        result: { data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64") },
      }),
    );
    try {
      assert.deepEqual(
        await screenshot(fake.client, "s1", 70),
        Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
      );
    } finally {
      await fake.close();
    }
  });
});
