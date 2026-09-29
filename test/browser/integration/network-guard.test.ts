import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { findChrome } from "../../../src/browser/launcher.ts";
import { createCdpDriver } from "../../../src/engine/cdp/driver.ts";
import type { BrowserHandle, PageHandle } from "../../../src/engine/types.ts";
import { OrchestratorSession } from "../../../src/orchestrator/session.ts";
import { testProfile } from "../../support/browser-profile.ts";

const executable = await findChrome();
const skipped =
  process.env.JEVPILOT_SKIP_BROWSER === "1"
    ? "JEVPILOT_SKIP_BROWSER=1"
    : !executable
      ? "Chrome executable not found"
      : undefined;
const marker = "O3_SECRET_MARKER_NEVER_REPORT";

async function listen(server: Server, host: string): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture address");
  return `http://${host}:${address.port}`;
}

describe("O3 network guard in Chrome", { skip: skipped }, () => {
  let browser: BrowserHandle;
  let directory: string;
  let originA: string;
  let originB: string;
  let requestsB = 0;
  const serverA = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: `${originB}/secret` });
      response.end();
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      request.url === "/frame"
        ? `<title>Parent works</title><p>Parent works</p><iframe onload="document.body.dataset.frameDone = '1'" src="${originB}/secret"></iframe>`
        : `<title>Allowed</title><p>Allowed</p><button id="open" style="position:fixed;left:10px;top:10px;width:120px;height:40px" onclick="window.open('${originB}/secret')">Open</button>`,
    );
  });
  const serverB = createServer((_request, response) => {
    requestsB++;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<title>${marker}</title><p>${marker}</p>`);
  });
  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "jevpilot-o3-"));
    originA = await listen(serverA, "127.0.0.1");
    originB = await listen(serverB, "127.0.0.2");
    browser = await createCdpDriver().launch(
      {
        ...testProfile(directory),
        executable,
        extraArgs: [
          ...(testProfile(directory).extraArgs ?? []),
          "--no-proxy-server",
          "--host-resolver-rules=MAP rebind.test 127.0.0.2",
        ],
      },
      { networkGuard: { mode: "metadata", extraBlocked: ["127.0.0.2/32"] } },
    );
  });
  after(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => serverA.close(() => resolve()));
    await new Promise<void>((resolve) => serverB.close(() => resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function navigate(
    url: string,
  ): Promise<{ page: PageHandle; result: Awaited<ReturnType<OrchestratorSession["run"]>> }> {
    const page = await browser.newPage();
    const navigation = await page.navigate(url, { timeoutMs: 5000 });
    const session = new OrchestratorSession({ page, goal: "Read page", navigation });
    return { page, result: await session.run() };
  }
  test("O3: navigating to a blocked address is stopped before the request is sent", async () => {
    const beforeCount = requestsB;
    const { page, result } = await navigate(`${originB}/secret`);
    assert.equal(requestsB, beforeCount);
    assert.equal(result.status, "BLOCKED_BY_POLICY");
    assert.ok(!JSON.stringify(result).includes(marker));
    await page.close();
  });
  test("O3: a redirect to a blocked address is stopped at the redirect", async () => {
    const beforeCount = requestsB;
    const { page, result } = await navigate(`${originA}/redirect`);
    assert.equal(requestsB, beforeCount);
    assert.equal(result.status, "BLOCKED_BY_POLICY");
    await page.close();
  });
  test("O3: a host the browser resolves to a blocked address is caught by the response check", async () => {
    const { page, result } = await navigate(`http://rebind.test:${new URL(originB).port}/secret`);
    assert.equal(
      result.status,
      "BLOCKED_BY_POLICY",
      JSON.stringify({ reason: result.reason, question: result.question, url: result.url }),
    );
    assert.ok(!JSON.stringify(result).includes(marker));
    await page.close();
  });
  test("O3: an iframe pointing at a blocked address does not load while the page keeps working", async () => {
    const beforeCount = requestsB;
    const page = await browser.newPage();
    const navigation = await page.navigate(`${originA}/frame`);
    // Wait until the iframe navigation has finished (its load event also fires for the error page).
    for (let waited = 0; waited < 5000; waited += 50) {
      if (await page.callIsolated(() => document.body.dataset.frameDone === "1", [])) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(
      await page.callIsolated(() => document.body.dataset.frameDone, []),
      "1",
      "the iframe navigation finished",
    );
    assert.equal(requestsB, beforeCount);
    const session = new OrchestratorSession({ page, goal: "Read page", navigation });
    const observed = await session.observe("full");
    assert.notEqual(observed.status, "BLOCKED_BY_POLICY");
    assert.match(JSON.stringify(observed), /Parent works/u);
    assert.ok(!JSON.stringify(observed).includes(marker));
    await page.close();
  });
  test("O3: a popup opened to a blocked address is not followed", async () => {
    const page = await browser.newPage();
    await page.navigate(originA);
    const baseline = browser.pages().length;
    let opening = 0;
    let followed = 0;
    page.on("popupOpening", () => opening++);
    page.on("popup", () => followed++);
    // A trusted click carries user activation, so Chrome's popup blocker lets window.open through.
    await page.click(70, 30);
    for (let waited = 0; waited < 3000 && opening === 0; waited += 50)
      await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.ok(opening > 0, "the popup was really opened");
    assert.equal(followed, 0);
    assert.equal(browser.pages().length, baseline);
    await page.close();
  });
  test("O3: localhost and private addresses stay reachable with the default guard", async () => {
    const defaultDirectory = await mkdtemp(join(tmpdir(), "jevpilot-o3-default-"));
    const defaultBrowser = await createCdpDriver().launch({
      ...testProfile(defaultDirectory),
      executable,
    });
    try {
      for (const url of [originA, originB]) {
        const page = await defaultBrowser.newPage();
        const result = await page.navigate(url);
        assert.equal(result.status, 200);
        await page.close();
      }
    } finally {
      await defaultBrowser.close();
      await rm(defaultDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});
