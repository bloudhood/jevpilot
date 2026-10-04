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
import { locateRef } from "../../../src/observer/page-snapshot.ts";
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
  let crossSiteBase: string;

  before(async () => {
    crossServer = createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      if (request.url === "/top") {
        response.end(
          '<!doctype html><style>html,body{margin:0}</style><button style="box-sizing:border-box;width:180px;height:70px">Top frame target</button>',
        );
        return;
      }
      if (request.url === "/offset-inner") {
        response.end(
          '<!doctype html><style>html,body{margin:0}</style><button style="position:absolute;left:30px;top:40px;width:150px;height:90px">Offset target</button>',
        );
        return;
      }
      if (request.url === "/deep") {
        response.end(
          "<!doctype html><title>Deep frame</title><style>html,body{margin:0}</style>" +
            '<div style="height:400px"></div>' +
            '<button id="deep" style="box-sizing:border-box;width:180px;height:70px">Deep frame target</button>',
        );
        return;
      }
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
    // A different site (localhost vs 127.0.0.1) puts the frame in its own process (OOPIF).
    crossSiteBase = `http://localhost:${crossAddress.port}`;

    server = createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      const path = (request.url ?? "/").split("?")[0];
      const pages: Record<string, string> = {
        "/below-frame":
          '<!doctype html><style>html,body{margin:0}</style><div style="height:900px"></div>' +
          `<iframe src="${crossSiteBase}/top" style="width:400px;height:300px;border:0"></iframe>`,
        "/offset-frame":
          "<!doctype html><style>html,body{margin:0}</style>" +
          `<iframe src="${crossSiteBase}/offset-inner" style="position:absolute;left:200px;top:150px;width:400px;height:300px;border:0"></iframe>`,
        "/wrapped":
          '<!doctype html><style>html,body{margin:0}a{line-height:20px}</style><div style="width:120px"><a href="#">A long inline link with enough words to wrap onto many separate lines for capture</a></div>',
        "/viewport":
          "<!doctype html><title>Viewport</title><style>html,body{margin:0}</style>" +
          '<p>Viewport fixture</p><div style="height:3000px;width:100%"></div>',
        "/element":
          "<!doctype html><title>Element</title><style>html,body{margin:0}</style>" +
          '<button id="clip" style="box-sizing:border-box;width:200px;height:80px">Clip target</button>',
        "/scroll":
          "<!doctype html><title>Scroll</title><style>html,body{margin:0}</style>" +
          // The spacer must stay inside the observer's below-fold collection range
          // (belowFoldScreens defaults to 1: ~1400px at a 700px viewport), while still
          // pushing the button fully off-screen.
          '<div style="height:900px"></div>' +
          '<button id="deep" style="box-sizing:border-box;width:180px;height:70px">Deep target</button>',
        "/resize":
          "<!doctype html><title>Resize</title><style>html,body{margin:0}</style>" +
          '<button id="target" style="box-sizing:border-box;width:120px;height:60px">Resize target</button>',
        "/frame":
          "<!doctype html><title>Frame</title><style>html,body{margin:0}</style>" +
          `<iframe src="${crossBase}/inner" style="width:400px;height:300px;border:0"></iframe>`,
        "/frame-scroll":
          "<!doctype html><title>Frame scroll</title><style>html,body{margin:0}</style>" +
          `<iframe src="${crossSiteBase}/deep" style="width:400px;height:300px;border:0"></iframe>`,
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
      const dialogOpened = new Promise<void>((resolve) => {
        session.page.on("dialog", () => resolve());
      });
      await session.page.callIsolated(() => {
        setTimeout(() => window.confirm("Hold the page"), 0);
        return true;
      }, []);
      await dialogOpened;
      const started = Date.now();
      const result = await session.screenshot();
      const elapsed = Date.now() - started;
      assert.deepEqual(result, { ok: false, reason: "dialog_open" });
      assert.ok(elapsed < 1000, `screenshot took ${elapsed}ms with a dialog open`);
    } finally {
      await session.page.handleDialog(false);
      await session.close();
    }
  });

  test("M7c: ref screenshot of an iframe element below the fold scrolls the page", async () => {
    const session = await opened("/below-frame");
    try {
      await session.observe();
      const target = observed(session, "Top frame target");
      assert.match(target.ref, /^frame:/u);
      assert.equal(await session.page.callIsolated(() => scrollY, []), 0);
      const result = await session.screenshot({ ref: target.ref });
      assert.ok(result.ok, JSON.stringify(result));
      const size = jpegSize(result.capture.data);
      assert.ok(Math.abs(size.width - 180) <= 1, `image width ${size.width}`);
      assert.ok(Math.abs(size.height - 70) <= 1, `image height ${size.height}`);
      assert.ok((await session.page.callIsolated(() => scrollY, [])) > 0);
    } finally {
      await session.close();
    }
  });

  test("M7c: ref screenshot of a wrapped inline link covers all its lines", async () => {
    const session = await opened("/wrapped");
    try {
      await session.observe();
      const target = session.lastObservation!.elements.find((item) => item.role === "link");
      assert.ok(target);
      const metrics = await session.page.callIsolated(() => {
        const link = document.querySelector("a")!;
        return {
          lines: link.getClientRects().length,
          lineHeight: Number.parseFloat(getComputedStyle(link).lineHeight),
        };
      }, []);
      assert.ok(metrics.lines >= 3);
      const result = await session.screenshot({ ref: target.ref });
      assert.ok(result.ok, JSON.stringify(result));
      assert.ok(jpegSize(result.capture.data).height >= metrics.lineHeight * 2.5);
    } finally {
      await session.close();
    }
  });

  test("M7c: ref screenshot of an opacity:0 element reports not visible", async () => {
    const session = await opened("/element");
    try {
      await session.observe();
      const target = observed(session, "Clip target");
      await session.page.callIsolated(() => {
        document.getElementById("clip")!.style.opacity = "0";
      }, []);
      assert.deepEqual(await session.screenshot({ ref: target.ref }), {
        ok: false,
        reason: "not_visible",
      });
    } finally {
      await session.close();
    }
  });

  test("M7c: ref screenshot of an aria-hidden but painted element succeeds", async () => {
    const session = await opened("/element");
    try {
      await session.observe();
      const target = observed(session, "Clip target");
      await session.page.callIsolated(() => {
        document.getElementById("clip")!.setAttribute("aria-hidden", "true");
      }, []);
      const result = await session.screenshot({ ref: target.ref });
      assert.ok(result.ok, JSON.stringify(result));
      const size = jpegSize(result.capture.data);
      assert.ok(Math.abs(size.width - 200) <= 1);
      assert.ok(Math.abs(size.height - 80) <= 1);
    } finally {
      await session.close();
    }
  });

  test("M7c: locateRef maps an iframe element to page coordinates", async () => {
    const session = await opened("/offset-frame");
    try {
      await session.observe();
      const target = observed(session, "Offset target");
      assert.match(target.ref, /^frame:/u);
      const result = await locateRef(
        session.page,
        session.lastObservation!.epoch,
        target.ref,
        target.fingerprint,
      );
      assert.equal(result.status, "ok");
      assert.ok(result.rect);
      assert.ok(Math.abs(result.rect.x - 230) <= 1, `rect.x ${result.rect.x}`);
      assert.ok(Math.abs(result.rect.y - 190) <= 1, `rect.y ${result.rect.y}`);
    } finally {
      await session.close();
    }
  });

  test("M7b: ref screenshot scrolls an off-screen element inside an iframe into view", async () => {
    const session = await opened("/frame-scroll");
    try {
      await session.observe();
      const element = observed(session, "Deep frame target");
      assert.match(element.ref, /^frame:/u);
      // The button sits below the frame's own 300px viewport. Its mapped rect still lies inside the
      // top-level viewport, so only the frame's scroll position shows whether it was brought into view
      // (without that scroll the capture would have the right size but show the page below the frame).
      const frameId = element.ref.slice(6, element.ref.lastIndexOf("@", element.ref.indexOf("/")));
      const frame = (await session.page.frames()).find((item) => item.id === frameId);
      assert.ok(frame, "the target frame is attached");
      assert.equal(await frame.callIsolated(() => scrollY, []), 0);
      const result = await session.screenshot({ ref: element.ref });
      assert.ok(result.ok, JSON.stringify(result));
      assert.ok(
        (await frame.callIsolated(() => scrollY, [])) > 0,
        "the frame scrolled the target into view",
      );
      const size = jpegSize(result.capture.data);
      assert.ok(Math.abs(size.width - 180) <= 1, `image width ${size.width}`);
      assert.ok(Math.abs(size.height - 70) <= 1, `image height ${size.height}`);
    } finally {
      await session.close();
    }
  });
});
