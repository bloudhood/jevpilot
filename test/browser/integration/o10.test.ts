import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findChrome, launchBrowser } from "../../../src/browser/launcher.ts";
import { click } from "../../../src/browser/input.ts";
import { createCdpDriver } from "../../../src/engine/cdp/driver.ts";
import { testProfile } from "../../support/browser-profile.ts";

const executable = await findChrome();
const skip = process.env.JEVPILOT_SKIP_BROWSER === "1" || !executable;
// Container runs need the test profile's flags (e.g. --no-sandbox) for every launch below.
const extraArgs = testProfile("").extraArgs;
const launchExtras = extraArgs ? { extraArgs } : {};

test("O10: headless launches carry no HeadlessChrome in the user agent", { skip }, async () => {
  const headers = new Map<string, { userAgent: string; brands: string }>();
  const requestWaiters = new Map<string, Array<() => void>>();
  const waitForRequest = (path: string) =>
    headers.has(path)
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`request timed out: ${path}`)), 5000);
          const waiters = requestWaiters.get(path) ?? [];
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
          requestWaiters.set(path, waiters);
        });
  const server = createServer((request, response) => {
    response.setHeader("x-worker-ua", String(request.headers["user-agent"] ?? ""));
    response.setHeader("x-worker-ch", String(request.headers["sec-ch-ua"] ?? ""));
    headers.set(request.url ?? "", {
      userAgent: String(request.headers["user-agent"] ?? ""),
      brands: String(request.headers["sec-ch-ua"] ?? ""),
    });
    for (const resolve of requestWaiters.get(request.url ?? "") ?? []) resolve();
    requestWaiters.delete(request.url ?? "");
    // Worker scripts need a JavaScript MIME type (Chrome refuses to register a service worker without one).
    if (request.url === "/worker.js" || request.url === "/sw.js")
      response.setHeader("content-type", "text/javascript");
    if (request.url === "/worker.js")
      return void response.end(
        "self.onmessage=async()=>{const r=await fetch('/worker-fetch');const h=await navigator.userAgentData?.getHighEntropyValues(['architecture']);postMessage({ua:navigator.userAgent,brands:navigator.userAgentData?.brands?.map(b=>b.brand).join(','),architecture:h?.architecture,headers:r.headers.get('x-worker-ua')})}",
      );
    if (request.url === "/sw.js")
      return void response.end("self.addEventListener('fetch',()=>{});");
    if (request.url === "/popup")
      return void response.end(
        "<!doctype html><script>document.title=navigator.userAgent</script>",
      );
    response.end(`<!doctype html><title>O10 fixture</title><button id="popup" onclick="window.open('/popup')">popup</button><script>
      const worker=new Worker('/worker.js'); worker.onmessage=e=>document.title=JSON.stringify(e.data); worker.postMessage(1);
      navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready);
    </script>`);
  });
  const directory = await mkdtemp(join(tmpdir(), "jevpilot-o10-"));
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  let headed: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server missing address");
    // desktop-chrome on Windows; server-plain (the Linux default) in containers.
    browser = await launchBrowser(
      { ...testProfile(directory), display: "headless", ...(executable ? { executable } : {}) },
      { timeoutMs: 15000, allowDegraded: true },
    );
    const page = await browser.newPage();
    await page.navigate(`http://127.0.0.1:${address.port}/probe`);
    const values = await page.world.evaluate<{
      userAgent: string;
      brands: unknown;
      screen: number[];
      outer: number[];
      dpr: number;
    }>(
      "({userAgent:navigator.userAgent,brands:navigator.userAgentData?.brands,screen:[screen.width,screen.height,screen.availWidth,screen.availHeight],outer:[outerWidth,outerHeight],dpr:devicePixelRatio})",
    );
    assert.doesNotMatch(values.userAgent, /Headless/u);
    // The --user-agent switch empties the high-entropy values; the page override restores them.
    // (Linux Chromium reports no platformVersion even headed, so check architecture instead.)
    const metadata = await page.world.evaluate<{
      architecture: string;
      fullVersionList: unknown[];
    }>("navigator.userAgentData.getHighEntropyValues(['architecture','fullVersionList'])");
    assert.ok(Array.isArray(values.brands) && values.brands.length > 0);
    assert.ok(metadata.architecture.length > 0);
    assert.ok(metadata.fullVersionList.length > 0);
    const assertHeaders = (path: string) => {
      const item = headers.get(path);
      assert.ok(item?.userAgent);
      assert.doesNotMatch(item.userAgent, /Headless/u);
      if (path === "/fetch") assert.ok(item.brands);
      if (item.brands) assert.doesNotMatch(item.brands, /Headless/u);
    };
    assertHeaders("/probe");
    await page.world.evaluate("fetch('/fetch')");
    await waitForRequest("/fetch");
    assertHeaders("/fetch");
    await waitForRequest("/worker.js");
    assertHeaders("/worker.js");
    await waitForRequest("/worker-fetch");
    assertHeaders("/worker-fetch");
    await waitForRequest("/sw.js");
    assertHeaders("/sw.js");
    // The worker reports through document.title once its fetch has come back; wait for that, not a fixed delay.
    const worker = await page.world.evaluate<{
      ua: string;
      brands: string;
      architecture: string;
      headers: string;
    }>(
      "new Promise((resolve, reject) => { const started = Date.now(); const poll = () => document.title.startsWith('{') ? resolve(JSON.parse(document.title)) : Date.now() - started > 5000 ? reject(new Error('worker result timed out')) : setTimeout(poll, 20); poll(); })",
    );
    assert.doesNotMatch(String(worker.ua), /Headless/u);
    assert.ok(worker.brands.length > 0);
    // Dedicated workers inherit the page's override, high-entropy values included.
    assert.ok(String(worker.architecture ?? "").length > 0);
    assert.doesNotMatch(String(worker.brands), /Headless/u);
    assert.doesNotMatch(String(worker.headers), /Headless/u);
    assert.ok(String(worker.headers).length > 0);
    await browser.client.call("Target.setDiscoverTargets", { discover: true });
    const popupCreated = browser.client.waitForEvent(
      "Target.targetCreated",
      (event) => {
        const target = (event as { targetInfo?: { type?: string; openerId?: string } }).targetInfo;
        return target?.type === "page" && target.openerId === page.targetId;
      },
      5000,
    );
    const position = await page.world.evaluate<{ x: number; y: number }>(
      "(()=>{const r=document.querySelector('#popup').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
    );
    await click(browser.client, page.sessionId, position.x, position.y);
    const popupEvent = await popupCreated;
    const popupTarget = (popupEvent as { targetInfo: { targetId: string } }).targetInfo;
    if (!popupTarget) throw new Error("popup target missing");
    const popupSession = await browser.client.attach(popupTarget.targetId);
    const popup = await browser.attachPage(popupTarget.targetId, popupSession);
    const popupUa = await popup.world.evaluate("navigator.userAgent");
    assert.doesNotMatch(String(popupUa), /Headless/u);
    await waitForRequest("/popup");
    assertHeaders("/popup");
    const workerTarget = (
      await browser.client.call("Target.getTargets", undefined)
    ).targetInfos.find((item) => item.type === "worker");
    assert.ok(workerTarget);
    // The service worker target can appear a little after its script request; wait for it.
    let swTarget: { targetId: string } | undefined;
    for (const started = Date.now(); !swTarget && Date.now() - started < 5000;) {
      swTarget = (await browser.client.call("Target.getTargets", undefined)).targetInfos.find(
        // Chrome's own component extensions run service workers too: pick the fixture's one.
        (item) => item.type === "service_worker" && item.url.endsWith("/sw.js"),
      );
      if (!swTarget) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(swTarget);
    const swSession = await browser.client.attach(swTarget!.targetId);
    const swUa = await browser.client.call(
      "Runtime.evaluate",
      { expression: "navigator.userAgent", returnByValue: true },
      swSession,
    );
    assert.doesNotMatch(String(swUa.result.value), /Headless/u);
    await popup.close();
    const headedDir = await mkdtemp(join(tmpdir(), "jevpilot-o10-headed-"));
    if (process.platform === "win32" || process.env.DISPLAY)
      headed = await launchBrowser(
        {
          kind: "desktop-chrome",
          display: "headed",
          userDataDir: headedDir,
          windowSize: { width: 1280, height: 900 },
          ...(executable ? { executable } : {}),
          ...launchExtras,
        },
        { selfCheck: true, allowDegraded: true },
      );
    if (headed) {
      const headedPage = await headed.newPage();
      await headedPage.navigate(`http://127.0.0.1:${address.port}/headed`);
      const headedIdentity = await headedPage.world.evaluate(
        "(async()=>{const h=await navigator.userAgentData.getHighEntropyValues(['fullVersionList','platform','platformVersion','architecture','bitness']);return {brands:navigator.userAgentData.brands, ...h}})()",
      );
      const headlessIdentity = await page.world.evaluate(
        "(async()=>{const h=await navigator.userAgentData.getHighEntropyValues(['fullVersionList','platform','platformVersion','architecture','bitness']);return {brands:navigator.userAgentData.brands, ...h}})()",
      );
      assert.deepEqual(headlessIdentity, headedIdentity);
      await headed.close();
      headed = undefined;
    }
    await rm(headedDir, { recursive: true, force: true });
  } finally {
    await browser?.close();
    await headed?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "O10: a headless page reports a screen at least as large as its window",
  { skip },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevpilot-o10-screen-"));
    let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
    try {
      browser = await launchBrowser(
        { ...testProfile(directory), display: "headless", ...(executable ? { executable } : {}) },
        { selfCheck: true, allowDegraded: true },
      );
      const page = await browser.newPage();
      const values = await page.world.evaluate<{ screen: number[]; outer: number[] }>(
        "({screen:[screen.width,screen.height],outer:[outerWidth,outerHeight]})",
      );
      assert.ok(values.screen[0]! >= values.outer[0]!);
      assert.ok(values.screen[1]! >= values.outer[1]!);
      assert.notDeepEqual(values.screen.slice(0, 2), [800, 600]);
      // The larger screen must not resize the window the executor clicks in.
      assert.deepEqual(values.outer, [1280, 900]);
    } finally {
      await browser?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

// Desktop only: in a container the desktop renderer and plugin checks fail, and server-plain is always low.
const desktopSkip =
  skip || (process.env.JEVPILOT_TEST_PROFILE === "server-plain" ? "desktop-chrome only" : false);

test("O10: the self-check reports headless stealth honestly", { skip: desktopSkip }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevpilot-o10-stealth-"));
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    const profile = {
      kind: "desktop-chrome" as const,
      userDataDir: directory,
      windowSize: { width: 1280, height: 900 },
      display: "headless" as const,
    };
    browser = await launchBrowser(
      { ...profile, display: "headless", ...(executable ? { executable } : {}), ...launchExtras },
      { selfCheck: true, allowDegraded: true },
    );
    assert.equal(browser.selfCheck?.stealth, "medium");
    const driverDirectory = await mkdtemp(join(tmpdir(), "jevpilot-o10-driver-"));
    const handle = await createCdpDriver().launch(
      { ...profile, userDataDir: driverDirectory, executable, ...launchExtras },
      { selfCheck: true, allowDegraded: true },
    );
    try {
      assert.equal(handle.engine.stealthLevel, "medium");
    } finally {
      await handle.close();
      await rm(driverDirectory, { recursive: true, force: true });
    }
    // Without a successful identity probe the UA fix is missing, so the report must drop to low.
    // A fresh module instance has an empty probe cache; the probe fails because its port file cannot be read.
    const freshUrl = new URL("../../../src/browser/launcher.ts?o10-probe-failure", import.meta.url);
    const fresh = (await import(
      freshUrl.href
    )) as typeof import("../../../src/browser/launcher.ts");
    const failedDirectory = await mkdtemp(join(tmpdir(), "jevpilot-o10-probe-fail-"));
    const warn = console.warn;
    console.warn = () => {};
    let failed: Awaited<ReturnType<typeof launchBrowser>> | undefined;
    try {
      failed = await fresh.launchBrowser(
        {
          ...profile,
          userDataDir: failedDirectory,
          ...(executable ? { executable } : {}),
          ...launchExtras,
        },
        { selfCheck: true, allowDegraded: true },
        {
          readFile: async (path: string) => {
            if (path.includes("jevpilot-probe-")) throw new Error("probe port file unreadable");
            return readFile(path, "utf8");
          },
        },
      );
      assert.equal(failed.selfCheck?.stealth, "low");
    } finally {
      console.warn = warn;
      await failed?.close();
      await rm(failedDirectory, { recursive: true, force: true });
    }
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
