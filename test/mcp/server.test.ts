import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MockDecider } from "../../src/decision/mock.ts";
import { DecisionTransportError } from "../../src/decision/errors.ts";
import { sessionResultSchema } from "../../src/orchestrator/result.ts";
import { BrowserConfigError } from "../../src/engine/default.ts";
import { EngineRegistry } from "../../src/engine/registry.ts";
import { CdpTimeoutError } from "../../src/browser/errors.ts";
import { createServer } from "../../src/mcp/server.ts";
import { fakeMcpDeps, fakeObservation } from "../support/mcp-fixture.ts";
import { FakePageHandle } from "../support/fake-engine.ts";
import type { DecisionResult } from "../../src/decision/types.ts";

const data = (result: unknown): Record<string, unknown> =>
  (result as { structuredContent: Record<string, unknown> }).structuredContent;
const text = (result: unknown): string =>
  (result as { content: { text: string }[] }).content[0]!.text;

async function cancelledDecision(resume: boolean) {
  const deps = fakeMcpDeps();
  deps.maxSessions = 1;
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const blocked = deferred();
  const aborted = deferred();
  const closed = deferred();
  let calls = 0;
  let actions = 0;
  let blockedSignal: AbortSignal | undefined;
  const blockedCall = resume ? 3 : 2;
  const answer: DecisionResult = {
    answers: {},
    usage: { inputTokens: 1, outputTokens: 1 },
    provider: "mock",
    model: "mock",
    latencyMs: 0,
    attempts: 1,
  };
  deps.decisionPort = {
    decide: async (_request, options) => {
      calls++;
      if (calls !== blockedCall) return answer;
      blockedSignal = options?.signal;
      assert.ok(blockedSignal);
      blocked.resolve();
      return new Promise<DecisionResult>((_resolve, reject) => {
        const cancel = () => {
          aborted.resolve();
          reject(new Error("decision aborted"));
        };
        if (blockedSignal!.aborted) cancel();
        else blockedSignal!.addEventListener("abort", cancel, { once: true });
      });
    },
  };
  deps.orchestrator!.interpret = () =>
    (resume && calls === 1) || calls > blockedCall
      ? { type: "handoff", reason: "needs_values", source: "code", details: {} }
      : { type: "act", action: { kind: "scroll", direction: "down" } };
  deps.orchestrator!.executeAction = async (page) => {
    actions++;
    await page.wheel(0, 0, 100);
    return {
      outcome: "changed",
      changes: { url: false, pageHash: true, value: false, checked: false },
      timings: { precheckMs: 0, inputMs: 0, settleMs: 0, harnessMs: 0 },
    };
  };
  const app = createServer(deps);
  const client = new Client({ name: "r10-cancel", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  const controller = new AbortController();
  const writes: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const session = resume
      ? data(await client.callTool({ name: "browser_run", arguments: { goal: "Finish" } })).session
      : undefined;
    const pending = client.callTool(
      resume
        ? { name: "browser_resume", arguments: { session } }
        : { name: "browser_run", arguments: { goal: "Finish" } },
      undefined,
      { signal: controller.signal },
    );
    const rejected = assert.rejects(pending, /cancelled by test/u);
    await blocked.promise;
    assert.equal(actions, 1);
    deps.pages[0]!.close = async () => {
      closed.resolve();
    };
    controller.abort(new Error("cancelled by test"));
    await rejected;
    await aborted.promise;
    assert.equal(blockedSignal?.aborted, true);
    if (resume) {
      // This queued request also waits for the cancelled invocation to release its session chain.
      assert.equal(
        data(await client.callTool({ name: "browser_observe", arguments: { session } })).status,
        "RUNNING",
      );
      const result = await client.callTool({ name: "browser_close", arguments: { session } });
      assert.equal(result.isError, undefined);
      assert.deepEqual(data(result), { session, closed: true });
    } else {
      await closed.promise;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, blockedCall);
    assert.equal(actions, 1);
    assert.equal(deps.pages[0]!.calls.filter((call) => call.name === "wheel").length, 1);
    assert.deepEqual(writes, [], "request cancellation must not be logged as a tool failure");
    if (!resume) {
      const next = data(
        await client.callTool({ name: "browser_run", arguments: { goal: "Again" } }),
      );
      assert.notEqual(next.reason, "too_many_sessions");
      assert.equal(next.status, "NEEDS_VALUES");
      assert.equal(deps.pages.length, 2);
    }
  } finally {
    process.stderr.write = write;
    controller.abort();
    await client.close();
    await app.close();
  }
}

test("R10: a cancelled browser_run stops deciding and acting", { timeout: 5000 }, async () => {
  await cancelledDecision(false);
});

test("R10: a cancelled browser_resume stops and keeps its session", { timeout: 5000 }, async () => {
  await cancelledDecision(true);
});

test("R2: result url, title and tab urls are redacted", async () => {
  const secret = "env:JEVPILOT_SECRET_R2";
  const deps = fakeMcpDeps();
  deps.orchestrator!.observe = async () => ({
    ...fakeObservation("r2"),
    url: `http://fixture.test/${secret}`,
    title: `Account ${secret}`,
  });
  const app = createServer(deps);
  const client = new Client({ name: "r2-redaction", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  try {
    const run = data(
      await client.callTool({
        name: "browser_run",
        arguments: {
          goal: "inspect",
          values: { password: { secret_ref: secret, origins: ["http://fixture.test"] } },
        },
      }),
    );
    assert.equal(String(run.url).includes(secret), false);
    assert.equal(String(run.title).includes(secret), false);
    const page = deps.pages[0]!;
    Object.assign(page, { targetUrl: async () => `http://fixture.test/${secret}` });
    const tabs = data(
      await client.callTool({
        name: "browser_tabs",
        arguments: { session: run.session, action: "list" },
      }),
    );
    assert.equal(JSON.stringify(tabs).includes(secret), false);
    assert.match(JSON.stringify(tabs), /\[REDACTED\]/u);
  } finally {
    await client.close();
    await app.close();
  }
});

test("R1: concurrent calls on one session run one after another", async () => {
  const deps = fakeMcpDeps();
  let active = 0;
  let overlapped = false;
  let navigations = 0;
  const app = createServer(deps);
  const client = new Client({ name: "r1", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  try {
    const first = data(await client.callTool({ name: "browser_run", arguments: { goal: "x" } }));
    const id = first.session as string;
    const page = deps.pages[0]!;
    const navigate = page.navigate.bind(page);
    page.navigate = async (url, options) => {
      active++;
      navigations++;
      if (active > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 10));
      try {
        return await navigate(url, options);
      } finally {
        active--;
      }
    };
    const results = await Promise.all([
      client.callTool({
        name: "browser_navigate",
        arguments: { session: id, url: "http://fixture.test/one" },
      }),
      client.callTool({
        name: "browser_navigate",
        arguments: { session: id, url: "http://fixture.test/two" },
      }),
    ]);
    assert.ok(results.every((result) => !result.isError));
    assert.equal(navigations, 2);
    assert.equal(overlapped, false);
  } finally {
    await client.close();
    await app.close();
  }
});

test("R1: shutdown closes the MCP transport even when the browser close fails", async () => {
  const deps = fakeMcpDeps();
  let closed = false;
  deps.engines = new EngineRegistry({ default: { driver: "close-failure", profile: {} } });
  deps.engines.register({
    kind: "close-failure",
    launch: async () => ({
      engine: { name: "close-failure", driver: "close-failure", stealthLevel: "high" },
      capabilities: new FakePageHandle().capabilities,
      selfCheck: undefined,
      connected: true,
      onDisconnected: () => () => {},
      newPage: async () => new FakePageHandle(),
      pages: () => [],
      close: async () => {
        closed = true;
        throw new Error("browser close failed");
      },
    }),
  });
  const app = createServer(deps);
  const client = new Client({ name: "r1-close", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  try {
    await client.callTool({ name: "browser_run", arguments: { goal: "x" } });
    await app.close();
    assert.equal(closed, true);
    assert.equal(app.server.isConnected(), false);
  } finally {
    await client.close();
    await app.close();
  }
});

test("O2.5: the MCP server passes JEVPILOT_USAGE_DETAIL to sessions", async () => {
  const deps = fakeMcpDeps();
  deps.usageDetail = true;
  const app = createServer(deps);
  const client = new Client({ name: "usage-detail", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  try {
    const run = data(await client.callTool({ name: "browser_run", arguments: { goal: "Finish" } }));
    assert.ok((run.usage as { detail?: unknown }).detail);
  } finally {
    await client.close();
    await app.close();
  }
});

test("O3: browser_run at the session limit reclaims idle sessions first, then fails with too_many_sessions", async () => {
  const deps = fakeMcpDeps();
  let now = 1_000_000;
  deps.maxSessions = 2;
  deps.clock = () => now;
  deps.orchestrator = { ...deps.orchestrator, now: () => now };
  deps.sessionOptions = { idleTimeoutMs: 60_000 };
  const app = createServer(deps);
  const client = new Client({ name: "session-limit", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  const run = async () =>
    data(await client.callTool({ name: "browser_run", arguments: { goal: "Finish" } }));
  const observe = (session: unknown) =>
    client.callTool({ name: "browser_observe", arguments: { session } });
  try {
    const first = await run();
    now += 30_000;
    const second = await run();
    const refused = await run();
    assert.equal(refused.status, "FAILED");
    assert.equal(refused.reason, "too_many_sessions");
    assert.match(String(refused.question), /at most 2 sessions/u);
    assert.equal(deps.pages.length, 2, "the refused run opens no page");
    for (const session of [first.session, second.session])
      assert.notEqual((await observe(session)).isError, true, "no active session is closed");
    // The first session goes idle; the second was observed just now.
    now += 60_001;
    await observe(second.session);
    const admitted = await run();
    assert.notEqual(admitted.reason, "too_many_sessions");
    assert.equal((await observe(first.session)).isError, true, "the idle session was reclaimed");
    assert.notEqual((await observe(second.session)).isError, true);
  } finally {
    await client.close();
    await app.close();
  }
});

test("M6k: isolated sessions option opens every run in a fresh context and disposes it on close", async () => {
  const deps = fakeMcpDeps();
  const options: unknown[] = [];
  let disposed = 0;
  deps.isolatedSessions = true;
  deps.engines = new EngineRegistry({ default: { driver: "isolated-fake", profile: {} } });
  deps.engines.register({
    kind: "isolated-fake",
    launch: async () => ({
      engine: { name: "isolated-fake", driver: "isolated-fake", stealthLevel: "high" },
      capabilities: { ...new FakePageHandle().capabilities, isolatedContexts: true },
      selfCheck: undefined,
      connected: true,
      onDisconnected: () => () => {},
      newPage: async (pageOptions) => {
        options.push(pageOptions);
        const page = new FakePageHandle();
        page.close = async () => {
          disposed++;
        };
        return page;
      },
      pages: () => [],
      close: async () => {},
    }),
  });
  const app = createServer(deps);
  const client = new Client({ name: "isolated-sessions", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  try {
    for (let index = 0; index < 2; index++) {
      const run = await client.callTool({ name: "browser_run", arguments: { goal: "Finish" } });
      await client.callTool({ name: "browser_close", arguments: { session: data(run).session } });
    }
    assert.deepEqual(options, [
      { isolated: { copyCookies: false } },
      { isolated: { copyCookies: false } },
    ]);
    assert.equal(disposed, 2);
  } finally {
    await client.close();
    await app.close();
  }
});

test("M6g: browser_run and browser_navigate refuse non-http(s) URLs", async () => {
  const deps = fakeMcpDeps();
  const app = createServer(deps);
  const client = new Client({ name: "mcp-url-rule", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  try {
    for (const url of [
      "file:///C:/secret.txt",
      "data:text/html,hi",
      "javascript:alert(1)",
      "chrome://settings",
      "view-source:https://example.com",
    ]) {
      const refused = await client.callTool({
        name: "browser_run",
        arguments: { goal: "Read", url },
      });
      assert.match(text(refused), /http.*https/iu);
    }
    const run = await client.callTool({
      name: "browser_run",
      arguments: { goal: "Finish", constraints: { allowed_domains: ["fixture.test"] } },
    });
    assert.notEqual(data(run).reason, "confirm_required");
    for (const url of ["file:///C:/secret.txt", "data:text/html,hi"]) {
      const refused = await client.callTool({
        name: "browser_navigate",
        arguments: { session: data(run).session, url },
      });
      assert.match(text(refused), /http.*https/iu);
    }
  } finally {
    await client.close();
    await app.close();
  }
});

test("M6e: tool descriptions tell agents to pass typed text in values", async () => {
  const app = createServer(fakeMcpDeps());
  const client = new Client({ name: "mcp-description-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await app.server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = (await client.listTools()).tools;
    const run = tools.find((tool) => tool.name === "browser_run")!;
    const act = tools.find((tool) => tool.name === "browser_act")!;
    assert.match(run.description ?? "", /hands back early.*browser_act \/ browser_resume/u);
    assert.match(
      JSON.stringify(run.inputSchema),
      /Every piece of text.*values|Every piece of text the page needs typed/u,
    );
    assert.match(JSON.stringify(run.inputSchema), /Text inside the goal is never typed/u);
    assert.match(
      JSON.stringify(run.inputSchema),
      /Checks that already hold on the start page are ignored/u,
    );
    assert.match(act.description ?? "", /separate browser_observe is not needed/u);
  } finally {
    await client.close();
    await app.close();
  }
});

test("M6f: browser_act forwards the key alias through its schema", async () => {
  const app = createServer(fakeMcpDeps());
  const client = new Client({ name: "mcp-key-alias-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  try {
    const run = await client.callTool({ name: "browser_run", arguments: { goal: "Finish" } });
    const acted = await client.callTool({
      name: "browser_act",
      arguments: {
        session: String(data(run).session),
        ops: [{ action: "press_key", key: "Enter" }],
      },
    });
    assert.doesNotMatch(JSON.stringify(data(acted)), /press_key needs name/u);
    assert.equal(data(acted).status, "RUNNING");
  } finally {
    await client.close();
    await app.close();
  }
});

test("M6c: observe screenshot racing browser_close leaves no directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevpilot-mcp-race-test-"));
  const directory = join(root, "shot");
  const deps = fakeMcpDeps();
  deps.orchestrator!.tempDir = async () => {
    const path = join(root, "handoff");
    await mkdir(path);
    return path;
  };
  deps.screenshotTempDir = async () => {
    await mkdir(directory);
    return directory;
  };
  const app = createServer(deps);
  const client = new Client({ name: "screenshot-race", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await app.server.connect(right);
  await client.connect(left);
  try {
    const run = await client.callTool({ name: "browser_run", arguments: { goal: "Finish" } });
    const session = String(data(run).session);
    deps.pages[0]!.screenshot = async () => {
      entered();
      await pending;
      return new Uint8Array();
    };
    const observing = client.callTool({
      name: "browser_observe",
      arguments: { session, screenshot: true },
    });
    await started;
    const closing = client.callTool({ name: "browser_close", arguments: { session } });
    release();
    const observed = data(await observing);
    await closing;
    assert.equal(observed.screenshot_path, undefined);
    assert.equal(existsSync(directory), false);
  } finally {
    release();
    await client.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("M6c: observe screenshot dir created after browser_close is removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevpilot-mcp-create-race-test-"));
  const directory = join(root, "shot");
  const deps = fakeMcpDeps();
  deps.orchestrator!.tempDir = async () => {
    const path = join(root, "handoff");
    await mkdir(path);
    return path;
  };
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  deps.screenshotTempDir = async () => {
    entered();
    await pending;
    await mkdir(directory);
    return directory;
  };
  const app = createServer(deps);
  const client = new Client({ name: "screenshot-create-race", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  try {
    const run = await client.callTool({ name: "browser_run", arguments: { goal: "Finish" } });
    const session = String(data(run).session);
    const observing = client.callTool({
      name: "browser_observe",
      arguments: { session, screenshot: true },
    });
    await started;
    await client.callTool({ name: "browser_close", arguments: { session } });
    release();
    const observed = data(await observing);
    assert.equal(observed.screenshot_path, undefined);
    assert.equal(existsSync(directory), false);
  } finally {
    release();
    await client.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("M6c: server close does not wait for an in-flight browser_run", async () => {
  const deps = fakeMcpDeps();
  let entered!: () => void;
  let release!: () => void;
  const deciding = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  deps.decisionPort = new MockDecider(async () => {
    entered();
    await pending;
    return { answers: {} };
  });
  const app = createServer(deps);
  const client = new Client({ name: "close-during-run", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  const running = client
    .callTool({ name: "browser_run", arguments: { goal: "Finish" } })
    .catch(() => undefined);
  try {
    await deciding;
    // Shutdown (stdin end, SIGTERM) must not wait for Jev to finish; clients kill after a few seconds.
    const outcome = await Promise.race([
      app.close().then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("waited"), 2000)),
    ]);
    assert.equal(outcome, "closed");
  } finally {
    release();
    await running;
    await client.close();
    await app.close();
  }
});

test("browser_run passes the navigation timeout and returns initial failures as ERROR_PAGE with URL", async () => {
  const deps = fakeMcpDeps();
  deps.navigationTimeoutMs = 30_000;
  const received: number[] = [];
  const pages: FakePageHandle[] = [];
  deps.engines = new EngineRegistry({ default: { driver: "timeout", profile: {} } });
  deps.engines.register({
    kind: "timeout",
    launch: async () => ({
      engine: { name: "timeout", driver: "timeout", stealthLevel: "high" },
      capabilities: new FakePageHandle().capabilities,
      selfCheck: undefined,
      connected: true,
      onDisconnected: () => () => {},
      newPage: async () => {
        const page = new FakePageHandle();
        page.navigate = async (_url, options) => {
          received.push(options?.timeoutMs ?? -1);
          throw new CdpTimeoutError("Page.navigate timed out");
        };
        pages.push(page);
        return page;
      },
      pages: () => pages,
      close: async () => {},
    }),
  });
  const app = createServer(deps);
  const client = new Client({ name: "navigation-timeout", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  try {
    for (const explicit of [undefined, 42] as const) {
      const run = await client.callTool({
        name: "browser_run",
        arguments: {
          goal: "Open map",
          url: "http://fixture.test/map",
          ...(explicit ? { navigation_timeout_ms: explicit } : {}),
        },
      });
      const result = data(run);
      assert.equal(result.status, "ERROR_PAGE");
      assert.equal(result.url, "http://fixture.test/map");
      assert.match(String(result.question), /timeout/u);
    }
    assert.deepEqual(received, [30_000, 42]);
  } finally {
    await client.close();
    await app.close();
  }
});

test("every session status validates through the in-process SDK client", async () => {
  const handoffs = [
    "needs_values",
    "needs_login",
    "blocked_by_challenge",
    "confirm_required",
    "info_not_on_page",
    "uncertain",
    "stuck",
    "error_page",
  ] as const;
  const cases = [
    "RUNNING",
    "DONE_VERIFIED",
    "DONE_UNVERIFIED",
    "BUDGET_EXHAUSTED",
    "FAILED",
    ...handoffs,
  ] as const;
  for (const status of cases) {
    const deps = fakeMcpDeps();
    if (status === "FAILED")
      // M6l: only non-recoverable decision failures still end FAILED (a 503 now hands off).
      deps.decisionPort = new MockDecider([
        { error: new DecisionTransportError("failed", 401, false) },
      ]);
    else if (status === "DONE_UNVERIFIED") {
      let calls = 0;
      deps.orchestrator!.interpret = () =>
        ++calls === 1
          ? { type: "act", action: { kind: "wait" } }
          : { type: "done_candidate", goalMet: 1 };
    } else if (status === "DONE_VERIFIED") {
      // M6e: the assertion must become true after acting, not hold on the start page.
      let samples = 0;
      deps.orchestrator!.observe = async () =>
        samples++ === 0
          ? fakeObservation("start")
          : { ...fakeObservation("changed"), url: "http://fixture.test/done" };
      let calls = 0;
      deps.orchestrator!.interpret = () =>
        ++calls === 1
          ? { type: "act", action: { kind: "wait" } }
          : { type: "done_candidate", goalMet: 1 };
    } else if (handoffs.includes(status as (typeof handoffs)[number]))
      deps.orchestrator!.interpret = () => ({
        type: "handoff",
        reason: status as (typeof handoffs)[number],
        source: "code",
        details: {},
      });
    const app = createServer(deps);
    const client = new Client({ name: "status-contract", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await app.server.connect(right);
    await client.connect(left);
    try {
      const argumentsForRun = {
        goal: "Finish",
        ...(status === "DONE_VERIFIED" ? { success: { url_matches: "/done$" } } : {}),
        ...(status === "BUDGET_EXHAUSTED" ? { budget: { steps: 0 } } : {}),
      };
      const run = await client.callTool({ name: "browser_run", arguments: argumentsForRun });
      const returned =
        status === "RUNNING"
          ? await client.callTool({
              name: "browser_observe",
              arguments: { session: data(run).session },
            })
          : run;
      const parsed = sessionResultSchema.parse(data(returned));
      const expected = handoffs.includes(status as (typeof handoffs)[number])
        ? status.toUpperCase()
        : status;
      assert.equal(parsed.status, expected);
      if (status === "FAILED")
        assert.deepEqual(parsed.details, [
          "DecisionTransportError: decision transport failed",
          "HTTP status: 401",
          "attempts: 0",
        ]);
      if (status === "DONE_UNVERIFIED") assert.equal(parsed.trace[0]?.op, "wait");
      if (handoffs.includes(status as (typeof handoffs)[number])) assert.ok(parsed.screenshot_path);
    } finally {
      await client.close();
      await app.close();
    }
  }
});

test("MCP tools list schemas and round-trip all tools without a browser", async () => {
  const deps = fakeMcpDeps();
  const app = createServer(deps);
  const client = new Client({ name: "mcp-unit", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await app.server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        "browser_run",
        "browser_resume",
        "browser_observe",
        "browser_act",
        "browser_navigate",
        "browser_tabs",
        "browser_close",
        "jev_decide",
      ],
    );
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.outputSchema?.type, "object");
      assert.ok(tool.description);
    }
    assert.equal(deps.launches(), 0);
    const run = await client.callTool({
      name: "browser_run",
      arguments: {
        goal: "Finish",
        url: "http://fixture.test/start",
        values: { password: { secret_ref: "env:SECRET_MARKER", origins: ["http://fixture.test"] } },
      },
    });
    assert.equal(data(run).status, "NEEDS_VALUES");
    assert.deepEqual(JSON.parse(text(run)), data(run));
    assert.match(text(run), /"session"|"snapshot"/u);
    const session = String(data(run).session);
    assert.equal(deps.launches(), 1);
    const observed = await client.callTool({
      name: "browser_observe",
      arguments: { session, detail: "full", screenshot: true },
    });
    assert.equal(data(observed).status, "RUNNING");
    assert.equal(data(observed).screenshot_path, undefined);
    const acted = await client.callTool({
      name: "browser_act",
      arguments: { session, ops: [{ action: "wait" }] },
    });
    assert.equal(data(acted).status, "RUNNING");
    const resumed = await client.callTool({
      name: "browser_resume",
      arguments: { session, goal_update: "Finish now" },
    });
    assert.equal(data(resumed).status, "DONE_UNVERIFIED");
    const decided = await client.callTool({
      name: "jev_decide",
      arguments: { state: {}, questions: {} },
    });
    assert.deepEqual(Object.keys(data(decided)).sort(), [
      "answers",
      "latency_ms",
      "model",
      "usage",
    ]);
    const closed = await client.callTool({ name: "browser_close", arguments: { session } });
    assert.deepEqual(data(closed), { session, closed: true });
    assert.deepEqual(JSON.parse(text(closed)), data(closed));
    for (const value of [run, observed, acted, resumed, decided, closed])
      assert.doesNotMatch(JSON.stringify(value), /SECRET_MARKER/u);
    await assert.rejects(
      client.callTool({ name: "browser_run", arguments: { goal: "" } }),
      (error: unknown) =>
        (error as { code?: number; message?: string }).code === -32602 &&
        /goal/u.test((error as Error).message) &&
        !/Finish/u.test((error as Error).message),
    );
    await assert.rejects(
      client.callTool({
        name: "browser_run",
        arguments: { goal: "Finish", budget: { steps: "SECRET_MARKER" } },
      }),
      (error: unknown) =>
        (error as { code?: number; message?: string }).code === -32602 &&
        /budget\.steps/u.test((error as Error).message) &&
        !/SECRET_MARKER/u.test((error as Error).message),
    );
  } finally {
    await client.close();
    await app.close();
  }
});

test("explicit observations save a screenshot and remove it on close", async () => {
  const app = createServer(fakeMcpDeps());
  const client = new Client({ name: "mcp-unit", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  try {
    const run = await client.callTool({ name: "browser_run", arguments: { goal: "Finish" } });
    const session = String(data(run).session);
    const observed = await client.callTool({
      name: "browser_observe",
      arguments: { session, screenshot: true },
    });
    const screenshot = String(data(observed).screenshot_path);
    assert.equal(existsSync(screenshot), true);
    await client.callTool({ name: "browser_close", arguments: { session } });
    assert.equal(existsSync(screenshot), false);
  } finally {
    await client.close();
    await app.close();
  }
});

test("unexpected engine errors never expose their message", async () => {
  const deps = fakeMcpDeps();
  deps.engines.resolve = () => {
    throw new Error("SECRET_MARKER");
  };
  const app = createServer(deps);
  const client = new Client({ name: "mcp-unit", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  try {
    const failed = await client.callTool({ name: "browser_run", arguments: { goal: "Finish" } });
    assert.equal(failed.isError, true);
    assert.doesNotMatch(JSON.stringify(failed), /SECRET_MARKER/u);
  } finally {
    await client.close();
    await app.close();
  }
});

test("unexpected engine errors are diagnosed without exposing secrets", async () => {
  const deps = fakeMcpDeps();
  deps.engines.resolve = () =>
    ({
      launch: async () => {
        throw new TypeError("SECRET_MARKER");
      },
    }) as never;
  const app = createServer(deps);
  const client = new Client({ name: "mcp-unit", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  const writes: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  await app.server.connect(right);
  await client.connect(left);
  try {
    const failed = await client.callTool({
      name: "browser_run",
      arguments: {
        goal: "Finish",
        values: { password: { secret_ref: "env:SECRET_MARKER", origins: ["http://fixture.test"] } },
      },
    });
    assert.equal(failed.isError, true);
    assert.match(text(failed), /Tool failed \(TypeError\)/u);
    assert.equal(writes.length, 1);
    assert.match(writes[0]!, /tool=browser_run error=TypeError/u);
    // M7a: the launch await chain moved verbatim from server.ts to host.ts, so the first src/
    // frame in the logged stack moved with it. The log format itself is unchanged.
    assert.match(writes[0]!, /frame=.*src[\\/]mcp[\\/](?:server|host)\.ts:\d+/u);
    assert.doesNotMatch(`${writes.join("")} ${JSON.stringify(failed)}`, /SECRET_MARKER/u);
  } finally {
    process.stderr.write = write;
    await client.close();
    await app.close();
  }
});

test("decision tool is conditional and orchestrator FAILED remains a normal result", async () => {
  const deps = fakeMcpDeps();
  delete deps.decisionPort;
  const app = createServer(deps);
  const client = new Client({ name: "mcp-unit", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  try {
    assert.equal((await client.listTools()).tools.length, 7);
    const failed = await client.callTool({ name: "browser_run", arguments: { goal: "Finish" } });
    assert.equal(data(failed).status, "FAILED");
    assert.equal(data(failed).reason, "decision_port_not_configured");
    assert.match(String(data(failed).question), /JEV_PROVIDER|JEV_API_KEY/u);
    assert.equal(deps.launches(), 0);
  } finally {
    await client.close();
    await app.close();
  }

  const failedDeps = fakeMcpDeps();
  failedDeps.decisionPort = new MockDecider([{ error: new Error("SECRET_MARKER") }]);
  const failedApp = createServer(failedDeps);
  const failedClient = new Client({ name: "mcp-unit", version: "1" });
  const [failedLeft, failedRight] = InMemoryTransport.createLinkedPair();
  await failedApp.server.connect(failedRight);
  await failedClient.connect(failedLeft);
  try {
    const result = await failedClient.callTool({
      name: "browser_run",
      arguments: { goal: "Finish" },
    });
    assert.equal(result.isError, undefined);
    assert.equal(data(result).status, "FAILED");
    assert.doesNotMatch(JSON.stringify(result), /SECRET_MARKER/u);
  } finally {
    await failedClient.close();
    await failedApp.close();
  }
});

test("safe operational errors are actionable and unknown exceptions stay generic", async () => {
  const deps = fakeMcpDeps();
  deps.allowedDomains = ["fixture.test"];
  const app = createServer(deps);
  const client = new Client({ name: "mcp-unit", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  try {
    const outside = await client.callTool({
      name: "browser_run",
      arguments: { goal: "Finish", url: "http://outside.test/" },
    });
    assert.equal(outside.isError, true);
    assert.match(text(outside), /Initial URL is outside allowed domains/u);
    const forbidden = await client.callTool({
      name: "browser_run",
      arguments: { goal: "Finish", constraints: { allowed_domains: ["outside.test"] } },
    });
    assert.match(text(forbidden), /server allowlist/u);
    const run = await client.callTool({ name: "browser_run", arguments: { goal: "Finish" } });
    const mismatch = await client.callTool({
      name: "browser_run",
      arguments: { goal: "Finish", profile: "other" },
    });
    assert.match(text(mismatch), /active browser/u);
    const unknown = await client.callTool({
      name: "browser_resume",
      arguments: { session: "missing" },
    });
    assert.match(text(unknown), /Unknown session/u);
    await client.callTool({ name: "browser_close", arguments: { session: data(run).session } });
  } finally {
    await client.close();
    await app.close();
  }

  const unavailable = fakeMcpDeps();
  const engines = new EngineRegistry({ default: { driver: "fail", profile: {} } });
  engines.register({
    kind: "fail",
    launch: async () => {
      throw new BrowserConfigError("Chrome executable not found");
    },
  });
  unavailable.engines = engines;
  const failedApp = createServer(unavailable);
  const failedClient = new Client({ name: "mcp-unit", version: "1" });
  const [failedLeft, failedRight] = InMemoryTransport.createLinkedPair();
  await failedApp.server.connect(failedRight);
  await failedClient.connect(failedLeft);
  try {
    const failed = await failedClient.callTool({
      name: "browser_run",
      arguments: { goal: "Finish" },
    });
    assert.match(text(failed), /Chrome executable not found/u);
  } finally {
    await failedClient.close();
    await failedApp.close();
  }
});

test("idle sweep reclaims sessions and screenshot directories with a fake clock", async () => {
  let now = 0;
  const deps = fakeMcpDeps();
  deps.clock = () => now;
  deps.sessionOptions = { idleTimeoutMs: 10 };
  deps.idleReclaimIntervalMs = 5;
  const app = createServer(deps);
  const client = new Client({ name: "mcp-unit", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  try {
    const run = await client.callTool({ name: "browser_run", arguments: { goal: "Finish" } });
    const session = String(data(run).session);
    const observed = await client.callTool({
      name: "browser_observe",
      arguments: { session, screenshot: true },
    });
    const path = String(data(observed).screenshot_path);
    assert.equal(existsSync(path), true);
    now = 11;
    for (let attempt = 0; attempt < 40 && existsSync(path); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(existsSync(path), false);
    const reclaimed = await client.callTool({ name: "browser_observe", arguments: { session } });
    assert.match(text(reclaimed), /Unknown session/u);
  } finally {
    await client.close();
    await app.close();
  }
});

test("idle sweep leaves an in-flight browser run open", async () => {
  let now = 0;
  let entered: () => void = () => {};
  let release: () => void = () => {};
  const started = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const deps = fakeMcpDeps();
  deps.clock = () => now;
  deps.sessionOptions = { idleTimeoutMs: 10 };
  deps.idleReclaimIntervalMs = 5;
  deps.orchestrator!.observe = async () => {
    entered();
    await gate;
    return fakeObservation("start");
  };
  const app = createServer(deps);
  const client = new Client({ name: "mcp-unit", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  let closed = false;
  try {
    const pending = client.callTool({ name: "browser_run", arguments: { goal: "Finish" } });
    await started;
    deps.pages[0]!.close = async () => {
      closed = true;
    };
    now = 100;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(closed, false);
    release();
    const run = await pending;
    assert.equal(data(run).status, "NEEDS_VALUES");
    now = 111;
    for (let attempt = 0; attempt < 40 && !closed; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(closed, true);
  } finally {
    release();
    await client.close();
    await app.close();
  }
});

test("R5: concurrent browser_run calls cannot exceed the session limit", async () => {
  const deps = fakeMcpDeps();
  deps.maxSessions = 1;
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const opened: FakePageHandle[] = [];
  deps.engines = new EngineRegistry({ default: { driver: "slow-fake", profile: {} } });
  deps.engines.register({
    kind: "slow-fake",
    launch: async () => ({
      engine: { name: "slow-fake", driver: "slow-fake", stealthLevel: "high" },
      capabilities: new FakePageHandle().capabilities,
      selfCheck: undefined,
      connected: true,
      onDisconnected: () => () => {},
      newPage: async () => {
        await gate;
        const page = new FakePageHandle();
        opened.push(page);
        return page;
      },
      pages: () => opened,
      close: async () => {},
    }),
  });
  const app = createServer(deps);
  const client = new Client({ name: "r5-limit", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  try {
    const runs = [1, 2, 3].map(() =>
      client.callTool({ name: "browser_run", arguments: { goal: "Finish" } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    openGate();
    const results = (await Promise.all(runs)).map(data);
    assert.equal(opened.length, 1, "only one tab is opened");
    assert.equal(results.filter((run) => run.reason === "too_many_sessions").length, 2);
    // A run that fails while opening its tab gives its place back.
    const failing = fakeMcpDeps();
    failing.maxSessions = 1;
    failing.engines = new EngineRegistry({ default: { driver: "failing-fake", profile: {} } });
    let attempts = 0;
    failing.engines.register({
      kind: "failing-fake",
      launch: async () => ({
        engine: { name: "failing-fake", driver: "failing-fake", stealthLevel: "high" },
        capabilities: new FakePageHandle().capabilities,
        selfCheck: undefined,
        connected: true,
        onDisconnected: () => () => {},
        newPage: async () => {
          if (attempts++ === 0) throw new Error("no tab");
          return new FakePageHandle();
        },
        pages: () => [],
        close: async () => {},
      }),
    });
    const second = createServer(failing);
    const secondClient = new Client({ name: "r5-limit-retry", version: "1" });
    const [secondLeft, secondRight] = InMemoryTransport.createLinkedPair();
    await second.server.connect(secondRight);
    await secondClient.connect(secondLeft);
    try {
      const refused = await secondClient.callTool({
        name: "browser_run",
        arguments: { goal: "Finish" },
      });
      assert.equal(refused.isError, true);
      const admitted = data(
        await secondClient.callTool({ name: "browser_run", arguments: { goal: "Finish" } }),
      );
      assert.notEqual(admitted.reason, "too_many_sessions");
    } finally {
      await secondClient.close();
      await second.close();
    }
  } finally {
    await client.close();
    await app.close();
  }
});

test("R5: a session whose tab cannot be closed is still released", async () => {
  const deps = fakeMcpDeps();
  let now = 1_000_000;
  deps.maxSessions = 1;
  deps.clock = () => now;
  deps.orchestrator = { ...deps.orchestrator, now: () => now };
  deps.sessionOptions = { idleTimeoutMs: 60_000 };
  const app = createServer(deps);
  const client = new Client({ name: "r5-close", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  const run = async () =>
    data(await client.callTool({ name: "browser_run", arguments: { goal: "Finish" } }));
  const unknown = async (session: unknown) => {
    const result = await client.callTool({ name: "browser_observe", arguments: { session } });
    return result.isError === true && /Unknown session/u.test(text(result));
  };
  try {
    // browser_close: the tab is already gone.
    const first = await run();
    deps.pages[0]!.close = async () => {
      throw new Error("No target with given id found");
    };
    const closed = await client.callTool({
      name: "browser_close",
      arguments: { session: first.session },
    });
    assert.equal(closed.isError, true, "the failure is reported");
    assert.equal(await unknown(first.session), true, "the session is no longer registered");
    const second = await run();
    assert.notEqual(second.reason, "too_many_sessions", "its place in the limit is free");
    // Idle reclamation: the same failure while sweeping.
    deps.pages[1]!.close = async () => {
      throw new Error("No target with given id found");
    };
    now += 60_001;
    const third = await run();
    assert.notEqual(third.reason, "too_many_sessions");
    assert.equal(await unknown(second.session), true);
  } finally {
    await client.close();
    await app.close();
  }
});

function slowNavigation() {
  const deps = fakeMcpDeps();
  deps.maxSessions = 1;
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const started = deferred();
  const finish = deferred();
  const closed = deferred();
  let disconnect = () => {};
  deps.engines = new EngineRegistry({ default: { driver: "slow-navigation", profile: {} } });
  deps.engines.register({
    kind: "slow-navigation",
    async launch() {
      let connected = true;
      const listeners = new Set<() => void>();
      disconnect = () => {
        connected = false;
        for (const listener of listeners) listener();
      };
      return {
        engine: { name: "slow-navigation", driver: "slow-navigation", stealthLevel: "high" },
        capabilities: new FakePageHandle().capabilities,
        selfCheck: undefined,
        get connected() {
          return connected;
        },
        onDisconnected(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        newPage: async () => {
          const page = new FakePageHandle();
          if (!deps.pages.length) {
            page.navigate = async (url) => {
              started.resolve();
              await finish.promise;
              return { url, status: 200, headers: {} };
            };
            page.close = async () => {
              closed.resolve();
            };
          }
          deps.pages.push(page);
          return page;
        },
        pages: () => deps.pages,
        close: async () => {},
      };
    },
  });
  return { deps, started, finish, closed, disconnect: () => disconnect() };
}

test(
  "R9: a browser_run cancelled by the client does not keep a session",
  { timeout: 20_000 },
  async () => {
    const setup = slowNavigation();
    const app = createServer(setup.deps);
    const client = new Client({ name: "r9-cancel", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await app.server.connect(right);
    await client.connect(left);
    const controller = new AbortController();
    try {
      const pending = client.callTool(
        {
          name: "browser_run",
          arguments: { goal: "Finish", url: "http://fixture.test/start" },
        },
        undefined,
        { signal: controller.signal },
      );
      const cancelled = assert.rejects(pending, /cancelled by test/u);
      await setup.started.promise;
      controller.abort(new Error("cancelled by test"));
      await cancelled;
      await setup.closed.promise;
      // The cancelled navigation is still pending: cleanup cannot depend on its completion.
      const second = data(
        await client.callTool({ name: "browser_run", arguments: { goal: "Finish again" } }),
      );
      assert.notEqual(second.reason, "too_many_sessions");
      assert.equal(second.status, "NEEDS_VALUES");
      assert.equal(setup.deps.pages.length, 2);
      const observed = data(
        await client.callTool({ name: "browser_observe", arguments: { session: second.session } }),
      );
      assert.equal(observed.status, "RUNNING");
    } finally {
      setup.finish.resolve();
      await client.close();
      await app.close();
    }
  },
);

test(
  "R9: a browser_run whose browser disconnected during navigation does not register a session",
  { timeout: 20_000 },
  async () => {
    const setup = slowNavigation();
    const app = createServer(setup.deps);
    const client = new Client({ name: "r9-disconnected-navigation", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await app.server.connect(right);
    await client.connect(left);
    try {
      const pending = client.callTool({
        name: "browser_run",
        arguments: { goal: "Finish", url: "http://fixture.test/start" },
      });
      await setup.started.promise;
      setup.disconnect();
      const first = data(await pending);
      await setup.closed.promise;
      assert.equal(first.status, "FAILED");
      assert.equal(first.reason, "browser_disconnected");
      assert.ok(first.session);
      const missing = await client.callTool({
        name: "browser_observe",
        arguments: { session: first.session },
      });
      assert.equal(missing.isError, true);
      assert.match(text(missing), /Unknown session/u);
      const second = data(
        await client.callTool({ name: "browser_run", arguments: { goal: "Finish again" } }),
      );
      assert.notEqual(second.reason, "too_many_sessions");
      assert.equal(second.status, "NEEDS_VALUES");
    } finally {
      setup.finish.resolve();
      await client.close();
      await app.close();
    }
  },
);
