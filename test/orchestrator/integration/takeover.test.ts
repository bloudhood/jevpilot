import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { findChrome } from "../../../src/browser/launcher.ts";
import type { Answers, DecisionRequest } from "../../../src/decision/types.ts";
import { tagAnswers } from "../../../src/decision/validate.ts";
import { createCdpDriver } from "../../../src/engine/cdp/driver.ts";
import type { BrowserHandle, PageHandle } from "../../../src/engine/types.ts";
import { OrchestratorSession, type SessionResult } from "../../../src/orchestrator/session.ts";
import { answersFor } from "../../support/mcp-fixture.ts";
import { testProfile } from "../../support/browser-profile.ts";

const executable = process.env.JEVPILOT_SKIP_BROWSER === "1" ? undefined : await findChrome();
const skipped = executable ? undefined : "Chrome unavailable or JEVPILOT_SKIP_BROWSER=1";

const pages: Record<string, string> = {
  "/hover": `<title>Hover</title><style>
    #menu { width:160px;height:48px;background:#ddd }
    #item { display:none;width:160px;height:48px }
    #menu:hover #item { display:block }
  </style><div id="menu" role="button" aria-label="Open menu" tabindex="0">
    <button id="item" onclick="document.querySelector('#state').textContent='Chosen'">Choose item</button>
  </div><p id="state">Waiting</p>`,
  "/reorder": `<title>Reorder</title><ol id="list">
    <li><button draggable="true" data-name="Alpha">Alpha</button></li>
    <li><button draggable="true" data-name="Beta">Beta</button></li>
    <li><button draggable="true" data-name="Gamma">Gamma</button></li>
  </ol><script>
    let source;
    document.querySelectorAll('#list button').forEach(button => {
      button.style.cssText='display:block;width:160px;height:48px;margin:12px';
      button.addEventListener('dragstart', event => {
        source=button.closest('li'); event.dataTransfer.setData('text/plain', button.dataset.name);
      });
      button.addEventListener('dragover', event => event.preventDefault());
      button.addEventListener('drop', event => {
        event.preventDefault();
        button.closest('li').after(source);
      });
    });
  </script>`,
  "/slider": `<title>Slider</title><style>
    #track { position:relative;width:320px;height:48px;background:#ddd }
    #thumb { position:absolute;left:0;top:0;width:48px;height:48px;background:#555 }
    #end { position:absolute;left:272px;top:0;width:48px;height:48px;background:#aaa }
  </style><div id="track"><div id="thumb" role="slider" aria-label="Volume" tabindex="0"></div>
    <button id="end" aria-label="Slider end"></button></div><output id="value">0</output>
  <script>
    const thumb=document.querySelector('#thumb'), track=document.querySelector('#track');
    thumb.addEventListener('pointerdown', event => { thumb.setPointerCapture(event.pointerId); });
    thumb.addEventListener('pointermove', event => {
      if (!thumb.hasPointerCapture(event.pointerId)) return;
      const value=Math.max(0,Math.min(100,Math.round((event.clientX-track.getBoundingClientRect().left)/3.2)));
      document.querySelector('#value').textContent=String(value);
    });
  </script>`,
  "/upload": `<title>Upload</title><label>Choose file <input type="file" onchange="document.querySelector('#filename').textContent=this.files[0]?.name || ''"></label><p id="filename">No file</p>`,
  "/delayed": `<title>Delayed</title><p id="state">Waiting</p><script>setTimeout(() => document.querySelector('#state').textContent='Ready after delay', 400)</script>`,
  "/spinner": `<title>Spinner</title><p id="spinner">Loading spinner</p><script>setTimeout(() => document.querySelector('#spinner').remove(), 400)</script>`,
  "/never": "<title>Never</title><p>Waiting</p>",
  "/slow-reveal": `<title>Slow reveal</title><p id="state">Waiting</p><script>setTimeout(() => document.querySelector('#state').textContent='Revealed later', 900)</script>`,
  "/search": `<title>Search</title><form action="/results"><label>Query <input name="q" type="search"></label><button>Search</button></form>`,
  "/secret": `<title>Secret</title><label>Secret <input type="password"></label>`,
  "/modal": `<title>Modal</title><div id="panel" role="dialog">Panel open</div><script>
    addEventListener('keydown', event => { if (event.key==='Escape') document.querySelector('#panel').remove(); });
  </script>`,
  "/focus": `<title>Focus</title><button id="first" autofocus>First</button><button id="second">Second</button>`,
  "/scroll": `<title>Scroll</title><p>Top</p><div style="height:2400px"></div><p>Bottom</p>`,
  "/start": `<title>Start</title><a href="/popup" target="_blank">Open page</a>`,
  "/popup": "<title>Popup</title><h1>Second page</h1>",
  "/destination": "<title>Destination</title><h1>Allowed destination</h1>",
  "/unowned": "<title>Unowned</title><h1>Other page</h1>",
  "/covered-submit": `<title>Covered submit</title><form action="/results"><label>Query <input name="q" type="search" oninput="document.querySelector('#layer').style.display='block'"></label><button type="submit" style="display:block;margin-top:8px;width:120px;height:40px">Search</button><div id="layer" style="display:none;position:absolute;left:8px;top:34px;width:280px;height:55px;background:white;z-index:4">Suggestion</div></form>`,
  "/replacing-form": `<title>Replacing form</title><form action="/delayed-results"><label>Query <input name="q" type="search" style="width:180px;height:32px"></label><button type="submit" style="width:120px;height:40px">Search</button></form>`,
  "/slow-page": `<title>Slow page</title><h1>Interactive page</h1><script src="/slow-resource"></script>`,
  "/covered-clear": `<title>Covered clear</title><form action="/results"><label>Query <input name="q" type="search" oninput="document.querySelector('#layer').style.display='block'"></label><button type="button" onclick="document.title='cleared'" style="display:block;margin-top:8px;width:120px;height:40px">Clear</button><div id="layer" style="display:none;position:absolute;left:8px;top:34px;width:280px;height:55px;background:white;z-index:4">Suggestion</div></form>`,
  "/suggestions": `<title>Suggestions</title><button id="elsewhere" autofocus>Elsewhere</button><form action="/results"><label>Query <input name="q" type="search" style="width:180px;height:32px" oninput="document.querySelector('#suggestions').textContent=this.value+' suggestion'"></label><button type="submit" style="width:120px;height:40px">Search</button></form><div id="suggestions"></div>`,
  "/start-moving": `<title>Start moving</title><a href="/popup-moving" target="_blank">Open moving page</a>`,
  "/popup-moving": `<title>Moving</title><h1>Moving page</h1><script>setTimeout(() => history.pushState({}, "", "/popup-moved"), 1500)</script>`,
  "/date-fields": `<title>Date fields</title><label>Day <input type="date" id="day"></label><label>Time <input type="time" id="time"></label><label>Month <input type="month" id="month"></label><output id="changes"></output><script>
    document.querySelectorAll('input').forEach(field => field.addEventListener('change', () => { document.querySelector('#changes').textContent += field.id + ':' + field.value + ';'; }));
  </script>`,
  "/buy-keys": `<title>Buy keys</title><button type="button" id="buy" style="width:140px;height:40px" onclick="document.title='bought'">Buy now</button>
    <div id="remove" style="cursor:pointer;width:160px;height:40px;background:#ddd" tabindex="0" onclick="document.title='removed'">Delete account</div>
    <form onsubmit="event.preventDefault(); document.title='ordered'"><label>Quantity <input id="quantity" name="quantity" style="width:80px;height:28px"></label><button type="submit" style="width:140px;height:40px">Place order</button></form>`,
  "/key-fields": `<title>Key fields</title><label>Letters <input id="letters" style="width:180px;height:32px"></label>`,
  "/approval-focus": `<title>Approval focus</title>
    <button type="button" id="delete" onclick="document.getElementById('deleted').textContent=String(Number(document.getElementById('deleted').textContent)+1)">Delete account</button>
    <output id="deleted">0</output>
    <form onsubmit="event.preventDefault(); document.getElementById('searched').textContent=String(Number(document.getElementById('searched').textContent)+1)">
      <label>Search query <input type="search" name="q"></label><button type="submit">Search</button>
    </form><output id="searched">0</output>`,
  "/long-order": `<title>Long order</title>
    <form onsubmit="event.preventDefault(); document.getElementById('submitted').textContent='submitted'">
      <label>Quantity <input name="quantity"></label>
      <div style="height:4000px"></div><button type="submit">Place order</button>
    </form><output id="submitted">not submitted</output>`,
  "/pointer-cards": `<title>Cards</title><style>.card { cursor:pointer;width:220px;height:48px;display:block;margin:10px }</style>
    <div class="card" id="plain"><span>First</span> <span>course</span></div>
    <div class="card" id="linked"><a href="/destination">Linked course</a></div>
    <output id="choice">Waiting</output><script>
      document.querySelector('#plain').addEventListener('click', () => { document.querySelector('#choice').textContent='Chosen'; });
    </script>`,
  "/busy-main": `<title>Busy main</title><button style="width:120px;height:40px">Ready</button>
    <script>setTimeout(() => { const until = Date.now() + 60000; while (Date.now() < until) {} }, 500)</script>`,
  "/prime": `<title>Prime</title><button style="width:120px;height:40px">Ready</button>
    <script>localStorage.setItem('context-busy', 'yes')</script>`,
  "/context-busy": `<title>Context busy</title><button style="width:120px;height:40px">Ready</button>
    <script>if (localStorage.getItem('context-busy') === 'yes')
      setTimeout(() => { const until = Date.now() + 60000; while (Date.now() < until) {} }, 500)</script>`,
  "/cookie-prime": `<title>Cookie prime</title><button style="width:120px;height:40px">Ready</button>
    <script>document.cookie = 'shared=yes; path=/'</script>`,
  "/cookie-read": `<title>Cookie read</title><button style="width:120px;height:40px">Ready</button>`,
  "/frame-flip": `<title>Frame flip</title><button style="width:120px;height:40px">Ready</button>
    <div id="slot"></div><script>
      setInterval(() => {
        const frame = document.createElement('iframe');
        frame.style.cssText = 'width:180px;height:80px';
        frame.srcdoc = '<button style="width:120px;height:40px">Inside</button>';
        document.querySelector('#slot').replaceChildren(frame);
      }, 30);
    </script>`,
};

