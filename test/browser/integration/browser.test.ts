import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { click, insertText, screenshot, selectAll } from "../../../src/browser/input.ts";
import {
  findChrome,
  launchBrowser,
  waitForDevToolsPort,
  type BrowserInstance,
} from "../../../src/browser/launcher.ts";
import { stopBrowser } from "../../../src/browser/process.ts";
import { createCdpDriver } from "../../../src/engine/cdp/driver.ts";
import type { BrowserHandle } from "../../../src/engine/types.ts";
import { testProfile } from "../../support/browser-profile.ts";

const executable = await findChrome();
const skipped =
  process.env.JEVPILOT_SKIP_BROWSER === "1"
    ? "JEVPILOT_SKIP_BROWSER=1"
    : !executable
      ? "Chrome executable not found"
      : undefined;

describe("real Chrome driver", { skip: skipped }, () => {
  let browser: BrowserInstance;
  let directory: string;
  let baseUrl: string;
  const methods: string[] = [];
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cf-mitigated", "challenge");
    response.setHeader("server", "fixture");
    response.end(`<!doctype html>
      <button id="button">Click</button><input id="field">
      <script>
        window.pageSecret = 1;
        document.documentElement.dataset.events = "[]";
        setInterval(() => {
          document.documentElement.dataset.isolatedVisibility = typeof window.isolatedOnly;
        }, 50);
        function record(event) {
          const events = JSON.parse(document.documentElement.dataset.events);
          events.push([event.type, event.isTrusted]);
          document.documentElement.dataset.events = JSON.stringify(events);
        }
        document.querySelector("#button").addEventListener("click", record);
        document.querySelector("#field").addEventListener("input", record);
      </script><p>${request.url}</p>`);
  });
  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "jevpilot-m1a-"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("missing server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      browser = await launchBrowser(
        {
          ...testProfile(directory, { width: 1366, height: 900 }),
          ...(executable ? { executable } : {}),
        },
        { timeoutMs: 15000 },
        { cdpOptions: { onSentMethod: (method) => methods.push(method) } },
      );
    } catch (cause) {
      throw new Error(`launch failed after methods: ${methods.join(", ")}`, { cause });
    }
  });
  after(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (directory)
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  test(
    "offscreen launch passes self-check",
    {
      timeout: 20000,
      skip:
        process.env.JEVPILOT_TEST_PROFILE === "server-plain" ? "desktop-chrome only" : undefined,
    },
    () => {
      assert.equal(browser.selfCheck?.ok, true);
    },
  );
  test(
    "self-check includes window, Chrome, plugin and notification checks",
    {
      timeout: 10000,
      skip:
        process.env.JEVPILOT_TEST_PROFILE === "server-plain" ? "desktop-chrome only" : undefined,
    },
    () => {
      for (const name of ["outer-size", "chrome-object", "plugins", "notifications"]) {
        assert.equal(browser.selfCheck?.checks.find((check) => check.name === name)?.ok, true);
      }
    },
  );
  test(
    "startup tab is closed and new pages come from Target.createTarget",
    { timeout: 10000 },
    async () => {
      const before = await browser.client.call("Target.getTargets", undefined);
      const existingPages = before.targetInfos.filter((target) => target.type === "page");
      assert.equal(existingPages.length, 1);
      assert.equal(browser.sessions.size, 1);
      assert.equal(existingPages[0]?.targetId, [...browser.sessions][0]?.targetId);
      assert.equal(
        existingPages.some((target) => browser.startupTargetIds.includes(target.targetId)),
        false,
      );
      const page = await browser.newPage();
      try {
        const during = await browser.client.call("Target.getTargets", undefined);
        assert.deepEqual(
          new Set(
            during.targetInfos
              .filter((target) => target.type === "page")
              .map((target) => target.targetId),
          ),
          new Set([...browser.sessions].map((session) => session.targetId)),
        );
        assert.equal(methods.includes("Target.createTarget"), true);
      } finally {
        await page.close();
      }
    },
  );
  test("navigation captures main document status and headers", { timeout: 15000 }, async () => {
    const page = await browser.newPage();
    try {
      const result = await page.navigate(`${baseUrl}/first`);
      assert.equal(result.status, 200);
      assert.equal(result.headers["cf-mitigated"], "challenge");
      assert.match(result.headers["content-type"] ?? "", /text\/html/);
    } finally {
      await page.close();
    }
  });
  test(
    "isolated state is invisible and world recreates after navigation",
    { timeout: 15000 },
    async () => {
      const page = await browser.newPage();
      try {
        await page.navigate(`${baseUrl}/one`);
        assert.equal(await page.world.evaluate("globalThis.isolatedOnly=42; isolatedOnly"), 42);
        assert.equal(await page.world.evaluate("window.isolatedOnly"), 42);
        assert.equal(await page.world.evaluate("window.pageSecret"), undefined);
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(
          await page.world.evaluate("document.documentElement.dataset.isolatedVisibility"),
          "undefined",
        );
        await page.navigate(`${baseUrl}/two`);
        assert.equal(await page.world.evaluate("document.querySelector('p').textContent"), "/two");
        assert.equal(await page.world.evaluate("globalThis.isolatedOnly"), undefined);
      } finally {
        await page.close();
      }
    },
  );
  test("trusted click, text, select-all and JPEG", { timeout: 15000 }, async () => {
    const page = await browser.newPage();
    try {
      await page.navigate(`${baseUrl}/input`);
      const position = await page.world.evaluate<{ x: number; y: number }>(`(() => {
        const rect = document.querySelector('#button').getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      await click(browser.client, page.sessionId, position.x, position.y);
      await page.world.evaluate("document.querySelector('#field').focus()");
      await insertText(browser.client, page.sessionId, "first");
      await selectAll(browser.client, page.sessionId);
      await insertText(browser.client, page.sessionId, "replacement");
      assert.equal(
        await page.world.evaluate("document.querySelector('#field').value"),
        "replacement",
      );
      assert.deepEqual(
        JSON.parse(await page.world.evaluate<string>("document.documentElement.dataset.events")),
        [
          ["click", true],
          ["input", true],
          ["input", true],
        ],
      );
      const image = await screenshot(browser.client, page.sessionId);
      assert.equal(image[0], 0xff);
      assert.equal(image[1], 0xd8);
      assert.equal(image.at(-2), 0xff);
      assert.equal(image.at(-1), 0xd9);
    } finally {
      await page.close();
    }
  });
  test("never enables Runtime or Console", () => {
    assert.equal(methods.includes("Runtime.enable"), false);
    assert.equal(methods.includes("Console.enable"), false);
  });
  test(
    "engine handle supports navigation, isolated calls, events and trusted input",
    { timeout: 15000 },
    async () => {
      const url = await waitForDevToolsPort(directory, 15000);
      const attached = await createCdpDriver().launch(
        { kind: "attach", cdpUrl: url },
        { selfCheck: false },
      );
      const page = await attached.newPage();
      const navigated: string[] = [];
      const listener = (event: { url: string }) => navigated.push(event.url);
      page.on("navigated", listener);
      try {
        assert.equal(attached.engine.stealthLevel, "medium");
        assert.equal(attached.capabilities.isolatedExecution, true);
        assert.equal(attached.capabilities.crossOriginFrames, true);
        const result = await page.navigate(`${baseUrl}/engine`);
        assert.equal(result.status, 200);
        assert.ok(navigated.includes(`${baseUrl}/engine`));
        await page.callIsolated(() => {
          document.querySelector<HTMLInputElement>("#field")?.focus();
        }, []);
        await page.insertText("engine text");
        assert.equal(
          await page.callIsolated(
            () => document.querySelector<HTMLInputElement>("#field")?.value,
            [],
          ),
          "engine text",
        );
        assert.equal((await page.screenshot())[0], 0xff);
      } finally {
        page.off("navigated", listener);
        await page.close();
        await attached.close();
      }
    },
  );
  test(
    "attach close leaves external browser alive",
    {
      timeout: 20000,
      skip:
        process.env.JEVPILOT_TEST_PROFILE === "server-plain" ? "desktop-chrome only" : undefined,
    },
    async () => {
      const externalDir = await mkdtemp(join(tmpdir(), "jevpilot-attach-"));
      const child = spawn(
        executable as string,
        [
          "--remote-debugging-port=0",
          `--user-data-dir=${externalDir}`,
          "--disable-blink-features=AutomationControlled",
          "--no-first-run",
          "--no-default-browser-check",
          "--window-position=-3000,-3000",
          "--window-size=1366,900",
        ],
        { shell: false, stdio: "ignore" },
      );
      try {
        const url = await waitForDevToolsPort(externalDir, 15000);
        const attached = await launchBrowser({ kind: "attach", cdpUrl: url });
        await attached.close();
        assert.equal(child.exitCode, null);
      } finally {
        await stopBrowser(child);
        await rm(externalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    },
  );
  test("close exits Chrome and releases its profile directory", { timeout: 15000 }, async () => {
    const pid = browser.pid;
    assert.equal(typeof pid, "number");
    await browser.close();
    assert.throws(() => process.kill(pid as number, 0), { code: "ESRCH" });
    await rm(directory, { recursive: true });
  });
});

test("trusted click reaches a page that is not the front tab", { skip: skipped }, async () => {
  const site = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<title>Older page</title>
      <button id="marker" style="width:100px;height:48px" onclick="document.querySelector('#state').textContent='Clicked'">Mark</button>
      <a id="popup" href="/second" target="_blank" style="display:block;width:100px;height:48px">Open</a>
      <p id="state">Waiting</p>`);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const address = site.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  const directory = await mkdtemp(join(tmpdir(), "jevpilot-background-input-"));
  let driver: BrowserHandle | undefined;
  try {
    driver = await createCdpDriver().launch(
      {
        ...testProfile(directory, { width: 1000, height: 700 }),
        executable,
        extraArgs: [
          ...(testProfile(directory).extraArgs ?? []),
          "--no-proxy-server",
          "--disable-background-networking",
        ],
      },
      { timeoutMs: 15000 },
    );
    const older = await driver.newPage();
    await older.navigate(`http://127.0.0.1:${address.port}/first`);
    const newer = await driver.newPage();
    await newer.navigate(`http://127.0.0.1:${address.port}/second`);
    const marker = await older.callIsolated(() => {
      const rect = document.querySelector("#marker")!.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, []);
    await older.click(marker.x, marker.y);
    assert.equal(
      await older.callIsolated(() => document.querySelector("#state")?.textContent, []),
      "Clicked",
    );
    let popupTimer: ReturnType<typeof setTimeout>;
    const popup = new Promise<void>((resolve, reject) => {
      const onPopup = () => {
        clearTimeout(popupTimer);
        older.off("popup", onPopup);
        resolve();
      };
      older.on("popup", onPopup);
      popupTimer = setTimeout(() => {
        older.off("popup", onPopup);
        reject(new Error("popup not opened"));
      }, 3000);
    });
    const link = await older.callIsolated(() => {
      const rect = document.querySelector("#popup")!.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, []);
    await older.click(link.x, link.y);
    await popup;
  } finally {
    await driver?.close();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
