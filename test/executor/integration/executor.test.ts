import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { findChrome } from "../../../src/browser/launcher.ts";
import { createCdpDriver } from "../../../src/engine/cdp/driver.ts";
import type { BrowserHandle, PageHandle } from "../../../src/engine/types.ts";
import { executeAction } from "../../../src/executor/execute.ts";
import type { Action, Target } from "../../../src/executor/types.ts";
import { observe } from "../../../src/observer/observe.ts";
import { resolveRef } from "../../../src/observer/page-snapshot.ts";
import { OrchestratorSession } from "../../../src/orchestrator/session.ts";
import type { Observation, ObservedElement } from "../../../src/observer/types.ts";
import { testProfile } from "../../support/browser-profile.ts";

const executable = await findChrome();
const skipped =
  process.env.JEVPILOT_SKIP_BROWSER === "1"
    ? "JEVPILOT_SKIP_BROWSER=1"
    : !executable
      ? "Chrome executable not found"
      : undefined;

describe("real Chrome Executor", { skip: skipped }, () => {
  let browser: BrowserHandle;
  let server: Server;
  let crossServer: Server;
  let directory: string;
  let baseUrl: string;
  let crossUrl: string;
  const harnessSamples: number[] = [];

  before(async () => {
    crossServer = createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(
        request.url === "/frame?scaled"
          ? '<button id="frame-button" style="margin:100px 0 0 220px" onclick="this.textContent=\'Scaled clicked\'">Scaled action</button>'
          : '<button id="frame-button" onclick="this.textContent=\'Frame clicked\'">Frame action</button>',
      );
    });
    await new Promise<void>((resolve) => crossServer.listen(0, "127.0.0.1", resolve));
    const crossAddress = crossServer.address();
    if (!crossAddress || typeof crossAddress === "string")
      throw new Error("cross server address missing");
    crossUrl = `http://127.0.0.1:${crossAddress.port}/frame`;
    server = createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      if (request.url === "/scaled-frame") {
        response.end(
          `<iframe src="${crossUrl}?scaled" style="width:600px;height:240px;transform:scale(0.5);transform-origin:top left"></iframe>`,
        );
        return;
      }
      if (request.url === "/delayed") {
        response.end(
          `<title>Delayed navigation</title><a href="/next" onclick="event.preventDefault();setTimeout(()=>location.href=this.href,150)">Delayed link</a>`,
        );
        return;
      }
      if (request.url === "/router") {
        response.end(
          `<title>Router</title><a href="/routed" onclick="event.preventDefault();history.pushState({},'',this.href);document.title='Routed'">Router link</a>`,
        );
        return;
      }
      if (request.url === "/overlay") {
        response.end(
          `<title>Overlay</title><a href="/next" style="display:block;width:200px;height:40px">Result link</a><div role="listbox" aria-label="Suggestions" style="position:absolute;top:8px;left:8px;width:200px;height:40px;background:white;z-index:3">Suggestions</div><script>document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelector('[role=listbox]').remove()})</script>`,
        );
        return;
      }
      if (request.url === "/wrapped-link") {
        response.end(
          '<title>Wrapped link</title><h3 style="width:180px"><a href="/next">A long question title that wraps across two lines in this heading</a></h3>',
        );
        return;
      }
      if (request.url === "/next" || request.url === "/submitted") {
        response.end("<title>Next</title><p>Destination loaded</p>");
        return;
      }
      if (request.url === "/o9e-date") {
        response.end(
          `<!doctype html><label>Date <input id="date"></label><label>Other <select id="other"><option>One</option><option>Two</option></select></label><script>const input=document.getElementById('date');let state='';input.addEventListener('keyup',()=>state=input.value);input.addEventListener('blur',()=>input.value=state);</script>`,
        );
        return;
      }
      if (request.url?.startsWith("/slow-results")) {
        setTimeout(() => response.end("<title>Slow results</title><p>Results</p>"), 1500);
        return;
      }
      response.end(`<!doctype html><title>Executor</title>
        <a href="/next">Navigate</a>
        <div style="position:relative;width:300px;height:50px;margin-top:12px">
          <button id="covered" style="position:absolute;left:0;top:12px" onclick="this.textContent='Clicked'">Covered action</button>
          <div id="banner" role="banner" aria-label="Cookie banner" style="position:absolute;left:0;top:0;width:300px;height:50px;background:white;z-index:10">
            <button style="position:absolute;right:0;top:12px" onclick="this.parentElement.remove()">Close cookies</button>
          </div>
        </div>
        <button id="rerender" onclick="document.getElementById('stale').outerHTML='<button id=stale>Replacement</button>'">Rerender</button>
        <button id="stale" onclick="this.textContent='Bad click'">Stale target</button>
        <button id="mouse-action" onclick="this.textContent='Mouse clicked'">Mouse action</button>
        <label>Text <input type="text"></label><label>Email <input type="email"></label>
        <label>Password <input type="password"></label>
        <label>Search <input role="searchbox" oninput="setTimeout(()=>{document.getElementById('suggestions').innerHTML='<div role=option>Suggestion</div>'},120)"></label>
        <div id="suggestions"></div>
        <label>Choice <select oninput="this.dataset.trusted=String(event.isTrusted)"><option>First</option><option>Second</option><option>Third</option></select></label>
        <label>Agree <input type="checkbox"></label>
        <div id="key-capture" tabindex="0">Keyboard target</div>
        <form action="/submitted"><label>Submit field <input id="submit-field"></label></form>
        <form id="dynamic-search" action="/submitted"><input id="dynamic-input" type="search" aria-label="Dynamic search" oninput="if(!this.dataset.replaced){const next=this.cloneNode();next.value=this.value;next.dataset.replaced='1';this.replaceWith(next);next.focus()}"></form>
        <button onclick="confirm('Proceed?')">Confirm action</button>
        <iframe src="${crossUrl}" style="width:400px;height:100px"></iframe>
        <div style="height:1600px"></div><button id="below" onclick="this.textContent='Below clicked'">Below fold</button>
        <script>
          window.keyEvents=[]; window.mouseEvents=[];
          document.addEventListener('keydown', event => {
            window.keyEvents.push({ key:event.key, code:event.code, keyCode:event.keyCode, isTrusted:event.isTrusted, ctrlKey:event.ctrlKey });
            document.documentElement.dataset.keyEvents=JSON.stringify(window.keyEvents);
          });
          for (const type of ['mousedown','mouseup','click']) document.getElementById('mouse-action').addEventListener(type, event => {
            window.mouseEvents.push({ type, buttons:event.buttons, detail:event.detail, isTrusted:event.isTrusted });
            document.documentElement.dataset.mouseEvents=JSON.stringify(window.mouseEvents);
          });
        </script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server address missing");
    baseUrl = `http://127.0.0.1:${address.port}`;
    directory = await mkdtemp(join(tmpdir(), "jevpilot-executor-"));
    browser = await createCdpDriver().launch(
      { ...testProfile(directory), executable },
      { timeoutMs: 15000, autoAcceptAlerts: false },
    );
  });
  after(async () => {
    await browser?.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (crossServer) await new Promise<void>((resolve) => crossServer.close(() => resolve()));
    if (directory)
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (harnessSamples.length) {
      const sorted = [...harnessSamples].sort((left, right) => left - right);
      const p50 = sorted[Math.floor((sorted.length - 1) / 2)];
      const max = sorted[sorted.length - 1];
      console.log(
        `Executor warm harness: p50=${p50?.toFixed(1)} ms max=${max?.toFixed(1)} ms n=${sorted.length}`,
      );
    }
  });
  async function withPage(run: (page: PageHandle) => Promise<void>): Promise<void> {
    const page = await browser.newPage();
    try {
      await page.navigate(baseUrl);
      const warmState = await observe(page);
      await executeAction(page, warmState, { kind: "wait" });
      await run(page);
    } finally {
      await page.close();
    }
  }
  function find(state: Observation, name: string): ObservedElement {
    const element = state.elements.find((item) => item.name === name);
    if (!element) throw new Error(`missing observed element: ${name}`);
    return element;
  }
  function target(state: Observation, element: ObservedElement): Target {
    return { epoch: state.epoch, ref: element.ref, fingerprint: element.fingerprint };
  }
  async function act(
    page: PageHandle,
    state: Observation,
    action: Action,
    values: Record<string, string> = {},
  ) {
    const result = await executeAction(page, state, action, values);
    harnessSamples.push(result.timings.harnessMs);
    assert.ok(result.timings.harnessMs <= 100, `harness overhead ${result.timings.harnessMs} ms`);
    assert.ok(
      result.timings.harnessMs - (result.timings.waitMs ?? 0) <= 100,
      `harness overhead ${result.timings.harnessMs} ms`,
    );
    return result;
  }

  test("M6a: reused node renamed is identity-changed; replaced node renamed is not relocated", async () =>
    withPage(async (page) => {
      await page.callIsolated(() => {
        document.body.innerHTML =
          '<button id="target">Original</button><button id="other">Other</button>';
      }, []);
      const state = await observe(page);
      const original = find(state, "Original");
      await page.callIsolated(() => {
        document.querySelector("#target")!.textContent = "Renamed";
      }, []);
      assert.equal(
        (await resolveRef(page, state.epoch, original.ref, original.fingerprint)).status,
        "identity-changed",
      );
      await page.callIsolated(() => {
        document.querySelector("#target")!.outerHTML = '<button id="target">Different</button>';
      }, []);
      const result = await executeAction(page, state, {
        kind: "click",
        target: target(state, original),
      });
      assert.equal(result.outcome, "stale");
      assert.equal(
        await page.callIsolated(() => document.querySelector("#other")!.textContent, []),
        "Other",
      );
    }));

  test("M6a: digit drift on the same node is ok and recorded; strict rejects drift", async () =>
    withPage(async (page) => {
      await page.callIsolated(() => {
        document.body.innerHTML =
          '<button id="count" onclick="this.dataset.clicked=\'yes\'">18 comments</button><button id="delete">Delete 18</button>';
      }, []);
      const state = await observe(page);
      const count = find(state, "18 comments");
      const deletion = find(state, "Delete 18");
      await page.callIsolated(() => {
        document.querySelector("#count")!.textContent = "19 comments";
        document.querySelector("#delete")!.textContent = "Delete 19";
      }, []);
      // Before the click: executing an action re-snapshots, which retires this epoch.
      assert.equal(
        (await resolveRef(page, state.epoch, deletion.ref, deletion.fingerprint, true, true))
          .status,
        "identity-changed",
      );
      const clicked = await executeAction(page, state, {
        kind: "click",
        target: target(state, count),
      });
      assert.equal(clicked.drift, true);
      assert.equal(
        await page.callIsolated(
          () => document.querySelector("#count")!.getAttribute("data-clicked"),
          [],
        ),
        "yes",
      );
      await page.callIsolated(() => {
        document.querySelector("#count")!.textContent = "18 comments";
      }, []);
      const session = new OrchestratorSession(
        { page, goal: "Open comments", budget: { steps: 1 } },
        {
          buildDecisionState: () => ({ state: {}, questions: {}, reductions: [] }),
          decide: async () => ({
            answers: {},
            usage: { inputTokens: 0, outputTokens: 0 },
            model: "fixture",
            provider: "fixture",
            latencyMs: 0,
            attempts: 1,
          }),
          interpret: (_questions, _answers, context) => {
            const link = context.observation.elements.find((item) => item.name === "18 comments")!;
            return {
              type: "act",
              action: { kind: "click", target: target(context.observation, link) },
            };
          },
          executeAction: async (...args) => {
            await page.callIsolated(() => {
              document.querySelector("#count")!.textContent = "19 comments";
            }, []);
            return executeAction(...args);
          },
        },
      );
      try {
        const result = await session.run();
        assert.equal(result.trace[0]?.drift, true);
      } finally {
        await session.close();
      }
    }));

  test("M6a: duplicate links relocate by container text; ambiguous duplicates are not executed", async () =>
    withPage(async (page) => {
      await page.callIsolated(() => {
        document.body.innerHTML =
          '<ul><li>Alpha <a id="alpha" href="#alpha" onclick="document.body.dataset.clicked=\'alpha\'">18 comments</a></li><li>Beta <a id="beta" href="#beta" onclick="document.body.dataset.clicked=\'beta\'">18 comments</a></li></ul>';
      }, []);
      let calls = 0;
      const session = new OrchestratorSession(
        {
          page,
          goal: "Open Beta comments",
          success: { text_present: "clicked" },
          budget: { steps: 1 },
        },
        {
          buildDecisionState: () => ({ state: {}, questions: {}, reductions: [] }),
          decide: async () => ({
            answers: {},
            usage: { inputTokens: 0, outputTokens: 0 },
            model: "fixture",
            provider: "fixture",
            latencyMs: 0,
            attempts: 1,
          }),
          interpret: (_questions, _answers, context) => {
            const beta = context.observation.elements.find(
              (item) => item.role === "link" && item.containerText?.includes("Beta"),
            )!;
            return {
              type: "act",
              action: { kind: "click", target: target(context.observation, beta) },
            };
          },
          executeAction: async (...args) => {
            if (calls++ === 0)
              await page.callIsolated(() => {
                document.querySelector("#beta")!.outerHTML =
                  '<a id="beta" href="#beta" onclick="document.body.dataset.clicked=\'beta\'">18 comments</a>';
              }, []);
            return executeAction(...args);
          },
          pageMatches: async () =>
            (await page.callIsolated(() => document.body.dataset.clicked, [])) === "beta",
        },
      );
      const result = await session.run();
      assert.equal(result.status, "DONE_VERIFIED");
      assert.deepEqual(
        result.trace.map((item) => item.outcome),
        ["stale", "changed"],
      );
      assert.equal(calls, 2);
      await page.callIsolated(() => {
        document.body.innerHTML =
          '<a id="one" href="#one">18 comments</a><a id="two" href="#two">18 comments</a>';
      }, []);
      let ambiguousCalls = 0;
      let decisions = 0;
      const ambiguous = new OrchestratorSession(
        { page, goal: "Open comments", budget: { steps: 2 } },
        {
          buildDecisionState: () => ({ state: {}, questions: {}, reductions: [] }),
          decide: async () => ({
            answers: {},
            usage: { inputTokens: 0, outputTokens: 0 },
            model: "fixture",
            provider: "fixture",
            latencyMs: 0,
            attempts: 1,
          }),
          interpret: (_questions, _answers, context) =>
            decisions++ === 0
              ? {
                  type: "act",
                  action: {
                    kind: "click",
                    target: target(
                      context.observation,
                      context.observation.elements.find((item) => item.role === "link")!,
                    ),
                  },
                }
              : {
                  type: "handoff",
                  reason: "uncertain",
                  source: "code",
                  details: { missing: "ambiguous" },
                },
          executeAction: async (...args) => {
            if (ambiguousCalls++ === 0)
              await page.callIsolated(() => {
                document.querySelector("#one")!.outerHTML =
                  '<a id="one" href="#one">18 comments</a>';
              }, []);
            return executeAction(...args);
          },
        },
      );
      try {
        assert.equal((await ambiguous.run()).status, "UNCERTAIN");
        assert.equal(ambiguousCalls, 1);
        assert.equal(await page.callIsolated(() => location.hash, []), "#beta");
      } finally {
        await ambiguous.close();
        await session.close();
      }
    }));

  test("M6a: a re-rendered filled field is relocated by identity name", async () =>
    withPage(async (page) => {
      await page.callIsolated(() => {
        document.body.innerHTML =
          '<input id="filled" placeholder="Search books" value="query"><input id="other" placeholder="Other field" value="x">';
      }, []);
      const first = await observe(page);
      const filled = first.elements.find((item) => item.placeholder === "Search books");
      assert.ok(filled);
      assert.equal(filled.name, "");
      assert.equal(filled.identityName, "Search books");
      assert.equal(first.elements.find((item) => item.placeholder === "Other field")?.name, "");
      let calls = 0;
      const session = new OrchestratorSession(
        { page, goal: "Update search", success: { text_present: "updated" }, budget: { steps: 1 } },
        {
          buildDecisionState: () => ({ state: {}, questions: {}, reductions: [] }),
          decide: async () => ({
            answers: {},
            usage: { inputTokens: 0, outputTokens: 0 },
            model: "fixture",
            provider: "fixture",
            latencyMs: 0,
            attempts: 1,
          }),
          interpret: (_questions, _answers, context) => {
            const field = context.observation.elements.find(
              (item) => item.placeholder === "Search books",
            )!;
            return {
              type: "act",
              action: { kind: "type", target: target(context.observation, field), text: "updated" },
            };
          },
          executeAction: async (...args) => {
            if (calls++ === 0)
              await page.callIsolated(() => {
                document.querySelector("#filled")!.outerHTML =
                  '<input id="filled" placeholder="Search books" value="query">';
              }, []);
            return executeAction(...args);
          },
          pageMatches: async () =>
            (await page.callIsolated(
              () => (document.querySelector("#filled") as HTMLInputElement).value,
              [],
            )) === "updated",
        },
      );
      try {
        const result = await session.run();
        assert.equal(result.status, "DONE_VERIFIED");
        assert.deepEqual(
          result.trace.map((item) => item.outcome),
          ["stale", "changed"],
        );
        assert.equal(calls, 2);
        assert.equal(
          await page.callIsolated(
            () => (document.querySelector("#other") as HTMLInputElement).value,
            [],
          ),
          "x",
        );
      } finally {
        await session.close();
      }
    }));

  test("M6a: relocation after a list shift follows container text, not the old position", async () =>
    withPage(async (page) => {
      await page.callIsolated(() => {
        document.body.innerHTML =
          '<ul id="list"><li>Alpha <a id="alpha" href="#alpha" onclick="document.body.dataset.clicked=\'alpha\'">18 comments</a></li><li>Beta <a id="beta" href="#beta" onclick="document.body.dataset.clicked=\'beta\'">18 comments</a></li></ul>';
      }, []);
      let calls = 0;
      const session = new OrchestratorSession(
        {
          page,
          goal: "Open Beta comments",
          success: { text_present: "clicked" },
          budget: { steps: 1 },
        },
        {
          buildDecisionState: () => ({ state: {}, questions: {}, reductions: [] }),
          decide: async () => ({
            answers: {},
            usage: { inputTokens: 0, outputTokens: 0 },
            model: "fixture",
            provider: "fixture",
            latencyMs: 0,
            attempts: 1,
          }),
          interpret: (_questions, _answers, context) => {
            const beta = context.observation.elements.find(
              (item) => item.role === "link" && item.containerText?.includes("Beta"),
            )!;
            return {
              type: "act",
              action: { kind: "click", target: target(context.observation, beta) },
            };
          },
          executeAction: async (...args) => {
            // A new story lands on top and Beta's node is re-rendered: Beta moves from
            // position 2 to 3, and position 2 now holds Alpha.
            if (calls++ === 0)
              await page.callIsolated(() => {
                document
                  .querySelector("#list")!
                  .insertAdjacentHTML(
                    "afterbegin",
                    '<li>Gamma <a id="gamma" href="#gamma" onclick="document.body.dataset.clicked=\'gamma\'">18 comments</a></li>',
                  );
                document.querySelector("#beta")!.outerHTML =
                  '<a id="beta" href="#beta" onclick="document.body.dataset.clicked=\'beta\'">18 comments</a>';
              }, []);
            return executeAction(...args);
          },
          pageMatches: async () =>
            (await page.callIsolated(() => document.body.dataset.clicked, [])) === "beta",
        },
      );
      try {
        const result = await session.run();
        assert.equal(await page.callIsolated(() => document.body.dataset.clicked, []), "beta");
        assert.equal(result.status, "DONE_VERIFIED");
        assert.deepEqual(
          result.trace.map((item) => item.outcome),
          ["stale", "changed"],
        );
      } finally {
        await session.close();
      }
    }));

  test("click navigates and settles on DOMContentLoaded; back navigates", async () =>
    withPage(async (page) => {
      const state = await observe(page);
      const clicked = await act(page, state, {
        kind: "click",
        target: target(state, find(state, "Navigate")),
      });
      assert.equal(clicked.outcome, "changed");
      assert.equal(clicked.changes.url, true);
      const next = await observe(page);
      const backed = await act(page, next, { kind: "back" });
      assert.equal(backed.changes.url, true);
    }));

  test("delayed href navigation starts after 150 ms", async () => {
    const page = await browser.newPage();
    try {
      await page.navigate(`${baseUrl}/delayed`);
      const state = await observe(page);
      const clicked = await executeAction(page, state, {
        kind: "click",
        target: target(state, find(state, "Delayed link")),
      });
      assert.equal(clicked.changes.url, true);
      assert.match(clicked.url ?? "", /\/next$/u);
    } finally {
      await page.close();
    }
  });

  test("pushState router navigation is observed after click", async () => {
    const page = await browser.newPage();
    try {
      await page.navigate(`${baseUrl}/router`);
      const state = await observe(page);
      const clicked = await executeAction(page, state, {
        kind: "click",
        target: target(state, find(state, "Router link")),
      });
      assert.equal(clicked.changes.url, true);
      assert.match(clicked.url ?? "", /\/routed$/u);
    } finally {
      await page.close();
    }
  });

  test("wrapped heading link uses a client rect point without false occlusion", async () => {
    const page = await browser.newPage();
    try {
      await page.navigate(`${baseUrl}/wrapped-link`);
      const state = await observe(page);
      const clicked = await executeAction(page, state, {
        kind: "click",
        target: target(
          state,
          find(state, "A long question title that wraps across two lines in this heading"),
        ),
      });
      assert.notEqual(clicked.outcome, "covered");
      assert.equal(clicked.changes.url, true);
    } finally {
      await page.close();
    }
  });

  test("open listbox covering a result link closes with Escape and retries", async () => {
    const page = await browser.newPage();
    try {
      await page.navigate(`${baseUrl}/overlay`);
      const session = new OrchestratorSession(
        { page, goal: "Open result", success: { url_matches: "/next$" } },
        {
          buildDecisionState: () => ({ state: {}, questions: {}, reductions: [] }),
          decide: async () => ({
            answers: {},
            usage: { inputTokens: 0, outputTokens: 0 },
            model: "fixture",
            provider: "fixture",
            latencyMs: 0,
            attempts: 1,
          }),
          interpret: (_questions, _answers, context) => {
            const link = context.observation.elements.find((item) => item.name === "Result link")!;
            return {
              type: "act",
              action: {
                kind: "click",
                target: {
                  epoch: context.observation.epoch,
                  ref: link.ref,
                  fingerprint: link.fingerprint,
                },
              },
            };
          },
        },
      );
      try {
        const result = await session.run();
        assert.equal(result.status, "DONE_VERIFIED");
        assert.deepEqual(result.trace[0]?.coveredBy, { role: "listbox", name: "Suggestions" });
        assert.equal(result.trace[1]?.outcome, "changed");
      } finally {
        await session.close();
      }
    } finally {
      await page.close();
    }
  });

  test("covered cookie banner reports role and name; click succeeds after close", async () =>
    withPage(async (page) => {
      let state = await observe(page);
      const blocked = await act(page, state, {
        kind: "click",
        target: target(state, find(state, "Covered action")),
      });
      assert.equal(blocked.outcome, "covered");
      assert.equal(blocked.coveredBy?.name, "Cookie banner");
      await act(page, state, {
        kind: "click",
        target: target(state, find(state, "Close cookies")),
      });
      state = await observe(page);
      assert.equal(
        (
          await act(page, state, {
            kind: "click",
            target: target(state, find(state, "Covered action")),
          })
        ).outcome,
        "changed",
      );
    }));

  test("M6b: element that appears after 300 ms is clicked", async () =>
    withPage(async (page) => {
      await page.callIsolated(() => {
        document.body.innerHTML =
          '<button id="late" onclick="this.dataset.hit=\'yes\'">Late button</button>';
      }, []);
      const state = await observe(page);
      await page.callIsolated(() => {
        const button = document.querySelector<HTMLElement>("#late")!;
        button.style.visibility = "hidden";
        setTimeout(() => {
          button.style.visibility = "visible";
        }, 300);
      }, []);
      const result = await executeAction(page, state, {
        kind: "click",
        target: target(state, find(state, "Late button")),
      });
      assert.ok((result.timings.waitMs ?? 0) >= 250);
      assert.equal(
        await page.callIsolated(
          () => document.querySelector("#late")?.getAttribute("data-hit"),
          [],
        ),
        "yes",
      );
    }));

  test("M6b: button enabled after 300 ms is clicked", async () =>
    withPage(async (page) => {
      await page.callIsolated(() => {
        document.body.innerHTML =
          '<button id="late" onclick="this.dataset.hit=\'yes\'">Enable me</button>';
      }, []);
      const state = await observe(page);
      await page.callIsolated(() => {
        const button = document.querySelector<HTMLButtonElement>("#late")!;
        button.disabled = true;
        setTimeout(() => {
          button.disabled = false;
        }, 300);
      }, []);
      const result = await executeAction(page, state, {
        kind: "click",
        target: target(state, find(state, "Enable me")),
      });
      assert.ok((result.timings.waitMs ?? 0) >= 250);
      assert.equal(
        await page.callIsolated(
          () => document.querySelector("#late")?.getAttribute("data-hit"),
          [],
        ),
        "yes",
      );
    }));

  test("M6b: click lands on an element after its 400 ms transition", async () =>
    withPage(async (page) => {
      await page.callIsolated(() => {
        document.body.innerHTML =
          '<button id="moving" style="transition:transform 1500ms" onclick="this.dataset.hit=\'yes\';this.dataset.clickAt=performance.now()">Moving button</button>';
        const moving = document.querySelector<HTMLElement>("#moving")!;
        moving.addEventListener("transitionend", () => {
          moving.dataset.transitionAt = String(performance.now());
        });
      }, []);
      const state = await observe(page);
      await page.callIsolated(() => {
        const moving = document.querySelector<HTMLElement>("#moving")!;
        getComputedStyle(moving).transform;
        moving.style.transform = "translateX(120px)";
      }, []);
      const result = await executeAction(page, state, {
        kind: "click",
        target: target(state, find(state, "Moving button")),
      });
      const evidence = await page.callIsolated(() => {
        const moving = document.querySelector<HTMLElement>("#moving")!;
        return {
          hit: moving.dataset.hit,
          clickAt: Number(moving.dataset.clickAt),
          transitionAt: Number(moving.dataset.transitionAt),
        };
      }, []);
      assert.equal(evidence.hit, "yes");
      assert.ok(evidence.transitionAt > 0);
      assert.ok(evidence.clickAt >= evidence.transitionAt);
    }));

  test("O10: the executor waits for an animation that has not started yet", async () =>
    withPage(async (page) => {
      await page.callIsolated(() => {
        document.body.innerHTML =
          '<button id="moving" onclick="this.dataset.hit=\'yes\';this.dataset.clickAt=performance.now()">Pending button</button>';
      }, []);
      const state = await observe(page);
      // An animation without a timeline stays pending and does not move; it starts 300 ms later.
      // A fresh CSS transition is pending the same way for a few frames (longer in headless Chrome).
      await page.callIsolated(() => {
        const moving = document.querySelector<HTMLElement>("#moving")!;
        const animation = new Animation(
          new KeyframeEffect(moving, [{ transform: "none" }, { transform: "translateX(120px)" }], {
            duration: 400,
            fill: "forwards",
          }),
          null,
        );
        animation.onfinish = () => {
          moving.dataset.finishedAt = String(performance.now());
        };
        animation.play();
        setTimeout(() => {
          animation.timeline = document.timeline;
        }, 300);
      }, []);
      const result = await executeAction(page, state, {
        kind: "click",
        target: target(state, find(state, "Pending button")),
      });
      const evidence = await page.callIsolated(() => {
        const moving = document.querySelector<HTMLElement>("#moving")!;
        return {
          hit: moving.dataset.hit,
          clickAt: Number(moving.dataset.clickAt),
          finishedAt: Number(moving.dataset.finishedAt),
        };
      }, []);
      assert.notEqual(result.outcome, "unstable");
      assert.equal(evidence.hit, "yes");
      assert.ok(evidence.finishedAt > 0);
      assert.ok(evidence.clickAt >= evidence.finishedAt);
    }));

  test("M6b: loading overlay removed after 500 ms, then click", async () =>
    withPage(async (page) => {
      await page.callIsolated(() => {
        document.body.innerHTML =
          '<button id="target" onclick="this.dataset.hit=\'yes\'">Wait target</button>';
      }, []);
      const state = await observe(page);
      await page.callIsolated(() => {
        const button = document.querySelector<HTMLElement>("#target")!;
        const box = button.getBoundingClientRect();
        const cover = document.createElement("div");
        cover.id = "loading";
        Object.assign(cover.style, {
          position: "fixed",
          left: `${box.left}px`,
          top: `${box.top}px`,
          width: `${box.width}px`,
          height: `${box.height}px`,
          zIndex: "100",
          background: "white",
        });
        document.body.append(cover);
        setTimeout(() => cover.remove(), 500);
      }, []);
      const result = await executeAction(page, state, {
        kind: "click",
        target: target(state, find(state, "Wait target")),
      });
      assert.ok((result.timings.waitMs ?? 0) >= 450);
      assert.equal(
        await page.callIsolated(
          () => document.querySelector("#target")?.getAttribute("data-hit"),
          [],
        ),
        "yes",
      );
    }));

  test("M6b: permanent overlay reports covered after the timeout", async () =>
    withPage(async (page) => {
      await page.callIsolated(() => {
        document.body.innerHTML = '<button id="target">Covered target</button>';
      }, []);
      const state = await observe(page);
      await page.callIsolated(() => {
        const box = document.querySelector("#target")!.getBoundingClientRect();
        const cover = document.createElement("div");
        cover.setAttribute("aria-label", "Loading overlay");
        Object.assign(cover.style, {
          position: "fixed",
          left: `${box.left}px`,
          top: `${box.top}px`,
          width: `${box.width}px`,
          height: `${box.height}px`,
          zIndex: "100",
          background: "white",
        });
        document.body.append(cover);
      }, []);
      const result = await executeAction(
        page,
        state,
        { kind: "click", target: target(state, find(state, "Covered target")) },
        {},
        { actionabilityTimeoutMs: 150 },
      );
      assert.equal(result.outcome, "covered");
      assert.equal(result.coveredBy?.name, "Loading overlay");
      assert.ok((result.timings.waitMs ?? 0) >= 140);
    }));

  test("M6b: transient popup cover returns covered without waiting", async () =>
    withPage(async (page) => {
      await page.callIsolated(() => {
        document.body.innerHTML = '<button id="target">Result link</button>';
      }, []);
      const state = await observe(page);
      await page.callIsolated(() => {
        const box = document.querySelector("#target")!.getBoundingClientRect();
        const popup = document.createElement("div");
        popup.setAttribute("role", "listbox");
        popup.setAttribute("aria-label", "Suggestions");
        Object.assign(popup.style, {
          position: "fixed",
          left: `${box.left}px`,
          top: `${box.top}px`,
          width: `${box.width}px`,
          height: `${box.height}px`,
          zIndex: "100",
          background: "white",
        });
        document.body.append(popup);
      }, []);
      const result = await executeAction(
        page,
        state,
        { kind: "click", target: target(state, find(state, "Result link")) },
        {},
        { actionabilityTimeoutMs: 2000 },
      );
      assert.equal(result.outcome, "covered");
      assert.equal(result.coveredBy?.role, "listbox");
      assert.equal(result.timings.waitMs ?? 0, 0);
      assert.ok(result.timings.precheckMs < 500, `precheck ${result.timings.precheckMs} ms`);
    }));

  test("M6b: placeholder overlay and label overlay fields receive text via focus", async () =>
    withPage(async (page) => {
      await page.callIsolated(() => {
        document.body.innerHTML =
          '<div style="position:relative"><input id="field" aria-label="Covered field" style="width:180px;height:32px"></div>';
      }, []);
      for (const overlay of ["placeholder", "label"] as const) {
        const state = await observe(page);
        await page.callIsolated(
          (kind: string) => {
            const field = document.querySelector<HTMLInputElement>("#field")!;
            const cover = document.createElement(kind === "label" ? "label" : "div");
            cover.id = "cover";
            if (kind === "label") (cover as HTMLLabelElement).htmlFor = "field";
            cover.textContent = "Overlay";
            Object.assign(cover.style, {
              position: "absolute",
              left: "0",
              top: "0",
              width: "180px",
              height: "32px",
              zIndex: "10",
              background: "white",
            });
            field.parentElement!.append(cover);
          },
          [overlay],
        );
        await executeAction(page, state, {
          kind: "type",
          target: target(state, find(state, "Covered field")),
          text: overlay,
        });
        assert.equal(
          await page.callIsolated(
            () => document.querySelector<HTMLInputElement>("#field")?.value,
            [],
          ),
          overlay,
        );
        await page.callIsolated(() => document.querySelector("#cover")?.remove(), []);
      }
    }));

  test("M6b: interactive overlay over a field is not typed through", async () =>
    withPage(async (page) => {
      await page.callIsolated(() => {
        document.body.innerHTML =
          '<div style="position:relative"><input id="field" aria-label="Protected field" style="width:180px;height:32px"></div>';
      }, []);
      const state = await observe(page);
      await page.callIsolated(() => {
        const cover = document.createElement("button");
        cover.textContent = "Block";
        Object.assign(cover.style, {
          position: "absolute",
          left: "0",
          top: "0",
          width: "180px",
          height: "32px",
          zIndex: "10",
        });
        document.querySelector("#field")!.parentElement!.append(cover);
      }, []);
      const result = await executeAction(
        page,
        state,
        { kind: "type", target: target(state, find(state, "Protected field")), text: "blocked" },
        {},
        { actionabilityTimeoutMs: 120 },
      );
      assert.equal(result.outcome, "covered");
      assert.equal(
        await page.callIsolated(
          () => document.querySelector<HTMLInputElement>("#field")?.value,
          [],
        ),
        "",
      );
    }));

  test("M6b: ready targets do not wait", async () =>
    withPage(async (page) => {
      await page.callIsolated(() => {
        document.body.innerHTML =
          '<button id="ready" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">Ready button</button>';
      }, []);
      for (let index = 0; index < 20; index++) {
        const state = await observe(page);
        const result = await executeAction(page, state, {
          kind: "click",
          target: target(state, find(state, "Ready button")),
        });
        assert.equal(result.timings.waitMs, 0);
      }
      assert.equal(
        await page.callIsolated(
          () => document.querySelector("#ready")?.getAttribute("data-clicks"),
          [],
        ),
        "20",
      );
    }));

  test("stale ref after rerender does not click", async () =>
    withPage(async (page) => {
      const state = await observe(page);
      const rerender = await act(page, state, {
        kind: "click",
        target: target(state, find(state, "Rerender")),
      });
      assert.equal(rerender.outcome, "changed");
      const stale = await act(page, state, {
        kind: "click",
        target: target(state, find(state, "Stale target")),
      });
      assert.equal(stale.outcome, "stale");
    }));

  test("type text email password and delayed search suggestions", async () =>
    withPage(async (page) => {
      for (const [name, secret] of [
        ["Text", false],
        ["Email", false],
        ["Password", true],
        ["Search", false],
      ] as const) {
        const state = await observe(page);
        const value =
          name === "Email" ? "a@example.test" : name === "Search" ? "lookup" : "private-secret";
        const result = await act(
          page,
          state,
          { kind: "type", target: target(state, find(state, name)), valueKey: "entry" },
          { entry: value },
        );
        assert.equal(result.outcome, "changed");
        assert.equal(result.changes.value, true);
        if (secret) assert.doesNotMatch(JSON.stringify(result), /private-secret/u);
        if (secret) {
          const next = await observe(page);
          const replacement = await act(
            page,
            next,
            { kind: "type", target: target(next, find(next, "Password")), valueKey: "entry" },
            { entry: "revised-secret" },
          );
          assert.equal(replacement.outcome, "changed");
          assert.equal(replacement.changes.value, true);
          assert.doesNotMatch(JSON.stringify(replacement), /revised-secret/u);
        }
        if (name === "Search") assert.match((await observe(page)).text, /Suggestion/u);
      }
    }));

  test("native select uses trusted keyboard events and toggle flips checked", async () =>
    withPage(async (page) => {
      let state = await observe(page);
      const selected = await act(page, state, {
        kind: "select",
        target: target(state, find(state, "Choice")),
        optionLabel: "Third",
      });
      assert.equal(selected.outcome, "changed");
      assert.equal(
        await page.callIsolated(
          () => document.querySelector("select")?.getAttribute("data-trusted"),
          [],
        ),
        "true",
      );
      state = await observe(page);
      const toggled = await act(page, state, {
        kind: "toggle",
        target: target(state, find(state, "Agree")),
      });
      assert.equal(toggled.changes.checked, true);
    }));

  test("R1: an option after the first twenty of a native select can be selected", async () =>
    withPage(async (page) => {
      await page.callIsolated(() => {
        document.body.innerHTML = '<label>Long list <select id="long-list"></select></label>';
        const select = document.querySelector("select")!;
        for (let index = 0; index < 60; index++) select.add(new Option(`Option ${index}`));
      }, []);
      const state = await observe(page);
      const select = find(state, "Long list");
      assert.equal(select.options?.length, 20);
      assert.equal(select.optionCount, 60);
      const result = await executeAction(page, state, {
        kind: "select",
        target: target(state, select),
        optionLabel: "Option 45",
      });
      assert.equal(result.outcome, "changed");
      assert.equal(
        await page.callIsolated(
          () => (document.querySelector("select") as HTMLSelectElement).selectedIndex,
          [],
        ),
        45,
      );
    }));

  test("keyboard events carry key code and trusted modifiers", async () =>
    withPage(async (page) => {
      await page.callIsolated(() => document.getElementById("key-capture")?.focus(), []);
      await page.key("ArrowDown");
      await page.key("Enter");
      await page.key("Tab");
      assert.equal(await page.callIsolated(() => document.activeElement?.id, []), "submit-field");
      await page.selectAll();
      const eventsJson = await page.callIsolated(
        () => document.documentElement.dataset.keyEvents ?? "[]",
        [],
      );
      const events = JSON.parse(eventsJson) as {
        key: string;
        code: string;
        keyCode: number;
        isTrusted: boolean;
        ctrlKey: boolean;
      }[];
      for (const key of ["ArrowDown", "Enter", "Tab", "a"]) {
        const event = events.find((item) => item.key === key);
        assert.ok(event, `${key} keydown missing`);
        assert.ok(event.keyCode > 0, `${key} keyCode is zero`);
        assert.ok(event.code.length > 0, `${key} code missing`);
        assert.equal(event.isTrusted, true);
      }
      assert.equal(events.find((event) => event.key === "a")?.ctrlKey, true);
    }));

  test("Enter submits a form through trusted keyboard input", async () =>
    withPage(async (page) => {
      await page.callIsolated(() => document.getElementById("submit-field")?.focus(), []);
      const state = await observe(page);
      const result = await act(page, state, { kind: "key", name: "Enter" });
      assert.equal(result.outcome, "changed");
      assert.equal(result.changes.url, true);
      assert.equal(new URL((await observe(page)).url).pathname, "/submitted");
    }));

  test("O9e: a key-driven date picker keeps the value jevpilot typed", async () =>
    withPage(async (page) => {
      await page.navigate(`${baseUrl}/o9e-date`, { timeoutMs: 5000 });
      const before = await observe(page);
      const date = find(before, "Date");
      await executeAction(page, before, {
        kind: "type",
        target: { epoch: before.epoch, ref: date.ref, fingerprint: date.fingerprint },
        text: "09/28/2026",
      });
      const afterType = await observe(page);
      const select = find(afterType, "Other");
      await executeAction(page, afterType, {
        kind: "select",
        target: { epoch: afterType.epoch, ref: select.ref, fingerprint: select.fingerprint },
        optionLabel: "Two",
      });
      const value = await page.callIsolated(
        () => (document.getElementById("date") as HTMLInputElement).value,
        [],
      );
      assert.equal(value, "09/28/2026");
    }));

  test("SUBMIT uses focused replacement search input after first keystroke", async () =>
    withPage(async (page) => {
      const before = await observe(page);
      const field = find(before, "Dynamic search");
      const typed = await act(
        page,
        before,
        { kind: "type", target: target(before, field), valueKey: "query" },
        { query: "article" },
      );
      assert.equal(typed.outcome, "changed");
      assert.equal(
        await page.callIsolated(
          () => document.getElementById("dynamic-input")?.dataset.replaced,
          [],
        ),
        "1",
      );
      const after = await observe(page);
      const submitted = await act(page, after, { kind: "submit", target: target(before, field) });
      assert.equal(submitted.changes.url, true);
      assert.equal(new URL((await observe(page)).url).pathname, "/submitted");
    }));

  test("trusted mouse click reports buttons and detail", async () =>
    withPage(async (page) => {
      const state = await observe(page);
      const result = await act(page, state, {
        kind: "click",
        target: target(state, find(state, "Mouse action")),
      });
      assert.equal(result.outcome, "changed");
      const eventsJson = await page.callIsolated(
        () => document.documentElement.dataset.mouseEvents ?? "[]",
        [],
      );
      const events = JSON.parse(eventsJson) as {
        type: string;
        buttons: number;
        detail: number;
        isTrusted: boolean;
      }[];
      assert.deepEqual(
        events.map((event) => [event.type, event.buttons, event.detail, event.isTrusted]),
        [
          ["mousedown", 1, 1, true],
          ["mouseup", 0, 1, true],
          ["click", 0, 1, true],
        ],
      );
    }));

  test("scroll brings a below-fold element into viewport", async () =>
    withPage(async (page) => {
      let state = await observe(page);
      for (let step = 0; step < 4; step++) {
        await act(page, state, { kind: "scroll", direction: "down" });
        state = await observe(page);
        if (state.elements.some((item) => item.name === "Below fold" && item.inViewport)) return;
      }
      assert.fail("below-fold button never reached viewport");
    }));

  test("confirm click returns dialog-opened", async () =>
    withPage(async (page) => {
      const state = await observe(page);
      const result = await act(page, state, {
        kind: "click",
        target: target(state, find(state, "Confirm action")),
      });
      assert.equal(result.outcome, "dialog-opened");
      assert.equal(result.dialog?.kind, "confirm");
      await page.handleDialog(false);
    }));

  test("click inside a cross-origin iframe", async () =>
    withPage(async (page) => {
      const state = await observe(page);
      const frameButton = find(state, "Frame action");
      assert.match(frameButton.ref, /^frame:/u);
      const result = await act(page, state, { kind: "click", target: target(state, frameButton) });
      assert.equal(result.outcome, "changed");
    }));

  test("R2: a click inside a scaled iframe lands on its target", async () =>
    withPage(async (page) => {
      await page.navigate(`${baseUrl}/scaled-frame`);
      const state = await observe(page);
      const button = find(state, "Scaled action");
      const result = await act(page, state, { kind: "click", target: target(state, button) });
      assert.equal(result.outcome, "changed");
      const frame = (await page.frames())[0]!;
      assert.equal(
        await frame.callIsolated(() => document.querySelector("button")?.textContent, []),
        "Scaled clicked",
      );
    }));

  test("R2: typing into a contenteditable editor is reported as a change", async () =>
    withPage(async (page) => {
      await page.callIsolated(
        () =>
          (document.body.innerHTML =
            '<div contenteditable role="textbox" aria-label="Editor">before</div>'),
        [],
      );
      const state = await observe(page);
      const editor = find(state, "Editor");
      const result = await act(page, state, {
        kind: "type",
        target: target(state, editor),
        text: "after",
      });
      assert.equal(result.changes.value, true);
    }));

  test("R2: selecting past a disabled option picks the requested option", async () =>
    withPage(async (page) => {
      await page.callIsolated(
        () =>
          (document.body.innerHTML =
            "<label>Pick <select><option>One</option><option disabled>Skip</option><option>Three</option><option>Four</option></select></label>"),
        [],
      );
      const state = await observe(page);
      const select = find(state, "Pick");
      const result = await act(page, state, {
        kind: "select",
        target: target(state, select),
        optionLabel: "Three",
      });
      assert.equal(result.outcome, "changed");
      assert.equal(
        await page.callIsolated(
          () => (document.querySelector("select") as HTMLSelectElement).selectedIndex,
          [],
        ),
        2,
      );
    }));

  test("M6x: the executor reports popup opened for a slow target=_blank submit", async () =>
    withPage(async (page) => {
      await page.callIsolated(
        (url: string) => {
          document.body.innerHTML = `<form target="_blank" action="${url}/slow-results"><input type="search" name="q"></form>`;
        },
        [baseUrl],
      );
      const before = await observe(page);
      const field = before.elements.find((item) => item.inputType === "search");
      assert.ok(field);
      const result = await act(page, before, {
        kind: "type",
        target: target(before, field),
        text: "query",
        submit: true,
      });
      assert.equal(result.popup, "opened");
      assert.equal((await page.targetUrl?.()) ?? "", `${baseUrl}/`);
    }));
});
