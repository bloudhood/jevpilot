import assert from "node:assert/strict";
import { test } from "node:test";
import type { CdpClient } from "../../src/browser/cdp/client.ts";
import { CdpTimeoutError } from "../../src/browser/errors.ts";
import { keyPress, selectAll, drag } from "../../src/browser/input.ts";
import { BrowserSession } from "../../src/browser/session.ts";
import { buildLaunchArgs } from "../../src/browser/launcher.ts";
import { loadMcpProfile } from "../../src/mcp/profile.ts";

for (const [title, operation, expected] of [
  [
    "R10: a key press whose main key times out still releases the key and its modifiers",
    (client: CdpClient) => keyPress(client, "s1", "Control+Shift+a"),
    ["a", "Shift", "Control"],
  ],
  [
    "R10: selectAll releases Control after its letter times out",
    (client: CdpClient) => selectAll(client, "s1"),
    ["a", "Control"],
  ],
  [
    "R10: a drag that times out still turns drag interception off",
    (client: CdpClient) => drag(client, "s1", { x: 0, y: 0 }, { x: 10, y: 10 }),
    [false],
  ],
] as const) {
  test(title, { timeout: 1000 }, async () => {
    const timeout = new CdpTimeoutError("busy renderer", "s1");
    const released: unknown[] = [];
    const client = {
      on: () => () => {},
      call: async (method: string, params: Record<string, unknown>) => {
        if (
          params.type === "keyUp" ||
          (method === "Input.setInterceptDrags" && params.enabled === false)
        ) {
          released.push(params.key ?? params.enabled);
          return new Promise(() => {});
        }
        if (params.key === "a" || params.type === "mouseMoved") throw timeout;
        return {};
      },
    } as unknown as CdpClient;
    await assert.rejects(operation(client), (error) => error === timeout);
    assert.deepEqual(released, expected);
  });
}

test("R10: navigation without a frame tree does not report a child frame's response status", async () => {
  for (const mainResponse of [true, false]) {
    let responseListener: (event: unknown) => void = () => {};
    let lifecycleDone: (value: unknown) => void = () => {};
    const emit = (frame: string) =>
      responseListener({
        type: "Document",
        frameId: frame,
        response: {
          url: `http://test/${frame}`,
          status: frame === "main" ? 200 : 404,
          headers: { "X-Frame": frame },
        },
      });
    const client = {
      on: (_method: string, listener: (event: unknown) => void) => {
        responseListener = listener;
        return () => {};
      },
      waitForEvent: () =>
        new Promise((resolve) => {
          lifecycleDone = resolve;
        }),
      call: async (method: string) => {
        if (method === "Page.getFrameTree") throw new CdpTimeoutError("tree");
        if (method === "Page.navigate") {
          for (const frame of mainResponse ? ["main", "child"] : ["child"]) emit(frame);
          // A child frame's document usually arrives after Page.navigate has returned.
          setTimeout(() => {
            emit("child");
            lifecycleDone({});
          }, 0);
          return { frameId: "main" };
        }
        return {};
      },
    } as unknown as CdpClient;
    const session = await BrowserSession.attached(client, "target", "s1", () => {});
    const result = await session.navigate("http://test/");
    assert.equal(result.status, mainResponse ? 200 : undefined);
    assert.deepEqual(result.headers, mainResponse ? { "x-frame": "main" } : {});
  }
});

test("R10: a profile whose extraArgs override a managed browser switch is refused", () => {
  for (const flag of [
    "--user-data-dir",
    "--remote-debugging-port",
    "--remote-debugging-pipe",
    "--remote-debugging-address",
    "--proxy-server",
  ])
    for (const argument of [flag, `${flag}=override`])
      assert.throws(
        () =>
          buildLaunchArgs({
            kind: "desktop-chrome",
            userDataDir: "profile",
            windowSize: { width: 800, height: 600 },
            extraArgs: [argument],
          }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(flag) &&
          (flag !== "--proxy-server" || error.message.includes("proxy field")),
      );
});

test("R10: a JEVPILOT_EXTRA_ARGS flag split at a space is refused with a pointer to JEVPILOT_PROFILE_FILE", async () => {
  await assert.rejects(
    loadMcpProfile({
      JEVPILOT_EXTRA_ARGS: "--host-resolver-rules=MAP *.internal.test 169.254.169.254",
    }),
    /flags containing spaces.*extraArgs.*JEVPILOT_PROFILE_FILE/u,
  );
});
