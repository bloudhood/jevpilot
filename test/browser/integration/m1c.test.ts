import assert from "node:assert/strict";
import { createServer, type RequestListener, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { after, before, describe, test } from "node:test";
import { BrowserConfigError, DialogBlockingError } from "../../../src/browser/errors.ts";
import { CdpClient } from "../../../src/browser/cdp/client.ts";
import { findChrome, waitForDevToolsPort } from "../../../src/browser/launcher.ts";
import { spawnBrowser, stopBrowser } from "../../../src/browser/process.ts";
import { createCdpDriver } from "../../../src/engine/cdp/driver.ts";
import type { BrowserHandle, PageEvents, PageHandle } from "../../../src/engine/types.ts";
import { observe } from "../../../src/observer/observe.ts";
import { resolveRef } from "../../../src/observer/page-snapshot.ts";
import { testProfile } from "../../support/browser-profile.ts";

const executable = await findChrome();
const skipped =
  process.env.JEVPILOT_SKIP_BROWSER === "1"
    ? "JEVPILOT_SKIP_BROWSER=1"
    : !executable
      ? "Chrome executable not found"
      : undefined;

async function listen(server: Server, host = "127.0.0.1"): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("missing HTTP address");
  return `http://${host}:${address.port}`;
}

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition timed out");
}

function nextEvent<K extends keyof PageEvents>(page: PageHandle, name: K): Promise<PageEvents[K]> {
  return new Promise((resolve) => {
    const handler = (event: PageEvents[K]) => {
      page.off(name, handler);
      resolve(event);
    };
    page.on(name, handler);
  });
}