function refFor(result: SessionResult, name: string): string {
  const line = result.snapshot.split("\n").find((entry) => entry.includes(JSON.stringify(name)));
  const ref = line?.match(/^(e\d+)\s/u)?.[1];
  assert.ok(ref, `No ref for ${name}: ${result.snapshot}`);
  return ref;
}

function running(result: SessionResult): void {
  assert.equal(result.status, "RUNNING", JSON.stringify(result));
}

describe("M5a real Chrome takeover", { skip: skipped }, () => {
  let server: Server;
  let browser: BrowserHandle;
  let directory: string;
  let base: string;
  let replacingFormSubmissions = 0;
  before(async () => {
    server = createServer((request, response) => {
      if (request.url === "/slow-resource") {
        response.setHeader("content-type", "application/javascript");
        setTimeout(() => response.end(""), 900);
        return;
      }
      if (request.url?.startsWith("/delayed-results")) {
        replacingFormSubmissions++;
        response.setHeader("content-type", "text/html; charset=utf-8");
        setTimeout(() => response.end("<title>Results</title><h1>Search results</h1>"), 300);
        return;
      }
      response.setHeader("content-type", "text/html; charset=utf-8");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      response.end(
        url.pathname === "/results"
          ? `<title>Results</title><h1>Results for ${url.searchParams.get("q") ?? ""}</h1>`
          : (pages[url.pathname] ?? "<title>Missing</title>"),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server has no port");
    base = `http://127.0.0.1:${address.port}`;
    directory = await mkdtemp(join(tmpdir(), "jevpilot-takeover-"));
    browser = await createCdpDriver().launch(
      {
        ...testProfile(join(directory, "profile"), { width: 1000, height: 700 }),
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
    if (directory)
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  async function opened(
    path: string,
    allowedDomains = ["127.0.0.1"],
    navigationTimeoutMs?: number,
  ): Promise<{ session: OrchestratorSession; page: PageHandle }> {
    const page = await browser.newPage();
    const navigation = await page.navigate(`${base}${path}`);
    const session = new OrchestratorSession(
      {
        page,
        navigation,
        goal: "Exercise the local fixture",
        ...(navigationTimeoutMs ? { navigationTimeoutMs } : {}),
        constraints: { allowed_domains: allowedDomains },
      },
      {
        decide: async () => {
          throw new Error("manual test must not ask for a decision");
        },
        tempDir: () => mkdtemp(join(directory, "handoff-")),
      },
    );
    return { session, page };
  }

  test("M5a: hover reveals a menu item that is then clickable", async () => {
    const { session } = await opened("/hover");
    try {
      running(
        await session.act([{ action: "hover", ref: refFor(await session.observe(), "Open menu") }]),
      );
      const item = refFor(await session.observe(), "Choose item");
      running(await session.act([{ action: "click", ref: item }]));
      assert.match((await session.observe()).snapshot, /Chosen/u);
    } finally {
      await session.close();
    }
  });

  test("M5a: drag reorders an HTML5 drag-and-drop list", async () => {
    const { session, page } = await opened("/reorder");
    try {
      const observation = await session.observe();
      running(
        await session.act([
          {
            action: "drag",
            ref: refFor(observation, "Alpha"),
            to_ref: refFor(observation, "Gamma"),
          },
        ]),
      );
      const order = await page.callIsolated(
        () => [...document.querySelectorAll("#list button")].map((button) => button.textContent),
        [],
      );
      assert.deepEqual(order, ["Beta", "Gamma", "Alpha"]);
    } finally {
      await session.close();
    }
  });

  test("M5a: drag moves a pointer-events slider", async () => {
    const { session, page } = await opened("/slider");
    try {
      const observation = await session.observe();
      running(
        await session.act([
          {
            action: "drag",
            ref: refFor(observation, "Volume"),
            to_ref: refFor(observation, "Slider end"),
          },
        ]),
      );
      const value = await page.callIsolated(
        () => Number(document.querySelector("#value")?.textContent),
        [],
      );
      assert.ok(value > 50, `slider value: ${value}`);
    } finally {
      await session.close();
    }
  });

  test("M5a: upload sets a file from JEVPILOT_UPLOAD_DIR", async () => {
    const upload = join(directory, "uploads");
    await mkdir(upload);
    const previous = process.env.JEVPILOT_UPLOAD_DIR;
    process.env.JEVPILOT_UPLOAD_DIR = upload;
    const { session } = await opened("/upload");
    try {
      const file = join(upload, "sample.txt");
      await writeFile(file, "fixture", "utf8");
      const result = await session.act([
        { action: "upload", ref: refFor(await session.observe(), "Choose file"), paths: [file] },
      ]);
      running(result);
      assert.match((await session.observe()).snapshot, /sample\.txt/u);
    } finally {
      await session.close();
      if (previous === undefined) delete process.env.JEVPILOT_UPLOAD_DIR;
      else process.env.JEVPILOT_UPLOAD_DIR = previous;
    }
  });

  test("M5a: upload refuses a path outside JEVPILOT_UPLOAD_DIR", async () => {
    const upload = join(directory, "allowed");
    await mkdir(upload);
    const outside = join(directory, "outside.txt");
    await writeFile(outside, "outside", "utf8");
    const previous = process.env.JEVPILOT_UPLOAD_DIR;
    process.env.JEVPILOT_UPLOAD_DIR = upload;
    const { session } = await opened("/upload");
    try {
      const result = await session.act([
        { action: "upload", ref: refFor(await session.observe(), "Choose file"), paths: [outside] },
      ]);
      assert.equal(result.status, "UNCERTAIN");
      assert.match(result.question ?? "", /outside JEVPILOT_UPLOAD_DIR/u);
      assert.match((await session.observe()).snapshot, /No file/u);
    } finally {
      await session.close();
      if (previous === undefined) delete process.env.JEVPILOT_UPLOAD_DIR;
      else process.env.JEVPILOT_UPLOAD_DIR = previous;
    }
  });

  test("M5a: upload refuses a link that escapes JEVPILOT_UPLOAD_DIR", async () => {
    const upload = join(directory, "linked-uploads");
    const outside = join(directory, "linked-outside");
    await mkdir(upload);
    await mkdir(outside);
    await writeFile(join(outside, "escape.txt"), "outside", "utf8");
    await symlink(outside, join(upload, "link"), process.platform === "win32" ? "junction" : "dir");
    const previous = process.env.JEVPILOT_UPLOAD_DIR;
    process.env.JEVPILOT_UPLOAD_DIR = upload;
    const { session } = await opened("/upload");
    try {
      const result = await session.act([
        {
          action: "upload",
          ref: refFor(await session.observe(), "Choose file"),
          paths: [join(upload, "link", "escape.txt")],
        },
      ]);
      assert.equal(result.status, "UNCERTAIN");
      assert.match(result.question ?? "", /outside JEVPILOT_UPLOAD_DIR/u);
      assert.match((await session.observe()).snapshot, /No file/u);
    } finally {
      await session.close();
      if (previous === undefined) delete process.env.JEVPILOT_UPLOAD_DIR;
      else process.env.JEVPILOT_UPLOAD_DIR = previous;
    }
  });

  test("M5a: wait_for resolves text that appears after 400 ms", async () => {
    const { session } = await opened("/delayed");
    try {
      running(
        await session.act([{ action: "wait_for", text: "Ready after delay", timeout_ms: 3000 }]),
      );
      assert.match((await session.observe()).snapshot, /Ready after delay/u);
    } finally {
      await session.close();
    }
  });

  test("M5a: wait_for resolves a spinner that disappears", async () => {
    const { session } = await opened("/spinner");
    try {
      assert.match((await session.observe()).snapshot, /Loading spinner/u);
      running(
        await session.act([
          {
            action: "wait_for",
            text: "Loading spinner",
            condition: "disappears",
            timeout_ms: 3000,
          },
        ]),
      );
      assert.doesNotMatch((await session.observe()).snapshot, /Loading spinner/u);
    } finally {
      await session.close();
    }
  });

  test("M5a: wait_for timeout returns a handoff, not an error", async () => {
    const { session } = await opened("/never");
    try {
      const result = await session.act([
        { action: "wait_for", text: "Never arrives", timeout_ms: 250 },
      ]);
      assert.equal(result.status, "UNCERTAIN");
      assert.match(result.question ?? "", /wait_for timed out/u);
    } finally {
      await session.close();
    }
  });

  test("M5a: type with literal text and submit reaches the results page", async () => {
    const { session } = await opened("/search");
    try {
      const result = await session.act([
        {
          action: "type",
          ref: refFor(await session.observe(), "Query"),
          text: "cedar",
          submit: true,
        },
      ]);
      assert.notEqual(result.status, "FAILED", JSON.stringify(result));
      assert.match((await session.observe()).snapshot, /Results for cedar/u);
    } finally {
      await session.close();
    }
  });

  test("M5a: literal text into a password field is refused", async () => {
    const { session, page } = await opened("/secret");
    try {
      const result = await session.act([
        { action: "type", ref: refFor(await session.observe(), "Secret"), text: "literal-secret" },
      ]);
      assert.equal(result.status, "NEEDS_VALUES");
      const value = await page.callIsolated(
        () => (document.querySelector('input[type="password"]') as HTMLInputElement).value,
        [],
      );
      assert.equal(value, "");
    } finally {
      await session.close();
    }
  });

  test("M5a: press_key Escape closes a modal", async () => {
    const { session } = await opened("/modal");
    try {
      assert.match((await session.observe()).snapshot, /Panel open/u);
      running(await session.act([{ action: "press_key", name: "Escape" }]));
      assert.doesNotMatch((await session.observe()).snapshot, /Panel open/u);
    } finally {
      await session.close();
    }
  });

  test("M5a: press_key Tab moves focus", async () => {
    const { session, page } = await opened("/focus");
    try {
      await session.observe();
      running(await session.act([{ action: "press_key", name: "Tab" }]));
      assert.equal(await page.callIsolated(() => document.activeElement?.id, []), "second");
    } finally {
      await session.close();
    }
  });

  test("M5a: press_key PageDown scrolls the page", async () => {
    const { session, page } = await opened("/scroll");
    try {
      await session.observe();
      const before = await page.callIsolated(() => scrollY, []);
      running(await session.act([{ action: "press_key", name: "PageDown" }]));
      await session.act([{ action: "wait_for", delay_ms: 250 }]);
      assert.ok((await page.callIsolated(() => scrollY, [])) > before);
    } finally {
      await session.close();
    }
  });

  test("M5a: browser_navigate follows the allowlist", async () => {
    const { session } = await opened("/start");
    try {
      const allowed = await session.navigate(`${base}/destination`);
      running(allowed);
      assert.match(allowed.snapshot, /Allowed destination/u);
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture port missing");
      const refused = await session.navigate(`http://localhost:${address.port}/destination`);
      assert.equal(refused.status, "CONFIRM_REQUIRED");
      assert.match((await session.observe()).snapshot, /Allowed destination/u);
    } finally {
      await session.close();
    }
  });

  test("M5a: tabs list, select and close only session-owned pages", async () => {
    const { session } = await opened("/start");
    const unowned = await browser.newPage();
    try {
      await unowned.navigate(`${base}/unowned`);
      const original = await session.listTabs();
      assert.equal(original.length, 1);
      assert.notEqual(original[0]?.tab_id, unowned.id);
      running(
        await session.act([{ action: "click", ref: refFor(await session.observe(), "Open page") }]),
      );
      const tabs = await session.listTabs();
      assert.equal(tabs.length, 2);
      assert.ok(!tabs.some((tab) => tab.tab_id === unowned.id));
      const popup = tabs.find((tab) => tab.tab_id !== original[0]?.tab_id);
      assert.ok(popup);
      assert.match(popup.url, /\/popup$/u);
      assert.match((await session.selectTab(popup.tab_id)).snapshot, /Second page/u);
      running(await session.closeTab(popup.tab_id));
      assert.deepEqual(
        (await session.listTabs()).map((tab) => tab.tab_id),
        [original[0]?.tab_id],
      );
      assert.equal((await session.closeTab(unowned.id)).status, "UNCERTAIN");
      assert.equal(await unowned.callIsolated(() => document.title, []), "Unowned");
    } finally {
      await session.close();
      await unowned.close();
    }
  });

  test("M6d: navigation load timeout continues on an interactive page", async () => {
    const { session } = await opened("/start", ["127.0.0.1"], 100);
    try {
      const result = await session.navigate(`${base}/slow-page`);
      assert.notEqual(result.status, "ERROR_PAGE");
      assert.match(result.snapshot, /Interactive page/u);
    } finally {
      await session.close();
    }
  });

  test("M6d: page navigation that times out on an interactive document reports no failure", async () => {
    const page = await browser.newPage();
    try {
      const navigation = await page.navigate(`${base}/slow-page`, { timeoutMs: 300 });
      assert.equal(navigation.failure, undefined);
    } finally {
      await page.close();
    }
  });

  test("M6d: tab list follows a popup that changes its own URL", async () => {
    const { session } = await opened("/start-moving");
    try {
      running(
        await session.act([
          { action: "click", ref: refFor(await session.observe(), "Open moving page") },
        ]),
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const tabs = await session.listTabs();
      assert.ok(
        tabs.some((tab) => /\/popup-moved$/u.test(tab.url)),
        JSON.stringify(tabs),
      );
    } finally {
      await session.close();
    }
  });

  test("M6d: covered submit button submits with Enter from the filled field", async () => {
    const { session } = await opened("/covered-submit");
    try {
      const initial = await session.observe();
      running(
        await session.act([{ action: "type", ref: refFor(initial, "Query"), text: "paper" }]),
      );
      const filled = await session.observe();
      const result = await session.act([{ action: "click", ref: refFor(filled, "Search") }]);
      assert.match(result.url, /\/results\?q=paper/u);
      assert.ok(result.trace.some((entry) => entry.op === "submit"));
    } finally {
      await session.close();
    }
  });

  test("M6i: a search form is typed and submitted after one decision", async () => {
    const page = await browser.newPage();
    const navigation = await page.navigate(`${base}/search`);
    let decisions = 0;
    const session = new OrchestratorSession(
      {
        page,
        navigation,
        goal: "Search for paper",
        values: { query: "paper" },
        success: { url_matches: "/results\\?q=paper" },
        constraints: { allowed_domains: ["127.0.0.1"] },
      },
      {
        decide: async (request: DecisionRequest) => {
          decisions++;
          assert.equal(decisions, 1, "results must be observed before another decision");
          const answers: Answers = answersFor(request);
          for (const [id, key] of [
            ["op", "TYPE"],
            ["submit_after_type", "submit"],
          ] as const) {
            const question = request.questions[id];
            assert.equal(question?.type, "choice");
            if (question?.type !== "choice") throw new Error(`missing ${id}`);
            answers[id] = {
              choice: key,
              confidence: 1,
              probabilities: Object.fromEntries(
                Object.keys(question.criteria).map((candidate) => [
                  candidate,
                  Number(candidate === key),
                ]),
              ),
            };
          }
          const valueQuestion = Object.entries(request.questions).find(([id]) =>
            id.startsWith("value_for_"),
          );
          assert.ok(valueQuestion && valueQuestion[1].type === "choice");
          const [id, question] = valueQuestion;
          if (question.type !== "choice") throw new Error("missing value choice");
          answers[id] = {
            choice: "query",
            confidence: 1,
            probabilities: Object.fromEntries(
              Object.keys(question.criteria).map((candidate) => [
                candidate,
                Number(candidate === "query"),
              ]),
            ),
          };
          return {
            answers: tagAnswers(request.questions, answers),
            usage: { inputTokens: 1, outputTokens: 1 },
            model: "scripted",
            provider: "scripted",
            latencyMs: 0,
            attempts: 1,
          };
        },
        tempDir: () => mkdtemp(join(directory, "handoff-")),
      },
    );
    try {
      const result = await session.run();
      assert.equal(result.status, "DONE_VERIFIED");
      assert.match(result.url, /\/results\?q=paper/u);
      assert.equal(decisions, 1);
    } finally {
      await session.close();
    }
  });

  test("M6e: a covered type=button control is never replaced by Enter", async () => {
    const { session } = await opened("/covered-clear");
    try {
      const initial = await session.observe();
      running(
        await session.act([{ action: "type", ref: refFor(initial, "Query"), text: "paper" }]),
      );
      const filled = await session.observe();
      const result = await session.act([{ action: "click", ref: refFor(filled, "Clear") }]);
      assert.doesNotMatch(result.url, /\/results/u);
      assert.ok(!result.trace.some((entry) => entry.op === "submit"));
    } finally {
      await session.close();
    }
  });

  test("M6e: covered submit falls back to Enter without waiting for the actionability timeout", async () => {
    const { session } = await opened("/covered-submit");
    try {
      const initial = await session.observe();
      running(
        await session.act([{ action: "type", ref: refFor(initial, "Query"), text: "paper" }]),
      );
      const filled = await session.observe();
      const started = performance.now();
      const result = await session.act([{ action: "click", ref: refFor(filled, "Search") }]);
      assert.ok(performance.now() - started < 1500);
      assert.match(result.url, /\/results\?q=paper/u);
      assert.ok(result.trace.some((entry) => entry.op === "submit"));
    } finally {
      await session.close();
    }
  });

  test("M6e: a form submit that replaces the document during the action does not fail the run", async () => {
    const { session } = await opened("/replacing-form", ["127.0.0.1"], 2000);
    try {
      replacingFormSubmissions = 0;
      const initial = await session.observe();
      running(
        await session.act([{ action: "type", ref: refFor(initial, "Query"), text: "paper" }]),
      );
      const filled = await session.observe();
      const result = await session.act([{ action: "click", ref: refFor(filled, "Search") }]);
      assert.ok(["RUNNING", "DONE_VERIFIED", "DONE_UNVERIFIED"].includes(result.status));
      assert.equal(replacingFormSubmissions, 1, "the form must reach the fixture server");
    } finally {
      await session.close();
    }
  });

  test("M6h: a page whose main thread stays busy hands off within the bound", async () => {
    const { session } = await opened("/busy-main");
    try {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const firstStarted = Date.now();
      const first = await session.observe();
      assert.equal(first.status, "UNCERTAIN");
      assert.ok(Date.now() - firstStarted < 15_000);
      assert.match(first.question, /not responding/u);
      const nextStarted = Date.now();
      const next = await session.act([{ action: "press_key", key: "Enter" }]);
      assert.equal(next.status, "UNCERTAIN");
      assert.ok(Date.now() - nextStarted < 5_000);
      const recovery = await session.navigate(`${base}/destination`);
      assert.notEqual(recovery.status, "FAILED");
      if (recovery.status === "UNCERTAIN") assert.match(recovery.question, /not responding/u);
      else assert.match(recovery.url, /\/destination$/u);
    } finally {
      await session.close();
    }
  });

  test("M6k: a page that hangs only in the shared context continues after an isolated reopen", async () => {
    const priming = await opened("/prime");
    await priming.session.close();
    const page = await browser.newPage();
    const navigation = await page.navigate(`${base}/context-busy`);
    const session = new OrchestratorSession(
      {
        page,
        navigation,
        goal: "Read the ready page",
        constraints: { allowed_domains: ["127.0.0.1"] },
        openIsolatedPage: () => browser.newPage({ isolated: { copyCookies: true } }),
      },
      { tempDir: () => mkdtemp(join(directory, "handoff-")) },
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const started = Date.now();
      const result = await session.observe();
      assert.ok(Date.now() - started < 20_000);
      assert.ok(!["FAILED", "UNCERTAIN"].includes(result.status));
      assert.match(result.snapshot, /Ready/u);
      assert.match(result.details?.join(" ") ?? "", /cookies copied, site storage not/u);
    } finally {
      await session.close();
    }
  });

  test("M6k: isolated sessions do not see the shared context's cookies", async () => {
    const shared = await opened("/cookie-prime");
    try {
      const sharedCookie = await shared.page.callIsolated(() => document.cookie, []);
      assert.match(sharedCookie, /shared=yes/u);
    } finally {
      await shared.session.close();
    }
    const page = await browser.newPage({ isolated: { copyCookies: false } });
    const navigation = await page.navigate(`${base}/cookie-read`);
    const session = new OrchestratorSession({ page, navigation, goal: "Read page" });
    try {
      const result = await page.callIsolated(
        () => ({ cookies: document.cookie, width: window.outerWidth, height: window.outerHeight }),
        [],
      );
      assert.doesNotMatch(result.cookies, /shared=yes/u);
      assert.ok(result.width > 0 && result.height > 0);
    } finally {
      await session.close();
    }
  });

  test("M6h: an iframe replaced during observation does not fail the observation", async () => {
    const { session } = await opened("/frame-flip");
    try {
      for (let index = 0; index < 20; index++) {
        const result = await session.observe();
        assert.equal(result.status, "RUNNING", `observation ${index}: ${result.question}`);
      }
    } finally {
      await session.close();
    }
  });

  test("M6f: a suggestion list repeating the typed text does not verify completion", async () => {
    const page = await browser.newPage();
    const navigation = await page.navigate(`${base}/suggestions`);
    const session = new OrchestratorSession(
      {
        page,
        navigation,
        goal: "Find paper",
        values: { query: "paper" },
        success: { text_present: "paper" },
        constraints: { allowed_domains: ["127.0.0.1"] },
      },
      {
        buildDecisionState: () => ({ state: {}, questions: {}, reductions: [] }),
        decide: async () => ({
          answers: {},
          usage: { inputTokens: 1, outputTokens: 1 },
          model: "scripted",
          provider: "scripted",
          latencyMs: 0,
          attempts: 1,
        }),
        interpret: () => ({ type: "done_candidate", goalMet: 0.95 }),
        tempDir: () => mkdtemp(join(directory, "handoff-")),
      },
    );
    try {
      const initial = await session.observe();
      running(
        await session.act([{ action: "type", ref: refFor(initial, "Query"), value_key: "query" }]),
      );
      const premature = await session.run();
      assert.notEqual(premature.status, "DONE_VERIFIED");
      const filled = await session.observe();
      assert.equal(
        (await session.act([{ action: "press_key", ref: refFor(filled, "Query"), key: "Enter" }]))
          .status,
        "DONE_VERIFIED",
      );
      assert.match((await session.observe()).url, /\/results\?q=paper/u);
    } finally {
      await session.close();
    }
  });

  test("M6f: press_key with a ref sends the key to that element", async () => {
    const { session, page } = await opened("/suggestions");
    try {
      const initial = await session.observe();
      running(
        await session.act([{ action: "type", ref: refFor(initial, "Query"), text: "paper" }]),
      );
      await page.callIsolated(() => document.getElementById("elsewhere")?.focus(), []);
      const filled = await session.observe();
      const result = await session.act([
        { action: "press_key", ref: refFor(filled, "Query"), key: "Enter" },
      ]);
      assert.match(result.url, /\/results\?q=paper/u);
    } finally {
      await session.close();
    }
  });

  test("R9: an approved Enter reaches the approved button in a real page after focus moved", async () => {
    const page = await browser.newPage();
    const navigation = await page.navigate(`${base}/approval-focus`);
    const session = new OrchestratorSession(
      {
        page,
        navigation,
        goal: "Delete the fixture account",
        constraints: { allowed_domains: ["127.0.0.1"] },
      },
      {
        buildDecisionState: () => ({ state: {}, questions: {}, reductions: [] }),
        decide: async () => ({
          answers: {},
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "scripted",
          provider: "scripted",
          latencyMs: 0,
          attempts: 1,
        }),
        interpret: () => ({
          type: "handoff",
          reason: "info_not_on_page",
          source: "code",
          details: {},
        }),
        tempDir: () => mkdtemp(join(directory, "handoff-")),
      },
    );
    const counters = () =>
      page.callIsolated(
        () => ({
          deleted: Number(document.getElementById("deleted")!.textContent),
          searched: Number(document.getElementById("searched")!.textContent),
        }),
        [],
      );
    try {
      const initial = await session.observe();
      const gated = await session.act([
        { action: "key", name: "Enter", ref: refFor(initial, "Delete account") },
      ]);
      assert.equal(gated.status, "CONFIRM_REQUIRED");
      assert.deepEqual(await counters(), { deleted: 0, searched: 0 });
      running(
        await session.act([
          { action: "click", ref: refFor(await session.observe(), "Search query") },
        ]),
      );
      assert.equal(
        await page.callIsolated(() => (document.activeElement as HTMLInputElement).name, []),
        "q",
      );
      const resumed = await session.resume({ allow_irreversible: true });
      assert.equal(resumed.status, "INFO_NOT_ON_PAGE", JSON.stringify(resumed));
      assert.deepEqual(await counters(), { deleted: 1, searched: 0 });
    } finally {
      await session.close();
    }
  });

  test("R9: typing with submit into a long form waits for approval when its Place order button is far below the viewport", async () => {
    const { session, page } = await opened("/long-order");
    try {
      const initial = await session.observe();
      assert.doesNotMatch(initial.snapshot, /button\s+"Place order"/u);
      assert.ok(
        await page.callIsolated(
          () => document.querySelector('button[type="submit"]')!.getBoundingClientRect().top > 4000,
          [],
        ),
      );
      const result = await session.act([
        { action: "type", ref: refFor(initial, "Quantity"), text: "2", submit: true },
      ]);
      assert.equal(result.status, "CONFIRM_REQUIRED");
      assert.match(result.question, /Approve "Place order"/u);
      assert.equal(
        await page.callIsolated(() => document.getElementById("submitted")!.textContent, []),
        "not submitted",
      );
      assert.equal(
        await page.callIsolated(
          () => (document.querySelector("input") as HTMLInputElement).value,
          [],
        ),
        "",
      );
    } finally {
      await session.close();
    }
  });

  test("R3: Enter, Space, a typed submit and a clickable div wait for approval in a real page", async () => {
    const title = (page: PageHandle) => page.callIsolated(() => document.title, []);
    for (const key of ["Enter", "Space"]) {
      const { session, page } = await opened("/buy-keys");
      try {
        const initial = await session.observe();
        const blocked = await session.act([
          { action: "press_key", ref: refFor(initial, "Buy now"), key },
        ]);
        assert.equal(blocked.status, "CONFIRM_REQUIRED", key);
        assert.equal(await title(page), "Buy keys", key);
        // Focus moved to the button by the keyboard alone, then Enter without a ref.
        await page.callIsolated(() => document.getElementById("buy")?.focus(), []);
        const again = await session.act([{ action: "press_key", key }]);
        assert.equal(again.status, "CONFIRM_REQUIRED", key);
        assert.equal(await title(page), "Buy keys", key);
        const approved = await session.act(
          [{ action: "press_key", ref: refFor(initial, "Buy now"), key }],
          { allow_irreversible: true },
        );
        assert.notEqual(approved.status, "CONFIRM_REQUIRED", key);
        assert.equal(await title(page), "bought", key);
      } finally {
        await session.close();
      }
    }
    const { session, page } = await opened("/buy-keys");
    try {
      const initial = await session.observe();
      const typed = await session.act([
        { action: "type", ref: refFor(initial, "Quantity"), text: "2", submit: true },
      ]);
      assert.equal(typed.status, "CONFIRM_REQUIRED");
      assert.equal(await title(page), "Buy keys");
      assert.equal(
        await page.callIsolated(
          () => (document.getElementById("quantity") as HTMLInputElement).value,
          [],
        ),
        "",
      );
      const div = await session.act([{ action: "click", ref: refFor(initial, "Delete account") }]);
      assert.equal(div.status, "CONFIRM_REQUIRED");
      assert.equal(await title(page), "Buy keys");
      const approved = await session.resume({ allow_irreversible: true });
      assert.notEqual(approved.status, "CONFIRM_REQUIRED");
    } finally {
      await session.close();
    }
  });

  test("M6g: typing into date, time and month inputs sets their values and fires change", async () => {
    const { session, page } = await opened("/date-fields");
    try {
      for (const [name, value] of [
        ["Day", "2026年10月15日"],
        ["Time", "09:42"],
        ["Month", "2026-10"],
      ] as const) {
        const result = await session.observe();
        running(await session.act([{ action: "type", ref: refFor(result, name), text: value }]));
      }
      const fields = await page.callIsolated(
        () => ({
          day: (document.getElementById("day") as HTMLInputElement).value,
          time: (document.getElementById("time") as HTMLInputElement).value,
          month: (document.getElementById("month") as HTMLInputElement).value,
          changes: document.getElementById("changes")?.textContent,
        }),
        [],
      );
      assert.deepEqual(fields, {
        day: "2026-10-15",
        time: "09:42",
        month: "2026-10",
        changes: "day:2026-10-15;time:09:42;month:2026-10;",
      });
    } finally {
      await session.close();
    }
  });

  test("M6g: press_key types printable characters and applies Control+a", async () => {
    const { session, page } = await opened("/key-fields");
    try {
      const initial = await session.observe();
      const ref = refFor(initial, "Letters");
      running(await session.act([{ action: "press_key", ref, key: "1" }]));
      running(await session.act([{ action: "press_key", ref, key: "a" }]));
      assert.equal(
        await page.callIsolated(
          () => (document.getElementById("letters") as HTMLInputElement).value,
          [],
        ),
        "1a",
      );
      running(await session.act([{ action: "press_key", ref, key: "Control+a" }]));
      running(await session.act([{ action: "press_key", ref, key: "2" }]));
      assert.equal(
        await page.callIsolated(
          () => (document.getElementById("letters") as HTMLInputElement).value,
          [],
        ),
        "2",
      );
      const unknown = await session.act([{ action: "press_key", ref, key: "MysteryKey" }]);
      assert.equal(unknown.status, "UNCERTAIN");
      assert.match(unknown.question, /printable character.*Modifier\+Key/iu);
    } finally {
      await session.close();
    }
  });

  test("M6g: pointer-cursor cards with script listeners are observed and clickable", async () => {
    const { session, page } = await opened("/pointer-cards");
    try {
      const observed = await session.observe();
      const plain = observed.snapshot
        .split("\n")
        .filter((line) => /clickable.*"First course"/u.test(line));
      assert.equal(plain.length, 1, observed.snapshot);
      assert.doesNotMatch(
        observed.snapshot,
        /clickable.*"First"|clickable.*"course"|clickable.*"Linked course"/u,
      );
      assert.match(observed.snapshot, /link.*"Linked course"/u);
      running(await session.act([{ action: "click", ref: refFor(observed, "First course") }]));
      assert.equal(
        await page.callIsolated(() => document.getElementById("choice")?.textContent, []),
        "Chosen",
      );
    } finally {
      await session.close();
    }
  });

  test("M6d: WAIT holds until the page changes in a real browser", async () => {
    const { session } = await opened("/slow-reveal");
    try {
      assert.doesNotMatch((await session.observe()).snapshot, /Revealed later/u);
      running(await session.act([{ action: "wait" }]));
      assert.match((await session.observe()).snapshot, /Revealed later/u);
    } finally {
      await session.close();
    }
  });

  test("M6d: tab list reports the live URL of a popup", async () => {
    const { session } = await opened("/start");
    try {
      await session.act([{ action: "click", ref: refFor(await session.observe(), "Open page") }]);
      const tabs = await session.listTabs();
      const popup = tabs.find((tab) => tab.selected);
      assert.ok(popup);
      await session.navigate(`${base}/destination`);
      assert.equal(
        (await session.listTabs()).find((tab) => tab.tab_id === popup.tab_id)?.url,
        `${base}/destination`,
      );
    } finally {
      await session.close();
    }
  });
});
