import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { IsolatedWorld } from "../../src/browser/isolated-world.ts";
import { checkBrowser } from "../../src/browser/self-check.ts";

const normal = {
  webdriver: false,
  userAgent: "Chrome/153",
  platform: "Win32",
  brands: [],
  renderer: "AMD Radeon",
  screen: [2560, 1440],
  outer: [1366, 900],
  timezone: "Asia/Taipei",
  languages: ["zh-CN"],
  plugins: 5,
  chromeType: "object",
  notificationPermission: "default",
  queriedNotificationPermission: "prompt",
};

function world(values: typeof normal): IsolatedWorld {
  return { evaluate: async () => values } as unknown as IsolatedWorld;
}

describe("desktop Chrome self-check", () => {
  test("accepts a normal desktop fingerprint", async () => {
    const report = await checkBrowser(world(normal));
    assert.equal(report.ok, true);
    assert.equal(report.checks.length, 8);
  });

  test("reports stealth and window failures", async () => {
    const report = await checkBrowser(
      world({
        ...normal,
        webdriver: true,
        userAgent: "HeadlessChrome",
        renderer: "SwiftShader",
        outer: [0, 0],
        chromeType: "undefined",
        plugins: 0,
        notificationPermission: "denied",
        queriedNotificationPermission: "prompt",
      }),
    );
    assert.equal(report.ok, false);
    assert.deepEqual(
      report.checks.filter((check) => !check.ok).map((check) => check.name),
      [
        "webdriver",
        "user-agent",
        "renderer",
        "outer-size",
        "chrome-object",
        "plugins",
        "notifications",
      ],
    );
  });
});

test("O1a: self-check treats software rendering as informational on server-plain", async () => {
  const report = await checkBrowser(
    world({ ...normal, renderer: "SwiftShader", plugins: 0 }),
    "server-plain",
  );
  assert.equal(report.ok, true);
  assert.equal(report.stealth, "low");
  assert.deepEqual(
    report.checks.filter((check) => !check.ok).map((check) => [check.name, check.required]),
    [
      ["renderer", false],
      ["plugins", false],
    ],
  );
});

test("O1a: headless self-check accepts the HeadlessChrome user agent and a small screen", async () => {
  const report = await checkBrowser(
    world({
      ...normal,
      userAgent: "HeadlessChrome",
      screen: [800, 600],
      renderer: "llvmpipe",
      plugins: 0,
    }),
    "server-plain",
    "headless",
  );
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.checks.filter((check) => !check.ok).map((check) => check.required),
    [false, false, false, false],
  );
});

test("O1a: server-plain reports low stealth even when every check passes", async () => {
  const server = await checkBrowser(world(normal), "server-plain");
  assert.equal(server.ok, true);
  assert.ok(server.checks.every((check) => check.ok));
  assert.equal(server.stealth, "low");
  assert.equal((await checkBrowser(world(normal))).stealth, "high");
});

test("O10: a failing headless check reports low stealth", async () => {
  const report = await checkBrowser(
    world({ ...normal, webdriver: true }),
    "desktop-chrome",
    "headless",
  );
  assert.equal(report.stealth, "low");
});