describe("M1c real Chrome", { skip: skipped }, () => {
  let browser: BrowserHandle;
  let directory: string;
  let origin: string;
  let childOrigin: string;
  let oopifOrigin: string;
  let probe: CdpClient;
  const methods: { method: string; sessionId?: string }[] = [];
  function assertTestDownloadPath(path: string | undefined): asserts path is string {
    const withinProfile = path ? relative(directory, path) : undefined;
    assert.ok(
      withinProfile &&
        withinProfile !== ".." &&
        !withinProfile.startsWith(`..${sep}`) &&
        !isAbsolute(withinProfile),
      `download escaped test profile: ${path}`,
    );
  }
  const serveChild: RequestListener = (_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      '<!doctype html><label for="inside">Inside frame</label><input id="inside"><button id="trusted">Trusted</button><script>document.querySelector("#trusted").onclick=e=>document.body.dataset.trusted=String(e.isTrusted)</script>',
    );
  };
  const childServer = createServer(serveChild);
  const oopifServer = createServer(serveChild);
  const server = createServer((request, response) => {
    if (request.url === "/file") {
      response.setHeader("content-type", "application/octet-stream");
      response.setHeader("content-disposition", 'attachment; filename="payload.txt"');
      response.end("M1c download bytes");
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><title>M1c fixture</title>
      <iframe id="cross" src="${request.url === "/oopif" ? oopifOrigin : childOrigin}/iframe" style="position:absolute;left:80px;top:90px;width:400px;height:200px"></iframe>
      <button id="alert" onclick="alert('notice')">Alert</button>
      <button id="confirm" onclick="document.body.dataset.confirm=String(confirm('confirm?'))">Confirm</button>
      <button id="prompt" onclick="document.body.dataset.prompt=prompt('prompt?', 'default')">Prompt</button>
      <button id="open" onclick="window.open('/popup')">Open</button>
      <a id="blank" target="_blank" href="/popup">Blank</a>
      <a id="download" href="/file">Download</a>
      <input id="upload" type="file" onchange="document.body.dataset.upload=this.files[0].name+':'+this.files[0].size">
      <p>${request.url}</p>`);
  });
  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "jevpilot-m1c-"));
    childOrigin = await listen(childServer);
    oopifOrigin = await listen(oopifServer, "localhost");
    origin = await listen(server);
    browser = await createCdpDriver({
      cdpOptions: {
        onSentMethod: (method, sessionId) =>
          methods.push({ method, ...(sessionId ? { sessionId } : {}) }),
      },
    }).launch({ ...testProfile(directory), executable }, { timeoutMs: 15000 });
    probe = await CdpClient.connect(await waitForDevToolsPort(directory));
  });
  after(async () => {
    await browser?.close();
    probe?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => childServer.close(() => resolve()));
    await new Promise<void>((resolve) => oopifServer.close(() => resolve()));
    if (directory)
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  async function checkFrame(url: string, expectOopif: boolean): Promise<void> {
    const page = await browser.newPage();
    try {
      await page.navigate(url);
      const state = await until(async () => {
        const snapshot = await observe(page);
        return snapshot.elements.some((element) => element.name === "Inside frame")
          ? snapshot
          : undefined;
      });
      assert.equal(state.elements.filter((element) => element.name === "Inside frame").length, 1);
      const targets = await probe.call("Target.getTargets", undefined);
      const frameOrigin = expectOopif ? oopifOrigin : childOrigin;
      assert.equal(
        targets.targetInfos.some(
          (target) => target.type === "iframe" && target.url.startsWith(frameOrigin),
        ),
        expectOopif,
      );
      const field = state.elements.find((element) => element.name === "Inside frame");
      if (!field) throw new Error("iframe field missing");
      assert.ok(field.ref.startsWith("frame:"));
      assert.ok(field.rect.x >= 80 && field.rect.y >= 90);
      const resolved = await resolveRef(page, state.epoch, field.ref, field.fingerprint);
      assert.equal(resolved.status, "ok");
      assert.equal(resolved.rect?.x, field.rect.x);
      await page.click(field.rect.x + 5, field.rect.y + 5);
      await page.insertText("frame text");
      const frame = (await page.frames()).find(
        (candidate) => candidate.id === field.ref.split("@")[0]?.slice(6),
      );
      if (!frame) throw new Error("frame handle missing");
      assert.equal(
        await frame.callIsolated(
          () => document.querySelector<HTMLInputElement>("#inside")?.value,
          [],
        ),
        "frame text",
      );
      const button = state.elements.find((element) => element.name === "Trusted");
      if (!button) throw new Error("frame button missing");
      await page.click(button.rect.x + 5, button.rect.y + 5);
      assert.equal(await frame.callIsolated(() => document.body.dataset.trusted, []), "true");
    } finally {
      await page.close();
    }
  }

  test(
    "OOPIF frame has target, frame refs, top-level rects and trusted input",
    { timeout: 20000 },
    () => checkFrame(`${origin}/oopif`, true),
  );
  test(
    "same-site cross-origin frame has no target but is observed with trusted input",
    { timeout: 20000 },
    () => checkFrame(origin, false),
  );

  test(
    "alert auto-accepts; confirm and prompt events answer; pending dialog fails fast",
    { timeout: 20000 },
    async () => {
      const page = await browser.newPage();
      try {
        await page.navigate(origin);
        const alertEvent = nextEvent(page, "dialog");
        await page.callIsolated(
          () => document.querySelector<HTMLButtonElement>("#alert")?.click(),
          [],
        );
        assert.equal((await alertEvent).kind, "alert");
        const confirmEvent = nextEvent(page, "dialog");
        const blocked = assert.rejects(
          page.callIsolated(
            () => document.querySelector<HTMLButtonElement>("#confirm")?.click(),
            [],
          ),
          DialogBlockingError,
        );
        assert.equal((await confirmEvent).kind, "confirm");
        await assert.rejects(
          page.callIsolated(() => true, []),
          DialogBlockingError,
        );
        await page.handleDialog(true);
        await blocked;
        const promptEvent = nextEvent(page, "dialog");
        const pending = assert.rejects(
          page.callIsolated(
            () => document.querySelector<HTMLButtonElement>("#prompt")?.click(),
            [],
          ),
          DialogBlockingError,
        );
        assert.equal((await promptEvent).defaultPrompt, "default");
        await page.handleDialog(true, "answer");
        await pending;
        assert.equal(await page.callIsolated(() => document.body.dataset.prompt, []), "answer");
      } finally {
        await page.close();
      }
    },
  );

  test(
    "trusted confirm click returns dialog details before CDP mouse release completes",
    { timeout: 20000 },
    async () => {
      const page = await browser.newPage();
      try {
        await page.navigate(origin);
        const rect = await page.callIsolated(() => {
          const box = document
            .querySelector<HTMLButtonElement>("#confirm")
            ?.getBoundingClientRect();
          return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : undefined;
        }, []);
        if (!rect) throw new Error("confirm button missing");
        const dialogEvent = nextEvent(page, "dialog");
        const action = Promise.allSettled([page.click(rect.x, rect.y)]);
        const dialog = await dialogEvent;
        const [outcome] = await action;
        if (outcome?.status !== "fulfilled") throw outcome?.reason;
        assert.deepEqual(outcome.value.dialog, dialog);
        await assert.rejects(
          page.callIsolated(() => true, []),
          DialogBlockingError,
        );
        await page.handleDialog(true);
        assert.equal(await page.callIsolated(() => document.body.dataset.confirm, []), "true");
      } finally {
        await page.close();
      }
    },
  );

  test(
    "window.open and target blank each yield a ready managed popup",
    { timeout: 20000 },
    async () => {
      const opener = await browser.newPage();
      try {
        await opener.navigate(origin);
        for (const selector of ["#open", "#blank"]) {
          const popupEvent = nextEvent(opener, "popup");
          const rect = await opener.callIsolated(
            (target) => {
              const box = document.querySelector<HTMLElement>(target)?.getBoundingClientRect();
              return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : undefined;
            },
            [selector],
          );
          if (!rect) throw new Error(`popup control missing: ${selector}`);
          await opener.click(rect.x, rect.y);
          const popup = await popupEvent;
          assert.ok(browser.pages().some((page) => page.id === popup.id));
          await popup.navigate(`${origin}/popup`);
          assert.equal((await observe(popup)).title, "M1c fixture");
        }
        await opener.close();
        assert.equal(browser.pages().length, 2);
      } finally {
        await opener.close();
      }
    },
  );

  test("browser close releases opener and popup targets", { timeout: 20000 }, async () => {
    const url = await waitForDevToolsPort(directory);
    const probe = await CdpClient.connect(url);
    const downloadDirsBefore = new Set(
      (await readdir(tmpdir())).filter((name) => name.startsWith("jevpilot-downloads-")),
    );
    const attachMethods: string[] = [];
    const attached = await createCdpDriver({
      cdpOptions: { onSentMethod: (method) => attachMethods.push(method) },
    }).launch({ kind: "attach", cdpUrl: url }, { selfCheck: false });
    const createdDownloadDirs = (await readdir(tmpdir())).filter(
      (name) => name.startsWith("jevpilot-downloads-") && !downloadDirsBefore.has(name),
    );
    try {
      assert.equal(createdDownloadDirs.length, 0);
      assert.equal(attached.capabilities.downloads, false);
      assert.equal(attachMethods.includes("Browser.setDownloadBehavior"), false);
      const opener = await attached.newPage();
      await opener.navigate(origin);
      const popupEvent = nextEvent(opener, "popup");
      const rect = await opener.callIsolated(() => {
        const box = document.querySelector<HTMLElement>("#open")?.getBoundingClientRect();
        return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : undefined;
      }, []);
      if (!rect) throw new Error("popup control missing");
      await opener.click(rect.x, rect.y);
      const popup = await popupEvent;
      const ids = [opener.id, popup.id];
      await attached.close();
      const downloadDirsAfter = new Set(await readdir(tmpdir()));
      assert.equal(
        createdDownloadDirs.some((name) => downloadDirsAfter.has(name)),
        false,
      );
      assert.equal(attachMethods.includes("Browser.setDownloadBehavior"), false);
      const targets = await probe.call("Target.getTargets", undefined);
      assert.equal(
        targets.targetInfos.some((target) => ids.includes(target.targetId)),
        false,
      );
    } finally {
      await attached.close();
      probe.close();
    }
  });

  test("attach cannot override downloads owned by desktop Chrome", { timeout: 10000 }, async () => {
    const url = await waitForDevToolsPort(directory);
    await assert.rejects(
      createCdpDriver().launch(
        { kind: "attach", cdpUrl: url },
        { selfCheck: false, manageDownloads: true },
      ),
      BrowserConfigError,
    );
  });

  test(
    "closing default attach preserves desktop download directory",
    { timeout: 20000 },
    async () => {
      const url = await waitForDevToolsPort(directory);
      const attached = await createCdpDriver().launch(
        { kind: "attach", cdpUrl: url },
        { selfCheck: false },
      );
      await attached.close();
      const page = await browser.newPage();
      try {
        await page.navigate(origin);
        const completed = page.waitForDownload((event) => event.state === "completed", 10000);
        await page.callIsolated(
          () => document.querySelector<HTMLAnchorElement>("#download")?.click(),
          [],
        );
        const event = await completed;
        assertTestDownloadPath(event.path);
        assert.equal(dirname(event.path), join(directory, "downloads"));
      } finally {
        await page.close();
      }
    },
  );

  test(
    "opt-in external attach removes its managed temporary download directory",
    {
      timeout: 30000,
      skip:
        process.env.JEVPILOT_TEST_PROFILE === "server-plain" ? "desktop-chrome only" : undefined,
    },
    async () => {
      if (!executable) throw new Error("Chrome executable missing");
      const externalDir = await mkdtemp(join(tmpdir(), "jevpilot-download-external-"));
      const child = spawnBrowser(executable, [
        "--remote-debugging-port=0",
        `--user-data-dir=${externalDir}`,
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-position=-3000,-3000",
        "--window-size=1280,900",
      ]);
      let attached: BrowserHandle | undefined;
      try {
        const url = await waitForDevToolsPort(externalDir, 15000);
        const before = new Set(
          (await readdir(tmpdir())).filter((name) => name.startsWith("jevpilot-downloads-")),
        );
        const sent: string[] = [];
        attached = await createCdpDriver({
          cdpOptions: { onSentMethod: (method) => sent.push(method) },
        }).launch({ kind: "attach", cdpUrl: url }, { selfCheck: false, manageDownloads: true });
        assert.equal(attached.capabilities.downloads, true);
        const created = (await readdir(tmpdir())).filter(
          (name) => name.startsWith("jevpilot-downloads-") && !before.has(name),
        );
        assert.equal(created.length, 1);
        await attached.close();
        attached = undefined;
        const after = new Set(await readdir(tmpdir()));
        assert.equal(
          created.some((name) => after.has(name)),
          false,
        );
        // Set on launch, reset to default on close (user decision 2026-09-29).
        assert.equal(sent.filter((method) => method === "Browser.setDownloadBehavior").length, 2);
      } finally {
        await attached?.close();
        await stopBrowser(child);
        await rm(externalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    },
  );

  test(
    "download emits started and completed and reports exact file bytes",
    { timeout: 20000 },
    async () => {
      const page = await browser.newPage();
      try {
        await page.navigate(origin);
        const started = nextEvent(page, "download");
        const completed = page.waitForDownload((event) => event.state === "completed", 10000);
        await page.callIsolated(
          () => document.querySelector<HTMLAnchorElement>("#download")?.click(),
          [],
        );
        const startEvent = await started;
        const event = await completed;
        assertTestDownloadPath(event.path);
        assert.equal(startEvent.state, "started");
        assert.equal(dirname(event.path), join(directory, "downloads"));
        assert.equal(await readFile(event.path, "utf8"), "M1c download bytes");
      } finally {
        await page.close();
      }
    },
  );

  test("setInputFiles lets page read uploaded name and size", { timeout: 15000 }, async () => {
    const page = await browser.newPage();
    const file = join(directory, "upload.txt");
    try {
      await writeFile(file, "seven!");
      await page.navigate(origin);
      await page.setInputFiles(
        () => document.querySelector<HTMLInputElement>("#upload"),
        [],
        [file],
      );
      assert.equal(await page.callIsolated(() => document.body.dataset.upload, []), "upload.txt:6");
    } finally {
      await page.close();
    }
  });

  test("all page, child-frame and popup sessions avoid Runtime.enable and Console.enable", () => {
    assert.equal(
      methods.filter((entry) => entry.method === "Browser.setDownloadBehavior").length,
      1,
    );
    assert.equal(
      methods.some(
        (entry) => entry.method === "Runtime.enable" || entry.method === "Console.enable",
      ),
      false,
    );
    assert.ok(
      methods.some((entry) => entry.method === "Page.createIsolatedWorld" && entry.sessionId),
    );
  });
});
