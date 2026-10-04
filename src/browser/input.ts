import { CdpClient } from "./cdp/client.ts";
import { CdpTimeoutError } from "./errors.ts";
import type { Protocol } from "devtools-protocol/types/protocol.js";

export async function click(
  client: CdpClient,
  sessionId: string,
  x: number,
  y: number,
): Promise<void> {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const)
    await client.call(
      "Input.dispatchMouseEvent",
      {
        type,
        x,
        y,
        buttons: type === "mousePressed" ? 1 : 0,
        pointerType: "mouse",
        ...(type === "mouseMoved" ? {} : { button: "left" as const, clickCount: 1 }),
      },
      sessionId,
    );
}
export const hover = (client: CdpClient, sessionId: string, x: number, y: number) =>
  client.call(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x, y, buttons: 0, pointerType: "mouse" },
    sessionId,
  );
export async function drag(
  client: CdpClient,
  sessionId: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  let intercepted: Protocol.Input.DragInterceptedEvent | undefined;
  let resolveIntercept: (() => void) | undefined;
  const interceptedEvent = new Promise<void>((resolve) => {
    resolveIntercept = resolve;
  });
  const off = client.on(
    "Input.dragIntercepted",
    (event) => {
      intercepted = event as Protocol.Input.DragInterceptedEvent;
      resolveIntercept?.();
    },
    sessionId,
  );
  let pressed = false;
  let timedOut = false;
  try {
    await client.call("Input.setInterceptDrags", { enabled: true }, sessionId);
    await client.call(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x: from.x, y: from.y, buttons: 0, pointerType: "mouse" },
      sessionId,
    );
    await client.call(
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        x: from.x,
        y: from.y,
        buttons: 1,
        button: "left",
        clickCount: 1,
        pointerType: "mouse",
      },
      sessionId,
    );
    pressed = true;
    for (let step = 1; step <= 4; step++) {
      const progress = step / 4;
      await client.call(
        "Input.dispatchMouseEvent",
        {
          type: "mouseMoved",
          x: from.x + (to.x - from.x) * progress,
          y: from.y + (to.y - from.y) * progress,
          buttons: 1,
          button: "left",
          pointerType: "mouse",
        },
        sessionId,
      );
    }
    if (!intercepted)
      await Promise.race([
        interceptedEvent,
        new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ]);
    if (intercepted) {
      const { data } = intercepted as Protocol.Input.DragInterceptedEvent;
      for (const type of ["dragEnter", "dragOver", "drop"] as const)
        await client.call("Input.dispatchDragEvent", { type, x: to.x, y: to.y, data }, sessionId);
    }
  } catch (error) {
    timedOut = error instanceof CdpTimeoutError;
    throw error;
  } finally {
    try {
      if (pressed && !timedOut)
        await client.call(
          "Input.dispatchMouseEvent",
          {
            type: "mouseReleased",
            x: to.x,
            y: to.y,
            buttons: 0,
            button: "left",
            clickCount: 1,
            pointerType: "mouse",
          },
          sessionId,
        );
    } catch (error) {
      timedOut = error instanceof CdpTimeoutError;
      throw error;
    } finally {
      off();
      const cleanup = client.call("Input.setInterceptDrags", { enabled: false }, sessionId);
      if (timedOut) void cleanup.catch(() => {});
      else await cleanup;
    }
  }
}
export const insertText = (client: CdpClient, sessionId: string, text: string) =>
  client.call("Input.insertText", { text }, sessionId);

// Input.insertText fires `input` but no key events, so widgets that read their field on keyup (date pickers,
// masks) never see typed text and later rewrite the field. A Shift press after the text is in gives them a
// keyup with the full value; it inserts nothing, moves no caret and does not steer an open suggestion list.
export async function tapShift(client: CdpClient, sessionId: string): Promise<void> {
  const shift = {
    key: "Shift",
    code: "ShiftLeft",
    windowsVirtualKeyCode: 16,
    nativeVirtualKeyCode: 16,
  };
  await client.call(
    "Input.dispatchKeyEvent",
    { type: "rawKeyDown", ...shift, modifiers: 8 },
    sessionId,
  );
  await client.call("Input.dispatchKeyEvent", { type: "keyUp", ...shift, modifiers: 0 }, sessionId);
}

