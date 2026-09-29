import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { findChrome } from "../../../src/browser/launcher.ts";
import { MockDecider, type MockStep } from "../../../src/decision/mock.ts";
import type { Answers, DecisionRequest, Question } from "../../../src/decision/types.ts";
import { createCdpDriver } from "../../../src/engine/cdp/driver.ts";
import type { BrowserHandle } from "../../../src/engine/types.ts";
import {
  OrchestratorSession,
  type SessionOptions,
  type SessionResult,
} from "../../../src/orchestrator/session.ts";
import { testProfile } from "../../support/browser-profile.ts";

const executable = process.env.JEVPILOT_SKIP_BROWSER === "1" ? undefined : await findChrome();
const skipped =
  process.env.JEVPILOT_SKIP_BROWSER === "1"
    ? "JEVPILOT_SKIP_BROWSER=1"
    : !executable
      ? "Chrome executable not found"
      : undefined;

function answersFor(
  request: DecisionRequest,
  wanted: {
    op?: string;
    target?: string;
    situation?: string;
    value?: string;
    goalMet?: number;
  } = {},
): Answers {
  const answers: Answers = {};
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === "noul") {
      answers[id] = { noul: wanted.goalMet ?? 0 };
      continue;
    }
    if (question.type === "score") throw new Error("unexpected score question");
    const keys = Object.keys(question.criteria);
    const chosen =
      id === "op"
        ? wanted.op
        : id === "situation"
          ? wanted.situation
          : id.endsWith("_target")
            ? wanted.target
            : id.startsWith("value_for_")
              ? wanted.value
              : undefined;
    const choice =
      chosen && keys.includes(chosen)
        ? chosen
        : keys.includes("none")
          ? "none"
          : keys.includes("not_provided")
            ? "not_provided"
            : keys[0]!;
    answers[id] = {
      choice,
      confidence: 1,
      probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])),
    };
  }
  return answers;
}

