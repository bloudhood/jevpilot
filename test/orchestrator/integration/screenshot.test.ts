import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { findChrome } from "../../../src/browser/launcher.ts";
import { MockDecider } from "../../../src/decision/mock.ts";
import { createCdpDriver } from "../../../src/engine/cdp/driver.ts";
import type { BrowserHandle } from "../../../src/engine/types.ts";
import { OrchestratorSession } from "../../../src/orchestrator/session.ts";
import { testProfile } from "../../support/browser-profile.ts";

const executable = process.env.JEVPILOT_SKIP_BROWSER === "1" ? undefined : await findChrome();
const skipped =
  process.env.JEVPILOT_SKIP_BROWSER === "1"
    ? "JEVPILOT_SKIP_BROWSER=1"
    : !executable
      ? "Chrome executable not found"
      : undefined;

/** Reads the frame size from a JPEG's SOF0/SOF2 segment (width and height in pixels). */
function jpegSize(data: Uint8Array): { width: number; height: number } {
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error("not a JPEG");
  let offset = 2;
  while (offset + 9 <= data.length) {
    if (data[offset] !== 0xff) throw new Error("invalid JPEG marker");
    let markerOffset = offset;
    while (data[markerOffset] === 0xff && data[markerOffset + 1] === 0xff) markerOffset++;
    const marker = data[markerOffset + 1]!;
    const length = (data[markerOffset + 2]! << 8) | data[markerOffset + 3]!;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = (data[markerOffset + 5]! << 8) | data[markerOffset + 6]!;
      const width = (data[markerOffset + 7]! << 8) | data[markerOffset + 8]!;
      return { width, height };
    }
    offset = markerOffset + 2 + length;
  }
  throw new Error("JPEG has no SOF marker");
}