const keys = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  PageDown: { code: "PageDown", keyCode: 34 },
  PageUp: { code: "PageUp", keyCode: 33 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  Space: { code: "Space", keyCode: 32, text: " " },
  Insert: { code: "Insert", keyCode: 45 },
} as const;

export class UnknownKeyError extends Error {
  constructor(key: string) {
    super(
      `Unknown key ${JSON.stringify(key)}; use a printable character, Enter/Tab/Escape/arrows/navigation keys, Space, Insert, F1-F12, or Modifier+Key (Control, Shift, Alt, Meta, ControlOrMeta).`,
    );
    this.name = "UnknownKeyError";
  }
}

type KeyDefinition = { key: string; code: string; keyCode: number; text?: string };
function keyDefinition(key: string): KeyDefinition {
  if (key in keys) {
    const named = keys[key as keyof typeof keys];
    return {
      key: key === "Space" ? " " : key,
      code: named.code,
      keyCode: named.keyCode,
      ...("text" in named ? { text: named.text } : {}),
    };
  }
  const functionKey = /^F([1-9]|1[0-2])$/u.exec(key);
  if (functionKey) return { key, code: key, keyCode: 111 + Number(functionKey[1]) };
  if (/^[a-zA-Z]$/u.test(key))
    return {
      key,
      code: `Key${key.toUpperCase()}`,
      keyCode: key.toUpperCase().charCodeAt(0),
      text: key,
    };
  if (/^[0-9]$/u.test(key))
    return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key };
  const punctuation: Record<string, [string, number]> = {
    "!": ["Digit1", 49],
    "@": ["Digit2", 50],
    "#": ["Digit3", 51],
    $: ["Digit4", 52],
    "%": ["Digit5", 53],
    "^": ["Digit6", 54],
    "&": ["Digit7", 55],
    "*": ["Digit8", 56],
    "(": ["Digit9", 57],
    ")": ["Digit0", 48],
    "-": ["Minus", 189],
    _: ["Minus", 189],
    "=": ["Equal", 187],
    "+": ["Equal", 187],
    "[": ["BracketLeft", 219],
    "{": ["BracketLeft", 219],
    "]": ["BracketRight", 221],
    "}": ["BracketRight", 221],
    "\\": ["Backslash", 220],
    "|": ["Backslash", 220],
    ";": ["Semicolon", 186],
    ":": ["Semicolon", 186],
    "'": ["Quote", 222],
    '"': ["Quote", 222],
    ",": ["Comma", 188],
    "<": ["Comma", 188],
    ".": ["Period", 190],
    ">": ["Period", 190],
    "/": ["Slash", 191],
    "?": ["Slash", 191],
    "`": ["Backquote", 192],
    "~": ["Backquote", 192],
  };
  if (key === " ") return { key, code: "Space", keyCode: 32, text: key };
  if (punctuation[key])
    return { key, code: punctuation[key][0], keyCode: punctuation[key][1], text: key };
  if (Array.from(key).length === 1 && !/\p{C}/u.test(key))
    return { key, code: "Unidentified", keyCode: 0, text: key };
  throw new UnknownKeyError(key);
}