describe("real Chrome orchestrator local fixture", { skip: skipped }, () => {
  let server: Server;
  let browser: BrowserHandle;
  let directory: string;
  let base: string;
  before(async () => {
    server = createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      const path = (request.url ?? "/").split("?")[0];
      if (path === "/challenge") response.setHeader("cf-mitigated", "challenge");
      if (path === "/form-challenge") response.setHeader("cf-mitigated", "challenge");
      if (path === "/waf") {
        response.setHeader("x-amzn-waf-action", "captcha");
        response.statusCode = 405;
      }
      if (path === "/not-found") response.statusCode = 404;
      if (path === "/error") response.statusCode = 500;
      if (path === "/slow-results") {
        setTimeout(() => response.end("<title>Results</title><h1>Popup results</h1>"), 1500);
        return;
      }
      const pages: Record<string, string> = {
        "/search": '<title>Search</title><a href="/result">Search result</a>',
        "/result": "<title>Result</title><h1>Found result</h1>",
        "/form":
          '<title>Form</title><form action="/form-done"><label>Name <input name="name" required></label><button>Continue</button></form>',
        "/form-done": "<title>Form done</title><h1>Form complete</h1>",
        "/login":
          '<title>Login</title><form><label>Email <input type="email"></label><label>Password <input type="password"></label><button>Sign in</button></form>',
        "/batch-login":
          '<title>Login</title><form action="/batch-done"><label>Email <input type="email" required></label><label>Password <input type="password" required></label><button>Sign in</button></form>',
        "/batch-done": "<title>Signed in</title><h1>Signed in</h1>",
        // The page clears the field once, 1 s after the first input: after the type step has checked its
        // value, before the (delayed) submit decision.
        "/o9e-clear": `<title>Profile</title><form action="/o9e-done"><label>Name <input name="name"></label><button>Continue</button></form>
          <script>
            const field = document.querySelector("input");
            let cleared = false;
            field.addEventListener("input", () => {
              if (cleared) return;
              cleared = true;
              setTimeout(() => (field.value = ""), 1000);
            });
          </script>`,
        "/o9e-done":
          '<title>Saved</title><p id="saved"></p><script>document.getElementById("saved").textContent = "Saved name " + new URLSearchParams(location.search).get("name");</script>',
        "/dynamic-merge": `<title>Dynamic search</title>
          <form id="dynamic" action="/dynamic-result">
            <label>Search <input id="dynamic-input" type="search"></label>
            <button id="dynamic-button">Search</button>
          </form>
          <script>
            document.getElementById("dynamic-input").addEventListener("input", function () {
              const next = this.cloneNode(true);
              next.value = this.value;
              this.replaceWith(next);
              document.getElementById("dynamic-button").replaceWith(
                document.getElementById("dynamic-button").cloneNode(true)
              );
              next.focus();
            });
          </script>`,
        "/dynamic-result": "<title>Result</title><h1>Dynamic result</h1>",
        "/popup-search":
          '<title>Popup search</title><form target="_blank" action="/slow-results"><label>Search <input type="search" name="q"></label></form>',
        "/place-order":
          '<title>Order</title><form action="/batch-done"><label>Order note <input value="ready"></label><button>Place order</button></form>',
        "/buy":
          "<title>Buy</title><button onclick=\"document.body.innerHTML='<h1>Purchased</h1>'\">Buy now</button>",
        "/external": '<title>External</title><a href="http://outside.test/">Outside</a>',
        "/local-outside": `<title>Local outside</title><a href="http://outside.test:${(server.address() as { port: number }).port}/result">Local result</a>`,
        "/dialog":
          "<title>Dialog</title><button onclick=\"if(confirm('Continue?'))document.body.innerHTML='<h1>Dialog complete</h1>'\">Continue</button>",
        // The deep content arrives after the first observation (M6e ignores assertions true on the start page).
        "/deep": `<title>Deep</title>${Array.from({ length: 140 }, (_, index) => `<button>Other ${index}</button>`).join("")}<div id="late"></div><script>setTimeout(() => { document.querySelector("#late").innerHTML = "<p>" + "x".repeat(1800) + "Beyond compact</p><button>Deep result</button>"; }, 1000)</script>`,
        "/challenge":
          '<title>Just a moment...</title><div class="cf-turnstile" style="width:300px;height:70px">Checking</div>',
        "/error": "<title>Error</title><h1>Server error</h1>",
        "/link-404": '<title>Links</title><a href="/not-found">Open result</a>',
        "/not-found": "<title>Missing</title><h1>Missing document</h1>",
        "/form-challenge-start":
          '<title>Form</title><form action="/form-challenge"><input name="query" value="ready"><button>Continue</button></form>',
        "/form-challenge": "<title>Verification</title><h1>Verification required</h1>",
        "/push-state":
          "<title>History</title><button onclick=\"history.pushState({}, '', '/push-state?next=1'); document.querySelector('h1').textContent='Updated'\">Update</button><h1>Initial</h1>",
        "/waf": "<title>Verification</title><h1>Verification required</h1>",
        "/empty": "<title>Empty</title><p>Nothing here</p>",
        "/stuck": '<title>Stuck</title><button onclick="void 0">Try again</button>',
      };
      response.end(pages[path ?? ""] ?? pages["/empty"]);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server has no port");
    base = `http://127.0.0.1:${address.port}`;
    directory = await mkdtemp(join(tmpdir(), "jevpilot-orchestrator-browser-"));
    browser = await createCdpDriver().launch(
      {
        ...testProfile(directory, { width: 1000, height: 700 }),
        executable,
        extraArgs: [
          ...(testProfile(directory).extraArgs ?? []),
          "--no-proxy-server",
          "--disable-background-networking",
          "--host-resolver-rules=MAP outside.test 127.0.0.1",
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
    script: (request: DecisionRequest) => MockStep,
    options: Partial<SessionOptions> = {},
  ): Promise<OrchestratorSession> {
    const page = await browser.newPage();
    const navigation = await page.navigate(`${base}${path}`);
    const mock = new MockDecider(script);
    return new OrchestratorSession(
      {
        page,
        navigation,
        goal: "Complete the fixture task",
        constraints: { allowed_domains: ["127.0.0.1"] },
        ...options,
      },
      { decide: (request) => mock.decide(request) },
    );
  }
  const scripted =
    (wanted: Parameters<typeof answersFor>[1]) =>
    (request: DecisionRequest): MockStep => ({ answers: answersFor(request, wanted) });
  async function check(
    path: string,
    script: (request: DecisionRequest) => MockStep,
    expected: SessionResult["status"],
    options: Partial<SessionOptions> = {},
  ): Promise<void> {
    const session = await opened(path, script, options);
    try {
      assert.equal((await session.run()).status, expected);
    } finally {
      await session.close();
    }
  }

  test("search to result reaches DONE_VERIFIED", async () => {
    const session = await opened(
      "/search",
      (request) => scripted({ op: "CLICK", target: "e1" })(request),
      { success: { text_present: "Found result" } },
    );
    try {
      assert.equal((await session.run()).status, "DONE_VERIFIED");
    } finally {
      await session.close();
    }
  });
  test("changed search result reaches DONE_UNVERIFIED without assertions", async () => {
    const session = await opened("/search", (request) => {
      const state = request.state as { page_observation?: string };
      return scripted(
        state.page_observation?.includes("Found result")
          ? { op: "DONE", goalMet: 0.95 }
          : { op: "CLICK", target: "e1" },
      )(request);
    });
    try {
      assert.equal((await session.run()).status, "DONE_UNVERIFIED");
    } finally {
      await session.close();
    }
  });
  test("form reaches NEEDS_VALUES", async () =>
    check("/form", scripted({ op: "WAIT", situation: "needs_user_values" }), "NEEDS_VALUES"));
  test("login reaches NEEDS_LOGIN", async () =>
    check("/login", scripted({ op: "STOP" }), "NEEDS_LOGIN"));
  test("batch fills two-field login and SUBMIT reaches DONE_VERIFIED", async () => {
    const previous = process.env.JEVPILOT_SECRET_M3F_TEST;
    process.env.JEVPILOT_SECRET_M3F_TEST = "fixture-password";
    let calls = 0;
    const session = await opened(
      "/batch-login",
      (request) => {
        const answers = answersFor(request, { op: calls++ === 0 ? "TYPE" : "SUBMIT" });
        for (const [id, question] of Object.entries(request.questions)) {
          if (!id.startsWith("value_for_") || question.type !== "choice") continue;
          const key = Object.hasOwn(question.criteria, "password") ? "password" : "email";
          answers[id] = {
            choice: key,
            confidence: 1,
            probabilities: Object.fromEntries(
              Object.keys(question.criteria).map((candidate) => [
                candidate,
                candidate === key ? 1 : 0,
              ]),
            ),
          };
        }
        return { answers };
      },
      {
        values: {
          email: "user@example.test",
          password: { secret_ref: "env:JEVPILOT_SECRET_M3F_TEST", origins: [base] },
        },
        success: { text_present: "Signed in" },
        budget: { steps: 2 },
      },
    );
    try {
      const result = await session.run();
      assert.equal(
        result.status,
        "DONE_VERIFIED",
        JSON.stringify({ reason: result.reason, url: result.url, trace: result.trace }),
      );
      assert.deepEqual(
        session.trace.map((entry) => entry.op),
        ["type", "type", "submit"],
      );
      assert.deepEqual(
        session.trace.slice(0, 2).map((entry) => entry.step),
        [1, 1],
      );
    } finally {
      if (previous === undefined) delete process.env.JEVPILOT_SECRET_M3F_TEST;
      else process.env.JEVPILOT_SECRET_M3F_TEST = previous;
      await session.close();
    }
  });
  test("O9e: a field the page clears after typing is retyped before the form is submitted", async () => {
    let calls = 0;
    const session = await opened(
      "/o9e-clear",
      (request) => {
        const first = calls++ === 0;
        // The submit decision arrives after the page has cleared the field.
        return {
          answers: answersFor(request, { op: first ? "TYPE" : "SUBMIT", value: "name" }),
          ...(first ? {} : { latencyMs: 2000 }),
        };
      },
      {
        values: { name: "Ada" },
        success: { text_present: "Saved name Ada" },
        budget: { steps: 2 },
      },
    );
    try {
      const result = await session.run();
      assert.equal(
        result.status,
        "DONE_VERIFIED",
        JSON.stringify({ reason: result.reason, url: result.url, trace: result.trace }),
      );
      // The first type, the retype after the page cleared the field, then the submit.
      assert.deepEqual(
        session.trace.map((entry) => entry.op),
        ["type", "type", "submit"],
      );
    } finally {
      await session.close();
    }
  });

  test("merged SUBMIT survives replacement of input and button in two decisions", async () => {
    let decisions = 0;
    const session = await opened(
      "/dynamic-merge",
      (request) => {
        decisions++;
        if (decisions > 2) throw new Error("unexpected third decision");
        const answers = answersFor(request, {
          op: decisions === 1 ? "TYPE" : "SUBMIT",
          value: "query",
        });
        if (decisions === 2) {
          const op = answers.op;
          if (!op || !("choice" in op)) throw new Error("missing op answer");
          op.confidence = 0.58;
          op.probabilities = Object.fromEntries(
            Object.keys(op.probabilities).map((key) => [
              key,
              key === "SUBMIT" ? 0.58 : key === "CLICK" ? 0.39 : key === "WAIT" ? 0.03 : 0,
            ]),
          );
          const target = request.questions.click_target;
          if (target?.type !== "choice") throw new Error("missing click target");
          const buttonRef = Object.entries(target.criteria).find(
            ([key, label]) => key !== "none" && String(label).startsWith("button "),
          )?.[0];
          if (!buttonRef) throw new Error("missing Search button");
          const replaced = request.state as { page_observation?: string };
          if (!replaced.page_observation?.includes('="article"'))
            throw new Error("search field was not filled before submit");
          answers.click_target = {
            choice: buttonRef,
            confidence: 0.95,
            probabilities: Object.fromEntries(
              Object.keys(target.criteria).map((key) => [key, key === buttonRef ? 1 : 0]),
            ),
          };
        }
        return { answers };
      },
      {
        values: { query: "article" },
        success: { text_present: "Dynamic result" },
        budget: { steps: 2 },
      },
    );
    try {
      const result = await session.run();
      assert.equal(
        result.status,
        "DONE_VERIFIED",
        JSON.stringify({ reason: result.reason, trace: result.trace }),
      );
      assert.equal(decisions, 2);
      assert.deepEqual(
        result.trace.map((entry) => entry.op),
        ["type", "submit"],
      );
    } finally {
      await session.close();
    }
  });
  test("M6x: a target=_blank search form whose results load slowly is followed in one step", async () => {
    let decisions = 0;
    const session = await opened(
      "/popup-search",
      (request) => {
        decisions++;
        const state = request.state as { page_observation?: string };
        if (state.page_observation?.includes("Popup results"))
          return scripted({ op: "DONE", goalMet: 0.95 })(request);
        // Jiemian: a second decision on the opener retyped the query. Following the popup must make it unnecessary.
        if (decisions > 1) return scripted({ op: "STOP" })(request);
        const answers = answersFor(request, { op: "TYPE", value: "query" });
        const submit = request.questions.submit_after_type;
        if (submit?.type !== "choice") throw new Error("missing submit_after_type");
        answers.submit_after_type = {
          choice: "submit",
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys(submit.criteria).map((key) => [key, key === "submit" ? 1 : 0]),
          ),
        };
        return { answers };
      },
      {
        values: { query: "jevpilot" },
        success: { text_present: "Popup results" },
        budget: { steps: 3 },
      },
    );
    try {
      const result = await session.run();
      assert.equal(
        result.status,
        "DONE_VERIFIED",
        JSON.stringify({ reason: result.reason, url: result.url, trace: result.trace }),
      );
      assert.equal(decisions, 1);
      assert.deepEqual(
        result.trace.map((entry) => entry.op),
        ["type"],
      );
      assert.match(result.url ?? "", /\/slow-results\?q=jevpilot$/u);
    } finally {
      await session.close();
    }
  });
  test("SUBMIT on Place order form requires confirmation", async () =>
    check("/place-order", scripted({ op: "SUBMIT" }), "CONFIRM_REQUIRED"));
  test("challenge reaches BLOCKED_BY_CHALLENGE", async () =>
    check("/challenge", scripted({ op: "STOP" }), "BLOCKED_BY_CHALLENGE", {
      autoPassWindowMs: 1000,
    }));
  test("buy reaches CONFIRM_REQUIRED", async () =>
    check("/buy", scripted({ op: "CLICK", target: "e1" }), "CONFIRM_REQUIRED"));
  test("off-list link reaches CONFIRM_REQUIRED", async () =>
    check("/external", scripted({ op: "CLICK", target: "e1" }), "CONFIRM_REQUIRED"));
  test("missing page information reaches INFO_NOT_ON_PAGE", async () =>
    check("/empty", scripted({ op: "STOP", situation: "info_not_on_page" }), "INFO_NOT_ON_PAGE"));
  test("uncertain operation reaches UNCERTAIN", async () =>
    check("/empty", scripted({ op: "STOP" }), "UNCERTAIN"));
  test("unchanged actions reach STUCK", async () =>
    check("/stuck", scripted({ op: "CLICK", target: "e1" }), "STUCK"));
  test("server error reaches ERROR_PAGE", async () =>
    check("/error", scripted({ op: "STOP" }), "ERROR_PAGE"));
  test("click link to 404 page reaches ERROR_PAGE", async () =>
    check("/link-404", scripted({ op: "CLICK", target: "e1" }), "ERROR_PAGE"));
  test("submit form with cf-mitigated response reaches BLOCKED_BY_CHALLENGE", async () =>
    check("/form-challenge-start", scripted({ op: "SUBMIT" }), "BLOCKED_BY_CHALLENGE", {
      autoPassWindowMs: 0,
    }));
  test("pushState navigation does not become an error page", async () =>
    check("/push-state", scripted({ op: "CLICK", target: "e1" }), "DONE_VERIFIED", {
      success: { text_present: "Updated" },
    }));
  test("navigate to AWS WAF 405 response reaches BLOCKED_BY_CHALLENGE", async () =>
    check("/waf", scripted({ op: "STOP" }), "BLOCKED_BY_CHALLENGE", {
      autoPassWindowMs: 0,
    }));
  test("step budget reaches BUDGET_EXHAUSTED", async () =>
    check("/empty", scripted({ op: "WAIT" }), "BUDGET_EXHAUSTED", { budget: { steps: 1 } }));
  test("decision transport failure reaches FAILED", async () =>
    check("/empty", () => ({ error: new Error("private transport detail") }), "FAILED"));
  test("resume form with values continues same session", async () => {
    const session = await opened(
      "/form",
      (request) =>
        scripted({ op: "TYPE", target: "e1", value: "name", situation: "needs_user_values" })(
          request,
        ),
      { budget: { steps: 1 } },
    );
    try {
      assert.equal((await session.run()).status, "NEEDS_VALUES");
      assert.equal((await session.resume({ values: { name: "Ada" } })).status, "BUDGET_EXHAUSTED");
      assert.equal(session.trace[0]?.op, "type");
    } finally {
      await session.close();
    }
  });
  test("resume approval performs stored buy exactly once", async () => {
    const session = await opened("/buy", scripted({ op: "CLICK", target: "e1" }), {
      success: { text_present: "Purchased" },
    });
    try {
      assert.equal((await session.run()).status, "CONFIRM_REQUIRED");
      assert.equal((await session.resume({ allow_irreversible: true })).status, "DONE_VERIFIED");
      assert.equal(session.trace.filter((entry) => entry.op === "click").length, 1);
    } finally {
      await session.close();
    }
  });
  test("resume confirm dialog continues to verified result", async () => {
    const session = await opened("/dialog", scripted({ op: "CLICK", target: "e1" }), {
      success: { text_present: "Dialog complete" },
    });
    try {
      assert.equal((await session.run()).status, "CONFIRM_REQUIRED");
      assert.equal((await session.resume({ dialog: { accept: true } })).status, "DONE_VERIFIED");
    } finally {
      await session.close();
    }
  });
  test("resume extends domain list and executes stored local link once", async () => {
    const session = await opened("/local-outside", scripted({ op: "CLICK", target: "e1" }), {
      success: { text_present: "Found result" },
    });
    try {
      assert.equal((await session.run()).status, "CONFIRM_REQUIRED");
      assert.equal(
        (await session.resume({ allowed_domains: ["outside.test"] })).status,
        "DONE_VERIFIED",
      );
      assert.equal(session.trace.filter((entry) => entry.op === "click").length, 1);
    } finally {
      await session.close();
    }
  });
  test("full-page success assertions find content beyond observation limits", async () => {
    const session = await opened("/deep", () => ({ error: new Error("decision should not run") }), {
      success: {
        text_present: "Beyond compact",
        element_present: { role: "button", name: "Deep result" },
      },
    });
    try {
      assert.notEqual((await session.observe()).status, "DONE_VERIFIED");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.equal((await session.observe()).status, "DONE_VERIFIED");
    } finally {
      await session.close();
    }
  });
});