describe("M7b browser_screenshot local fixture", { skip: skipped }, () => {
  let server: Server;
  let crossServer: Server;
  let browser: BrowserHandle;
  let directory: string;
  let base: string;
  let crossBase: string;

  before(async () => {
    crossServer = createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(
        "<!doctype html><title>Inner</title><style>html,body{margin:0}</style>" +
          '<button id="inner" style="box-sizing:border-box;width:150px;height:90px">Inner target</button>',
      );
    });
    await new Promise<void>((resolve) => crossServer.listen(0, "127.0.0.1", resolve));
    const crossAddress = crossServer.address();
    if (!crossAddress || typeof crossAddress === "string")
      throw new Error("cross fixture has no port");
    crossBase = `http://127.0.0.1:${crossAddress.port}`;

    server = createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      const path = (request.url ?? "/").split("?")[0];
      const pages: Record<string, string> = {
        "/viewport":
          "<!doctype html><title>Viewport</title><style>html,body{margin:0}</style>" +
          '<p>Viewport fixture</p><div style="height:3000px;width:100%"></div>',
        "/element":
          "<!doctype html><title>Element</title><style>html,body{margin:0}</style>" +
          '<button id="clip" style="box-sizing:border-box;width:200px;height:80px">Clip target</button>',
        "/scroll":
          "<!doctype html><title>Scroll</title><style>html,body{margin:0}</style>" +
          '<div style="height:3000px"></div>' +
          '<button id="deep" style="box-sizing:border-box;width:180px;height:70px">Deep target</button>',
        "/resize":
          "<!doctype html><title>Resize</title><style>html,body{margin:0}</style>" +
          '<button id="target" style="box-sizing:border-box;width:120px;height:60px">Resize target</button>',
        "/frame":
          "<!doctype html><title>Frame</title><style>html,body{margin:0}</style>" +
          `<iframe src="${crossBase}/inner" style="width:400px;height:300px;border:0"></iframe>`,
        "/dialog": '<!doctype html><title>Dialog</title><button id="ask">Ask</button>',
      };
      response.end(pages[path ?? ""] ?? pages["/viewport"]);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server has no port");
    base = `http://127.0.0.1:${address.port}`;

    directory = await mkdtemp(join(tmpdir(), "jevpilot-screenshot-browser-"));
    browser = await createCdpDriver().launch(
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
  });

  after(async () => {
    await browser?.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (crossServer) await new Promise<void>((resolve) => crossServer.close(() => resolve()));
    if (directory)
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  async function opened(path: string): Promise<OrchestratorSession> {
    const page = await browser.newPage();
    const navigation = await page.navigate(`${base}${path}`);
    const mock = new MockDecider(() => ({ answers: {} }));
    return new OrchestratorSession(
      {
        page,
        navigation,
        goal: "Capture the fixture page",
        constraints: { allowed_domains: ["127.0.0.1"] },
      },
      { decide: (request) => mock.decide(request) },
    );
  }

  function observed(session: OrchestratorSession, name: string) {
    const element = session.lastObservation?.elements.find((item) => item.name === name);
    assert.ok(element, `element ${JSON.stringify(name)} was not observed`);
    return element;
  }

  test("M7b: viewport screenshot is CSS-pixel sized", async () => {
    const session = await opened("/viewport");
    try {
      await session.observe();
      const metrics = await session.page.callIsolated(
        () => ({
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          clientWidth: document.documentElement.clientWidth,
          clientHeight: document.documentElement.clientHeight,
        }),
        [],
      );
      const result = await session.screenshot();
      assert.ok(result.ok, JSON.stringify(result));
      const size = jpegSize(result.capture.data);
      // The image is the visual viewport in CSS pixels: the page width minus the scrollbar.
      assert.ok(
        Math.abs(size.width - metrics.clientWidth) <= 1,
        `image width ${size.width} should match clientWidth ${metrics.clientWidth}`,
      );
      assert.ok(
        size.width <= metrics.innerWidth,
        `image width ${size.width} cannot exceed innerWidth ${metrics.innerWidth}`,
      );
      assert.ok(
        Math.abs(size.height - metrics.clientHeight) <= 1,
        `image height ${size.height} should match clientHeight ${metrics.clientHeight}`,
      );
    } finally {
      await session.close();
    }
  });

  test("M7b: background tab screenshot shows current content", async () => {
    const session = await opened("/resize");
    try {
      await session.observe();
      const foreground = await session.screenshot();
      assert.ok(foreground.ok, JSON.stringify(foreground));
      // Opening a second tab turns the session's tab into a background tab.
      const other = await browser.newPage();
      try {
        await other.navigate(`${base}/viewport`);
        await session.page.callIsolated(() => {
          document.body.style.background = "#000";
          document.body.style.height = "100vh";
        }, []);
        const background = await session.screenshot();
        assert.ok(background.ok, JSON.stringify(background));
        const before = Buffer.from(foreground.capture.data);
        const after = Buffer.from(background.capture.data);
        assert.notEqual(
          Buffer.compare(after, before),
          0,
          "the background capture was a stale frame, not the page's current content",
        );
      } finally {
        await other.close();
      }
    } finally {
      await session.close();
    }
  });

  test("M7b: ref screenshot clips the element", async () => {
    const session = await opened("/element");
    try {
      await session.observe();
      const element = observed(session, "Clip target");
      assert.equal(element.inViewport, true, "fixture element should be in the viewport");
      const result = await session.screenshot({ ref: element.ref });
      assert.ok(result.ok, JSON.stringify(result));
      const size = jpegSize(result.capture.data);
      assert.ok(Math.abs(result.capture.width - 200) <= 1, `clip width ${result.capture.width}`);
      assert.ok(Math.abs(result.capture.height - 80) <= 1, `clip height ${result.capture.height}`);
      assert.ok(Math.abs(size.width - 200) <= 1, `image width ${size.width}`);
      assert.ok(Math.abs(size.height - 80) <= 1, `image height ${size.height}`);
      assert.equal(result.title, "Element");
      assert.match(result.url, /\/element$/u);
    } finally {
      await session.close();
    }
  });

  test("M7b: ref screenshot scrolls an off-screen element into view", async () => {
    const session = await opened("/scroll");
    try {
      await session.observe();
      const element = observed(session, "Deep target");
      assert.equal(element.inViewport, false, "fixture element should start off-screen");
      const result = await session.screenshot({ ref: element.ref });
      assert.ok(result.ok, JSON.stringify(result));
      const size = jpegSize(result.capture.data);
      assert.ok(Math.abs(size.width - 180) <= 1, `image width ${size.width}`);
      assert.ok(Math.abs(size.height - 70) <= 1, `image height ${size.height}`);
      const fullyVisible = await session.page.callIsolated(() => {
        const button = document.getElementById("deep")!;
        const rect = button.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= window.innerHeight;
      }, []);
      assert.equal(fullyVisible, true, "the element should have been scrolled into view");
    } finally {
      await session.close();
    }
  });

  test("M7b: ref screenshot of an element in a cross-origin iframe", async () => {
    const session = await opened("/frame");
    try {
      await session.observe();
      const element = observed(session, "Inner target");
      assert.match(element.ref, /^frame:/u);
      const result = await session.screenshot({ ref: element.ref });
      assert.ok(result.ok, JSON.stringify(result));
      const size = jpegSize(result.capture.data);
      assert.ok(Math.abs(size.width - 150) <= 1, `image width ${size.width}`);
      assert.ok(Math.abs(size.height - 90) <= 1, `image height ${size.height}`);
    } finally {
      await session.close();
    }
  });

  test("M7b: screenshot with a JavaScript dialog open returns within the timeout", async () => {
    const session = await opened("/dialog");
    try {
      await session.observe();
      // Schedule the dialog so the screenshot is requested before the renderer blocks on it.
      await session.page.callIsolated(() => {
        setTimeout(() => window.confirm("Hold the page"), 0);
        return true;
      }, []);
      const started = Date.now();
      const result = await session.screenshot();
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 6000, `screenshot took ${elapsed}ms with a dialog open`);
      if (!result.ok) assert.equal(result.reason, "unresponsive", JSON.stringify(result));
    } finally {
      await session.close();
    }
  });
});