export async function keyPress(
  client: CdpClient,
  sessionId: string,
  key: keyof typeof keys | string,
): Promise<void> {
  const parts = Array.from(key).length === 1 ? [key] : key.split("+");
  const name = parts.pop() ?? "";
  const modifierCodes: Record<string, { code: string; keyCode: number; bit: number }> = {
    Alt: { code: "AltLeft", keyCode: 18, bit: 1 },
    Control: { code: "ControlLeft", keyCode: 17, bit: 2 },
    Meta: { code: "MetaLeft", keyCode: 91, bit: 4 },
    Shift: { code: "ShiftLeft", keyCode: 16, bit: 8 },
  };
  const modifiers = parts.map((part) =>
    part === "ControlOrMeta" ? (process.platform === "darwin" ? "Meta" : "Control") : part,
  );
  if (
    new Set(modifiers).size !== modifiers.length ||
    modifiers.some((part) => !modifierCodes[part])
  )
    throw new UnknownKeyError(key);
  const definition = keyDefinition(name);
  const common = {
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
    nativeVirtualKeyCode: definition.keyCode,
  };
  let mask = 0;
  let timedOut = false;
  try {
    for (const modifier of modifiers) {
      mask |= modifierCodes[modifier]!.bit;
      await client.call(
        "Input.dispatchKeyEvent",
        {
          type: "rawKeyDown",
          key: modifier,
          code: modifierCodes[modifier]!.code,
          windowsVirtualKeyCode: modifierCodes[modifier]!.keyCode,
          nativeVirtualKeyCode: modifierCodes[modifier]!.keyCode,
          modifiers: mask,
        },
        sessionId,
      );
    }
    await client.call(
      "Input.dispatchKeyEvent",
      {
        type:
          definition.text && !mask
            ? "keyDown"
            : name === "Enter" && !mask
              ? "keyDown"
              : "rawKeyDown",
        ...common,
        modifiers: mask,
        ...(definition.text && !mask
          ? { text: definition.text, unmodifiedText: definition.text }
          : {}),
        ...(name === "Enter" && !mask ? { text: "\r", unmodifiedText: "\r" } : {}),
        ...(name.toLowerCase() === "a" && mask & (2 | 4) ? { commands: ["selectAll"] } : {}),
      },
      sessionId,
    );
  } catch (error) {
    timedOut = error instanceof CdpTimeoutError;
    throw error;
  } finally {
    const cleanup = client.call(
      "Input.dispatchKeyEvent",
      { type: "keyUp", ...common, modifiers: mask },
      sessionId,
    );
    if (timedOut) void cleanup.catch(() => {});
    else await cleanup;
    for (const modifier of [...modifiers].reverse()) {
      mask &= ~modifierCodes[modifier]!.bit;
      const release = client.call(
        "Input.dispatchKeyEvent",
        {
          type: "keyUp",
          key: modifier,
          code: modifierCodes[modifier]!.code,
          windowsVirtualKeyCode: modifierCodes[modifier]!.keyCode,
          nativeVirtualKeyCode: modifierCodes[modifier]!.keyCode,
          modifiers: mask,
        },
        sessionId,
      );
      if (timedOut) void release.catch(() => {});
      else await release;
    }
  }
}
export async function selectAll(client: CdpClient, sessionId: string): Promise<void> {
  const control = {
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17,
  };
  const letter = {
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  };
  let timedOut = false;
  try {
    await client.call(
      "Input.dispatchKeyEvent",
      { type: "rawKeyDown", ...control, modifiers: 2 },
      sessionId,
    );
    try {
      await client.call(
        "Input.dispatchKeyEvent",
        { type: "rawKeyDown", ...letter, modifiers: 2, commands: ["selectAll"] },
        sessionId,
      );
    } catch (error) {
      timedOut = error instanceof CdpTimeoutError;
      throw error;
    } finally {
      const cleanup = client.call(
        "Input.dispatchKeyEvent",
        { type: "keyUp", ...letter, modifiers: 2 },
        sessionId,
      );
      if (timedOut) void cleanup.catch(() => {});
      else await cleanup;
    }
  } catch (error) {
    timedOut = error instanceof CdpTimeoutError;
    throw error;
  } finally {
    const cleanup = client.call(
      "Input.dispatchKeyEvent",
      { type: "keyUp", ...control, modifiers: 0 },
      sessionId,
    );
    if (timedOut) void cleanup.catch(() => {});
    else await cleanup;
  }
}
export async function screenshot(
  client: CdpClient,
  sessionId: string,
  quality = 80,
): Promise<Uint8Array> {
  const result = await client.call(
    "Page.captureScreenshot",
    { format: "jpeg", quality },
    sessionId,
  );
  return Uint8Array.from(Buffer.from(result.data, "base64"));
}
export async function captureScreenshot(
  client: CdpClient,
  sessionId: string,
  options: {
    quality?: number;
    clip?: { x: number; y: number; width: number; height: number; scale: number };
    timeoutMs?: number;
  } = {},
): Promise<Uint8Array> {
  const result = await client.call(
    "Page.captureScreenshot",
    {
      format: "jpeg",
      quality: options.quality ?? 70,
      ...(options.clip ? { clip: options.clip } : {}),
    },
    sessionId,
    options.timeoutMs,
  );
  return Uint8Array.from(Buffer.from(result.data, "base64"));
}
