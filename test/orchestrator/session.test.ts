import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { test } from "node:test";
import type { DecisionResult } from "../../src/decision/types.ts";
import { MockDecider } from "../../src/decision/mock.ts";
import { tagAnswers } from "../../src/decision/validate.ts";
import {
  CircuitOpenError,
  ContextLimitError,
  DecisionConfigError,
  DecisionRequestError,
  DecisionTimeoutError,
  DecisionTransportError,
  InvalidAnswerError,
} from "../../src/decision/errors.ts";
import { detect, type Finding } from "../../src/detectors/detect.ts";
import { CdpProtocolError, EvaluationError } from "../../src/browser/errors.ts";
import { NavigationInProgressError, PageUnresponsiveError } from "../../src/engine/types.ts";
import type { Action, ActionResult } from "../../src/executor/types.ts";
import { sessionResultSchema } from "../../src/orchestrator/result.ts";
import type { Observation, ObservedElement } from "../../src/observer/types.ts";
import { buildDecisionState, interpret, type PolicyOutcome } from "../../src/policy/index.ts";
import { estimateTokens, enforceLimits } from "../../src/decision/limits.ts";
import {
  OrchestratorSession,
  SessionCancelledError,
  type SessionDeps,
  type SessionOptions,
} from "../../src/orchestrator/session.ts";
import { FakePageHandle } from "../support/fake-engine.ts";
import { executeAction, normalizeDateLike } from "../../src/executor/execute.ts";
import { runInNewContext } from "node:vm";
import {
  installObserverLibrary,
  type ObserverPageLibrary,
} from "../../src/observer/page-library.ts";
import { UnknownKeyError } from "../../src/browser/input.ts";
import { readFile } from "node:fs/promises";
import { answersFor } from "../support/mcp-fixture.ts";

const element = (
  name = "Next",
  role = "button",
  extras: Partial<ObservedElement> = {},
): ObservedElement => ({
  ref: "e1",
  framePath: "",
  fingerprint: "same",
  role,
  name,
  tag: role === "link" ? "a" : "button",
  checked: false,
  selected: false,
  disabled: false,
  readonly: false,
  required: false,
  invalid: false,
  rect: { x: 0, y: 0, width: 100, height: 30 },
  inViewport: true,
  distanceBelowFold: 0,
  ...extras,
});
const observation = (
  items: ObservedElement[] = [element()],
  hash = "start",
  url = "http://example.test/start",
): Observation => ({
  url,
  title: "Fixture",
  readyState: "complete",
  epoch: 1,
  viewport: { width: 800, height: 600 },
  scroll: { x: 0, y: 0, maxY: 0 },
  elements: items,
  text: "fixture text",
  headings: [],
  forms: [],
  signals: {
    passwordFieldVisible: false,
    modalOverlay: false,
    dialogOpen: false,
    iframeOrigins: [],
    scriptOrigins: [],
  },
  pageHash: hash,
  timings: { snapshotMs: 0, totalMs: 0 },
});
const action = (item = element()): Action => ({
  kind: "click",
  target: { epoch: 1, ref: item.ref, fingerprint: item.fingerprint },
});
const changed = (url?: string): ActionResult => ({
  outcome: "changed",
  changes: { url: !!url, pageHash: true, value: false, checked: false },
  ...(url ? { url } : {}),
  timings: { precheckMs: 0, inputMs: 1, settleMs: 1, harnessMs: 1 },
});
const decision: DecisionResult = {
  answers: {},
  usage: { inputTokens: 2, outputTokens: 1 },
  model: "mock",
  provider: "mock",
  latencyMs: 0,
  attempts: 1,
};

test("observation timeout at the deadline yields instead of reporting an unresponsive page", async () => {
  for (const route of ["run", "pending", "dialog"] as const) {
    const clock = { now: 0 };
    let timeout = route !== "dialog";
    let opens = 0;
    let probes = 0;
    const instance = fixture({
      clock,
      observe: async () => {
        if (timeout) {
          clock.now = 10;
          throw new PageUnresponsiveError();
        }
        return observation();
      },
      options: {
        openIsolatedPage: async () => {
          opens++;
          return new FakePageHandle();
        },
      },
    });
    instance.page.callIsolated = async () => {
      probes++;
      return true as never;
    };
    if (route === "dialog") {
      instance.page.emit("dialog", { kind: "confirm", message: "Confirm?", defaultPrompt: "" });
      instance.page.handleDialog = async () => {
        clock.now = 10;
        throw new PageUnresponsiveError();
      };
    }
    if (route === "pending")
      instance.session.pendingGatedAction = {
        action: action(),
        url: observation().url,
        epoch: 1,
        ref: "e1",
        fingerprint: "same",
        role: "button",
        name: "Next",
        reason: "irreversible",
      };
    try {
      const result =
        route === "dialog"
          ? await instance.session.resume({ dialog: { accept: true } }, { deadlineAt: 10 })
          : route === "pending"
            ? await instance.session.resume({ allow_irreversible: true }, { deadlineAt: 10 })
            : await instance.session.run({ deadlineAt: 10 });
      assert.equal(result.reason, "call_deadline_exceeded");
      assert.equal(result.status, "BUDGET_EXHAUSTED");
      assert.equal(opens, 0);
      timeout = false;
      await instance.session.resume();
      assert.equal(probes, 0, "deadline timeout must not mark the page unresponsive");
    } finally {
      await instance.session.close();
    }
  }
});

test("deadline-cut initial navigation does not block completion", async () => {
  const instance = fixture({
    options: {
      navigation: { url: observation().url, headers: {}, failure: "call_deadline_exceeded" },
    },
    detect,
    outcomes: [{ type: "done_candidate", goalMet: 1 }],
  });
  try {
    assert.equal((await instance.session.run({ deadlineAt: 10 })).reason, "call_deadline_exceeded");
    const result = await instance.session.resume();
    assert.equal(result.status, "DONE_UNVERIFIED");
    assert.doesNotMatch(result.question, /error page/u);
  } finally {
    await instance.session.close();
  }
});

test("action finished after the deadline is recorded before yielding", async () => {
  for (const success of [false, true]) {
    const clock = { now: 0 };
    const field = element("Name", "textbox", { tag: "input", inputType: "text" });
    let finished = false;
    const instance = fixture({
      clock,
      options: {
        values: { name: "Ada" },
        usageDetail: true,
        ...(success ? { success: { text_present: "Finished" } } : {}),
      },
      observe: async () => observation([field], finished ? "done" : "start"),
      pageMatches: async () => finished,
      outcomes: [
        {
          type: "act",
          action: {
            kind: "type",
            target: { epoch: 1, ref: field.ref, fingerprint: field.fingerprint },
            valueKey: "name",
          },
        },
      ],
      executeAction: async () => {
        finished = true;
        clock.now = 11;
        return {
          ...changed(),
          changes: { url: false, pageHash: true, value: true, checked: false },
          timings: { precheckMs: 0, inputMs: 2, settleMs: 3, waitMs: 5, harnessMs: 1 },
        };
      },
    });
    try {
      const result = await instance.session.run({ deadlineAt: 10 });
      assert.equal(result.status, success ? "DONE_VERIFIED" : "BUDGET_EXHAUSTED");
      if (!success) assert.equal(result.reason, "call_deadline_exceeded");
      assert.equal(result.trace.length, 1);
      assert.equal(result.trace[0]?.op, "type");
      assert.equal(result.trace[0]?.waitMs, 5);
      assert.equal(result.trace[0]?.step, 1);
      assert.equal(result.timing.browser, 10);
      assert.ok(result.timing.harness >= 1);
      assert.ok(
        (instance.session as unknown as { consumedKeys: Set<string> }).consumedKeys.has("name"),
      );
      assert.equal(instance.seen.actions.length, 1);
    } finally {
      await instance.session.close();
    }
  }
});

test("post-action observation is bounded by the deadline", async () => {
  for (const bounded of [false, true]) {
    const clock = { now: 0 };
    let observeMaxWaitMs: number | undefined;
    const instance = fixture({
      clock,
      decide: async () => {
        clock.now = 7;
        return decision;
      },
      outcomes: [
        { type: "act", action: action() },
        { type: "done_candidate", goalMet: 1 },
      ],
      executeAction: async (_page, _before, _action, _values, options) => {
        observeMaxWaitMs = options?.observeMaxWaitMs;
        clock.now = 20;
        return changed();
      },
    });
    try {
      await instance.session.run(bounded ? { deadlineAt: 20 } : {});
      assert.equal(instance.seen.actions.length, 1);
      assert.equal(observeMaxWaitMs, bounded ? 13 : undefined);
    } finally {
      await instance.session.close();
    }
  }
});

// Bounded: without the deadline checks this wait loops on the fake clock instead of failing.
test("challenge wait stops at the deadline", { timeout: 10_000 }, async () => {
  const clock = { now: 0 };
  const instance = fixture({
    clock,
    findings: [
      [
        {
          kind: "challenge",
          level: "blocking",
          evidence: [],
          vendor: "Example",
          autoPassPlausible: true,
        },
      ],
    ],
    options: { autoPassWindowMs: 8000 },
  });
  try {
    const result = await instance.session.run({ deadlineAt: 250 });
    assert.equal(result.reason, "call_deadline_exceeded");
    assert.equal(clock.now, 250);
    assert.equal(instance.seen.actions.length, 0);
  } finally {
    await instance.session.close();
  }
});

test("empty page wait stops at the deadline", { timeout: 10_000 }, async () => {
  const clock = { now: 0 };
  const instance = fixture({ clock, observations: [{ ...observation([]), text: "" }] });
  try {
    const result = await instance.session.run({ deadlineAt: 750 });
    assert.equal(result.reason, "call_deadline_exceeded");
    assert.equal(clock.now, 750);
    assert.equal(instance.seen.actions.length, 0);
  } finally {
    await instance.session.close();
  }
});

test("field repair does not type after the deadline", async () => {
  for (const expires of [false, true]) {
    const clock = { now: 0 };
    let repairOptions: Parameters<SessionDeps["executeAction"]>[4];
    const field = element("Name", "textbox", { tag: "input", inputType: "text" });
    const target = { epoch: 1, ref: field.ref, fingerprint: field.fingerprint };
    const instance = fixture({
      clock,
      observations: [observation([field])],
      outcomes: [
        { type: "act", action: { kind: "type", target, text: "Ada" } },
        { type: "act", action: { kind: "submit", target } },
        { type: "done_candidate", goalMet: 1 },
      ],
      executeAction: async (_p, _o, chosen, _v, options) => {
        if (instance.seen.actions.length === 2 && chosen.kind === "type") {
          repairOptions = options;
        }
        return {
          ...changed(),
          changes: { url: false, pageHash: true, value: chosen.kind === "type", checked: false },
        };
      },
    });
    let checks = 0;
    instance.page.callIsolated = async (fn) => {
      if (fn.name === "checkTypedFieldsInPage") {
        if (++checks === 1) {
          clock.now = expires ? 10 : 5;
          return ["changed"] as never;
        }
        return ["ok"] as never;
      }
      return [] as never;
    };
    try {
      const result = await instance.session.run({ deadlineAt: 10 });
      if (expires) {
        assert.equal(result.reason, "call_deadline_exceeded");
        assert.deepEqual(
          instance.seen.actions.map((item) => item.kind),
          ["type"],
        );
      } else {
        assert.deepEqual(
          instance.seen.actions.map((item) => item.kind),
          ["type", "type", "submit"],
        );
        assert.equal(repairOptions?.navigationTimeoutMs, 5);
        assert.equal(repairOptions?.actionabilityTimeoutMs, 5);
        assert.equal(repairOptions?.observeMaxWaitMs, 5);
      }
    } finally {
      await instance.session.close();
    }
  }
});

test("batch stops at the deadline after its last budgeted step", async () => {
  const clock = { now: 0 };
  const first = element("First", "textbox", {
    tag: "input",
    inputType: "text",
    ref: "first",
    fingerprint: "first",
  });
  const second = element("Second", "textbox", {
    tag: "input",
    inputType: "text",
    ref: "second",
    fingerprint: "second",
  });
  const instance = fixture({
    clock,
    options: { budget: { steps: 1 }, values: { first: "Ada", second: "Grace" } },
    observations: [observation([first, second])],
    outcomes: [
      {
        type: "batch",
        actions: [first, second].map((item) => ({
          kind: "type",
          target: { epoch: 1, ref: item.ref, fingerprint: item.fingerprint },
          valueKey: item.ref,
        })),
      },
    ],
    executeAction: async () => {
      clock.now = 11;
      return { ...changed(), changes: { url: false, pageHash: true, value: true, checked: false } };
    },
  });
  try {
    const result = await instance.session.run({ deadlineAt: 10 });
    assert.equal(result.reason, "call_deadline_exceeded");
    assert.equal(instance.seen.actions.length, 1);
    const consumed = (instance.session as unknown as { consumedKeys: Set<string> }).consumedKeys;
    assert.ok(consumed.has("first"));
    assert.equal(consumed.has("second"), false);
  } finally {
    await instance.session.close();
  }
});

test("seconds reset but tokens remain cumulative", async () => {
  const clock = { now: 0 };
  const instance = fixture({
    clock,
    options: { budget: { seconds: 0.1, steps: 2 } },
    decide: async () => {
      clock.now += 20;
      return decision;
    },
    outcomes: [{ type: "act", action: action() }],
    executeAction: async () => {
      clock.now += 20;
      return changed();
    },
  });
  try {
    const first = await instance.session.run({ deadlineAt: 50 });
    assert.equal(first.reason, "call_deadline_exceeded");
    assert.equal(first.trace.length, 1);
    assert.equal(first.usage.decision_tokens, 6);
    clock.now += 1000;
    const second = await instance.session.resume({}, { deadlineAt: clock.now + 50 });
    assert.equal(second.reason, "call_deadline_exceeded");
    assert.equal(second.trace.length, 2);
    assert.equal(second.usage.decision_tokens, 12);
    const third = await instance.session.resume({}, { deadlineAt: clock.now + 1000 });
    assert.equal(third.reason, "budget_exhausted");
    assert.equal(third.trace.length, 4);
  } finally {
    await instance.session.close();
  }
  const smaller = fixture({
    clock: { now: 0 },
    options: { budget: { seconds: 0.01 } },
    decide: async () => {
      smaller.clock.now = 20;
      return decision;
    },
  });
  try {
    assert.equal((await smaller.session.run({ deadlineAt: 100 })).reason, "budget_exhausted");
  } finally {
    await smaller.session.close();
  }
});

test("yield neither screenshots nor finalizes session logging", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deadline-log-"));
  const path = join(directory, "decisions.jsonl");
  const clock = { now: 0 };
  let directories = 0;
  const instance = fixture({
    clock,
    options: { decisionLogPath: path },
    tempDir: async () => {
      directories++;
      return directory;
    },
    decide: async () => {
      clock.now += 10;
      return decision;
    },
    outcomes: [{ type: "done_candidate", goalMet: 1 }],
  });
  try {
    const result = await instance.session.run({ deadlineAt: 5 });
    assert.equal(result.reason, "call_deadline_exceeded");
    assert.equal(result.screenshot_path, undefined);
    assert.equal(directories, 0);
    assert.equal(
      instance.page.calls.some((c) => c.name === "screenshot"),
      false,
    );
    assert.equal(existsSync(path), false);
    await instance.session.resume({}, { deadlineAt: 100 });
    assert.match(await readFile(path, "utf8"), /session_end/u);
  } finally {
    await instance.session.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("deadline before approved action preserves pending approval", async () => {
  const clock = { now: 0 };
  let slow = false;
  const target = element("Delete account");
  const instance = fixture({
    clock,
    observe: async () => {
      if (slow) clock.now += 10;
      return observation([target]);
    },
    outcomes: [
      { type: "act", action: action(target) },
      { type: "handoff", reason: "needs_values", source: "code", details: {} },
    ],
  });
  try {
    assert.equal((await instance.session.run()).status, "CONFIRM_REQUIRED");
    slow = true;
    assert.equal(
      (await instance.session.resume({ allow_irreversible: true }, { deadlineAt: clock.now + 5 }))
        .reason,
      "call_deadline_exceeded",
    );
    assert.ok(instance.session.pendingGatedAction);
    assert.equal(instance.seen.actions.length, 0);
    slow = false;
    await instance.session.resume({ allow_irreversible: true }, { deadlineAt: clock.now + 100 });
    assert.equal(instance.seen.actions.length, 1);
    assert.equal(instance.session.pendingGatedAction, undefined);
    await instance.session.resume();
    assert.equal(instance.seen.actions.length, 1);
  } finally {
    await instance.session.close();
  }
});

test("approved pending action that yields after dispatch is not run again", async () => {
  const clock = { now: 0 };
  const target = element("Delete account");
  const instance = fixture({
    clock,
    observe: async () => observation([target]),
    outcomes: [
      { type: "act", action: action(target) },
      { type: "handoff", reason: "needs_values", source: "code", details: {} },
    ],
    executeAction: async () => {
      clock.now += 10;
      return changed();
    },
  });
  try {
    assert.equal((await instance.session.run()).status, "CONFIRM_REQUIRED");
    const resumed = await instance.session.resume(
      { allow_irreversible: true },
      { deadlineAt: clock.now + 5 },
    );
    assert.equal(resumed.reason, "call_deadline_exceeded");
    assert.equal(instance.seen.actions.length, 1);
    assert.equal(instance.session.pendingGatedAction, undefined);
    await instance.session.resume({ allow_irreversible: true }, { deadlineAt: clock.now + 100 });
    assert.equal(instance.seen.actions.length, 1);
  } finally {
    await instance.session.close();
  }
});

test("completed success wins over an unnecessary yield", async () => {
  const clock = { now: 0 };
  let complete = false;
  const instance = fixture({
    clock,
    options: { success: { text_present: "Finished" } },
    pageMatches: async () => complete,
    outcomes: [{ type: "act", action: action() }],
    executeAction: async () => {
      complete = true;
      clock.now = 10;
      return changed();
    },
    observe: async () => observation(undefined, complete ? "done" : "start"),
  });
  try {
    assert.equal((await instance.session.run({ deadlineAt: 10 })).status, "DONE_VERIFIED");
    assert.equal(instance.seen.actions.length, 1);
  } finally {
    await instance.session.close();
  }
});

function r10Deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("R10: OrchestratorSession.run stops at the next step boundary when its signal aborts", async () => {
  const controller = new AbortController();
  let decisions = 0;
  const instance = fixture({
    outcomes: [{ type: "act", action: action() }],
    decide: async () => {
      decisions++;
      controller.abort();
      return decision;
    },
  });
  try {
    await assert.rejects(
      instance.session.run({ signal: controller.signal }),
      SessionCancelledError,
    );
    assert.equal(decisions, 1);
    assert.deepEqual(instance.seen.actions, []);
    assert.equal((await instance.session.observe()).status, "RUNNING");
    await instance.session.act([{ action: "click", ref: "e1" }]);
    assert.equal(instance.seen.actions.length, 1, "manual action must not inherit cancellation");
  } finally {
    await instance.session.close();
  }
});

test("R10: cancellation waits for an already running action and prevents the next step", async () => {
  const controller = new AbortController();
  const started = r10Deferred();
  const finish = r10Deferred();
  let decisions = 0;
  const instance = fixture({
    outcomes: [{ type: "act", action: action() }],
    decide: async () => {
      decisions++;
      return decision;
    },
    executeAction: async () => {
      started.resolve();
      await finish.promise;
      return changed();
    },
  });
  try {
    let settled = false;
    const running = instance.session.run({ signal: controller.signal });
    const rejected = assert.rejects(running, SessionCancelledError);
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await started.promise;
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    finish.resolve();
    await rejected;
    assert.equal(decisions, 1);
    assert.equal(instance.seen.actions.length, 1);
    assert.equal(
      (await instance.session.observe()).trace.length,
      1,
      "an action that was running when the request was cancelled is still recorded",
    );
  } finally {
    finish.resolve();
    await instance.session.close();
  }
});

test("R10: closing a session waits for every tab before removing its handoff directory, also when one tab fails to close", async () => {
  for (const fails of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), "jevpilot-r10-close-"));
    const popup = new FakePageHandle();
    const tabStarted = r10Deferred();
    const tabFinished = r10Deferred();
    const screenshotStarted = r10Deferred();
    const screenshotFinished = r10Deferred();
    const failure = new Error("original tab close failed");
    const instance = fixture({
      options: { budget: { steps: 1 } },
      outcomes: [{ type: "act", action: action() }],
      tempDir: async () => directory,
      execute: () => {
        instance.page.emit("popup", popup);
        return changed();
      },
    });
    try {
      assert.equal((await instance.session.run()).status, "BUDGET_EXHAUSTED");
      assert.equal(instance.session.page, popup);
      assert.equal(existsSync(join(directory, "handoff-1.jpg")), true);
      popup.screenshot = async () => {
        screenshotStarted.resolve();
        await screenshotFinished.promise;
        return new Uint8Array([1, 2, 3]);
      };
      const handoff = instance.session.resume();
      await screenshotStarted.promise;
      let originalClosed = false;
      instance.page.close = async () => {
        originalClosed = true;
        if (fails) throw failure;
      };
      popup.close = async () => {
        tabStarted.resolve();
        await tabFinished.promise;
      };
      let settled = false;
      const closing = instance.session.close();
      const outcome = closing.then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await tabStarted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(originalClosed, true);
      assert.equal(settled, false);
      assert.equal(existsSync(directory), true);
      screenshotFinished.resolve();
      assert.equal((await handoff).screenshot_path, undefined);
      // Give a premature cleanup enough time to finish, while the second tab is still blocked.
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      assert.equal(settled, false, "close must still wait for the second tab");
      assert.equal(existsSync(directory), true);
      tabFinished.resolve();
      assert.equal(await outcome, fails ? failure : undefined);
      assert.equal(existsSync(directory), false);
    } finally {
      tabFinished.resolve();
      screenshotFinished.resolve();
      await instance.session.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("R10: a failed handoff directory creation is retried at the next handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevpilot-r10-retry-"));
  const directory = join(root, "handoff");
  let attempts = 0;
  const instance = fixture({
    outcomes: [{ type: "handoff", reason: "needs_values", source: "code", details: {} }],
    tempDir: async () => {
      if (++attempts === 1) throw new Error("temporary directory failure");
      await mkdir(directory);
      return directory;
    },
  });
  instance.page.screenshot = async () => new Uint8Array([1, 2, 3]);
  try {
    assert.equal((await instance.session.run()).screenshot_path, undefined);
    assert.equal(attempts, 1);
    const retried = await instance.session.resume();
    assert.equal(attempts, 2);
    assert.equal(retried.screenshot_path, join(directory, "handoff-0.jpg"));
    assert.deepEqual([...(await readFile(retried.screenshot_path!))], [1, 2, 3]);
    assert.equal((await instance.session.resume()).screenshot_path, retried.screenshot_path);
    assert.equal(attempts, 2);
  } finally {
    await instance.session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("R10: typing the same value repeatedly sends it to the decision model once", async () => {
  const field = element("Search", "textbox", { tag: "input", inputType: "search" });
  const urls = ["http://example.test/start", "http://example.test/next"];
  let url = urls[0]!;
  const requests: unknown[] = [];
  const instance = fixture({
    observe: async () => observation([field], "page", url),
    buildDecisionState: (context) => ({
      state: {
        typedValues: context.typedValues,
        futileSubmits: [...(context.futileSubmits ?? [])],
      },
      questions: {},
      reductions: [],
    }),
    decide: async (request) => {
      requests.push(request.state);
      return decision;
    },
  });
  try {
    for (const currentUrl of urls) {
      url = currentUrl;
      for (const text of ["first", "first", "second", "first"]) {
        await instance.session.act([{ action: "type", ref: field.ref, text, submit: true }]);
      }
      await instance.session.run();
    }
    assert.equal(instance.seen.actions.length, 8);
    assert.deepEqual(
      requests,
      urls.map((_, index) => ({
        typedValues: ["first", "second"],
        futileSubmits: urls.slice(0, index + 1).flatMap((url) => [
          { url, value: "first" },
          { url, value: "second" },
        ]),
      })),
    );
  } finally {
    await instance.session.close();
  }
});

test("M6t: the session passes its typed values to the policy", async () => {
  const seen: string[][] = [];
  const field = element("keyword", "textbox", { tag: "input", inputType: "text" });
  const instance = fixture({
    observations: [observation([field])],
    options: { values: { query: "艾尔登法环" } },
    executeAction: async () => ({
      ...changed(),
      changes: { url: false, pageHash: false, value: true, checked: false },
    }),
    buildDecisionState: (context) => {
      seen.push(context.typedValues ?? []);
      return { state: {}, questions: {}, reductions: [] };
    },
  });
  try {
    await instance.session.act([{ action: "type", ref: field.ref, value_key: "query" }]);
    await instance.session.run();
    assert.deepEqual(seen.at(-1), ["艾尔登法环"]);
  } finally {
    await instance.session.close();
  }
});

test("O9e: a field rewritten after typing is retyped before submitting", async () => {
  const field = element("Date", "textbox", { tag: "input", inputType: "text" });
  const instance = fixture({
    observations: [observation([field])],
    outcomes: [
      {
        type: "act",
        action: {
          kind: "type",
          target: { epoch: 1, ref: field.ref, fingerprint: field.fingerprint },
          text: "09/28/2026",
        },
      },
      {
        type: "act",
        action: {
          kind: "submit",
          target: { epoch: 1, ref: field.ref, fingerprint: field.fingerprint },
        },
      },
    ],
    executeAction: async (_page, _before, action) => ({
      ...changed(),
      changes: { url: false, pageHash: false, value: action.kind === "type", checked: false },
    }),
  });
  instance.page.results.push(["changed"], ["ok"]);
  try {
    const result = await instance.session.run();
    assert.notEqual(result.status, "FAILED");
    // The first type, the retype after the page rewrote the field, then the submit.
    assert.deepEqual(
      instance.seen.actions.slice(0, 3).map((item) => item.kind),
      ["type", "type", "submit"],
    );
    assert.equal(result.trace.filter((entry) => entry.op === "type").length, 2);
  } finally {
    await instance.session.close();
  }
});

test("O9e: a field that keeps being rewritten is handed back instead of submitted", async () => {
  const field = element("Date", "textbox", { tag: "input", inputType: "text" });
  const instance = fixture({
    observations: [observation([field])],
    outcomes: [
      {
        type: "act",
        action: {
          kind: "type",
          target: { epoch: 1, ref: field.ref, fingerprint: field.fingerprint },
          text: "09/28/2026",
        },
      },
      {
        type: "act",
        action: {
          kind: "submit",
          target: { epoch: 1, ref: field.ref, fingerprint: field.fingerprint },
        },
      },
    ],
    executeAction: async (_page, _before, action) => ({
      ...changed(),
      changes: { url: false, pageHash: false, value: action.kind === "type", checked: false },
    }),
  });
  instance.page.results.push(["changed"], ["changed"]);
  try {
    const result = await instance.session.run();
    assert.equal(result.status, "UNCERTAIN");
    assert.match(JSON.stringify(result), /Date/u);
    assert.ok(!instance.seen.actions.some((item) => item.kind === "submit"));
  } finally {
    await instance.session.close();
  }
});

test("O9e: the pre-submit check never exposes a secret value", async () => {
  const field = element("Password", "textbox", { tag: "input", inputType: "password" });
  const secret = "never-log-this";
  process.env.JEVPILOT_SECRET_O9E = secret;
  const instance = fixture({
    observations: [observation([field])],
    outcomes: [
      {
        type: "act",
        action: {
          kind: "type",
          target: { epoch: 1, ref: field.ref, fingerprint: field.fingerprint },
          valueKey: "password",
        },
      },
      {
        type: "act",
        action: {
          kind: "submit",
          target: { epoch: 1, ref: field.ref, fingerprint: field.fingerprint },
        },
      },
    ],
    options: {
      values: {
        password: { secret_ref: "env:JEVPILOT_SECRET_O9E", origins: ["http://example.test"] },
      },
    },
    executeAction: async (_page, _before, action) => ({
      ...changed(),
      changes: { url: false, pageHash: false, value: action.kind === "type", checked: false },
    }),
  });
  instance.page.results.push(["changed"], ["changed"]);
  try {
    const result = await instance.session.run();
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, new RegExp(secret, "u"));
    const retype = instance.seen.actions.at(1) as Extract<Action, { kind: "type" }>;
    assert.equal(retype.valueKey, "password");
    assert.equal(retype.text, undefined);
  } finally {
    delete process.env.JEVPILOT_SECRET_O9E;
    await instance.session.close();
  }
});

test("M6u: the session records a submit that left the URL unchanged", async () => {
  for (const op of ["submit", "type"] as const) {
    const seen: { url: string; value: string }[][] = [];
    const field = element("Search", "textbox", {
      tag: "input",
      inputType: "search",
      value: "query",
    });
    const instance = fixture({
      observations: [observation([field])],
      outcomes: [
        ...(op === "submit"
          ? ([
              {
                type: "act" as const,
                action: {
                  kind: "submit" as const,
                  target: { epoch: 1, ref: field.ref, fingerprint: field.fingerprint },
                },
              },
            ] as const)
          : []),
        { type: "handoff", reason: "uncertain", source: "code", details: {} },
      ],
      buildDecisionState: (context) => {
        seen.push(context.futileSubmits ?? []);
        return { state: {}, questions: {}, reductions: [] };
      },
    });
    try {
      if (op === "type")
        await instance.session.act([
          { action: "type", ref: field.ref, text: "typed query", submit: true },
        ]);
      await instance.session.run();
      assert.deepEqual(seen.at(-1), [
        { url: "http://example.test/start", value: op === "submit" ? "query" : "typed query" },
      ]);
    } finally {
      await instance.session.close();
    }
  }
});

test("M6u: a submit that changed the URL is not recorded", async () => {
  const seen: { url: string; value: string }[][] = [];
  const field = element("Search", "textbox", { tag: "input", value: "query" });
  const instance = fixture({
    observations: [observation([field]), observation([field], "next", "http://example.test/next")],
    execute: () => changed("http://example.test/next"),
    outcomes: [
      {
        type: "act",
        action: {
          kind: "submit",
          target: { epoch: 1, ref: field.ref, fingerprint: field.fingerprint },
        },
      },
      { type: "handoff", reason: "uncertain", source: "code", details: {} },
    ],
    buildDecisionState: (context) => {
      seen.push(context.futileSubmits ?? []);
      return { state: {}, questions: {}, reductions: [] };
    },
  });
  try {
    await instance.session.run();
    assert.deepEqual(seen.at(-1), []);
  } finally {
    await instance.session.close();
  }
});

test("M6x: a submit that opened a popup is not recorded as futile", async () => {
  const seen: { url: string; value: string }[][] = [];
  const field = element("Search", "textbox", { tag: "input", inputType: "search", value: "query" });
  const instance = fixture({
    observations: [observation([field])],
    outcomes: [
      {
        type: "act",
        action: {
          kind: "submit",
          target: { epoch: 1, ref: field.ref, fingerprint: field.fingerprint },
        },
      },
      { type: "handoff", reason: "uncertain", source: "code", details: {} },
    ],
    execute: () => ({ ...changed(), popup: "opened" }),
    buildDecisionState: (context) => {
      seen.push(context.futileSubmits ?? []);
      return { state: {}, questions: {}, reductions: [] };
    },
  });
  try {
    await instance.session.run();
    assert.deepEqual(seen.at(-1), []);
  } finally {
    await instance.session.close();
  }
});

test("M6x: a popup that arrives after the action result is followed before the next action", async () => {
  const popup = new FakePageHandle();
  const pages: unknown[] = [];
  const instance = fixture({
    executeAction: async (page) => {
      pages.push(page);
      if (pages.length === 1) setTimeout(() => (page as FakePageHandle).emit("popup", popup), 10);
      return changed();
    },
  });
  try {
    await instance.session.act([{ action: "click", ref: "e1" }]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await instance.session.act([{ action: "wait" }]);
    assert.equal(instance.session.page, popup);
    assert.ok(
      pages.slice(1).every((page) => page === popup),
      "no later action runs on the opener",
    );
  } finally {
    await instance.session.close();
  }
});

test("M6x: a popup that arrives while deciding is followed before the action runs", async () => {
  const popup = new FakePageHandle();
  const pages: unknown[] = [];
  const click: PolicyOutcome = {
    type: "act",
    action: { kind: "click", target: { epoch: 1, ref: "e1", fingerprint: "same" } },
  };
  let decisions = 0;
  const instance = fixture({
    outcomes: [click, click, { type: "done_candidate", goalMet: 0.9 }],
    decide: async () => {
      if (++decisions === 2) instance.page.emit("popup", popup);
      return decision;
    },
    executeAction: async (page) => {
      pages.push(page);
      return changed();
    },
  });
  try {
    await instance.session.run();
    assert.equal(instance.session.page, popup);
    assert.equal(pages[0], instance.page);
    assert.ok(
      pages.slice(1).every((page) => page === popup),
      "the action decided on the opener does not run there once the popup arrived",
    );
  } finally {
    await instance.session.close();
  }
});

test("M6x: observing after a late popup shows the popup", async () => {
  const popup = new FakePageHandle();
  const instance = fixture();
  try {
    await instance.session.act([{ action: "click", ref: "e1" }]);
    instance.page.emit("popup", popup);
    await instance.session.observe();
    assert.equal(instance.session.page, popup);
  } finally {
    await instance.session.close();
  }
});

test("M6x: a popup that opens before any action is not followed", async () => {
  const popup = new FakePageHandle();
  const instance = fixture();
  instance.page.emit("popup", popup);
  try {
    await instance.session.observe();
    await instance.session.act([{ action: "wait" }]);
    await instance.session.observe();
    assert.notEqual(instance.session.page, popup);
  } finally {
    await instance.session.close();
  }
});

test("M6x: a popup that arrives more than 10 s after the last action is not followed", async () => {
  const popup = new FakePageHandle();
  const instance = fixture();
  try {
    await instance.session.act([{ action: "click", ref: "e1" }]);
    instance.clock.now += 10_001;
    instance.page.emit("popup", popup);
    await instance.session.observe();
    assert.notEqual(instance.session.page, popup);
  } finally {
    await instance.session.close();
  }
});

test("O3: a main-frame block hands off as BLOCKED_BY_POLICY before any observation or screenshot", async () => {
  const metadataUrl = "http://169.254.169.254/latest/meta-data/";
  const click: PolicyOutcome = {
    type: "act",
    action: { kind: "click", target: { epoch: 1, ref: "e1", fingerprint: "same" } },
  };
  const blocked = (frame: "main" | "child") => {
    let observed = 0;
    return {
      get observed() {
        return observed;
      },
      instance: fixture({
        observe: async () => {
          observed++;
          return observation();
        },
        outcomes: [click, { type: "handoff", reason: "uncertain", source: "code", details: {} }],
        executeAction: async (page) => {
          (page as FakePageHandle).emit("requestBlocked", {
            url: metadataUrl,
            address: "169.254.169.254",
            frame,
          });
          return changed(metadataUrl);
        },
      }),
    };
  };
  const main = blocked("main");
  try {
    const result = await main.instance.session.run();
    assert.equal(result.status, "BLOCKED_BY_POLICY");
    assert.equal(result.reason, "blocked_address");
    assert.match(result.question, /169\.254\.169\.254/u);
    assert.match(result.question, /JEVPILOT_NETWORK_GUARD/u);
    assert.equal(result.snapshot, "");
    assert.equal(result.screenshot_path, undefined);
    const observedAtBlock = main.observed;
    for (const next of [
      await main.instance.session.observe(),
      await main.instance.session.act([{ action: "wait" }]),
      await main.instance.session.resume({ allowed_domains: ["169.254.169.254"] }),
    ]) {
      assert.equal(next.status, "BLOCKED_BY_POLICY");
      assert.equal(next.snapshot, "");
    }
    assert.equal(main.observed, observedAtBlock, "nothing is observed after the block");
    assert.equal(main.instance.seen.actions.length, 1, "no action runs after the block");
  } finally {
    await main.instance.session.close();
  }
  const child = blocked("child");
  try {
    assert.notEqual((await child.instance.session.run()).status, "BLOCKED_BY_POLICY");
  } finally {
    await child.instance.session.close();
  }
});

test("M6u: a covered submit-button click is not turned into a futile submit", async () => {
  const field = element("Search term", "textbox", {
    ref: "e1",
    tag: "input",
    inputType: "search",
    value: "query",
    formId: "search",
  });
  const button = element("Search", "button", {
    ref: "e2",
    fingerprint: "button",
    inputType: "submit",
    formId: "search",
  });
  const instance = fixture({
    observations: [observation([field, button])],
    outcomes: [
      {
        type: "act",
        action: {
          kind: "submit",
          target: { epoch: 1, ref: field.ref, fingerprint: field.fingerprint },
        },
      },
      { type: "handoff", reason: "uncertain", source: "code", details: {} },
    ],
    execute: (action) =>
      action.kind === "click"
        ? { ...changed(), outcome: "covered", coveredBy: { role: "div", name: "overlay" } }
        : changed(),
  });
  try {
    await instance.session.run();
    await instance.session.act([{ action: "click", ref: button.ref }]);
    assert.deepEqual(
      instance.seen.actions.map((item) => item.kind),
      ["submit", "click"],
    );
    assert.equal(instance.session.trace.at(-1)?.outcome, "covered");
  } finally {
    await instance.session.close();
  }
});

test("M6u: a password field or a secret value is never recorded as a futile submit", async () => {
  const password = element("Password", "textbox", {
    tag: "input",
    inputType: "password",
    value: "masked password",
  });
  const submit = (field: ObservedElement): PolicyOutcome => ({
    type: "act",
    action: {
      kind: "submit",
      target: { epoch: 1, ref: field.ref, fingerprint: field.fingerprint },
    },
  });
  const handoff: PolicyOutcome = {
    type: "handoff",
    reason: "uncertain",
    source: "code",
    details: {},
  };
  const passwordContexts: { url: string; value: string }[][] = [];
  const passwordCase = fixture({
    observations: [observation([password])],
    outcomes: [submit(password), handoff],
    buildDecisionState: (context) => {
      passwordContexts.push([...(context.futileSubmits ?? [])]);
      return { state: {}, questions: {}, reductions: [] };
    },
  });

  const secret = "M6U_SECRET_TEST_VALUE";
  const previous = process.env.JEVPILOT_SECRET_M6U_TEST;
  process.env.JEVPILOT_SECRET_M6U_TEST = secret;
  const secretField = { ...password, value: "" };
  const visibleSecret = element("Search", "textbox", {
    ref: "e2",
    fingerprint: "search",
    tag: "input",
    inputType: "search",
    value: secret,
  });
  const secretContexts: { url: string; value: string }[][] = [];
  const secretCase = fixture({
    observations: [observation([secretField, visibleSecret])],
    options: {
      values: {
        password: {
          secret_ref: "env:JEVPILOT_SECRET_M6U_TEST",
          origins: ["http://example.test"],
        },
      },
    },
    outcomes: [
      {
        type: "act",
        action: {
          kind: "type",
          target: { epoch: 1, ref: secretField.ref, fingerprint: secretField.fingerprint },
          valueKey: "password",
          submit: true,
        },
      },
      handoff,
      submit(visibleSecret),
      handoff,
    ],
    buildDecisionState: (context) => {
      secretContexts.push([...(context.futileSubmits ?? [])]);
      return { state: {}, questions: {}, reductions: [] };
    },
  });
  try {
    await passwordCase.session.run();
    assert.deepEqual(passwordContexts.at(-1), []);
    await secretCase.session.run();
    assert.deepEqual(secretContexts.at(-1), []);
    await secretCase.session.run();
    assert.deepEqual(secretContexts.at(-1), []);
    assert.deepEqual(
      secretCase.seen.actions.map((action) => action.kind),
      ["type", "submit"],
    );
  } finally {
    await passwordCase.session.close();
    await secretCase.session.close();
    if (previous === undefined) delete process.env.JEVPILOT_SECRET_M6U_TEST;
    else process.env.JEVPILOT_SECRET_M6U_TEST = previous;
  }
});

test("R10: date values with a one-digit month or day, or a year before 100, are normalized", async () => {
  for (const [type, value, expected] of [
    ["date", "2026/10/15", "2026-10-15"],
    ["date", "2026.10.15", "2026-10-15"],
    ["date", "2026年10月15日", "2026-10-15"],
    ["date", "2026-1-1", "2026-01-01"],
    ["date", "0050-01-01", "0050-01-01"],
    ["time", "09:42:03", "09:42:03"],
    ["datetime-local", "2026/10/15 09:42", "2026-10-15T09:42"],
    ["month", "2026-10", "2026-10"],
    ["week", "2026-W42", "2026-W42"],
    ["date", "10/15/2026", undefined],
    ["date", "2026-02-30", undefined],
    ["time", "25:00", undefined],
  ] as const)
    assert.equal(normalizeDateLike(type, value), expected);
  const field = element("Start date", "input", { tag: "input", inputType: "date" });
  const instance = fixture({
    observations: [observation([field])],
    options: { values: { start: "10/15/2026" } },
  });
  try {
    for (const op of [
      { action: "type", ref: field.ref, text: "10/15/2026" },
      { action: "type", ref: field.ref, value_key: "start" },
    ] as const) {
      const result = await instance.session.act([op]);
      assert.equal(result.status, "UNCERTAIN");
      assert.match(result.question, /Start date.*YYYY-MM-DD/u);
    }
    assert.equal(instance.seen.actions.length, 0);
  } finally {
    await instance.session.close();
  }
});

test("M6g: an unknown key name hands off instead of failing", async () => {
  const instance = fixture({
    executeAction: async () => {
      throw new UnknownKeyError("MysteryKey");
    },
  });
  try {
    const result = await instance.session.act([{ action: "press_key", name: "MysteryKey" }]);
    assert.equal(result.status, "UNCERTAIN");
    assert.match(result.question, /printable character.*Modifier\+Key/iu);
  } finally {
    await instance.session.close();
  }
});

test("M6g: goal_update ignores success assertions that already hold", async () => {
  const instance = fixture({
    observations: [observation(), { ...observation(), text: "Results ready", pageHash: "results" }],
    options: { success: { text_present: "Results" } },
  });
  try {
    await instance.session.observe();
    assert.equal((await instance.session.observe()).status, "DONE_VERIFIED");
    const resumed = await instance.session.resume({ goal_update: "Click the first course card" });
    assert.notEqual(resumed.status, "DONE_VERIFIED");
    assert.deepEqual(resumed.details, [
      "success assertions already held when the goal was updated and were ignored",
    ]);
  } finally {
    await instance.session.close();
  }
});

test("M6g: session navigation refuses non-http(s) URLs before navigating", async () => {
  const instance = fixture();
  const requested: string[] = [];
  instance.page.navigate = async (url: string) => {
    requested.push(url);
    return { url, status: 200, headers: {} };
  };
  try {
    for (const url of [
      "file:///C:/Users/someone/secret.txt",
      "view-source:https://example.test/",
      "javascript:void(0)",
    ]) {
      const result = await instance.session.navigate(url);
      assert.equal(result.status, "UNCERTAIN");
      assert.match(result.question, /Only http: and https: URLs/u);
    }
    assert.deepEqual(requested, []);
  } finally {
    await instance.session.close();
  }
});

test("M6g: a URL without a hostname is outside allowed_domains, a blank tab is not", async () => {
  const redirected = fixture({ options: { constraints: { allowed_domains: ["example.test"] } } });
  redirected.page.navigate = async () => ({
    url: "data:text/html,redirected",
    status: 200,
    headers: {},
  });
  const blank = fixture({
    observations: [observation([], "blank", "about:blank")],
    options: { constraints: { allowed_domains: ["example.test"] } },
  });
  try {
    const result = await redirected.session.navigate("https://example.test/redirect");
    assert.equal(result.status, "CONFIRM_REQUIRED");
    assert.match(JSON.stringify(result), /URL without a hostname/u);
    assert.notEqual((await blank.session.act([{ action: "wait" }])).status, "CONFIRM_REQUIRED");
  } finally {
    await redirected.session.close();
    await blank.session.close();
  }
});

function fixture(
  overrides: {
    observations?: Observation[];
    findings?: Finding[][];
    outcomes?: PolicyOutcome[];
    execute?: (action: Action, values: Readonly<Record<string, string>>) => ActionResult;
    executeAction?: SessionDeps["executeAction"];
    clock?: { now: number };
    options?: Partial<SessionOptions>;
    decide?: SessionDeps["decide"];
    interpret?: SessionDeps["interpret"];
    detect?: SessionDeps["detect"];
    pageMatches?: SessionDeps["pageMatches"];
    observe?: SessionDeps["observe"];
    buildDecisionState?: SessionDeps["buildDecisionState"];
    tempDir?: SessionDeps["tempDir"];
  } = {},
) {
  const page = new FakePageHandle();
  const clock = overrides.clock ?? { now: 0 };
  const seen: { actions: Action[]; values: Record<string, string>[] } = { actions: [], values: [] };
  const observations = overrides.observations ?? [observation()];
  const findings = overrides.findings ?? [[]];
  const outcomes = overrides.outcomes ?? [{ type: "done_candidate", goalMet: 0.9 }];
  let oi = 0,
    fi = 0,
    pi = 0;
  const deps: Partial<SessionDeps> = {
    observe:
      overrides.observe ?? (async () => observations[Math.min(oi++, observations.length - 1)]!),
    detect: overrides.detect ?? (() => findings[Math.min(fi++, findings.length - 1)]!),
    buildDecisionState:
      overrides.buildDecisionState ?? (() => ({ state: {}, questions: {}, reductions: [] })),
    decide: overrides.decide ?? (async () => decision),
    interpret: overrides.interpret ?? (() => outcomes[Math.min(pi++, outcomes.length - 1)]!),
    pageMatches:
      overrides.pageMatches ??
      (async (_page, assertions) => {
        const current = observations[Math.max(0, Math.min(oi - 1, observations.length - 1))]!;
        return (
          (!assertions.text_present || current.text.includes(assertions.text_present)) &&
          (!assertions.element_present ||
            current.elements.some(
              (item) =>
                item.role === assertions.element_present?.role &&
                item.name === assertions.element_present?.name,
            ))
        );
      }),
    executeAction: async (page, before, chosen, values, options) => {
      seen.actions.push(chosen);
      seen.values.push({ ...values });
      if (overrides.executeAction)
        return overrides.executeAction(page, before, chosen, values, options);
      return overrides.execute?.(chosen, values ?? {}) ?? changed();
    },
    now: () => clock.now,
    ...(overrides.tempDir ? { tempDir: overrides.tempDir } : {}),
    sleep: async (ms) => {
      clock.now += ms;
      // Yield to timers, so a wait loop that never ends fails by test timeout instead of starving it.
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  const session = new OrchestratorSession({ page, goal: "finish", ...overrides.options }, deps);
  return { page, session, clock, seen };
}

test("R9: an approved Enter is pressed on the approved control after focus moved", async () => {
  for (const canFocus of [true, false]) {
    let epoch = 0;
    let reordered = false;
    let current: Observation;
    let focused = "";
    const inputs: { kind: string; ref: string; epoch?: number }[] = [];
    const snapshot = (): Observation => {
      epoch++;
      current = {
        ...observation([
          element("Delete account", "button", {
            ref: reordered ? "e11" : "e1",
            fingerprint: "delete",
          }),
          element("Search", "textbox", {
            ref: reordered ? "e12" : "e2",
            fingerprint: "search",
            tag: "input",
            inputType: "search",
            rect: { x: 200, y: 0, width: 100, height: 30 },
          }),
        ]),
        epoch,
      };
      return current;
    };
    const instance = fixture({
      observe: async () => snapshot(),
      executeAction,
      outcomes: [{ type: "handoff", reason: "info_not_on_page", source: "code", details: {} }],
    });
    instance.page.callIsolated = async (fn, args) => {
      if (["focusObservedRef", "focusRefInPage"].includes(fn.name)) {
        assert.equal(args[0], current.epoch);
        assert.ok(current.elements.some((item) => item.ref === args[1]));
        if (fn.name === "focusRefInPage" && !canFocus) return false as never;
        focused = String(args[1]);
        inputs.push({ kind: "focus", ref: focused, epoch: Number(args[0]) });
        return true as never;
      }
      if (fn.name === "resolveRefInPage") {
        const item = current.elements.find((item) => item.ref === args[1]);
        assert.ok(item);
        return { status: "ok", visible: true, enabled: true, rect: item.rect } as never;
      }
      if (fn.name === "pageSnapshot") return snapshot() as never;
      if (fn.name === "waitForNavigationQuiet") return 0 as never;
      return undefined as never;
    };
    instance.page.click = async () => {
      focused = current.elements[1]!.ref;
      inputs.push({ kind: "click", ref: focused });
      reordered = true;
      return {};
    };
    instance.page.key = async (name) => {
      inputs.push({ kind: name, ref: focused });
      return {};
    };
    try {
      await instance.session.observe();
      const initialRef = current!.elements[0]!.ref;
      assert.equal(
        (await instance.session.act([{ action: "key", name: "Enter", ref: initialRef }])).status,
        "CONFIRM_REQUIRED",
      );
      assert.equal(
        inputs.some((item) => item.kind === "Enter"),
        false,
      );
      await instance.session.observe();
      await instance.session.act([{ action: "click", ref: current!.elements[1]!.ref }]);
      assert.equal(inputs.at(-1)?.kind, "click");
      const resumed = await instance.session.resume({ allow_irreversible: true });
      const approved = instance.seen.actions.at(-1);
      assert.equal(approved?.kind, "key");
      if (approved?.kind !== "key") throw new Error("expected approved key");
      assert.notEqual(approved.target?.ref, initialRef);
      if (canFocus) {
        assert.notEqual(resumed.status, "FAILED");
        assert.deepEqual(inputs.slice(-2), [
          { kind: "focus", ref: approved.target!.ref, epoch: approved.target!.epoch },
          { kind: "Enter", ref: approved.target!.ref },
        ]);
      } else {
        assert.equal(resumed.status, "UNCERTAIN");
        assert.match(resumed.question, /target cannot be focused/u);
        assert.equal(
          inputs.some((item) => item.kind === "Enter"),
          false,
        );
      }
    } finally {
      await instance.session.close();
    }
  }
});

test("R9: Enter and submit in a form whose irreversible button is not observed ask the page for its submit controls", async () => {
  const field = element("Quantity", "textbox", {
    tag: "input",
    inputType: "text",
    formId: "order",
  });
  for (const names of [["Place order"], ["Search"], undefined]) {
    for (const kind of ["key", "submit"] as const) {
      const chosen: Action =
        kind === "key"
          ? {
              kind,
              name: "Enter",
              target: { epoch: 1, ref: field.ref, fingerprint: field.fingerprint },
            }
          : { kind, target: { epoch: 1, ref: field.ref, fingerprint: field.fingerprint } };
      const instance = fixture({
        observations: [observation([field])],
        outcomes: [{ type: "act", action: chosen }],
        options: { budget: { steps: 1 } },
      });
      const requests: unknown[][] = [];
      instance.page.callIsolated = async (fn, args) => {
        if (fn.name === "formSubmitNamesInPage") {
          requests.push(args);
          if (!names) throw new Error("page query failed");
          return names as never;
        }
        return true as never;
      };
      try {
        const result =
          kind === "key"
            ? await instance.session.act([{ action: "key", name: "Enter", ref: field.ref }])
            : await instance.session.run();
        assert.deepEqual(requests, [[1, field.ref]]);
        if (names?.[0] === "Place order") {
          assert.equal(result.status, "CONFIRM_REQUIRED", kind);
          assert.match(result.question, /Approve "Place order"/u);
          assert.equal(instance.seen.actions.length, 0);
        } else {
          assert.equal(result.status, "BUDGET_EXHAUSTED", kind);
          assert.equal(instance.seen.actions[0]?.kind, kind);
        }
      } finally {
        await instance.session.close();
      }
    }
  }
});

test("R9: a password that starts with a common word leaves labels and the field type alone", async () => {
  const variable = "JEVPILOT_SECRET_R9_COMMON";
  const previous = process.env[variable];
  try {
    for (const secret of ["password1!", "Password1!"]) {
      process.env[variable] = secret;
      const field = element("Password", "textbox", {
        tag: "input",
        inputType: "password",
        ariaLabel: "Password",
        required: true,
        value: "",
      });
      const seen: Observation[] = [];
      const requests: Parameters<SessionDeps["decide"]>[0][] = [];
      const instance = fixture({
        observations: [observation([field])],
        options: {
          values: {
            credential: { secret_ref: `env:${variable}`, origins: ["http://example.test"] },
          },
        },
        buildDecisionState: (context) => {
          seen.push(context.observation);
          return buildDecisionState(context);
        },
        decide: async (request) => {
          requests.push(request);
          return { ...decision, answers: tagAnswers(request.questions, answersFor(request)) };
        },
        outcomes: [{ type: "handoff", reason: "uncertain", source: "code", details: {} }],
      });
      try {
        await instance.session.act([{ action: "type", ref: field.ref, value_key: "credential" }]);
        assert.equal(instance.seen.values[0]?.credential, secret);
        field.value = secret;
        await instance.session.run();
        assert.equal(seen.at(-1)?.elements[0]?.value, "[filled]");
        field.value = "";
        await instance.session.run();
        const sent = seen.at(-1)!.elements[0]!;
        assert.equal(sent.inputType, "password");
        assert.equal(sent.name, "Password");
        assert.equal(sent.ariaLabel, "Password");
        const question = requests.at(-1)!.questions.value_for_e1;
        assert.equal(question?.type, "choice");
        if (question?.type !== "choice") throw new Error("expected value_for choice");
        assert.ok(Object.hasOwn(question.criteria, "credential"));
        const state = requests.at(-1)!.state as Record<string, unknown>;
        assert.match(String(state.page_observation), /"Password"/u);
      } finally {
        await instance.session.close();
      }
    }
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});

test("R9: a secret cut short by the observer is still redacted", async () => {
  const secret = `common-word-${"abcdefghij".repeat(12)}`;
  const context: { __jevpilotObserverLibrary?: ObserverPageLibrary } = {};
  runInNewContext(`(${installObserverLibrary.toString()})()`, context);
  const clean = context.__jevpilotObserverLibrary!.clean;
  const page = observation([
    element(clean(secret, 80), "textbox", { tag: "input", value: clean(secret, 60) }),
  ]);
  page.text = `Ordinary ${secret.slice(0, 8)} text. ${clean(secret, 100)}`;
  const seen: Observation[] = [];
  const instance = fixture({
    observations: [page],
    buildDecisionState: (input) => {
      seen.push(input.observation);
      return { state: { observation: input.observation }, questions: {}, reductions: [] };
    },
    outcomes: [{ type: "handoff", reason: "uncertain", source: "code", details: {} }],
  });
  (instance.session as unknown as { secretLiterals: Set<string> }).secretLiterals.add(secret);
  try {
    assert.ok(page.elements[0]!.name.endsWith("…"));
    assert.ok(page.elements[0]!.value!.endsWith("…"));
    const result = await instance.session.run();
    assert.equal(seen[0]?.elements[0]?.name, "[REDACTED]…");
    assert.equal(seen[0]?.elements[0]?.value, "[REDACTED]…");
    assert.equal(seen[0]?.text, `Ordinary ${secret.slice(0, 8)} text. [REDACTED]…`);
    assert.ok(result.snapshot.includes(`Ordinary ${secret.slice(0, 8)} text.`));
    assert.equal(result.snapshot.includes(secret.slice(0, 59)), false);
  } finally {
    await instance.session.close();
  }
});

test("R9: a secret that extends another secret is fully redacted", async () => {
  const secrets = ["password", "password123456"];
  const page = observation([element(secrets[1]!, "button")]);
  page.text = `${secrets[0]} and ${secrets[1]} and ${encodeURIComponent(secrets[1]!)}`;
  page.title = secrets[1]!;
  const requests: string[] = [];
  const instance = fixture({
    observations: [page],
    buildDecisionState,
    decide: async (request) => {
      requests.push(JSON.stringify(request));
      return { ...decision, answers: tagAnswers(request.questions, answersFor(request)) };
    },
    outcomes: [{ type: "handoff", reason: "uncertain", source: "code", details: {} }],
  });
  const literals = (instance.session as unknown as { secretLiterals: Set<string> }).secretLiterals;
  for (const secret of secrets) literals.add(secret);
  try {
    const result = await instance.session.run();
    assert.equal(result.title, "[REDACTED]");
    assert.match(result.snapshot, /page: \[REDACTED\] and \[REDACTED\] and \[REDACTED\]/u);
    assert.equal(requests.length, 1);
    for (const text of [JSON.stringify(result), ...requests]) {
      assert.ok(text.includes("[REDACTED]"));
      assert.equal(text.includes("123456"), false);
      assert.equal(text.includes("password"), false);
    }
  } finally {
    await instance.session.close();
  }
});

test("R2: Enter in a field of an irreversible form waits for approval", async () => {
  const field = element("Order quantity", "textbox", {
    tag: "input",
    inputType: "text",
    formId: "order",
  });
  const buy = element("Place order", "button", { ref: "e2", formId: "order" });
  const search = element("Search", "textbox", { tag: "input", inputType: "search", ref: "e3" });
  const make = (allow = false) =>
    fixture({
      observations: [observation([field, buy, search])],
      options: { constraints: { allow_irreversible: allow }, budget: { steps: 1 } },
    });
  const gated = make();
  const allowed = make(true);
  const outside = make();
  try {
    gated.page.results.push(true);
    const blocked = await gated.session.act([
      { action: "press_key", key: "Enter", ref: field.ref },
    ]);
    assert.equal(blocked.status, "CONFIRM_REQUIRED");
    assert.equal(gated.seen.actions.length, 0);
    const approved = await gated.session.resume({ allow_irreversible: true });
    assert.equal(approved.status, "BUDGET_EXHAUSTED");
    assert.equal(gated.seen.actions[0]?.kind, "key");
    assert.equal((gated.seen.actions[0] as { name: string }).name, "Enter");
    allowed.page.results.push(true);
    assert.notEqual(
      (await allowed.session.act([{ action: "key", name: "Enter", ref: field.ref }])).status,
      "CONFIRM_REQUIRED",
    );
    assert.equal(allowed.seen.actions[0]?.kind, "key");
    outside.page.results.push(true);
    assert.notEqual(
      (await outside.session.act([{ action: "key", name: "Enter", ref: search.ref }])).status,
      "CONFIRM_REQUIRED",
    );
    assert.equal(outside.seen.actions[0]?.kind, "key");
  } finally {
    await gated.session.close();
    await allowed.session.close();
    await outside.session.close();
  }
});

test("R2: page text copied from a secret is redacted in every observation field", async () => {
  const secret = "secret-r2-marker";
  const select = element("Choice", "select", {
    tag: "select",
    options: [secret],
    optionLabel: secret,
    containerText: secret,
    identityName: secret,
  });
  const link = element("View", "link", { ref: "e2", href: `http://example.test/${secret}` });
  const seen: string[] = [];
  const caseUnderTest = fixture({
    observations: [observation([select, link])],
    buildDecisionState: (input) => {
      seen.push(JSON.stringify(input.observation));
      return { state: { observation: input.observation }, questions: {}, reductions: [] };
    },
    decide: async (request) => {
      seen.push(JSON.stringify(request));
      return decision;
    },
    outcomes: [{ type: "handoff", reason: "uncertain", source: "code", details: {} }],
  });
  (caseUnderTest.session as unknown as { secretLiterals: Set<string> }).secretLiterals.add(secret);
  try {
    await caseUnderTest.session.run();
    assert.equal(seen.length, 2);
    assert.ok(seen.every((item) => !item.includes(secret) && item.includes("[REDACTED]")));
  } finally {
    await caseUnderTest.session.close();
  }
});

test("R2: session result url and title are redacted", async () => {
  const secret = "secret-r2-marker";
  const page = observation([], "start", `http://example.test/${secret}`);
  page.title = `Account ${secret}`;
  const caseUnderTest = fixture({ observations: [page] });
  (caseUnderTest.session as unknown as { secretLiterals: Set<string> }).secretLiterals.add(secret);
  Object.assign(caseUnderTest.page, { targetUrl: async () => page.url });
  try {
    const result = await caseUnderTest.session.observe();
    assert.equal(result.url.includes(secret), false);
    assert.equal(result.title.includes(secret), false);
    caseUnderTest.page.navigationResult = { failure: "disconnected", headers: {} };
    const navigation = await caseUnderTest.session.navigate(page.url);
    assert.equal(navigation.url.includes(secret), false);
    assert.equal((await caseUnderTest.session.listTabs())[0]?.url.includes(secret), false);
  } finally {
    await caseUnderTest.session.close();
  }
});

test("R2: an upload hands the checked real path to the page", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevpilot-r2-upload-"));
  const previous = process.env.JEVPILOT_UPLOAD_DIR;
  process.env.JEVPILOT_UPLOAD_DIR = root;
  const file = join(root, "file.txt");
  await writeFile(file, "upload");
  await mkdir(join(root, "sub"));
  const caseUnderTest = fixture({
    observations: [observation([element("File", "textbox", { tag: "input", inputType: "file" })])],
  });
  try {
    await caseUnderTest.session.act([
      { action: "upload", ref: "e1", paths: [`${root}${sep}sub${sep}..${sep}file.txt`] },
    ]);
    const upload = caseUnderTest.page.calls.find((call) => call.name === "setInputFiles");
    assert.deepEqual(upload?.args[1], [await realpath(file)]);
  } finally {
    await caseUnderTest.session.close();
    await rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.JEVPILOT_UPLOAD_DIR;
    else process.env.JEVPILOT_UPLOAD_DIR = previous;
  }
});

test("R2: a decision call stops when the session budget runs out", async () => {
  const caseUnderTest = fixture({
    options: { budget: { seconds: 0.04 } },
    decide: async (_request, options) =>
      new Promise<DecisionResult>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      }),
  });
  try {
    const started = performance.now();
    const result = await caseUnderTest.session.run();
    assert.equal(result.status, "BUDGET_EXHAUSTED");
    assert.ok(performance.now() - started < 500);
  } finally {
    await caseUnderTest.session.close();
  }
});

test("R2: decision state is reduced against the configured provider and context limit", async () => {
  const items = [
    element("Choice", "select", {
      tag: "select",
      ref: "select",
      options: Array.from({ length: 8 }, (_, option) => `Choice ${option} ${"a".repeat(3000)}`),
    }),
    ...Array.from({ length: 200 }, (_, index) =>
      element(`Target ${index} ${"a".repeat(500)}`, "button", {
        ref: `e${index}`,
        inViewport: index < 5,
      }),
    ),
  ];
  const page = observation(items);
  const run = async (decisionProvider: "typesafe" | "custom", decisionContextLimit?: number) => {
    let built: ReturnType<typeof buildDecisionState> | undefined;
    const caseUnderTest = fixture({
      observations: [page],
      options: { decisionProvider, ...(decisionContextLimit ? { decisionContextLimit } : {}) },
      buildDecisionState: (input) => (built = buildDecisionState(input)),
      decide: async () => decision,
      outcomes: [{ type: "handoff", reason: "uncertain", source: "code", details: {} }],
    });
    try {
      await caseUnderTest.session.run();
      return built!;
    } finally {
      await caseUnderTest.session.close();
    }
  };
  const typesafe = await run("typesafe");
  assert.ok(
    estimateTokens({ state: typesafe.state, questions: typesafe.questions }) > 32_768,
    String(estimateTokens({ state: typesafe.state, questions: typesafe.questions })),
  );
  enforceLimits({ state: typesafe.state, questions: typesafe.questions }, "typesafe");
  const limited = await run("typesafe", 8000);
  assert.ok(limited.reductions.length > 0);
  enforceLimits({ state: limited.state, questions: limited.questions }, "typesafe", 8000);
});

test("O2.5: usage detail is absent by default", async () => {
  const instance = fixture();
  try {
    const result = await instance.session.run();
    assert.equal(result.usage.detail, undefined);
    assert.equal(result.usage.decision_tokens, 3);
  } finally {
    await instance.session.close();
  }
});

test("O2.5: usage detail reports this call and the session totals", async () => {
  const clock = { now: 0 };
  let calls = 0;
  const instance = fixture({
    clock,
    options: { usageDetail: true },
    outcomes: [
      { type: "handoff", reason: "needs_values", source: "code", details: {} },
      { type: "handoff", reason: "needs_values", source: "code", details: {} },
    ],
    decide: async () => {
      calls++;
      clock.now += 10;
      return {
        ...decision,
        usage: { inputTokens: calls * 2, outputTokens: calls },
        model: `model-${calls}`,
        latencyMs: 10,
      };
    },
  });
  try {
    const first = await instance.session.run();
    assert.deepEqual(first.usage.detail, {
      call: {
        decisions: 1,
        input_tokens: 2,
        output_tokens: 1,
        decide_ms: 10,
        browser_ms: 0,
        harness_ms: 0,
        total_ms: 10,
      },
      session: {
        decisions: 1,
        input_tokens: 2,
        output_tokens: 1,
        decide_ms: 10,
        browser_ms: 0,
        harness_ms: 0,
        total_ms: 10,
      },
      provider: "mock",
      model: "model-1",
    });
    const second = await instance.session.resume();
    assert.deepEqual(second.usage.detail, {
      call: {
        decisions: 1,
        input_tokens: 4,
        output_tokens: 2,
        decide_ms: 10,
        browser_ms: 0,
        harness_ms: 0,
        total_ms: 10,
      },
      session: {
        decisions: 2,
        input_tokens: 6,
        output_tokens: 3,
        decide_ms: 20,
        browser_ms: 0,
        harness_ms: 0,
        total_ms: 20,
      },
      provider: "mock",
      model: "model-2",
    });
    assert.equal(second.usage.decision_tokens, 9);
    assert.equal(second.timing.total, 10);
  } finally {
    await instance.session.close();
  }
});

test("O2.5: idle time between tool calls is not session time", async () => {
  const clock = { now: 0 };
  const instance = fixture({
    clock,
    options: { usageDetail: true },
    outcomes: [
      { type: "handoff", reason: "needs_values", source: "code", details: {} },
      { type: "handoff", reason: "needs_values", source: "code", details: {} },
    ],
    decide: async () => {
      clock.now += 10;
      return { ...decision, latencyMs: 10 };
    },
  });
  try {
    await instance.session.run();
    // The agent thinks for a minute before resuming.
    clock.now += 60_000;
    const second = await instance.session.resume();
    assert.equal(second.usage.detail?.call.total_ms, 10);
    assert.equal(second.usage.detail?.session.total_ms, 20);
  } finally {
    await instance.session.close();
  }
});

test("O2.5: candidate checks count as decision calls", async () => {
  let calls = 0;
  const instance = fixture({
    options: { usageDetail: true },
    interpret: () => ({
      type: "check",
      question: "click_target",
      candidates: [
        {
          id: "check_1",
          key: "e1",
          probability: 0.5,
          statement: "First",
          overrides: { click_target: "e1" },
        },
      ],
    }),
    decide: async () => ({
      ...decision,
      usage:
        ++calls === 1 ? { inputTokens: 5, outputTokens: 3 } : { inputTokens: 4, outputTokens: 2 },
    }),
  });
  try {
    const result = await instance.session.run();
    assert.equal(result.usage.detail?.call.decisions, 2);
    assert.equal(result.usage.detail?.call.input_tokens, 9);
    assert.equal(result.usage.detail?.call.output_tokens, 5);
    assert.equal(result.usage.decision_tokens, 14);
  } finally {
    await instance.session.close();
  }
});

test("O2.5: trace phases appear only with usage detail on", async () => {
  for (const enabled of [false, true]) {
    const instance = fixture({ options: { usageDetail: enabled } });
    try {
      const result = await instance.session.act([{ action: "click", ref: "e1" }]);
      assert.equal("phases" in result.trace[0]!, enabled);
      assert.equal(sessionResultSchema.safeParse(result).success, true);
    } finally {
      await instance.session.close();
    }
  }
});

test("O2.5: building a result twice in one call does not change the session totals", async () => {
  const clock = { now: 0 };
  const replacement = new FakePageHandle();
  replacement.callIsolated = async () => true as never;
  const instance = fixture({
    clock,
    options: {
      usageDetail: true,
      navigation: { url: "https://example.com/page", headers: {} },
      openIsolatedPage: async () => {
        clock.now += 7;
        return replacement;
      },
    },
    observe: async (page) => {
      if (page !== replacement) throw new PageUnresponsiveError();
      return observation();
    },
    outcomes: [{ type: "handoff", reason: "needs_values", source: "code", details: {} }],
    decide: async () => {
      clock.now += 5;
      return { ...decision, latencyMs: 5 };
    },
  });
  Object.defineProperty(instance.page, "capabilities", {
    value: { ...instance.page.capabilities, isolatedContexts: true },
  });
  try {
    const run = await instance.session.run();
    assert.equal(run.usage.detail?.call.total_ms, 12);
    assert.equal(run.usage.detail?.session.total_ms, 12);
    assert.equal(run.usage.detail?.session.decisions, 1);
    const later = await instance.session.observe();
    assert.equal(later.usage.detail?.session.total_ms, 12);
    assert.equal(later.usage.detail?.session.decisions, 1);
  } finally {
    await instance.session.close();
  }
});

test("candidate check makes one extra decision call without a second step", async () => {
  const first = element("Result", "link", { ref: "e1", fingerprint: "first", href: "/next" });
  const second = element("Result", "link", { ref: "e2", fingerprint: "second", href: "/next" });
  const mock = new MockDecider((request) => {
    if (request.questions.check_1)
      return {
        answers: { check_1: { noul: 0.91 }, check_2: { noul: 0.95 } },
        usage: { inputTokens: 4, outputTokens: 2 },
      };
    const answers = answersFor(request);
    const target = answers.click_target;
    if (!target || !("choice" in target)) throw new Error("target question missing");
    target.choice = "e1";
    target.confidence = 0.55;
    target.probabilities = { e1: 0.55, e2: 0.45, none: 0 };
    return { answers, usage: { inputTokens: 5, outputTokens: 3 } };
  });
  const { session, seen } = fixture({
    observations: [
      observation([first, second]),
      observation([], "next", "http://example.test/next"),
    ],
    options: { success: { url_matches: "/next$" } },
    buildDecisionState,
    interpret,
    decide: (request) => mock.decide(request),
  });
  try {
    const result = await session.run();
    assert.equal(result.status, "DONE_VERIFIED");
    assert.equal(mock.calls.length, 2);
    assert.deepEqual(mock.calls[1]?.state, mock.calls[0]?.state);
    assert.deepEqual(Object.keys(mock.calls[1]?.questions ?? {}), ["check_1", "check_2"]);
    assert.equal(result.trace.length, 1);
    assert.equal(result.usage.decision_tokens, 14);
    assert.equal((seen.actions[0] as Extract<Action, { kind: "click" }>).target.ref, "e1");
  } finally {
    await session.close();
  }
});

test("failed candidate check returns every Noul score without an action", async () => {
  let calls = 0;
  const { session, seen } = fixture({
    interpret: () => ({
      type: "check",
      question: "click_target",
      candidates: [
        {
          id: "check_1",
          key: "e1",
          probability: 0.55,
          statement: "First",
          overrides: { click_target: "e1" },
        },
        {
          id: "check_2",
          key: "e2",
          probability: 0.45,
          statement: "Second",
          overrides: { click_target: "e2" },
        },
      ],
    }),
    decide: async () =>
      ++calls === 1
        ? decision
        : {
            ...decision,
            answers: {
              check_1: { type: "noul", noul: 0.69 },
              check_2: { type: "noul", noul: 0.72 },
            },
          },
  });
  try {
    const result = await session.run();
    assert.equal(result.status, "UNCERTAIN");
    assert.deepEqual(result.details, ["e1: 0.69", "e2: 0.72"]);
    assert.equal(calls, 2);
    assert.equal(seen.actions.length, 0);
  } finally {
    await session.close();
  }
});

test("empty page is resampled six times before UNCERTAIN", async () => {
  const blank = { ...observation([]), text: "" };
  let samples = 0;
  const { session, clock } = fixture({
    observe: async () => {
      samples++;
      return blank;
    },
  });
  try {
    const result = await session.run();
    assert.equal(result.status, "UNCERTAIN");
    assert.equal(result.reason, "uncertain");
    assert.match(result.question, /Page appears empty.*example.test/u);
    assert.equal(samples, 7);
    assert.equal(clock.now, 3000);
  } finally {
    await session.close();
  }
});

test("navigation after a queued observation forces a fresh sample", async () => {
  let calls = 0;
  const { session, page } = fixture({
    observe: async () =>
      ++calls === 1 ? observation() : observation([], "new", "http://example.test/next"),
    options: { success: { url_matches: "/next$" } },
  });
  try {
    const first = await session.observe();
    assert.equal(first.status, "RUNNING");
    page.emit("navigated", { url: "http://example.test/next" });
    const result = await session.resume();
    assert.equal(result.status, "DONE_VERIFIED");
    assert.equal(calls, 2);
  } finally {
    await session.close();
  }
});

test("two covered attempts name the coverer and preserve it in trace", async () => {
  const covered = {
    outcome: "covered" as const,
    coveredBy: { role: "banner", name: "Cookie panel" },
    changes: { url: false, pageHash: false, value: false, checked: false },
    timings: { precheckMs: 0, inputMs: 0, settleMs: 0, harnessMs: 0 },
  };
  const { session } = fixture({
    outcomes: [{ type: "act", action: action() }],
    execute: () => covered,
  });
  try {
    const result = await session.run();
    assert.equal(result.status, "STUCK");
    assert.match(result.question, /Cookie panel/u);
    assert.deepEqual(result.trace[0]?.coveredBy, covered.coveredBy);
  } finally {
    await session.close();
  }
});

test("typed key disappears from decision state until resume supplies it again", async () => {
  const field = element("Name", "textbox", { tag: "input", inputType: "text", value: "" });
  const contexts: string[][] = [];
  let decisions = 0;
  const { session } = fixture({
    observations: [observation([field]), observation([field], "changed")],
    options: { values: { name: "Ada" } },
    execute: () => ({
      ...changed(),
      changes: { url: false, pageHash: false, value: true, checked: false },
    }),
    buildDecisionState: (context) => {
      contexts.push(context.valueKeys?.map((key) => key.name) ?? []);
      return { state: {}, questions: {}, reductions: [] };
    },
    interpret: () =>
      ++decisions === 1
        ? {
            type: "batch",
            actions: [
              {
                kind: "type",
                target: { epoch: 1, ref: field.ref, fingerprint: field.fingerprint },
                valueKey: "name",
              },
            ],
          }
        : { type: "handoff", reason: "needs_values", source: "code", details: {} },
  });
  try {
    assert.equal((await session.run()).status, "NEEDS_VALUES");
    assert.deepEqual(contexts, [["name"], []]);
    assert.equal((await session.resume({ values: { name: "Grace" } })).status, "NEEDS_VALUES");
    assert.deepEqual(contexts.at(-1), ["name"]);
  } finally {
    await session.close();
  }
});

for (const [reason, status] of Object.entries({
  needs_values: "NEEDS_VALUES",
  needs_login: "NEEDS_LOGIN",
  blocked_by_challenge: "BLOCKED_BY_CHALLENGE",
  confirm_required: "CONFIRM_REQUIRED",
  info_not_on_page: "INFO_NOT_ON_PAGE",
  uncertain: "UNCERTAIN",
  stuck: "STUCK",
  error_page: "ERROR_PAGE",
})) {
  test(`policy handoff ${status}`, async () => {
    const { session } = fixture({
      outcomes: [{ type: "handoff", reason: reason as never, source: "code", details: {} }],
    });
    try {
      assert.equal((await session.run()).status, status);
    } finally {
      await session.close();
    }
  });
}

test("verified and unverified completion", async () => {
  // M6e: assertions that already hold on the start page are ignored, so the text appears only after acting.
  const verified = fixture({
    observations: [{ ...observation(), text: "start page" }, observation([element()], "done")],
    outcomes: [
      { type: "act", action: action() },
      { type: "done_candidate", goalMet: 0.9 },
    ],
    options: { success: { text_present: "fixture text" } },
  });
  const unverified = fixture({
    observations: [observation(), observation([], "changed")],
    options: { thresholds: { goal_met_unchanged: 0.95 } },
  });
  try {
    assert.equal((await verified.session.run()).status, "DONE_VERIFIED");
    assert.equal((await unverified.session.run()).status, "UNCERTAIN");
    assert.equal(
      (await unverified.session.resume({ goal_update: "new goal" })).status,
      "DONE_UNVERIFIED",
    );
    assert.equal(unverified.session.goal, "new goal");
  } finally {
    await verified.session.close();
    await unverified.session.close();
  }
});

test("unchanged start page completes only at the configurable higher goal threshold", async () => {
  const accepted = fixture({ outcomes: [{ type: "done_candidate", goalMet: 0.8 }] });
  const below = fixture({ outcomes: [{ type: "done_candidate", goalMet: 0.79 }] });
  const configured = fixture({
    options: { thresholds: { goal_met_unchanged: 0.95 } },
    outcomes: [{ type: "done_candidate", goalMet: 0.8 }],
  });
  try {
    const done = await accepted.session.run();
    assert.deepEqual([done.status, done.reason], ["DONE_UNVERIFIED", "goal_met_without_action"]);
    const uncertain = await below.session.run();
    assert.equal(uncertain.status, "UNCERTAIN");
    assert.match(
      uncertain.question,
      /Cannot confirm completion: unchanged page requires goal_met >= 0\.80/u,
    );
    assert.equal((await configured.session.run()).status, "UNCERTAIN");
  } finally {
    await accepted.session.close();
    await below.session.close();
    await configured.session.close();
  }
});

test("value change without a page hash change satisfies the changed-page completion gate", async () => {
  const select = element("Choice", "select", { tag: "select", options: ["One", "Two"] });
  const fixtureCase = fixture({
    observations: [observation([select]), observation([select])],
    outcomes: [
      {
        type: "act",
        action: {
          kind: "select",
          target: { epoch: 1, ref: "e1", fingerprint: "same" },
          optionLabel: "Two",
        },
      },
      { type: "done_candidate", goalMet: 0.82 },
    ],
    execute: () => ({
      ...changed(),
      changes: { url: false, pageHash: false, value: true, checked: false },
      pageHash: "start",
    }),
  });
  try {
    const result = await fixtureCase.session.run();
    assert.deepEqual(
      [result.status, result.reason],
      ["DONE_UNVERIFIED", "goal_met_without_assertions"],
    );
    assert.equal(result.trace[0]?.outcome, "changed");
  } finally {
    await fixtureCase.session.close();
  }
});

test("resume with values continues typing", async () => {
  const input = element("Name", "textbox", { tag: "input", required: true, inputType: "text" });
  const field = observation([input]);
  const { session, seen } = fixture({
    observations: [field, field, observation([], "after")],
    outcomes: [
      { type: "handoff", reason: "needs_values", source: "code", details: {} },
      {
        type: "act",
        action: {
          kind: "type",
          target: { epoch: 1, ref: "e1", fingerprint: "same" },
          valueKey: "name",
        },
      },
      { type: "done_candidate", goalMet: 0.9 },
    ],
    options: { success: { url_matches: "never" }, budget: { steps: 1 } },
  });
  try {
    assert.equal((await session.run()).status, "NEEDS_VALUES");
    assert.equal((await session.resume({ values: { name: "Ada" } })).status, "BUDGET_EXHAUSTED");
    assert.deepEqual(seen.values, [{ name: "Ada" }]);
  } finally {
    await session.close();
  }
});

test("one-shot approval executes stored action once and rejects changed target", async () => {
  const buy = element("Buy now");
  const gated = fixture({
    observations: [observation([buy]), observation([buy]), observation([], "bought")],
    outcomes: [
      { type: "act", action: action(buy) },
      { type: "done_candidate", goalMet: 0.9 },
    ],
    options: { success: { text_present: "never" } },
  });
  const changedTarget = fixture({
    observations: [
      observation([buy]),
      observation([element("Buy now", "button", { fingerprint: "replacement" })]),
    ],
    outcomes: [{ type: "act", action: action(buy) }],
  });
  try {
    assert.equal((await gated.session.run()).status, "CONFIRM_REQUIRED");
    assert.equal((await gated.session.resume({ allow_irreversible: true })).status, "UNCERTAIN");
    assert.equal(gated.seen.actions.length, 1);
    assert.equal(gated.session.constraints.allow_irreversible, false);
    assert.equal((await changedTarget.session.run()).status, "CONFIRM_REQUIRED");
    assert.equal(
      (await changedTarget.session.resume({ allow_irreversible: true })).status,
      "CONFIRM_REQUIRED",
    );
    assert.equal(changedTarget.seen.actions.length, 1);
  } finally {
    await gated.session.close();
    await changedTarget.session.close();
  }
});

test("M6a: submit input value is gated as irreversible", async () => {
  const submit = element("确认支付", "button", {
    tag: "input",
    inputType: "submit",
    identityName: "确认支付",
  });
  const caseUnderTest = fixture({
    observations: [observation([submit])],
    outcomes: [{ type: "act", action: action(submit) }],
  });
  try {
    const result = await caseUnderTest.session.run();
    assert.equal(result.status, "CONFIRM_REQUIRED");
    assert.equal(caseUnderTest.seen.actions.length, 0);
  } finally {
    await caseUnderTest.session.close();
  }
});

for (const approval of ["irreversible", "domain"] as const) {
  test(`${approval} approval retargets a fresh epoch and ref before executor pre-check`, async () => {
    const original =
      approval === "domain"
        ? element("Outside", "link", { href: "http://outside.test/result" })
        : element("Buy now");
    const refreshed = { ...original, ref: "e9" };
    let observations = 0;
    const fixtureCase = fixture({
      observe: async () => {
        observations++;
        if (observations === 1) return { ...observation([original]), epoch: observations };
        if (observations === 2) return { ...observation([refreshed]), epoch: observations };
        return {
          ...observation(
            [],
            "done",
            approval === "domain" ? "http://outside.test/result" : "http://example.test/done",
          ),
          epoch: observations,
          text: "Approved result",
        };
      },
      pageMatches: async () => observations >= 3,
      outcomes: [
        approval === "domain"
          ? { type: "act", action: action(original) }
          : {
              type: "handoff",
              reason: "confirm_required",
              source: "code",
              details: { matched: "buy", target: { page_name: "Buy now" } },
              pendingAction: action(original),
            },
      ],
      options: {
        success: { text_present: "Approved result" },
        ...(approval === "domain" ? { constraints: { allowed_domains: ["example.test"] } } : {}),
      },
    });
    try {
      assert.equal((await fixtureCase.session.run()).status, "CONFIRM_REQUIRED");
      assert.equal(fixtureCase.seen.actions.length, 0);
      const resumed =
        approval === "domain"
          ? await fixtureCase.session.resume({ allowed_domains: ["outside.test"] })
          : await fixtureCase.session.resume({ allow_irreversible: true });
      assert.equal(resumed.status, "DONE_VERIFIED");
      assert.equal(fixtureCase.seen.actions.length, 1);
      assert.deepEqual(fixtureCase.seen.actions[0], {
        kind: "click",
        target: { epoch: 2, ref: "e9", fingerprint: original.fingerprint },
      });
    } finally {
      await fixtureCase.session.close();
    }
  });
}

test("one-shot approval rejects changed identity or ambiguous matches after re-observation", async () => {
  for (const variation of ["fingerprint", "role", "name", "duplicate"] as const) {
    const original = element("Buy now");
    let observations = 0;
    const fixtureCase = fixture({
      observe: async () => {
        observations++;
        const candidates =
          variation === "duplicate"
            ? [
                { ...original, ref: "e9" },
                { ...original, ref: "e10" },
              ]
            : [
                {
                  ...original,
                  ref: "e9",
                  ...(variation === "fingerprint"
                    ? { fingerprint: "changed" }
                    : variation === "role"
                      ? { role: "link" }
                      : { name: "Different buy" }),
                },
              ];
        return {
          ...observation(observations === 1 ? [original] : candidates),
          epoch: observations,
        };
      },
      outcomes: [{ type: "act", action: action(original) }],
    });
    try {
      assert.equal((await fixtureCase.session.run()).status, "CONFIRM_REQUIRED");
      const result = await fixtureCase.session.resume({ allow_irreversible: true });
      assert.equal(result.status, "UNCERTAIN");
      if (variation !== "fingerprint") assert.match(result.question, /stored target changed/u);
      assert.equal(fixtureCase.seen.actions.length, variation === "fingerprint" ? 1 : 0);
    } finally {
      await fixtureCase.session.close();
    }
  }
});

test("auto-pass challenge clears and times out", async () => {
  const challenge: Finding = {
    kind: "challenge",
    level: "blocking",
    vendor: "Cloudflare",
    autoPassPlausible: true,
    evidence: [],
  };
  const clears = fixture({
    findings: [[challenge], []],
    outcomes: [{ type: "done_candidate", goalMet: 0.9 }],
    options: { thresholds: { goal_met_unchanged: 0.95 } },
  });
  const timeout = fixture({ findings: [[challenge]], options: { autoPassWindowMs: 2000 } });
  try {
    assert.equal((await clears.session.run()).status, "UNCERTAIN");
    assert.equal(clears.clock.now, 1000);
    const result = await timeout.session.run();
    assert.equal(result.status, "BLOCKED_BY_CHALLENGE");
    assert.match(result.question, /Cloudflare/u);
    assert.equal(timeout.clock.now, 2000);
  } finally {
    await clears.session.close();
    await timeout.session.close();
  }
});

test("login wall requires matching-origin secret", async () => {
  const login: Finding = { kind: "login_wall", level: "blocking", evidence: [] };
  const noSecret = fixture({ findings: [[login]] });
  const withSecret = fixture({
    findings: [[login]],
    options: {
      values: { password: { secret_ref: "env:TEST_PASSWORD", origins: ["http://example.test"] } },
      thresholds: { goal_met_unchanged: 0.95 },
    },
  });
  try {
    assert.equal((await noSecret.session.run()).status, "NEEDS_LOGIN");
    assert.equal((await withSecret.session.run()).status, "UNCERTAIN");
  } finally {
    await noSecret.session.close();
    await withSecret.session.close();
  }
});

test("off-list href is gated before click and redirect is gated after action", async () => {
  const link = element("External", "link", { href: "http://outside.test/page" });
  const before = fixture({
    observations: [observation([link])],
    outcomes: [{ type: "act", action: action(link) }],
    options: { constraints: { allowed_domains: ["example.test"] } },
  });
  const after = fixture({
    observations: [observation(), observation([], "redirect", "http://outside.test/page")],
    outcomes: [{ type: "act", action: action() }],
    options: { constraints: { allowed_domains: ["example.test"] } },
  });
  try {
    assert.equal((await before.session.run()).status, "CONFIRM_REQUIRED");
    assert.equal(before.seen.actions.length, 0);
    const result = await after.session.run();
    assert.equal(result.status, "CONFIRM_REQUIRED");
    assert.match(result.question, /outside\.test/u);
    assert.equal(after.seen.actions.length, 1);
  } finally {
    await before.session.close();
    await after.session.close();
  }
});

test("step, time, and token budgets", async () => {
  const steps = fixture({
    outcomes: [{ type: "act", action: action() }],
    options: { budget: { steps: 1 } },
  });
  const seconds = fixture({ clock: { now: 2000 }, options: { budget: { seconds: 0 } } });
  const tokens = fixture({ options: { budget: { decision_tokens: 3 } } });
  try {
    assert.equal((await steps.session.run()).status, "BUDGET_EXHAUSTED");
    assert.equal((await seconds.session.run()).status, "BUDGET_EXHAUSTED");
    assert.equal((await tokens.session.run()).status, "BUDGET_EXHAUSTED");
  } finally {
    await steps.session.close();
    await seconds.session.close();
    await tokens.session.close();
  }
});

test("decision errors fail without action", async () => {
  for (const name of [
    "ContextLimitError",
    "DecisionTransportError",
    "CircuitOpenError",
    "InvalidAnswerError",
  ]) {
    const failure = fixture({
      decide: async () => {
        const error = new Error("sensitive provider detail");
        error.name = name;
        throw error;
      },
    });
    try {
      const result = await failure.session.run();
      assert.equal(result.status, "FAILED");
      assert.doesNotMatch(JSON.stringify(result), /sensitive provider detail/u);
      assert.equal(failure.seen.actions.length, 0);
    } finally {
      await failure.session.close();
    }
  }
});

test("M6l: a decision timeout hands the page to the agent with a snapshot", async () => {
  let samples = 0;
  const instance = fixture({
    observe: async () =>
      ++samples === 1
        ? observation([element("Old")])
        : observation([element("Current")], "current", "http://example.test/current"),
    decide: async () => {
      instance.page.emit("navigated", { url: "http://example.test/current" });
      throw new DecisionTimeoutError("private provider message");
    },
  });
  try {
    const result = await instance.session.run();
    assert.equal(result.status, "UNCERTAIN");
    assert.equal(result.reason, "decision_transport_error");
    assert.match(result.question, /timed out.*browser_act.*browser_resume/u);
    assert.match(result.snapshot, /Current/u);
    assert.doesNotMatch(result.snapshot, /Old/u);
    assert.equal(result.url, "http://example.test/current");
    assert.equal(samples, 2);
    assert.equal(instance.seen.actions.length, 0);
  } finally {
    await instance.session.close();
  }
});

test("M6l: retryable transport, circuit, context-limit and invalid-answer failures hand off as UNCERTAIN", async () => {
  const cases = [
    [new DecisionTransportError("private", 429, true), "decision_transport_error", /unavailable/u],
    [new CircuitOpenError("private"), "decision_circuit_open", /unavailable/u],
    [new ContextLimitError("private"), "decision_context_limit", /too large/u],
    [new InvalidAnswerError(["op: missing"]), "decision_invalid_answer", /invalid answer/u],
  ] as const;
  for (const [error, reason, wording] of cases) {
    const instance = fixture({
      decide: async () => {
        throw error;
      },
    });
    try {
      const result = await instance.session.run();
      assert.equal(result.status, "UNCERTAIN");
      assert.equal(result.reason, reason);
      assert.match(result.question, wording);
      assert.ok(result.snapshot.length > 0);
      assert.equal(instance.seen.actions.length, 0);
    } finally {
      await instance.session.close();
    }
  }
  let calls = 0;
  const check = fixture({
    interpret: () => ({
      type: "check",
      question: "click_target",
      candidates: [
        {
          id: "check_1",
          key: "e1",
          probability: 0.55,
          statement: "First",
          overrides: { click_target: "e1" },
        },
      ],
    }),
    decide: async () => {
      if (++calls === 1) return decision;
      throw new CircuitOpenError("private");
    },
  });
  try {
    const result = await check.session.run();
    assert.equal(result.status, "UNCERTAIN");
    assert.equal(result.reason, "decision_circuit_open");
    assert.equal(calls, 2);
    assert.equal(check.seen.actions.length, 0);
  } finally {
    await check.session.close();
  }
  const invalid = fixture({
    buildDecisionState: () => ({
      state: {},
      questions: { op: { type: "noul", instructions: "Check" } },
      reductions: [],
    }),
  });
  try {
    const result = await invalid.session.run();
    assert.equal(result.status, "UNCERTAIN");
    assert.equal(result.reason, "decision_invalid_answer");
    assert.ok(result.details?.includes("op: missing"));
  } finally {
    await invalid.session.close();
  }
  const invalidCheck = fixture({
    interpret: () => ({
      type: "check",
      question: "click_target",
      candidates: [
        {
          id: "check_1",
          key: "e1",
          probability: 0.55,
          statement: "First",
          overrides: { click_target: "e1" },
        },
      ],
    }),
  });
  try {
    const result = await invalidCheck.session.run();
    assert.equal(result.status, "UNCERTAIN");
    assert.equal(result.reason, "decision_invalid_answer");
    assert.ok(result.details?.includes("check_1: missing"));
  } finally {
    await invalidCheck.session.close();
  }
});

test("M6l: configuration, request and non-retryable transport failures still end FAILED", async () => {
  for (const error of [
    new DecisionConfigError("private"),
    new DecisionRequestError("private"),
    new DecisionTransportError("private", 401, false),
  ]) {
    const instance = fixture({
      decide: async () => {
        throw error;
      },
    });
    try {
      const result = await instance.session.run();
      assert.equal(result.status, "FAILED");
      assert.equal(result.reason, "decision_transport_error");
      assert.equal(instance.seen.actions.length, 0);
    } finally {
      await instance.session.close();
    }
  }
});

test("M6l: browser_resume after a decision handoff asks Jev again", async () => {
  let calls = 0;
  const instance = fixture({
    decide: async () => {
      if (++calls === 1) throw new DecisionTimeoutError("private");
      return decision;
    },
  });
  try {
    assert.equal((await instance.session.run()).status, "UNCERTAIN");
    const resumed = await instance.session.resume();
    assert.equal(calls, 2);
    assert.equal(resumed.status, "DONE_UNVERIFIED");
  } finally {
    await instance.session.close();
  }
});

test("secret origin mismatch and resolution failure hand off without leaking", async () => {
  const password = element("Password", "textbox", { tag: "input", inputType: "password" });
  const marker = "UNIQUE_SECRET_MARKER_92";
  const previousSecret = process.env.JEVPILOT_SECRET_TEST;
  process.env.JEVPILOT_SECRET_TEST = marker;
  const typed: PolicyOutcome = {
    type: "act",
    action: {
      kind: "type",
      target: { epoch: 1, ref: "e1", fingerprint: "same" },
      valueKey: "password",
    },
  };
  const mismatch = fixture({
    observations: [observation([password])],
    outcomes: [typed],
    options: {
      values: {
        password: { secret_ref: "env:JEVPILOT_SECRET_TEST", origins: ["http://elsewhere.test"] },
      },
    },
  });
  const unresolved = fixture({
    observations: [observation([password])],
    outcomes: [typed],
    options: {
      values: {
        password: {
          secret_ref: "env:JEVPILOT_SECRET_MISSING_901",
          origins: ["http://example.test"],
        },
      },
    },
  });
  const resolved = fixture({
    observations: [observation([password]), observation([password], "changed")],
    outcomes: [typed],
    options: {
      values: {
        password: { secret_ref: "env:JEVPILOT_SECRET_TEST", origins: ["http://example.test"] },
      },
      budget: { steps: 1 },
    },
    execute: (_action, values) => {
      assert.equal(values.password, marker);
      return changed();
    },
  });
  const manual = fixture({
    observations: [observation([password]), observation([password], "changed")],
    options: {
      values: {
        password: { secret_ref: "env:JEVPILOT_SECRET_TEST", origins: ["http://example.test"] },
      },
      budget: { steps: 1 },
    },
    execute: (_action, values) => {
      assert.equal(values.password, marker);
      return changed();
    },
  });
  const promptDialog = { kind: "prompt" as const, message: "Secret prompt", defaultPrompt: "" };
  const prompt = fixture({
    outcomes: [{ type: "act", action: action() }],
    options: {
      values: {
        password: { secret_ref: "env:JEVPILOT_SECRET_TEST", origins: ["http://example.test"] },
      },
    },
    execute: () => ({ ...changed(), outcome: "dialog-opened", dialog: promptDialog }),
  });
  prompt.page.handleDialog = async (_accept, text) => {
    assert.equal(text, marker);
  };
  const logs: string[] = [];
  const oldLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  try {
    const first = await mismatch.session.run();
    const missing = await unresolved.session.run();
    const second = await resolved.session.run();
    const acted = await manual.session.act([{ action: "type", ref: "e1", value_key: "password" }]);
    const promptHandoff = await prompt.session.run();
    const dialogActed = await prompt.session.act([
      { action: "dialog", accept: true, value_key: "password" },
    ]);
    assert.equal(first.status, "NEEDS_VALUES");
    assert.equal(missing.status, "NEEDS_VALUES");
    assert.equal(second.status, "BUDGET_EXHAUSTED");
    assert.equal(acted.status, "BUDGET_EXHAUSTED");
    assert.equal(promptHandoff.status, "NEEDS_VALUES");
    assert.equal(dialogActed.status, "RUNNING");
    assert.doesNotMatch(
      JSON.stringify({
        first,
        missing,
        second,
        acted,
        promptHandoff,
        dialogActed,
        trace: [resolved.session.trace, manual.session.trace, prompt.session.trace],
        logs,
      }),
      /UNIQUE_SECRET_MARKER_92|JEVPILOT_SECRET_MISSING_901/u,
    );
  } finally {
    console.log = oldLog;
    if (previousSecret === undefined) delete process.env.JEVPILOT_SECRET_TEST;
    else process.env.JEVPILOT_SECRET_TEST = previousSecret;
    await mismatch.session.close();
    await unresolved.session.close();
    await resolved.session.close();
    await manual.session.close();
    await prompt.session.close();
  }
});

test("idle reclaim closes page and deletes session temp directory", async () => {
  const clock = { now: 0 };
  const directory = await mkdtemp(join(tmpdir(), "jevpilot-orchestrator-test-"));
  const { session, page } = fixture({ clock, options: { idleTimeoutMs: 10 } });
  let closed = false;
  page.close = async () => {
    closed = true;
  };
  try {
    // Force a handoff screenshot into the injected directory.
    const source = new OrchestratorSession(
      { page, goal: "finish", idleTimeoutMs: 10 },
      {
        observe: async () => observation(),
        detect: () => [],
        buildDecisionState: () => ({ state: {}, questions: {}, reductions: [] }),
        decide: async () => decision,
        interpret: () => ({ type: "handoff", reason: "uncertain", source: "code", details: {} }),
        now: () => clock.now,
        tempDir: async () => directory,
      },
    );
    await source.run();
    clock.now = 11;
    assert.equal(await source.reclaimIdle(), true);
    assert.equal(existsSync(directory), false);
    assert.equal(closed, true);
  } finally {
    await session.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual act executes through the gate without deciding", async () => {
  const safe = fixture({
    decide: async () => {
      throw new Error("decision must not run");
    },
    observations: [observation(), observation([], "after")],
  });
  const guarded = fixture({
    decide: async () => {
      throw new Error("decision must not run");
    },
    observations: [observation([element("Buy now")])],
  });
  try {
    assert.equal((await safe.session.act([{ action: "click", ref: "e1" }])).status, "RUNNING");
    assert.equal(safe.seen.actions.length, 1);
    assert.equal(
      (await guarded.session.act([{ action: "click", ref: "e1" }])).status,
      "CONFIRM_REQUIRED",
    );
    assert.equal(guarded.seen.actions.length, 0);
  } finally {
    await safe.session.close();
    await guarded.session.close();
  }
});

test("M6d: manual type with a consumed value key types it again", async () => {
  const field = element("Search", "textbox", { tag: "input", inputType: "text" });
  const instance = fixture({
    observations: [observation([field])],
    options: { values: { query: "paper" } },
    execute: () => ({
      ...changed(),
      changes: { url: false, pageHash: false, value: true, checked: false },
    }),
  });
  try {
    assert.equal(
      (await instance.session.act([{ action: "type", ref: "e1", value_key: "query" }])).status,
      "RUNNING",
    );
    assert.equal(
      (await instance.session.act([{ action: "type", ref: "e1", value_key: "query" }])).status,
      "RUNNING",
    );
    assert.equal(instance.seen.actions.length, 2);
    assert.deepEqual(instance.seen.values, [{ query: "paper" }, { query: "paper" }]);
  } finally {
    await instance.session.close();
  }
});

test("M6d: value keys match case- and space-insensitively and unknown keys hand off with the provided keys", async () => {
  const field = element("Search", "textbox", { tag: "input", inputType: "text" });
  const instance = fixture({
    observations: [observation([field])],
    options: { values: { "Search term": "paper" } },
  });
  try {
    assert.equal(
      (await instance.session.act([{ action: "type", ref: "e1", value_key: "searchterm" }])).status,
      "RUNNING",
    );
    assert.deepEqual(instance.seen.values[0], { searchterm: "paper" });
    const unknown = await instance.session.act([
      { action: "type", ref: "e1", value_key: "missing" },
    ]);
    assert.equal(unknown.status, "UNCERTAIN");
    assert.match(unknown.question, /missing.*Search term/u);
    assert.equal(instance.seen.actions.length, 1);
  } finally {
    await instance.session.close();
  }
});

test("M6d: success assertions are re-checked after manual ops and navigation", async () => {
  const ready = { ...observation(), text: "Ready" };
  const manual = fixture({
    observations: [observation(), ready],
    options: { success: { text_present: "Ready" } },
  });
  const navigated = fixture({
    observations: [observation(), ready],
    options: { success: { text_present: "Ready" } },
  });
  try {
    await navigated.session.observe();
    assert.equal(
      (await manual.session.act([{ action: "wait_for", delay_ms: 10 }])).status,
      "DONE_VERIFIED",
    );
    assert.equal(
      (await navigated.session.navigate("http://example.test/ready")).status,
      "DONE_VERIFIED",
    );
  } finally {
    await manual.session.close();
    await navigated.session.close();
  }
});

test("M6e: success assertions that already hold on the start page do not verify completion", async () => {
  const instance = fixture({
    observations: [{ ...observation(), text: "BMI calculator" }],
    options: { success: { text_present: "BMI" } },
  });
  try {
    const result = await instance.session.run();
    assert.equal(result.status, "DONE_UNVERIFIED");
    assert.deepEqual(result.details, [
      "success assertions already held on the start page and were ignored",
    ]);
    assert.equal((await instance.session.run()).status, "DONE_UNVERIFIED");
  } finally {
    await instance.session.close();
  }
});

test("M6f: typed text still in its field on the same page does not satisfy text_present", async () => {
  const field = element("Query", "input", { tag: "input", inputType: "search" });
  const passed: string[][] = [];
  const instance = fixture({
    observations: [
      observation([field], "start", "http://example.test/search"),
      observation([field], "start", "http://example.test/search"),
      {
        ...observation([field], "typed", "http://example.test/search"),
        text: "paper suggestion",
      },
    ],
    options: { values: { query: "paper" }, success: { text_present: "paper" } },
    execute: () => ({ ...changed(), changes: { ...changed().changes, value: true } }),
    pageMatches: async (_page, _assertions, pending) => {
      passed.push(pending ?? []);
      return passed.length > 1 && !(pending ?? []).includes("paper");
    },
  });
  try {
    await instance.session.observe();
    await instance.session.act([{ action: "type", ref: "e1", value_key: "query" }]);
    assert.equal((await instance.session.observe()).status, "RUNNING");
    assert.deepEqual(passed.at(-1), ["paper"]);
  } finally {
    await instance.session.close();
  }
});

test("M6f: typed text counts again after the URL changes or the field is cleared", async () => {
  const field = element("Query", "input", { tag: "input", inputType: "search" });
  let pending: string[] = [];
  let cleared = false;
  let checked = 0;
  const instance = fixture({
    observations: [
      observation([field]),
      observation([field]),
      { ...observation([field], "typed"), text: "paper suggestion" },
      { ...observation([field], "typed"), text: "paper suggestion" },
      { ...observation([field], "results", "http://example.test/results"), text: "paper results" },
    ],
    options: { values: { query: "paper" }, success: { text_present: "paper" } },
    execute: () => ({ ...changed(), changes: { ...changed().changes, value: true } }),
    pageMatches: async (_page, _assertions, texts) => {
      pending = texts ?? [];
      checked++;
      return checked > 1 && (cleared || (texts ?? []).length === 0);
    },
  });
  try {
    await instance.session.observe();
    await instance.session.act([{ action: "type", ref: "e1", value_key: "query" }]);
    assert.equal((await instance.session.observe()).status, "RUNNING");
    assert.deepEqual(pending, ["paper"]);
    cleared = true;
    assert.equal((await instance.session.observe()).status, "DONE_VERIFIED");
    cleared = false;
    assert.equal((await instance.session.observe()).status, "DONE_VERIFIED");
    assert.deepEqual(pending, []);
  } finally {
    await instance.session.close();
  }
});

test("M6f: press_key accepts key as an alias of name", async () => {
  const instance = fixture();
  try {
    await instance.session.act([{ action: "press_key", key: "Enter" }]);
    assert.deepEqual(instance.seen.actions.at(-1), { kind: "key", name: "Enter" });
  } finally {
    await instance.session.close();
  }
});

test("M6f: invalid manual ops name the fields they need", async () => {
  const instance = fixture();
  try {
    for (const [op, expected] of [
      [{ action: "press_key" }, /press_key needs name/u],
      [{ action: "type" }, /type needs ref and text or value_key/u],
      [{ action: "select" }, /select needs ref and option_label/u],
      [{ action: "scroll" }, /scroll needs direction \(up or down\)/u],
    ] as const) {
      const result = await instance.session.act([op]);
      assert.match(result.question, expected);
    }
  } finally {
    await instance.session.close();
  }
});

test("M6e: manual ops and observe ignore assertions that held at session start", async () => {
  const instance = fixture({
    observations: [{ ...observation(), text: "BMI calculator" }],
    options: { success: { text_present: "BMI" } },
  });
  try {
    const first = await instance.session.observe();
    assert.equal(first.status, "RUNNING");
    assert.equal(
      (await instance.session.act([{ action: "wait_for", delay_ms: 1 }])).status,
      "RUNNING",
    );
    assert.equal((await instance.session.observe()).status, "RUNNING");
  } finally {
    await instance.session.close();
  }
});

test("M6e: a stale frame that persists hands off as UNCERTAIN, not FAILED", async () => {
  const instance = fixture({
    observe: async () => {
      throw new CdpProtocolError(
        -32602,
        "frame with given id was not found",
        "Page.createIsolatedWorld",
      );
    },
    options: { navigationTimeoutMs: 150 },
  });
  try {
    const result = await instance.session.run();
    assert.equal(result.status, "UNCERTAIN");
    assert.match(result.question, /page kept changing; current URL:/u);
    assert.equal(result.timing.total, 150);
  } finally {
    await instance.session.close();
  }
});

test("M6h: stale-frame errors never end navigate, observe, run or act as FAILED", async () => {
  for (const method of ["navigate", "observe", "run", "act"] as const) {
    const instance = fixture({
      observe: async () => {
        throw new CdpProtocolError(-32602, "Invalid frame id", "Page.createIsolatedWorld");
      },
      options: { navigationTimeoutMs: 100 },
    });
    if (method === "navigate")
      instance.page.navigate = async () => {
        throw new CdpProtocolError(-32602, "Invalid frame id", "Page.createIsolatedWorld");
      };
    try {
      const result =
        method === "navigate"
          ? await instance.session.navigate("http://example.test/next")
          : method === "act"
            ? await instance.session.act([{ action: "press_key", key: "Enter" }])
            : await instance.session[method]();
      assert.equal(result.status, "UNCERTAIN", method);
      assert.match(result.question, /page kept changing; current URL:/u);
    } finally {
      await instance.session.close();
    }
  }
});

test("M6h: a page call timeout hands off as not responding without a screenshot", async () => {
  const secret = "PRIVATE_PAGE_TIMEOUT_SECRET";
  const instance = fixture({
    observe: async () => {
      throw new PageUnresponsiveError();
    },
    options: { values: { password: secret } },
  });
  let screenshots = 0;
  instance.page.screenshot = async () => {
    screenshots++;
    return new Uint8Array();
  };
  try {
    const result = await instance.session.observe();
    assert.equal(result.status, "UNCERTAIN");
    assert.match(result.question, /page is not responding.*browser_navigate.*browser_close/u);
    assert.equal(result.screenshot_path, undefined);
    assert.equal(screenshots, 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PAGE_TIMEOUT_SECRET/u);
  } finally {
    await instance.session.close();
  }
});

test("M6h: later calls on an unresponsive page answer after one quick liveness check", async () => {
  let observations = 0;
  const instance = fixture({
    observe: async () => {
      observations++;
      throw new PageUnresponsiveError();
    },
  });
  let checks = 0;
  instance.page.callIsolated = async (_fn, _args, options) => {
    assert.equal(options?.timeoutMs, 2000);
    checks++;
    throw new PageUnresponsiveError();
  };
  try {
    assert.equal((await instance.session.observe()).status, "UNCERTAIN");
    assert.equal(
      (await instance.session.act([{ action: "press_key", key: "Enter" }])).status,
      "UNCERTAIN",
    );
    assert.equal(observations, 1);
    assert.equal(checks, 1);
  } finally {
    await instance.session.close();
  }
});

test("M6h: a page that answers again is used normally without further liveness checks", async () => {
  let observations = 0;
  const instance = fixture({
    observe: async () => {
      observations++;
      if (observations === 1) throw new PageUnresponsiveError();
      return observation();
    },
  });
  let checks = 0;
  instance.page.callIsolated = async () => {
    checks++;
    return true as never;
  };
  try {
    assert.equal((await instance.session.observe()).status, "UNCERTAIN");
    assert.equal((await instance.session.observe()).status, "RUNNING");
    assert.equal((await instance.session.observe()).status, "RUNNING");
    assert.equal(checks, 1);
  } finally {
    await instance.session.close();
  }
});

test("M6k: an unresponsive page is reopened once in an isolated context with cookies copied", async () => {
  const replacement = new FakePageHandle();
  replacement.callIsolated = async () => true as never;
  let opens = 0;
  const instance = fixture({
    options: {
      navigation: { url: "https://example.com/page", headers: {} },
      openIsolatedPage: async (copyCookies) => {
        assert.equal(copyCookies, true);
        opens++;
        return replacement;
      },
    },
    observe: async (page) => {
      if (page !== replacement) throw new PageUnresponsiveError();
      return observation();
    },
  });
  Object.defineProperty(instance.page, "capabilities", {
    value: { ...instance.page.capabilities, isolatedContexts: true },
  });
  try {
    const result = await instance.session.act([
      { action: "press_key", key: "Enter" },
      { action: "press_key", key: "Tab" },
    ]);
    assert.equal(result.status, "RUNNING");
    assert.equal(instance.session.page, replacement);
    assert.equal(opens, 1);
    assert.match(result.details?.join(" ") ?? "", /cookies copied, site storage not/u);
    assert.match(result.details?.join(" ") ?? "", /remaining ops were not run/u);
    await instance.session.observe();
    assert.equal(opens, 1);
  } finally {
    await instance.session.close();
  }
});

test("M6k: the isolated-reopen note appears only in the tool call that reopened the page", async () => {
  const replacement = new FakePageHandle();
  replacement.callIsolated = async () => true as never;
  const instance = fixture({
    options: {
      navigation: { url: "https://example.com/page", headers: {} },
      openIsolatedPage: async () => replacement,
    },
    observe: async (page) => {
      if (page !== replacement) throw new PageUnresponsiveError();
      return observation();
    },
  });
  Object.defineProperty(instance.page, "capabilities", {
    value: { ...instance.page.capabilities, isolatedContexts: true },
  });
  try {
    const reopened = await instance.session.observe();
    assert.match(reopened.details?.join(" ") ?? "", /reopened in an isolated context/u);
    const later = await instance.session.observe();
    assert.doesNotMatch(later.details?.join(" ") ?? "", /reopened in an isolated context/u);
  } finally {
    await instance.session.close();
  }
});

test("M6k: a reopened page that also stops responding hands off as not responding", async () => {
  const replacement = new FakePageHandle();
  replacement.callIsolated = async () => {
    throw new PageUnresponsiveError();
  };
  let opens = 0;
  const instance = fixture({
    options: {
      navigation: { url: "https://example.com/page", headers: {} },
      openIsolatedPage: async () => {
        opens++;
        return replacement;
      },
    },
    observe: async () => {
      throw new PageUnresponsiveError();
    },
  });
  Object.defineProperty(instance.page, "capabilities", {
    value: { ...instance.page.capabilities, isolatedContexts: true },
  });
  try {
    assert.equal((await instance.session.observe()).status, "UNCERTAIN");
    assert.equal((await instance.session.observe()).status, "UNCERTAIN");
    assert.equal(opens, 1);
  } finally {
    await instance.session.close();
  }
});

test("M6k: navigate while unresponsive opens the target in a new isolated page", async () => {
  const replacements: FakePageHandle[] = [];
  const instance = fixture({
    options: {
      navigation: { url: "https://example.com/old", headers: {} },
      openIsolatedPage: async (copyCookies) => {
        assert.equal(copyCookies, true);
        const page = new FakePageHandle();
        page.callIsolated = async () => true as never;
        replacements.push(page);
        return page;
      },
    },
    observe: async () => observation(),
  });
  Object.defineProperty(instance.page, "capabilities", {
    value: { ...instance.page.capabilities, isolatedContexts: true },
  });
  try {
    (instance.session as unknown as { pageUnresponsive: boolean }).pageUnresponsive = true;
    const result = await instance.session.navigate("https://example.com/new");
    assert.equal(result.status, "RUNNING");
    assert.equal(instance.session.page, replacements[0]);
    assert.equal(replacements.length, 1);
  } finally {
    await instance.session.close();
  }
});

test("M6h: a navigation timeout on a responsive page continues instead of reporting not responding", async () => {
  const button = element("Continue", "button");
  const slow = fixture({
    observations: [observation([button], "slow", "http://example.test/slow")],
  });
  slow.page.navigate = async (url: string) => ({
    url,
    status: 200,
    headers: {},
    failure: "timeout",
  });
  slow.page.callIsolated = async () => true as never;
  const stuck = fixture({ observations: [observation([button])] });
  stuck.page.navigate = async (url: string) => ({
    url,
    status: 200,
    headers: {},
    failure: "timeout",
  });
  stuck.page.callIsolated = async () => {
    throw new PageUnresponsiveError();
  };
  try {
    assert.equal((await slow.session.navigate("http://example.test/slow")).status, "RUNNING");
    const result = await stuck.session.navigate("http://example.test/slow");
    assert.equal(result.status, "UNCERTAIN");
    assert.match(result.question, /page is not responding/u);
  } finally {
    await slow.session.close();
    await stuck.session.close();
  }
});

test("success assertions never verify on an HTTP error document", async () => {
  const instance = fixture({
    observations: [
      observation([element("Search", "button")], "start", "http://example.test/start"),
      observation([element("Retry", "button")], "limited", "http://example.test/@/player"),
    ],
    options: { success: { url_matches: "/@/player$" } },
  });
  instance.page.navigate = async (url: string) => ({ url, status: 429, headers: {} });
  try {
    await instance.session.observe();
    assert.equal(
      (await instance.session.navigate("http://example.test/@/player")).status,
      "ERROR_PAGE",
    );
    const waited = await instance.session.act([{ action: "wait" }]);
    assert.notEqual(waited.status, "DONE_VERIFIED");
    assert.notEqual((await instance.session.observe()).status, "DONE_VERIFIED");
  } finally {
    await instance.session.close();
  }
});

test("M6p: success assertions never verify on a challenge, login wall or error page whose URL matches", async () => {
  const pages: Finding[] = [
    { kind: "login_wall", level: "blocking", evidence: ["password field"] },
    {
      kind: "challenge",
      level: "blocking",
      evidence: ["turnstile"],
      vendor: "cloudflare",
      autoPassPlausible: false,
    },
    { kind: "error_page", level: "blocking", evidence: ["not found text"] },
  ];
  for (const blocker of pages) {
    const instance = fixture({
      observations: [
        observation([element("Search", "button")], "start", "http://example.test/start"),
        observation(
          [element("Password", "textbox")],
          "blocked",
          "http://login.example.test/login?service=http%3A%2F%2Fexample.test%2Fsearch%2Fwangjing",
        ),
      ],
      findings: [[], [blocker]],
      options: { success: { url_matches: "wangjing" } },
    });
    try {
      await instance.session.observe();
      const navigated = await instance.session.navigate("http://example.test/search/wangjing");
      assert.notEqual(navigated.status, "DONE_VERIFIED", blocker.kind);
      assert.notEqual((await instance.session.observe()).status, "DONE_VERIFIED", blocker.kind);
    } finally {
      await instance.session.close();
    }
  }
});

test("M6p: a login page still verifies when the agent supplied credentials for its origin", async () => {
  const loginWall: Finding = {
    kind: "login_wall",
    level: "blocking",
    evidence: ["password field"],
  };
  const instance = fixture({
    observations: [
      observation([element("Search", "button")], "start", "http://example.test/start"),
      observation([element("Password", "textbox")], "signed", "http://example.test/login?done=1"),
    ],
    findings: [[], [loginWall]],
    options: {
      success: { url_matches: "done=1" },
      values: {
        password: { secret_ref: "env:JEVPILOT_SECRET_M6P", origins: ["http://example.test"] },
      },
    },
  });
  try {
    await instance.session.observe();
    assert.equal(
      (await instance.session.navigate("http://example.test/login?done=1")).status,
      "DONE_VERIFIED",
    );
  } finally {
    await instance.session.close();
  }
});

test("M6p: a challenge first page does not count as the start page for already-true assertions", async () => {
  const challenge: Finding = {
    kind: "challenge",
    level: "blocking",
    evidence: ["turnstile"],
    vendor: "cloudflare",
    autoPassPlausible: false,
  };
  const instance = fixture({
    observations: [
      observation(
        [element("Verify", "button")],
        "challenge",
        "http://example.test/check?next=%2Fresult",
      ),
      observation([element("Search", "button")], "home", "http://example.test/home"),
      observation([element("Result", "link")], "result", "http://example.test/result"),
    ],
    findings: [[challenge], []],
    options: { success: { url_matches: "result" } },
  });
  try {
    assert.notEqual((await instance.session.observe()).status, "DONE_VERIFIED");
    assert.equal((await instance.session.observe()).status, "RUNNING");
    assert.equal(
      (await instance.session.navigate("http://example.test/result")).status,
      "DONE_VERIFIED",
    );
  } finally {
    await instance.session.close();
  }
});

test("navigation error pages report the URL they landed on, not the previous page", async () => {
  const instance = fixture({
    observations: [
      observation([element("Search", "button")], "start", "http://example.test/start"),
    ],
  });
  instance.page.navigate = async () => ({
    url: "http://example.test/login",
    status: 429,
    headers: {},
  });
  try {
    await instance.session.observe();
    const result = await instance.session.navigate("http://example.test/search?q=express");
    assert.equal(result.status, "ERROR_PAGE");
    assert.equal(result.url, "http://example.test/login");
    assert.equal(result.snapshot, "");
  } finally {
    await instance.session.close();
  }
});

test("M6h: a main-frame node or context error is handled as a stale frame, not FAILED", async () => {
  const instance = fixture({
    observe: async () => {
      throw new CdpProtocolError(-32000, "No node with given id found", "DOM.resolveNode");
    },
    options: { navigationTimeoutMs: 100 },
  });
  try {
    const result = await instance.session.observe();
    assert.equal(result.status, "UNCERTAIN");
    assert.match(result.question, /page kept changing/u);
  } finally {
    await instance.session.close();
  }
});

test("M6e: navigation time is counted as browser time", async () => {
  const initial = fixture({
    options: { navigation: { url: "http://example.test/start", headers: {} }, navigationMs: 83 },
  });
  const later = fixture();
  later.page.navigate = async (url: string) => {
    later.clock.now += 47;
    return { url, status: 200, headers: {} };
  };
  try {
    assert.equal((await initial.session.run()).timing.browser, 83);
    assert.equal((await later.session.navigate("http://example.test/next")).timing.browser, 47);
  } finally {
    await initial.session.close();
    await later.session.close();
  }
});

test("M6d: op-choice UNCERTAIN question text names each candidate's target", async () => {
  const instance = fixture({
    interpret: () => ({
      type: "handoff",
      reason: "uncertain",
      source: "code",
      details: {
        question: "op",
        candidates: [
          {
            key: "CLICK",
            probability: 0.41,
            target: { ref: "e1", role: "button", name: "Search", covered: true },
          },
          { key: "WAIT", probability: 0.3 },
        ],
      },
    }),
  });
  try {
    const result = await instance.session.run();
    assert.equal(result.status, "UNCERTAIN");
    assert.match(result.question ?? "", /CLICK via e1 button "Search" \(0\.41, covered\)/u);
    assert.match(result.question ?? "", /WAIT \(0\.30\)/u);
  } finally {
    await instance.session.close();
  }
});

test("M6d: observation after a load timeout reports RUNNING once the page has content", async () => {
  const instance = fixture({
    observations: [observation()],
    options: { navigation: { url: "http://example.test/slow", headers: {}, failure: "timeout" } },
    // Like the real detectors: a navigation failure still on record yields a blocking error page.
    detect: (input) =>
      input.navigation?.failure
        ? [
            {
              kind: "error_page",
              level: "blocking",
              evidence: [`navigation failure: ${input.navigation.failure}`],
            },
          ]
        : [],
  });
  try {
    assert.equal((await instance.session.run()).status, "ERROR_PAGE");
    assert.equal((await instance.session.observe()).status, "RUNNING");
  } finally {
    await instance.session.close();
  }
});

test("M6d: later observation clears a stale ERROR_PAGE status", async () => {
  const instance = fixture({
    observations: [observation()],
    options: {
      navigation: { url: "http://example.test/slow", headers: {}, failure: "timeout" },
      success: { text_present: "fixture text" },
    },
  });
  try {
    assert.equal((await instance.session.run()).status, "ERROR_PAGE");
    // The stale ERROR_PAGE is gone. Since M6e the assertion is not evidence here: this observation is the
    // session's start page and nothing has been done yet, so the status is RUNNING, not DONE_VERIFIED.
    assert.equal((await instance.session.observe()).status, "RUNNING");
  } finally {
    await instance.session.close();
  }
});

test("M5a manual input operations support literal submit, press_key, hover, drag, wait_for and upload", async () => {
  const uploadRoot = await mkdtemp(join(tmpdir(), "jevpilot-upload-"));
  const uploadFile = join(uploadRoot, "fixture.txt");
  await writeFile(uploadFile, "upload");
  const previousUploadDirectory = process.env.JEVPILOT_UPLOAD_DIR;
  process.env.JEVPILOT_UPLOAD_DIR = uploadRoot;
  const text = element("Name", "textbox", { inputType: "text" });
  const file = element("Attachment", "textbox", { inputType: "file", ref: "e2" });
  const destination = element("Drop", "button", { ref: "e3" });
  const clock = { now: 0 };
  const fixtureCase = fixture({
    clock,
    observations: [observation([text, file, destination])],
  });
  try {
    const result = await fixtureCase.session.act([
      { action: "type", ref: "e1", text: "literal", submit: true },
      { action: "press_key", name: "Tab" },
      { action: "hover", ref: "e1" },
      { action: "drag", ref: "e1", to_ref: "e3" },
      { action: "upload", ref: "e2", paths: [uploadFile] },
      { action: "wait_for", delay_ms: 25 },
    ]);
    assert.equal(result.status, "RUNNING");
    assert.deepEqual(
      fixtureCase.seen.actions.map((item) => item.kind),
      ["type", "key"],
    );
    assert.equal(fixtureCase.seen.actions[0]?.kind, "type");
    if (fixtureCase.seen.actions[0]?.kind === "type") {
      assert.equal(fixtureCase.seen.actions[0].text, "literal");
      assert.equal(fixtureCase.seen.actions[0].submit, true);
    }
    assert.equal(
      fixtureCase.page.calls.some((call) => call.name === "hover"),
      true,
    );
    assert.equal(
      fixtureCase.page.calls.some((call) => call.name === "drag"),
      true,
    );
    assert.equal(
      fixtureCase.page.calls.some((call) => call.name === "setInputFiles"),
      true,
    );
    assert.equal(clock.now, 25);
  } finally {
    if (previousUploadDirectory === undefined) delete process.env.JEVPILOT_UPLOAD_DIR;
    else process.env.JEVPILOT_UPLOAD_DIR = previousUploadDirectory;
    await fixtureCase.session.close();
    await rm(uploadRoot, { recursive: true, force: true });
  }
});

test("M5a refuses literal text for password inputs and checks navigation allowlists", async () => {
  const password = element("Password", "textbox", { inputType: "password" });
  const guarded = fixture({
    observations: [observation([password])],
    options: { constraints: { allowed_domains: ["example.test"] } },
  });
  try {
    assert.equal(
      (await guarded.session.act([{ action: "type", ref: "e1", text: "secret" }])).status,
      "NEEDS_VALUES",
    );
    assert.equal(
      (await guarded.session.navigate("https://outside.test/" as string)).status,
      "CONFIRM_REQUIRED",
    );
  } finally {
    await guarded.session.close();
  }
});

test("observe returns a snapshot without deciding or acting", async () => {
  const { session, seen } = fixture({
    decide: async () => {
      throw new Error("decision must not run");
    },
  });
  try {
    const result = await session.observe("full");
    assert.equal(result.status, "RUNNING");
    assert.match(result.snapshot, /fixture text/u);
    assert.equal(seen.actions.length, 0);
  } finally {
    await session.close();
  }
});

test("policy confirmation question names its target and matched term", async () => {
  const { session } = fixture({
    outcomes: [
      {
        type: "handoff",
        reason: "confirm_required",
        source: "code",
        details: { matched: "buy", target: { ref: "e1", role: "button", page_name: "Buy now" } },
      },
    ],
  });
  try {
    assert.match((await session.run()).question, /Buy now.*buy/u);
  } finally {
    await session.close();
  }
});

test("confirm dialog resume accepts once and clears the blocker", async () => {
  const dialog = { kind: "confirm" as const, message: "Proceed?", defaultPrompt: "" };
  const { session, page, seen } = fixture({
    outcomes: [
      { type: "act", action: action() },
      { type: "handoff", reason: "info_not_on_page", source: "code", details: {} },
    ],
    execute: () => ({ ...changed(), outcome: "dialog-opened", dialog }),
  });
  const answers: { accept: boolean; text?: string }[] = [];
  page.handleDialog = async (accept, text) => {
    answers.push({ accept, ...(text === undefined ? {} : { text }) });
  };
  try {
    assert.equal((await session.run()).status, "CONFIRM_REQUIRED");
    assert.equal((await session.resume({ dialog: { accept: true } })).status, "INFO_NOT_ON_PAGE");
    assert.deepEqual(answers, [{ accept: true }]);
    assert.equal(seen.actions.length, 1);
  } finally {
    await session.close();
  }
});

test("answered confirm is absent from the next detector input", async () => {
  const dialog = { kind: "confirm" as const, message: "Proceed?", defaultPrompt: "" };
  const pendingAtDetection: boolean[] = [];
  const fixtureCase = fixture({
    outcomes: [
      { type: "act", action: action() },
      { type: "handoff", reason: "info_not_on_page", source: "code", details: {} },
    ],
    execute: () => ({ ...changed(), outcome: "dialog-opened", dialog }),
    detect: (input) => {
      pendingAtDetection.push(input.pendingDialog !== undefined);
      return input.pendingDialog
        ? [
            {
              kind: "dialog",
              level: "blocking",
              evidence: ["pending dialog"],
              dialog: input.pendingDialog,
            },
          ]
        : [];
    },
  });
  let answers = 0;
  fixtureCase.page.handleDialog = async (accept) => {
    assert.equal(accept, true);
    answers++;
  };
  try {
    assert.equal((await fixtureCase.session.run()).status, "CONFIRM_REQUIRED");
    assert.equal(
      (await fixtureCase.session.resume({ dialog: { accept: true } })).status,
      "INFO_NOT_ON_PAGE",
    );
    assert.deepEqual(pendingAtDetection, [false, false]);
    assert.equal(answers, 1);
    assert.equal(fixtureCase.seen.actions.length, 1);
  } finally {
    await fixtureCase.session.close();
  }
});

test("prompt dialog resumes with a provided value and act can answer it", async () => {
  const dialog = { kind: "prompt" as const, message: "Code?", defaultPrompt: "" };
  const one = fixture({
    outcomes: [
      { type: "act", action: action() },
      { type: "handoff", reason: "info_not_on_page", source: "code", details: {} },
    ],
    execute: () => ({ ...changed(), outcome: "dialog-opened", dialog }),
  });
  const two = fixture({
    outcomes: [{ type: "act", action: action() }],
    execute: () => ({ ...changed(), outcome: "dialog-opened", dialog }),
  });
  const answered: string[] = [];
  one.page.handleDialog = async (_accept, text) => {
    answered.push(text ?? "");
  };
  two.page.handleDialog = async (_accept, text) => {
    answered.push(text ?? "");
  };
  try {
    assert.equal((await one.session.run()).status, "NEEDS_VALUES");
    assert.equal(
      (
        await one.session.resume({
          values: { code: "731" },
          dialog: { accept: true, value_key: "code" },
        })
      ).status,
      "INFO_NOT_ON_PAGE",
    );
    assert.equal((await two.session.run()).status, "NEEDS_VALUES");
    assert.equal(
      (await two.session.act([{ action: "dialog", accept: true, value_key: "code" }])).status,
      "NEEDS_VALUES",
    );
    assert.equal((await two.session.act([{ action: "dialog", accept: false }])).status, "RUNNING");
    assert.deepEqual(answered, ["731", ""]);
  } finally {
    await one.session.close();
    await two.session.close();
  }
});

test("steps and seconds reset per invocation while decision tokens remain cumulative", async () => {
  const clock = { now: 0 };
  const steps = fixture({
    clock,
    outcomes: [{ type: "act", action: action() }],
    options: { budget: { steps: 1 } },
  });
  let samples = 0;
  const seconds = fixture({
    clock,
    observe: async () => {
      samples++;
      if (samples === 1) clock.now += 1000;
      return observation();
    },
    outcomes: [{ type: "handoff", reason: "uncertain", source: "code", details: {} }],
    options: { budget: { seconds: 1 } },
  });
  const tokens = fixture({ clock, options: { budget: { decision_tokens: 3 } } });
  const manual = fixture({ clock, options: { budget: { steps: 1 } } });
  try {
    assert.equal((await steps.session.run()).status, "BUDGET_EXHAUSTED");
    clock.now += 300_000;
    const stepped = await steps.session.resume();
    assert.equal(stepped.status, "BUDGET_EXHAUSTED");
    assert.equal(steps.seen.actions.length, 2);
    assert.ok(stepped.timing.total < 1000);
    assert.equal((await seconds.session.run()).status, "BUDGET_EXHAUSTED");
    clock.now += 300_000;
    const resumed = await seconds.session.resume();
    assert.equal(resumed.status, "UNCERTAIN");
    assert.ok(resumed.timing.total < 1000);
    assert.equal((await tokens.session.run()).usage.decision_tokens, 3);
    clock.now += 300_000;
    assert.equal((await tokens.session.resume()).status, "BUDGET_EXHAUSTED");
    assert.equal(
      (await manual.session.act([{ action: "click", ref: "e1" }])).status,
      "BUDGET_EXHAUSTED",
    );
    clock.now += 300_000;
    const manualAgain = await manual.session.act([{ action: "click", ref: "e1" }]);
    assert.equal(manualAgain.status, "BUDGET_EXHAUSTED");
    assert.equal(manual.seen.actions.length, 2);
    assert.ok(manualAgain.timing.total < 1000);
  } finally {
    await steps.session.close();
    await seconds.session.close();
    await tokens.session.close();
    await manual.session.close();
  }
});

test("domain allowlist extension resumes the stored click exactly once", async () => {
  const link = element("Outside", "link", { href: "http://outside.test/next" });
  const start = observation([link]);
  const fixtureCase = fixture({
    observations: [start, start, observation([], "outside", "http://outside.test/next")],
    outcomes: [{ type: "act", action: action(link) }],
    options: { constraints: { allowed_domains: ["example.test"] }, budget: { steps: 1 } },
  });
  try {
    assert.equal((await fixtureCase.session.run()).status, "CONFIRM_REQUIRED");
    assert.equal(fixtureCase.seen.actions.length, 0);
    assert.equal(
      (await fixtureCase.session.resume({ allowed_domains: ["outside.test"] })).status,
      "BUDGET_EXHAUSTED",
    );
    assert.equal(fixtureCase.seen.actions.length, 1);
    assert.deepEqual(fixtureCase.session.constraints.allowed_domains, [
      "example.test",
      "outside.test",
    ]);
  } finally {
    await fixtureCase.session.close();
  }
});

test("allowing a redirect destination continues from the current page", async () => {
  const outside = observation([], "redirected", "http://outside.test/result");
  const fixtureCase = fixture({
    observations: [observation(), outside, outside],
    outcomes: [
      { type: "act", action: action() },
      { type: "handoff", reason: "info_not_on_page", source: "code", details: {} },
    ],
    options: { constraints: { allowed_domains: ["example.test"] } },
  });
  try {
    assert.equal((await fixtureCase.session.run()).status, "CONFIRM_REQUIRED");
    assert.equal(
      (await fixtureCase.session.resume({ allowed_domains: ["outside.test"] })).status,
      "INFO_NOT_ON_PAGE",
    );
    assert.equal(fixtureCase.seen.actions.length, 1);
  } finally {
    await fixtureCase.session.close();
  }
});

test("run gates an off-list redirect after a click without an href", async () => {
  const landing = observation([], "redirected", "http://outside.test/result");
  const fixtureCase = fixture({
    observations: [observation([element("Continue")]), landing, landing],
    outcomes: [
      { type: "act", action: action() },
      { type: "handoff", reason: "info_not_on_page", source: "code", details: {} },
    ],
    options: { constraints: { allowed_domains: ["example.test"] } },
  });
  try {
    const gated = await fixtureCase.session.run();
    assert.equal(gated.status, "CONFIRM_REQUIRED");
    assert.match(gated.question, /outside\.test/u);
    assert.equal(fixtureCase.seen.actions.length, 1);
    const resumed = await fixtureCase.session.resume({ allowed_domains: ["outside.test"] });
    assert.equal(resumed.status, "INFO_NOT_ON_PAGE");
    assert.equal(fixtureCase.seen.actions.length, 1);
  } finally {
    await fixtureCase.session.close();
  }
});

test("act gates an off-list redirect after a manual click without an href", async () => {
  const landing = observation([], "redirected", "http://outside.test/result");
  const fixtureCase = fixture({
    observations: [observation([element("Continue")]), landing, landing],
    outcomes: [{ type: "handoff", reason: "info_not_on_page", source: "code", details: {} }],
    options: { constraints: { allowed_domains: ["example.test"] } },
  });
  try {
    const gated = await fixtureCase.session.act([{ action: "click", ref: "e1" }]);
    assert.equal(gated.status, "CONFIRM_REQUIRED");
    assert.match(gated.question, /outside\.test/u);
    assert.equal(fixtureCase.seen.actions.length, 1);
    const resumed = await fixtureCase.session.resume({ allowed_domains: ["outside.test"] });
    assert.equal(resumed.status, "INFO_NOT_ON_PAGE");
    assert.equal(fixtureCase.seen.actions.length, 1);
  } finally {
    await fixtureCase.session.close();
  }
});

test("run gates a redirect that lands off-list during the challenge auto-pass window", async () => {
  const landing = observation([], "redirected", "http://outside.test/result");
  const fixtureCase = fixture({
    observations: [observation(), landing, landing],
    detect: (input) =>
      input.observation.url.includes("outside.test")
        ? []
        : [
            {
              kind: "challenge",
              level: "blocking",
              evidence: ["challenge"],
              vendor: "Example",
              autoPassPlausible: true,
            },
          ],
    outcomes: [{ type: "handoff", reason: "info_not_on_page", source: "code", details: {} }],
    options: { constraints: { allowed_domains: ["example.test"] }, autoPassWindowMs: 1000 },
  });
  try {
    const gated = await fixtureCase.session.run();
    assert.equal(gated.status, "CONFIRM_REQUIRED");
    assert.match(gated.question, /outside\.test/u);
    assert.equal(fixtureCase.seen.actions.length, 0);
    assert.equal(
      (await fixtureCase.session.resume({ allowed_domains: ["outside.test"] })).status,
      "INFO_NOT_ON_PAGE",
    );
  } finally {
    await fixtureCase.session.close();
  }
});

test("benign ops preserve approval for the first gated op", async () => {
  const field = element("Name", "textbox", {
    ref: "field",
    fingerprint: "field",
    tag: "input",
    inputType: "text",
  });
  const buy = element("Buy now", "button", { ref: "buy", fingerprint: "buy", inputType: "button" });
  const instance = fixture({ observations: [observation([field, buy])] });
  try {
    const result = await instance.session.act(
      [
        { action: "type", ref: field.ref, text: "Ada" },
        { action: "click", ref: buy.ref },
      ],
      { allow_irreversible: true },
    );
    assert.equal(result.status, "RUNNING");
    assert.deepEqual(
      instance.seen.actions.map((chosen) => chosen.kind),
      ["type", "click"],
    );
    assert.deepEqual(instance.seen.actions[1], action(buy));
  } finally {
    await instance.session.close();
  }
});

test("second gated op stops and becomes pending", async () => {
  const buy = element("Buy now", "button", { ref: "buy", fingerprint: "buy" });
  const remove = element("Delete account", "button", { ref: "delete", fingerprint: "delete" });
  const tail = element("Next", "button", { ref: "tail", fingerprint: "tail" });
  const instance = fixture({ observations: [observation([buy, remove, tail])] });
  try {
    const result = await instance.session.act(
      [buy, remove, tail].map((item) => ({ action: "click" as const, ref: item.ref })),
      { allow_irreversible: true },
    );
    assert.equal(result.status, "CONFIRM_REQUIRED");
    assert.deepEqual(instance.seen.actions, [action(buy)]);
    assert.deepEqual(instance.session.pendingGatedAction?.action, action(remove));
    assert.equal(instance.session.pendingGatedAction?.ref, remove.ref);
    assert.equal(instance.session.pendingGatedAction?.url, "http://example.test/start");
  } finally {
    await instance.session.close();
  }
});

test("failed approved attempt cannot authorize another op", async () => {
  const buy = element("Buy now", "button", { ref: "buy", fingerprint: "buy" });
  const remove = element("Delete account", "button", { ref: "delete", fingerprint: "delete" });
  const instance = fixture({
    observations: [observation([buy, remove])],
    execute: () => ({
      ...changed(),
      outcome: "disabled",
      changes: { url: false, pageHash: false, value: false, checked: false },
    }),
  });
  try {
    const result = await instance.session.act(
      [buy, remove].map((item) => ({ action: "click" as const, ref: item.ref })),
      { allow_irreversible: true },
    );
    assert.equal(result.status, "CONFIRM_REQUIRED");
    assert.deepEqual(instance.seen.actions, [action(buy)]);
    assert.equal(result.trace[0]?.outcome, "disabled");
    assert.deepEqual(instance.session.pendingGatedAction?.action, action(remove));
  } finally {
    await instance.session.close();
  }
});

test("same-action retry preserves identity scope", async () => {
  for (const outcome of ["stale", "covered"] as const) {
    const buy = element("Buy now", "button", {
      ref: "buy",
      fingerprint: "buy",
      inputType: "button",
    });
    const relocated = { ...buy, ref: "new-buy", fingerprint: "new-buy" };
    const remove = element("Delete account", "button", { ref: "delete", fingerprint: "delete" });
    const refreshed = { ...observation([relocated, remove]), epoch: 2 };
    const strict: Array<boolean | undefined> = [];
    const instance = fixture({
      observations: [observation([buy, remove]), refreshed],
      executeAction: async (_page, _before, _chosen, _values, options) => {
        strict.push(options?.strictIdentity);
        return strict.length === 1
          ? {
              ...changed(),
              outcome,
              ...(outcome === "covered" ? { coveredBy: { role: "menu", name: "Menu" } } : {}),
            }
          : changed();
      },
    });
    try {
      const result = await instance.session.act(
        [
          { action: "click", ref: buy.ref },
          { action: "click", ref: remove.ref },
        ],
        { allow_irreversible: true },
      );
      assert.equal(result.status, "CONFIRM_REQUIRED", outcome);
      assert.deepEqual(instance.seen.actions, [
        action(buy),
        {
          kind: "click",
          target: { epoch: 2, ref: relocated.ref, fingerprint: relocated.fingerprint },
        },
      ]);
      assert.deepEqual(strict, [true, true]);
      assert.equal(instance.session.pendingGatedAction?.ref, remove.ref);
      assert.equal(instance.session.pendingGatedAction?.epoch, 2);
      if (outcome === "covered")
        assert.ok(
          instance.page.calls.some((call) => call.name === "key" && call.args[0] === "Escape"),
        );
    } finally {
      await instance.session.close();
    }
  }
});

test("pending approval does not move to another row", async () => {
  const alice = element("Delete", "button", {
    ref: "alice",
    fingerprint: "alice",
    containerText: "Alice",
  });
  const bob = { ...alice, ref: "bob", fingerprint: "bob", containerText: "Bob" };
  const instance = fixture({ observations: [observation([bob])] });
  instance.session.pendingGatedAction = {
    action: action(alice),
    url: "http://example.test/start",
    epoch: 1,
    ref: "alice",
    fingerprint: "alice",
    role: "button",
    name: "Delete",
    containerText: "Alice",
    reason: "irreversible:delete",
  };
  try {
    const result = await instance.session.resume({ allow_irreversible: true });
    assert.equal(result.status, "UNCERTAIN");
    assert.match(result.question, /stored target changed/u);
    assert.equal(instance.seen.actions.length, 0);
  } finally {
    await instance.session.close();
  }
});

test("pending approval still finds its row when it is the only match", async () => {
  const alice = element("Delete", "button", {
    ref: "alice",
    fingerprint: "alice",
    containerText: "Alice",
  });
  const instance = fixture({ observations: [observation([alice]), observation([alice])] });
  instance.session.pendingGatedAction = {
    action: action(alice),
    url: "http://example.test/start",
    epoch: 1,
    ref: "alice",
    fingerprint: "alice",
    role: "button",
    name: "Delete",
    containerText: "Alice",
    reason: "irreversible:delete",
  };
  try {
    await instance.session.resume({ allow_irreversible: true });
    assert.equal(instance.seen.actions.length, 1);
  } finally {
    await instance.session.close();
  }
});

test("a new goal drops the pending action", async () => {
  // Not an irreversible control, so the old action would really be dispatched without the fix.
  const item = element("Open report", "link", {
    ref: "report",
    fingerprint: "report",
    href: "https://outside.test/report",
  });
  const instance = fixture({ observations: [observation([item])] });
  instance.session.pendingGatedAction = {
    action: action(item),
    url: "http://example.test/start",
    epoch: 1,
    ref: "report",
    fingerprint: "report",
    role: "link",
    name: "Open report",
    reason: "domain:outside.test",
  };
  try {
    await instance.session.resume({ goal_update: "new goal", allowed_domains: ["outside.test"] });
    assert.equal(instance.seen.actions.length, 0);
  } finally {
    await instance.session.close();
  }
});

test("resume keeps a gate raised by the pending action", async () => {
  const link = element("Delete", "link", {
    ref: "go",
    fingerprint: "go",
    href: "https://outside.test/next",
  });
  const instance = fixture({ observations: [observation([link]), observation([link])] });
  instance.session.pendingGatedAction = {
    action: action(link),
    url: "http://example.test/start",
    epoch: 1,
    ref: "go",
    fingerprint: "go",
    role: "link",
    name: "Delete",
    reason: "domain:outside.test",
  };
  try {
    const first = await instance.session.resume({ allowed_domains: ["outside.test"] });
    assert.equal(first.status, "CONFIRM_REQUIRED");
    assert.ok(instance.session.pendingGatedAction);
  } finally {
    await instance.session.close();
  }
});

test("approved retry does not carry approval to another URL", async () => {
  const buy = element("Delete", "button", { ref: "buy", fingerprint: "buy" });
  const moved = { ...buy, ref: "moved", fingerprint: "moved" };
  let calls = 0;
  const instance = fixture({
    observations: [observation([buy]), observation([moved], "next", "http://example.test/other")],
    executeAction: async () => {
      calls++;
      return calls === 1 ? { ...changed(), outcome: "stale" } : changed();
    },
  });
  try {
    const result = await instance.session.act([{ action: "click", ref: buy.ref }], {
      allow_irreversible: true,
    });
    assert.equal(calls, 1);
    assert.equal(result.status, "CONFIRM_REQUIRED");
  } finally {
    await instance.session.close();
  }
});

test("approved retry does not carry approval to a popup", async () => {
  const buy = element("Delete", "button", { ref: "buy", fingerprint: "buy" });
  const onPopup = { ...buy, ref: "popup-delete", fingerprint: "popup-delete" };
  const popup = new FakePageHandle();
  let calls = 0;
  const instance = fixture({
    observations: [
      observation([buy]),
      observation([onPopup], "popup", "http://example.test/start"),
    ],
    executeAction: async () => {
      calls++;
      // The approved click does not land; meanwhile the page opens a popup with a same-named control.
      instance.page.emit("popup", popup);
      return { ...changed(), outcome: "stale" };
    },
  });
  try {
    const result = await instance.session.act([{ action: "click", ref: buy.ref }], {
      allow_irreversible: true,
    });
    assert.equal(instance.session.page, popup);
    assert.equal(calls, 1);
    assert.equal(result.status, "CONFIRM_REQUIRED");
    assert.equal(instance.session.pendingGatedAction?.ref, onPopup.ref);
  } finally {
    await instance.session.close();
  }
});

test("pending approval does not move to another row by position", async () => {
  const alice = element("Delete", "button", {
    ref: "alice",
    fingerprint: "alice",
    containerText: "Alice",
    itemPosition: 2,
  });
  const rows = ["Bob", "Carol", "Dave"].map((name, index) => ({
    ...alice,
    ref: name,
    fingerprint: name,
    containerText: name,
    itemPosition: index + 1,
  }));
  const instance = fixture({ observations: [observation(rows)] });
  instance.session.pendingGatedAction = {
    action: action(alice),
    url: "http://example.test/start",
    epoch: 1,
    ref: "alice",
    fingerprint: "alice",
    role: "button",
    name: "Delete",
    containerText: "Alice",
    itemPosition: 2,
    reason: "irreversible:delete",
  };
  try {
    const result = await instance.session.resume({ allow_irreversible: true });
    assert.equal(result.status, "UNCERTAIN");
    assert.match(result.question, /stored target changed/u);
    assert.equal(instance.seen.actions.length, 0);
  } finally {
    await instance.session.close();
  }
});

test("resume approves pending op without replaying batch tail", async () => {
  const buy = element("Buy now", "button", { ref: "buy", fingerprint: "buy" });
  const tail = element("Next", "button", { ref: "tail", fingerprint: "tail" });
  let decisions = 0;
  const instance = fixture({
    observations: [observation([buy, tail])],
    decide: async () => {
      decisions++;
      return decision;
    },
    outcomes: [{ type: "done_candidate", goalMet: 0.9 }],
  });
  try {
    assert.equal(
      (
        await instance.session.act([
          { action: "click", ref: buy.ref },
          { action: "click", ref: tail.ref },
        ])
      ).status,
      "CONFIRM_REQUIRED",
    );
    assert.deepEqual(instance.seen.actions, []);
    assert.deepEqual(instance.session.pendingGatedAction?.action, action(buy));
    assert.equal(
      (await instance.session.resume({ allow_irreversible: true })).status,
      "DONE_UNVERIFIED",
    );
    assert.deepEqual(instance.seen.actions, [action(buy)]);
    assert.equal(instance.session.pendingGatedAction, undefined);
    assert.equal(decisions, 1, "resume continues with Jev's loop");
  } finally {
    await instance.session.close();
  }
});

test("session preauthorization and Jev batches retain their semantics", async () => {
  const buy = element("Buy now", "button", { ref: "buy", fingerprint: "buy" });
  const remove = element("Delete account", "button", { ref: "delete", fingerprint: "delete" });
  const field = element("Name", "textbox", {
    ref: "field",
    fingerprint: "field",
    tag: "input",
    inputType: "text",
    formId: "purchase",
  });
  const submit = { ...buy, formId: "purchase", inputType: "submit" };
  const manual = fixture({
    observations: [observation([buy, remove])],
    options: { constraints: { allow_irreversible: true } },
  });
  let decisions = 0;
  const jev = fixture({
    observations: [observation([field, submit])],
    options: { values: { name: "Ada" } },
    decide: async () => {
      decisions++;
      return decision;
    },
    outcomes: [
      {
        type: "batch",
        actions: [
          {
            kind: "type",
            target: { epoch: 1, ref: field.ref, fingerprint: field.fingerprint },
            valueKey: "name",
            submit: true,
          },
        ],
      },
    ],
  });
  try {
    assert.equal(
      (
        await manual.session.act(
          [buy, remove].map((item) => ({ action: "click" as const, ref: item.ref })),
        )
      ).status,
      "RUNNING",
    );
    assert.deepEqual(manual.seen.actions, [action(buy), action(remove)]);
    assert.equal((await jev.session.run()).status, "CONFIRM_REQUIRED");
    assert.equal(decisions, 1);
    assert.deepEqual(jev.seen.actions, []);
    assert.equal(jev.session.pendingGatedAction?.action.kind, "type");
    assert.equal(jev.session.pendingGatedAction?.ref, field.ref);
  } finally {
    await manual.session.close();
    await jev.session.close();
  }
});

test("manual act bypasses blocking findings but keeps irreversible approval scoped to its call", async () => {
  const challenge: Finding = {
    kind: "challenge",
    level: "blocking",
    vendor: "Cloudflare",
    autoPassPlausible: true,
    evidence: [],
  };
  const manual = fixture({ findings: [[challenge]], options: { budget: { steps: 1 } } });
  const buy = fixture({
    observations: [observation([element("Buy now")]), observation([], "bought")],
    options: { budget: { steps: 1 } },
  });
  try {
    assert.equal(
      (await manual.session.act([{ action: "click", ref: "e1" }])).status,
      "BUDGET_EXHAUSTED",
    );
    assert.equal(manual.seen.actions.length, 1);
    assert.equal(manual.clock.now, 0);
    assert.equal(
      (await buy.session.act([{ action: "click", ref: "e1" }], { allow_irreversible: true }))
        .status,
      "BUDGET_EXHAUSTED",
    );
    assert.equal(buy.seen.actions.length, 1);
    assert.equal(buy.session.constraints.allow_irreversible, false);
  } finally {
    await manual.session.close();
    await buy.session.close();
  }
});

test("observe reports challenges immediately and full detail bypasses formatting token budget", async () => {
  const challenge: Finding = {
    kind: "challenge",
    level: "blocking",
    vendor: "Cloudflare",
    autoPassPlausible: true,
    evidence: [],
  };
  const blocked = fixture({ findings: [[challenge]] });
  const long = observation();
  long.text = "tail:" + "x".repeat(9000);
  const full = fixture({
    observations: [long],
    observe: async (_page, options) => {
      assert.equal(options?.maxTextChars, 20_000);
      assert.equal(options?.maxElements, 255);
      return long;
    },
  });
  try {
    assert.equal((await blocked.session.observe()).status, "BLOCKED_BY_CHALLENGE");
    assert.equal(blocked.clock.now, 0);
    const result = await full.session.observe("full");
    assert.equal(result.status, "RUNNING");
    assert.ok(result.snapshot.includes("x".repeat(8000)));
  } finally {
    await blocked.session.close();
    await full.session.close();
  }
});

test("one detection per observation preserves popup advisory for policy", async () => {
  let calls = 0;
  let policyFindings: Finding[] | undefined;
  const popup = new FakePageHandle();
  const fixtureCase = fixture({
    detect: () => {
      calls++;
      return [{ kind: "popup", level: "advisory", evidence: ["popup"], popup }];
    },
    buildDecisionState: (input) => {
      policyFindings = input.findings;
      return { state: {}, questions: {}, reductions: [] };
    },
    outcomes: [{ type: "handoff", reason: "uncertain", source: "code", details: {} }],
  });
  try {
    assert.equal((await fixtureCase.session.run()).status, "UNCERTAIN");
    assert.equal(calls, 1);
    assert.equal(policyFindings?.[0]?.kind, "popup");
  } finally {
    await fixtureCase.session.close();
  }
});

test("post-action popup and download advisories reach the next policy decision", async () => {
  const popup = new FakePageHandle();
  let detections = 0;
  const seenFindings: Finding[][] = [];
  const fixtureCase = fixture({
    outcomes: [
      { type: "act", action: action() },
      { type: "handoff", reason: "uncertain", source: "code", details: {} },
    ],
    detect: (input) => {
      detections++;
      return [
        ...input.events.popups.map((page): Finding => ({
          kind: "popup",
          level: "advisory",
          evidence: [],
          popup: page,
        })),
        ...input.events.downloads.map((download): Finding => ({
          kind: "download",
          level: "advisory",
          evidence: [],
          download,
        })),
      ];
    },
    buildDecisionState: (input) => {
      seenFindings.push(input.findings ?? []);
      return { state: {}, questions: {}, reductions: [] };
    },
    execute: () => {
      fixtureCase.page.emit("popup", popup);
      fixtureCase.page.emit("download", {
        id: "d1",
        url: "http://example.test/file",
        suggestedFilename: "file",
        state: "started",
      });
      return changed();
    },
  });
  try {
    assert.equal((await fixtureCase.session.run()).status, "UNCERTAIN");
    assert.equal(detections, 2);
    assert.deepEqual(
      seenFindings.map((findings) => findings.map((finding) => finding.kind)),
      [[], ["popup", "download"]],
    );
  } finally {
    await fixtureCase.session.close();
  }
});

test("login decision reaches policy unchanged with a typed credentials flag", async () => {
  let selected = "";
  let available = false;
  const fixtureCase = fixture({
    options: {
      values: {
        password: { secret_ref: "env:SESSION_TEST_SECRET", origins: ["http://example.test"] },
      },
    },
    buildDecisionState: () => ({
      state: {},
      questions: {
        situation: {
          type: "choice",
          instructions: "situation",
          criteria: { progressing: "continue", login_required: "login" },
        },
      },
      reductions: [],
    }),
    decide: async () => ({
      ...decision,
      answers: {
        situation: {
          type: "choice",
          choice: "login_required",
          confidence: 1,
          probabilities: { progressing: 0, login_required: 1 },
        },
      },
    }),
    interpret: (_questions, answers, context) => {
      selected = answers.situation?.type === "choice" ? answers.situation.choice : "";
      available = context.credentialsAvailable ?? false;
      return { type: "handoff", reason: "uncertain", source: "code", details: {} };
    },
  });
  try {
    assert.equal((await fixtureCase.session.run()).status, "UNCERTAIN");
    assert.equal(selected, "login_required");
    assert.equal(available, true);
  } finally {
    await fixtureCase.session.close();
  }
});

test("policy supplies the pending approval action without a second interpretation", async () => {
  let interpretations = 0;
  const buy = element("Buy now");
  const fixtureCase = fixture({
    observations: [observation([buy]), observation([buy]), observation([], "purchased")],
    options: { budget: { steps: 1 } },
    interpret: () => {
      interpretations++;
      return {
        type: "handoff",
        reason: "confirm_required",
        source: "code",
        details: { matched: "buy", target: { page_name: "Buy now" } },
        pendingAction: action(buy),
      };
    },
  });
  try {
    assert.equal((await fixtureCase.session.run()).status, "CONFIRM_REQUIRED");
    assert.equal(interpretations, 1);
    assert.equal(
      (await fixtureCase.session.resume({ allow_irreversible: true })).status,
      "BUDGET_EXHAUSTED",
    );
    assert.equal(fixtureCase.seen.actions.length, 1);
  } finally {
    await fixtureCase.session.close();
  }
});

test("custom policy goal threshold controls unverified completion", async () => {
  const fixtureCase = fixture({
    observations: [observation(), observation([], "changed")],
    outcomes: [{ type: "done_candidate", goalMet: 0.9 }],
    options: { thresholds: { goal_met: 0.95 } },
  });
  try {
    assert.equal((await fixtureCase.session.run()).status, "UNCERTAIN");
    assert.match((await fixtureCase.session.resume()).question, /goal_met is below threshold/u);
  } finally {
    await fixtureCase.session.close();
  }
});

test("success assertions use full-page matching beyond the compact observation", async () => {
  let called = 0;
  const fixtureCase = fixture({
    observations: [observation([element()], "start"), observation([], "done")],
    outcomes: [
      { type: "act", action: action() },
      { type: "done_candidate", goalMet: 0.9 },
    ],
    options: {
      success: {
        text_present: "Beyond 1500",
        element_present: { role: "button", name: "Deep result" },
      },
    },
    pageMatches: async (_page, assertions) => {
      called++;
      assert.equal(assertions.text_present, "Beyond 1500");
      assert.deepEqual(assertions.element_present, { role: "button", name: "Deep result" });
      // M6e: false on the start page (checked once there), true after the action.
      return called > 1;
    },
  });
  try {
    assert.equal((await fixtureCase.session.run()).status, "DONE_VERIFIED");
    // One full-page check on the start page (M6e) plus the one that verifies completion.
    assert.equal(called, 2);
  } finally {
    await fixtureCase.session.close();
  }
});

test("needs_values question uses policy's active-form field list", async () => {
  const outside = element("Unrelated required", "textbox", { required: true });
  const fixtureCase = fixture({
    observations: [observation([outside])],
    outcomes: [
      {
        type: "handoff",
        reason: "needs_values",
        source: "code",
        details: { fields: [{ label: "Active field" }] },
      },
    ],
  });
  try {
    const question = (await fixtureCase.session.run()).question;
    assert.match(question, /Active field/u);
    assert.doesNotMatch(question, /Unrelated required/u);
  } finally {
    await fixtureCase.session.close();
  }
});

test("needs_values with no field names the supplied keys and missing identification", async () => {
  const fixtureCase = fixture({
    options: { values: { "search term": "query" } },
    outcomes: [
      {
        type: "handoff",
        reason: "needs_values",
        source: "code",
        details: { dialogKind: "prompt" },
      },
    ],
  });
  try {
    const result = await fixtureCase.session.run();
    assert.match(result.question, /search term/u);
    assert.match(result.question, /pending prompt/u);
    assert.match(result.question, /No field was identified/u);
  } finally {
    await fixtureCase.session.close();
  }
});

test("batch fill records each field in one step and re-decides after a stale fill", async () => {
  const email = element("Email", "textbox", {
    ref: "e1",
    fingerprint: "email",
    tag: "input",
    inputType: "text",
  });
  const password = element("Password", "textbox", {
    ref: "e2",
    fingerprint: "password",
    tag: "input",
    inputType: "password",
  });
  const first = observation([email, password]);
  const second = observation([{ ...email, value: "Ada" }, password], "typed-email");
  const fixtureCase = fixture({
    observations: [first, second],
    options: {
      values: {
        email: "Ada",
        password: { secret_ref: "env:JEVPILOT_SECRET_M3F_TEST", origins: ["http://example.test"] },
      },
      budget: { steps: 2 },
    },
    outcomes: [
      {
        type: "batch",
        actions: [
          {
            kind: "type",
            target: { epoch: 1, ref: "e1", fingerprint: "email" },
            valueKey: "email",
          },
          {
            kind: "type",
            target: { epoch: 1, ref: "e2", fingerprint: "password" },
            valueKey: "password",
          },
        ],
      },
      {
        type: "handoff",
        reason: "uncertain",
        source: "code",
        details: { missing: "retry observed" },
      },
    ],
    execute: (chosen) =>
      chosen.kind === "type" && chosen.valueKey === "password"
        ? { ...changed(), outcome: "stale" }
        : changed(),
  });
  const previous = process.env.JEVPILOT_SECRET_M3F_TEST;
  process.env.JEVPILOT_SECRET_M3F_TEST = "secret-test-value";
  try {
    const result = await fixtureCase.session.run();
    assert.equal(result.status, "UNCERTAIN");
    assert.match(result.question, /Cannot proceed: retry observed/u);
    assert.deepEqual(
      result.trace.map((entry) => [entry.step, entry.target?.name, entry.outcome]),
      [
        [1, "Email", "changed"],
        [1, "Password", "stale"],
        [1, "Password", "stale"],
      ],
    );
    assert.equal(fixtureCase.seen.actions.length, 3);
  } finally {
    if (previous === undefined) delete process.env.JEVPILOT_SECRET_M3F_TEST;
    else process.env.JEVPILOT_SECRET_M3F_TEST = previous;
    await fixtureCase.session.close();
  }
});

test("repeated stale batch fills reach STUCK through no_progress", async () => {
  const field = element("Search", "textbox", {
    ref: "e1",
    fingerprint: "search",
    tag: "input",
    inputType: "search",
  });
  const fixtureCase = fixture({
    observations: [observation([field])],
    options: { values: { query: "term" }, budget: { steps: 5 } },
    outcomes: [
      {
        type: "batch",
        actions: [
          {
            kind: "type",
            target: { epoch: 1, ref: "e1", fingerprint: "search" },
            valueKey: "query",
          },
        ],
      },
    ],
    execute: () => ({
      ...changed(),
      outcome: "stale",
      pageHash: "start",
      url: "http://example.test/start",
      changes: { url: false, pageHash: false, value: false, checked: false },
    }),
    detect,
  });
  try {
    const result = await fixtureCase.session.run();
    assert.equal(result.status, "STUCK");
    assert.deepEqual(
      result.trace.map((entry) => [entry.step, entry.outcome]),
      [
        [1, "stale"],
        [1, "stale"],
      ],
    );
    assert.equal(fixtureCase.seen.actions.length, 2);
  } finally {
    await fixtureCase.session.close();
  }
});

test("batch fill completes two fields within one decision step", async () => {
  const first = element("First", "textbox", {
    ref: "e1",
    fingerprint: "first",
    tag: "input",
    inputType: "text",
  });
  const second = element("Second", "textbox", {
    ref: "e2",
    fingerprint: "second",
    tag: "input",
    inputType: "text",
  });
  const fixtureCase = fixture({
    observations: [
      observation([first, second]),
      observation([{ ...first, value: "A" }, second], "first-filled"),
      observation(
        [
          { ...first, value: "A" },
          { ...second, value: "B" },
        ],
        "both-filled",
      ),
    ],
    options: { values: { first: "A", second: "B" }, budget: { steps: 1 } },
    outcomes: [
      {
        type: "batch",
        actions: [
          {
            kind: "type",
            target: { epoch: 1, ref: "e1", fingerprint: "first" },
            valueKey: "first",
          },
          {
            kind: "type",
            target: { epoch: 1, ref: "e2", fingerprint: "second" },
            valueKey: "second",
          },
        ],
      },
    ],
  });
  try {
    const result = await fixtureCase.session.run();
    assert.equal(result.status, "BUDGET_EXHAUSTED");
    assert.deepEqual(
      result.trace.map((entry) => [entry.step, entry.target?.name]),
      [
        [1, "First"],
        [1, "Second"],
      ],
    );
    assert.deepEqual(fixtureCase.seen.values, [{ first: "A" }, { second: "B" }]);
  } finally {
    await fixtureCase.session.close();
  }
});

test("M6t-3: a batch types over a page-prefilled field", async () => {
  const field = element("Search", "textbox", {
    tag: "input",
    inputType: "text",
    value: "hot keyword",
  });
  const fixtureCase = fixture({
    observations: [observation([field]), observation([{ ...field, value: "query" }], "typed")],
    options: { values: { query: "query" }, budget: { steps: 1 } },
    outcomes: [
      {
        type: "batch",
        actions: [
          {
            kind: "type",
            target: { epoch: 1, ref: field.ref, fingerprint: field.fingerprint },
            valueKey: "query",
          },
        ],
      },
    ],
  });
  try {
    const result = await fixtureCase.session.run();
    assert.equal(result.status, "BUDGET_EXHAUSTED");
    assert.deepEqual(
      fixtureCase.seen.actions.map((item) => ("target" in item ? item.target.ref : "")),
      [field.ref],
    );
    assert.deepEqual(fixtureCase.seen.values, [{ query: "query" }]);
    assert.equal(result.trace.length, 1);
  } finally {
    await fixtureCase.session.close();
  }
});

test("M6t-3: a later batch field that the page prefilled is still retargeted", async () => {
  const first = element("First", "textbox", { tag: "input", inputType: "text", formId: "form" });
  const second = element("Second", "textbox", {
    ref: "e2",
    fingerprint: "second",
    tag: "input",
    inputType: "text",
    formId: "form",
    value: "page value",
  });
  const movedSecond = { ...second, ref: "e3" };
  const fixtureCase = fixture({
    observations: [
      observation([first, second]),
      { ...observation([{ ...first, value: "A" }, movedSecond], "first-typed"), epoch: 2 },
      {
        ...observation(
          [
            { ...first, value: "A" },
            { ...movedSecond, value: "B" },
          ],
          "both-typed",
        ),
        epoch: 3,
      },
    ],
    options: { values: { first: "A", second: "B" }, budget: { steps: 1 } },
    outcomes: [
      {
        type: "batch",
        actions: [
          { kind: "type", target: { epoch: 1, ref: "e1", fingerprint: "same" }, valueKey: "first" },
          {
            kind: "type",
            target: { epoch: 1, ref: "e2", fingerprint: "second" },
            valueKey: "second",
          },
        ],
      },
    ],
  });
  try {
    const result = await fixtureCase.session.run();
    assert.equal(result.status, "BUDGET_EXHAUSTED");
    assert.deepEqual(
      fixtureCase.seen.actions.map((item) => ("target" in item ? item.target.ref : "")),
      ["e1", "e3"],
    );
    assert.deepEqual(fixtureCase.seen.values, [{ first: "A" }, { second: "B" }]);
    assert.equal(result.trace.length, 2);
  } finally {
    await fixtureCase.session.close();
  }
});

test("M6t-3: a batch retarget skips a field this session typed", async () => {
  const first = element("Keyword", "textbox", { tag: "input", inputType: "text", formId: "form" });
  const second = { ...first, ref: "e2", fingerprint: "second" };
  const fixtureCase = fixture({
    observations: [
      observation([first, second]),
      { ...observation([{ ...first, value: "A" }, second], "first-typed"), epoch: 2 },
      {
        ...observation(
          [
            { ...first, value: "A" },
            { ...second, value: "B" },
          ],
          "both-typed",
        ),
        epoch: 3,
      },
    ],
    options: { values: { first: "A", second: "B" }, budget: { steps: 1 } },
    outcomes: [
      {
        type: "batch",
        actions: [
          { kind: "type", target: { epoch: 1, ref: "e1", fingerprint: "same" }, valueKey: "first" },
          {
            kind: "type",
            target: { epoch: 1, ref: "e2", fingerprint: "second" },
            valueKey: "second",
          },
        ],
      },
    ],
  });
  try {
    const result = await fixtureCase.session.run();
    assert.equal(result.status, "BUDGET_EXHAUSTED");
    assert.deepEqual(
      fixtureCase.seen.actions.map((item) => ("target" in item ? item.target.ref : "")),
      ["e1", "e2"],
    );
    assert.deepEqual(fixtureCase.seen.values, [{ first: "A" }, { second: "B" }]);
  } finally {
    await fixtureCase.session.close();
  }
});

test("M6t-3: the first batch action keeps the decided target while the page is unchanged", async () => {
  const first = element("Keyword", "textbox", { tag: "input", inputType: "text", formId: "form" });
  const second = { ...first, ref: "e2", fingerprint: "second" };
  const fixtureCase = fixture({
    observations: [
      observation([first, second]),
      observation([first, { ...second, value: "B" }], "typed"),
    ],
    options: { values: { second: "B" }, budget: { steps: 1 } },
    outcomes: [
      {
        type: "batch",
        actions: [
          {
            kind: "type",
            target: { epoch: 1, ref: "e2", fingerprint: "second" },
            valueKey: "second",
          },
        ],
      },
    ],
  });
  try {
    const result = await fixtureCase.session.run();
    assert.equal(result.status, "BUDGET_EXHAUSTED");
    assert.deepEqual(
      fixtureCase.seen.actions.map((item) => ("target" in item ? item.target.ref : "")),
      ["e2"],
    );
    assert.deepEqual(fixtureCase.seen.values, [{ second: "B" }]);
  } finally {
    await fixtureCase.session.close();
  }
});

test("M6t-3: a batch that runs no action hands off instead of spending the step", async () => {
  const first = element("Keyword", "textbox", { tag: "input", inputType: "text", formId: "form" });
  const second = { ...first, ref: "e2", fingerprint: "second" };
  let decisions = 0;
  const fixtureCase = fixture({
    observations: [{ ...observation([first, second]), epoch: 2 }],
    options: { values: { query: "A" }, budget: { steps: 2 } },
    decide: async () => {
      decisions++;
      return decision;
    },
    outcomes: [
      {
        type: "batch",
        actions: [
          { kind: "type", target: { epoch: 1, ref: "e1", fingerprint: "same" }, valueKey: "query" },
        ],
      },
    ],
  });
  try {
    const result = await fixtureCase.session.run();
    assert.equal(result.status, "UNCERTAIN");
    assert.match(result.question, /stored target changed/u);
    assert.equal(decisions, 1);
    assert.equal(fixtureCase.seen.actions.length, 0);
    assert.equal(result.trace.length, 0);
  } finally {
    await fixtureCase.session.close();
  }
});

test("stale action re-observes and retries a unique new ref in the same step", async () => {
  const original = element("Next", "button", { ref: "e1", fingerprint: "stable" });
  const moved = { ...original, ref: "e9" };
  const fixtureCase = fixture({
    observations: [
      observation([original]),
      { ...observation([moved]), epoch: 2 },
      observation([], "done"),
    ],
    options: { success: { text_present: "done" }, budget: { steps: 1 } },
    outcomes: [
      {
        type: "act",
        action: { kind: "click", target: { epoch: 1, ref: "e1", fingerprint: "stable" } },
      },
    ],
    execute: (_chosen, _values) =>
      fixtureCase.seen.actions.length === 1 ? { ...changed(), outcome: "stale" } : changed(),
    pageMatches: async () => fixtureCase.seen.actions.length === 2,
  });
  try {
    const result = await fixtureCase.session.run();
    assert.equal(result.status, "DONE_VERIFIED");
    assert.deepEqual(
      result.trace.map((entry) => [entry.step, entry.outcome]),
      [
        [1, "stale"],
        [1, "changed"],
      ],
    );
    assert.deepEqual(
      fixtureCase.seen.actions.map((item) => ("target" in item ? item.target.ref : "")),
      ["e1", "e9"],
    );
  } finally {
    await fixtureCase.session.close();
  }
});

test("stale batch fill retries once, then continues with the next refreshed field", async () => {
  const first = element("First", "textbox", {
    ref: "e1",
    fingerprint: "first",
    tag: "input",
    inputType: "text",
  });
  const second = element("Second", "textbox", {
    ref: "e2",
    fingerprint: "second",
    tag: "input",
    inputType: "text",
  });
  const movedFirst = { ...first, ref: "e9" };
  const movedSecond = { ...second, ref: "e10" };
  const fixtureCase = fixture({
    observations: [
      observation([first, second]),
      { ...observation([movedFirst, movedSecond]), epoch: 2 },
      { ...observation([{ ...movedFirst, value: "A" }, movedSecond], "first"), epoch: 3 },
      {
        ...observation(
          [
            { ...movedFirst, value: "A" },
            { ...movedSecond, value: "B" },
          ],
          "done",
        ),
        epoch: 4,
      },
    ],
    options: {
      values: { first: "A", second: "B" },
      budget: { steps: 1 },
      success: { text_present: "done" },
    },
    outcomes: [
      {
        type: "batch",
        actions: [
          {
            kind: "type",
            target: { epoch: 1, ref: "e1", fingerprint: "first" },
            valueKey: "first",
          },
          {
            kind: "type",
            target: { epoch: 1, ref: "e2", fingerprint: "second" },
            valueKey: "second",
          },
        ],
      },
    ],
    execute: () =>
      fixtureCase.seen.actions.length === 1 ? { ...changed(), outcome: "stale" } : changed(),
    pageMatches: async () => fixtureCase.seen.actions.length === 3,
  });
  try {
    const result = await fixtureCase.session.run();
    assert.equal(result.status, "DONE_VERIFIED");
    assert.deepEqual(
      result.trace.map((entry) => [entry.step, entry.outcome]),
      [
        [1, "stale"],
        [1, "changed"],
        [1, "changed"],
      ],
    );
    assert.deepEqual(
      fixtureCase.seen.actions.map((item) => ("target" in item ? item.target.ref : "")),
      ["e1", "e9", "e10"],
    );
  } finally {
    await fixtureCase.session.close();
  }
});

test("stale action without a unique identity returns to the decision loop", async () => {
  const original = element("Next", "button", { ref: "e1", fingerprint: "stable" });
  for (const candidates of [
    [],
    [
      { ...original, ref: "e9" },
      { ...original, ref: "e10" },
    ],
  ]) {
    const fixtureCase = fixture({
      observations: [observation([original]), { ...observation(candidates), epoch: 2 }],
      outcomes: [
        {
          type: "act",
          action: { kind: "click", target: { epoch: 1, ref: "e1", fingerprint: "stable" } },
        },
        {
          type: "handoff",
          reason: "uncertain",
          source: "code",
          details: { missing: "re-decided" },
        },
      ],
      execute: () => ({ ...changed(), outcome: "stale" }),
    });
    try {
      const result = await fixtureCase.session.run();
      assert.equal(result.status, "UNCERTAIN");
      assert.match(result.question, /re-decided/u);
      assert.equal(fixtureCase.seen.actions.length, 1);
    } finally {
      await fixtureCase.session.close();
    }
  }
});

test("two-field batch and SUBMIT complete within two decision steps", async () => {
  const first = element("First", "textbox", {
    ref: "e1",
    fingerprint: "first",
    tag: "input",
    inputType: "text",
  });
  const second = element("Second", "textbox", {
    ref: "e2",
    fingerprint: "second",
    tag: "input",
    inputType: "text",
  });
  const filledFirst = { ...first, value: "A" };
  const filledSecond = { ...second, value: "B" };
  const complete = { ...observation([filledFirst, filledSecond], "submitted"), text: "complete" };
  const fixtureCase = fixture({
    observations: [
      observation([first, second]),
      observation([filledFirst, second], "first-filled"),
      observation([filledFirst, filledSecond], "both-filled"),
      complete,
    ],
    options: {
      values: { first: "A", second: "B" },
      budget: { steps: 2 },
      success: { text_present: "complete" },
    },
    outcomes: [
      {
        type: "batch",
        actions: [
          {
            kind: "type",
            target: { epoch: 1, ref: "e1", fingerprint: "first" },
            valueKey: "first",
          },
          {
            kind: "type",
            target: { epoch: 1, ref: "e2", fingerprint: "second" },
            valueKey: "second",
          },
        ],
      },
      {
        type: "act",
        action: { kind: "submit", target: { epoch: 1, ref: "e2", fingerprint: "second" } },
      },
    ],
  });
  try {
    const result = await fixtureCase.session.run();
    assert.equal(result.status, "DONE_VERIFIED");
    assert.deepEqual(
      result.trace.map((entry) => [entry.step, entry.op]),
      [
        [1, "type"],
        [1, "type"],
        [2, "submit"],
      ],
    );
    assert.equal(fixtureCase.seen.actions.length, 3);
  } finally {
    await fixtureCase.session.close();
  }
});

test("unchanged decision cycles still exhaust the per-invocation step budget", async () => {
  const fixtureCase = fixture({
    options: { budget: { steps: 2 } },
    outcomes: [{ type: "act", action: { kind: "wait" } }],
    execute: () => ({
      ...changed(),
      outcome: "unchanged",
      changes: { url: false, pageHash: false, value: false, checked: false },
    }),
  });
  try {
    const result = await fixtureCase.session.run();
    assert.equal(result.status, "BUDGET_EXHAUSTED");
    assert.deepEqual(
      result.trace.map((entry) => [entry.step, entry.outcome]),
      [
        [1, "unchanged"],
        [2, "unchanged"],
      ],
    );
    assert.equal(fixtureCase.seen.actions.length, 2);
  } finally {
    await fixtureCase.session.close();
  }
});

test("uncertain questions explain low goal score and empty candidates", async () => {
  for (const [details, expected] of [
    [{ goalMet: 0.42, threshold: 0.8 }, "goal_met 0.42 < 0.80"],
    [{ question: "op", candidates: [] }, "Could not choose a confident op"],
    [{ missing: "stored target changed" }, "Cannot proceed: stored target changed"],
  ] as const) {
    const fixtureCase = fixture({
      outcomes: [{ type: "handoff", reason: "uncertain", source: "code", details }],
    });
    try {
      const result = await fixtureCase.session.run();
      assert.match(result.question, new RegExp(expected.replaceAll(".", "\\."), "u"));
      assert.doesNotMatch(result.question, /Choose among \[\]/u);
    } finally {
      await fixtureCase.session.close();
    }
  }
});

test("value_for uncertainty names the field and key probabilities", async () => {
  const fixtureCase = fixture({
    outcomes: [
      {
        type: "handoff",
        reason: "uncertain",
        source: "code",
        details: {
          question: "value_for",
          candidates: [
            {
              field: { ref: "e2", role: "textbox", name: "Search" },
              probabilities: [
                ["query", 0.58],
                ["not_provided", 0.42],
              ],
            },
          ],
        },
      },
    ],
  });
  try {
    const result = await fixtureCase.session.run();
    assert.equal(result.status, "UNCERTAIN");
    assert.match(result.question, /textbox.*Search.*e2.*query.*0\.58/u);
    assert.doesNotMatch(result.question, /"question":"op"/u);
  } finally {
    await fixtureCase.session.close();
  }
});

test("M6o: typing with no fitting field hands off UNCERTAIN naming the remaining keys and empty fields", async () => {
  const fixtureCase = fixture({
    outcomes: [
      {
        type: "handoff",
        reason: "uncertain",
        source: "code",
        details: {
          question: "value_for",
          candidates: [],
          remaining_keys: ["second package"],
          fields: [{ ref: "e4", label: "tyler@leftpad.com", type: "input" }],
        },
      },
    ],
  });
  try {
    const result = await fixtureCase.session.run();
    assert.equal(result.status, "UNCERTAIN");
    assert.match(result.question, /second package/u);
    assert.match(result.question, /input "tyler@leftpad\.com" \(e4\)/u);
    assert.match(result.question, /browser_act.*browser_resume/u);
  } finally {
    await fixtureCase.session.close();
  }
});

test("FAILED diagnostics include only bounded codes and metadata", async () => {
  const secret = "PRIVATE_FAILURE_MARKER";
  const failures = [
    {
      error: new InvalidAnswerError(["click_target: probabilities sum"]),
      expected: "click_target: probabilities sum",
    },
    {
      error: new DecisionTransportError(`provider echoed ${secret}`, 429, true),
      expected: "HTTP status: 429",
    },
    {
      error: Object.assign(new ContextLimitError(`page ${secret}`), {
        reductions: ["trace", "advisory"],
      }),
      expected: "reductions tried: trace, advisory",
    },
  ];
  for (const { error, expected } of failures) {
    if (error instanceof DecisionTransportError) error.attempts = 3;
    const fixtureCase = fixture({
      options: { values: { password: secret } },
      decide: async () => {
        throw error;
      },
    });
    try {
      const result = await fixtureCase.session.run();
      assert.equal(result.status, "UNCERTAIN");
      assert.ok(result.details?.includes(expected));
      if (error instanceof DecisionTransportError)
        assert.ok(result.details?.includes("attempts: 3"));
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FAILURE_MARKER|provider echoed/u);
    } finally {
      await fixtureCase.session.close();
    }
  }
});

test("FAILED details identify browser errors without page or secret text", async () => {
  const secret = "PRIVATE_BROWSER_FAILURE_MARKER";
  const examples = [
    {
      error: new CdpProtocolError(-32000, secret, "Page.navigate"),
      expected: "CdpProtocolError: Page.navigate returned code -32000",
    },
    {
      error: new NavigationInProgressError(secret),
      expected: "NavigationInProgressError: navigation interrupted browser operation",
    },
    { error: new Error(secret), expected: "Error" },
  ];
  for (const { error, expected } of examples) {
    const instance = fixture({
      options: { values: { password: secret } },
      observe: async () => {
        throw error;
      },
    });
    try {
      const result = await instance.session.run();
      assert.equal(result.status, "FAILED");
      assert.deepEqual(result.details, [expected]);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BROWSER_FAILURE_MARKER/u);
    } finally {
      await instance.session.close();
    }
  }
});

test("initial navigation timeout returns ERROR_PAGE with target URL before observation", async () => {
  let observed = false;
  const instance = fixture({
    options: { navigation: { url: "http://example.test/slow", headers: {}, failure: "timeout" } },
    observe: async () => {
      observed = true;
      throw new Error("should not observe");
    },
  });
  try {
    const result = await instance.session.run();
    assert.equal(result.status, "ERROR_PAGE");
    assert.equal(result.url, "http://example.test/slow");
    assert.match(result.question, /timeout/u);
    assert.equal(observed, false);
  } finally {
    await instance.session.close();
  }
});

test("configured navigation timeout reaches the executor", async () => {
  const timeouts: number[] = [];
  const actionabilityTimeouts: number[] = [];
  const instance = fixture({
    options: { navigationTimeoutMs: 45_000, actionabilityTimeoutMs: 1750, budget: { steps: 1 } },
    outcomes: [{ type: "act", action: action() }],
    executeAction: async (_page, _before, _action, _values, options) => {
      timeouts.push(options?.navigationTimeoutMs ?? -1);
      actionabilityTimeouts.push(options?.actionabilityTimeoutMs ?? -1);
      return changed();
    },
  });
  try {
    assert.equal((await instance.session.run()).status, "BUDGET_EXHAUSTED");
    assert.deepEqual(timeouts, [45_000]);
    assert.deepEqual(actionabilityTimeouts, [1750]);
  } finally {
    await instance.session.close();
  }
});

test("M6b: waitMs is traced and timeout outcomes pass the result schema", async () => {
  const instance = fixture({
    options: { budget: { steps: 1 }, actionabilityTimeoutMs: 25 },
    outcomes: [{ type: "act", action: action() }],
    execute: () => ({
      ...changed(),
      outcome: "unstable",
      timings: { precheckMs: 25, waitMs: 24, inputMs: 0, settleMs: 0, harnessMs: 25 },
    }),
  });
  try {
    const result = await instance.session.run();
    assert.equal(result.trace[0]?.outcome, "unstable");
    assert.equal(result.trace[0]?.waitMs, 24);
    assert.equal(sessionResultSchema.safeParse(result).success, true);
  } finally {
    await instance.session.close();
  }
});

test("M6c: session close during handoff screenshot capture drops the path", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevpilot-session-capture-test-"));
  const directory = join(root, "handoff");
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const instance = fixture({
    outcomes: [{ type: "handoff", reason: "needs_values", source: "code", details: {} }],
    tempDir: async () => {
      await mkdir(directory);
      return directory;
    },
  });
  instance.page.screenshot = async () => {
    entered();
    await pending;
    return new Uint8Array();
  };
  try {
    const running = instance.session.run();
    await started;
    const closing = instance.session.close();
    release();
    await closing;
    const result = await running;
    assert.equal(existsSync(directory), false);
    assert.equal(result.screenshot_path, undefined);
  } finally {
    release();
    await instance.session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("M6c: session close during an in-flight handoff screenshot leaves no directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevpilot-session-race-test-"));
  const directory = join(root, "handoff");
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const instance = fixture({
    outcomes: [{ type: "handoff", reason: "needs_values", source: "code", details: {} }],
    tempDir: async () => {
      entered();
      await pending;
      await (await import("node:fs/promises")).mkdir(directory);
      return directory;
    },
  });
  try {
    const running = instance.session.run();
    await started;
    const closing = instance.session.close();
    release();
    await closing;
    const result = await running;
    assert.equal(existsSync(directory), false);
    assert.equal(result.screenshot_path, undefined);
  } finally {
    release();
    await instance.session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("M6c: session timing counts each executor millisecond once", async () => {
  const instance = fixture({
    options: { budget: { steps: 1 } },
    outcomes: [{ type: "act", action: action() }],
    execute: () => ({
      ...changed(),
      timings: { precheckMs: 25, waitMs: 24, inputMs: 7, settleMs: 11, harnessMs: 3 },
    }),
  });
  try {
    const result = await instance.session.run();
    assert.equal(result.timing.browser, 42);
    assert.equal(result.timing.harness, 3);
  } finally {
    await instance.session.close();
  }
});

test("M6r: session trace entries carry per-phase timings", async () => {
  const instance = fixture({
    options: { usageDetail: true },
    execute: () => ({
      ...changed(),
      timings: {
        precheckMs: 25.4,
        inputMs: 7.6,
        settleMs: 11.2,
        waitMs: 24.5,
        resolveMs: 3.7,
        observeMs: 9.3,
        harnessMs: 2.9,
      },
    }),
  });
  try {
    const result = await instance.session.act([{ action: "click", ref: "e1" }]);
    assert.deepEqual(result.trace[0]?.phases, {
      precheck: 25,
      input: 8,
      settle: 11,
      wait: 25,
      resolve: 4,
      observe: 9,
      harness: 3,
    });
    assert.equal(sessionResultSchema.safeParse(result).success, true);
  } finally {
    await instance.session.close();
  }

  const withoutOptional = fixture({ options: { usageDetail: true } });
  try {
    const result = await withoutOptional.session.act([{ action: "click", ref: "e1" }]);
    assert.deepEqual(result.trace[0]?.phases, {
      precheck: 0,
      input: 1,
      settle: 1,
      harness: 1,
    });
  } finally {
    await withoutOptional.session.close();
  }
});

test("M6s-3: trace phases include rounded frame timings", async () => {
  const instance = fixture({
    options: { usageDetail: true },
    execute: () => ({
      ...changed(),
      timings: {
        precheckMs: 0,
        inputMs: 1,
        settleMs: 1,
        observeFramesMs: 12.6,
        observeChildFramesMs: 24.3,
        harnessMs: 1,
      },
    }),
  });
  try {
    const result = await instance.session.act([{ action: "click", ref: "e1" }]);
    assert.equal(result.trace[0]?.phases?.frames, 13);
    assert.equal(result.trace[0]?.phases?.children, 24);
    assert.equal(sessionResultSchema.safeParse(result).success, true);
  } finally {
    await instance.session.close();
  }
});

test("page-function failures name the thrown class and our function, never the exception text", async () => {
  const instance = fixture({
    observe: async () => {
      throw new EvaluationError(
        "page function call failed",
        "TypeError: Cannot read properties of null (PRIVATE_PAGE_TEXT_MARKER)",
        { functionName: "pageSnapshot", exceptionClass: "TypeError" },
      );
    },
  });
  try {
    const result = await instance.session.observe();
    assert.equal(result.status, "FAILED");
    assert.deepEqual(result.details, ["EvaluationError: TypeError in pageSnapshot"]);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PAGE_TEXT_MARKER/u);
  } finally {
    await instance.session.close();
  }
});

test("a WAIT counts its waited interval once as browser time", async () => {
  const instance = fixture({
    execute: () => ({
      ...changed(),
      timings: { precheckMs: 0, waitMs: 500, inputMs: 0, settleMs: 500, harnessMs: 0 },
    }),
  });
  try {
    const result = await instance.session.act([{ action: "wait" }]);
    assert.equal(result.timing.browser, 500);
  } finally {
    await instance.session.close();
  }
});

test("decision calibration log contains only redacted classes and final status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevpilot-decision-log-"));
  const path = join(directory, "decisions.jsonl");
  const secret = "CALIBRATION_SECRET_MARKER";
  const pageText = "PAGE_TEXT_MARKER_SHOULD_NOT_APPEAR";
  const instance = fixture({
    options: { values: { secret }, decisionLogPath: path },
    observations: [
      { ...observation([element("Search", "textbox", { value: "" })]), text: pageText },
      { ...observation([], "done"), text: pageText },
    ],
    interpret: () => ({ type: "done_candidate", goalMet: 1 }),
  });
  try {
    assert.equal((await instance.session.run()).status, "DONE_UNVERIFIED");
    const lines = (await readFile(path, "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.at(-1)?.type, "session_end");
    assert.equal(lines.at(-1)?.final_status, "DONE_UNVERIFIED");
    assert.doesNotMatch(JSON.stringify(lines), /CALIBRATION_SECRET_MARKER|PAGE_TEXT_MARKER|http/u);
    assert.ok(lines.some((line) => line.type === "decision"));
  } finally {
    await instance.session.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("O9a: the decision log records latency and attempts for every decision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevpilot-o9a-log-"));
  const successPath = join(directory, "success.jsonl");
  const failurePath = join(directory, "failure.jsonl");
  const successful = fixture({
    options: { decisionLogPath: successPath },
    decide: async () => ({ ...decision, latencyMs: 17, attempts: 2 }),
  });
  const clock = { now: 0 };
  const failed = fixture({
    clock,
    options: { decisionLogPath: failurePath },
    decide: async () => {
      clock.now += 13;
      const error = new DecisionTimeoutError("timed out");
      error.attempts = 3;
      throw error;
    },
  });
  try {
    await successful.session.run();
    await failed.session.run();
    const successLines = (await readFile(successPath, "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const failureLines = (await readFile(failurePath, "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const successDecision = successLines.find((line) => line.type === "decision");
    const failureDecision = failureLines.find((line) => line.type === "decision");
    assert.equal(successDecision?.latencyMs, 17);
    assert.equal(successDecision?.attempts, 2);
    assert.equal(failureDecision?.latencyMs, 13);
    assert.equal(failureDecision?.attempts, 3);
    assert.equal(failureDecision?.error_category, "timeout");
  } finally {
    await successful.session.close();
    await failed.session.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("file secret removes one trailing newline without exposing its path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevpilot-file-secret-"));
  const previousDirectory = process.env.JEVPILOT_SECRETS_DIR;
  process.env.JEVPILOT_SECRETS_DIR = directory;
  const secretPath = join(directory, "password.txt");
  await writeFile(secretPath, "file-secret-marker\r\n\n", "utf8");
  const password = element("Password", "textbox", { inputType: "password", tag: "input" });
  const fixtureCase = fixture({
    observations: [observation([password]), observation([password], "typed")],
    options: {
      values: { password: { secret_ref: `file:${secretPath}`, origins: ["http://example.test"] } },
      budget: { steps: 1 },
    },
    outcomes: [
      {
        type: "act",
        action: {
          kind: "type",
          target: { epoch: 1, ref: "e1", fingerprint: "same" },
          valueKey: "password",
        },
      },
    ],
    execute: (_action, values) => {
      assert.equal(values.password, "file-secret-marker\r\n");
      return changed();
    },
  });
  try {
    const result = await fixtureCase.session.run();
    assert.equal(result.status, "BUDGET_EXHAUSTED");
    assert.doesNotMatch(JSON.stringify(result), /file-secret-marker|password\.txt/u);
  } finally {
    await fixtureCase.session.close();
    await rm(directory, { recursive: true, force: true });
    if (previousDirectory === undefined) delete process.env.JEVPILOT_SECRETS_DIR;
    else process.env.JEVPILOT_SECRETS_DIR = previousDirectory;
  }
});

test("secret references only read approved environment variables", async () => {
  const previousApi = process.env.JEV_API_KEY;
  const previousSecret = process.env.JEVPILOT_SECRET_TEST;
  process.env.JEV_API_KEY = "forbidden-marker";
  process.env.JEVPILOT_SECRET_TEST = "approved-marker";
  const password = element("Password", "textbox", { inputType: "password", tag: "input" });
  const run = async (secret_ref: string) => {
    const fixtureCase = fixture({
      observations: [observation([password]), observation([password], "typed")],
      options: {
        values: { password: { secret_ref, origins: ["http://example.test"] } },
        budget: { steps: 1 },
      },
      outcomes: [
        {
          type: "act",
          action: {
            kind: "type",
            target: { epoch: 1, ref: "e1", fingerprint: "same" },
            valueKey: "password",
          },
        },
      ],
      execute: (_action, values) => {
        assert.equal(values.password, "approved-marker");
        return changed();
      },
    });
    try {
      return { result: await fixtureCase.session.run(), sent: fixtureCase.seen.values.length };
    } finally {
      await fixtureCase.session.close();
    }
  };
  try {
    const denied = await run("env:JEV_API_KEY");
    assert.equal(denied.result.status, "NEEDS_VALUES");
    assert.equal(denied.sent, 0);
    assert.match(denied.result.question, /JEVPILOT_SECRET_/u);
    assert.doesNotMatch(JSON.stringify(denied.result), /JEV_API_KEY|forbidden-marker/u);
    const allowed = await run("env:JEVPILOT_SECRET_TEST");
    assert.equal(allowed.result.status, "BUDGET_EXHAUSTED");
    assert.equal(allowed.sent, 1);
    assert.doesNotMatch(JSON.stringify(allowed.result), /approved-marker/u);
  } finally {
    if (previousApi === undefined) delete process.env.JEV_API_KEY;
    else process.env.JEV_API_KEY = previousApi;
    if (previousSecret === undefined) delete process.env.JEVPILOT_SECRET_TEST;
    else process.env.JEVPILOT_SECRET_TEST = previousSecret;
  }
});

test("file secret references reject outside paths and symlink escapes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jevpilot-secrets-root-"));
  const outside = await mkdtemp(join(tmpdir(), "jevpilot-secrets-outside-"));
  const previousDirectory = process.env.JEVPILOT_SECRETS_DIR;
  process.env.JEVPILOT_SECRETS_DIR = root;
  const allowedPath = join(root, "allowed.txt");
  const outsidePath = join(outside, "outside.txt");
  await writeFile(allowedPath, "approved-file-marker", "utf8");
  await writeFile(outsidePath, "forbidden-file-marker", "utf8");
  const password = element("Password", "textbox", { inputType: "password", tag: "input" });
  const run = async (path: string) => {
    const fixtureCase = fixture({
      observations: [observation([password]), observation([password], "typed")],
      options: {
        values: { password: { secret_ref: `file:${path}`, origins: ["http://example.test"] } },
        budget: { steps: 1 },
      },
      outcomes: [
        {
          type: "act",
          action: {
            kind: "type",
            target: { epoch: 1, ref: "e1", fingerprint: "same" },
            valueKey: "password",
          },
        },
      ],
      execute: (_action, values) => {
        assert.equal(values.password, "approved-file-marker");
        return changed();
      },
    });
    try {
      return { result: await fixtureCase.session.run(), sent: fixtureCase.seen.values.length };
    } finally {
      await fixtureCase.session.close();
    }
  };
  try {
    const denied = await run(outsidePath);
    assert.equal(denied.result.status, "NEEDS_VALUES");
    assert.equal(denied.sent, 0);
    assert.match(denied.result.question, /JEVPILOT_SECRETS_DIR/u);
    assert.doesNotMatch(JSON.stringify(denied.result), /outside\.txt|forbidden-file-marker/u);
    const escaped = await run(join(root, "..", outside.split(/[\\/]/u).at(-1)!, "outside.txt"));
    assert.equal(escaped.result.status, "NEEDS_VALUES");
    const allowed = await run(allowedPath);
    assert.equal(allowed.result.status, "BUDGET_EXHAUSTED");
    assert.equal(allowed.sent, 1);
    const link = join(root, "linked.txt");
    let canLink = true;
    try {
      await symlink(outsidePath, link, "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
        canLink = false;
      else throw error;
    }
    await t.test("symlink target outside secrets directory", { skip: !canLink }, async () => {
      const result = await run(link);
      assert.equal(result.result.status, "NEEDS_VALUES");
      assert.equal(result.sent, 0);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    if (previousDirectory === undefined) delete process.env.JEVPILOT_SECRETS_DIR;
    else process.env.JEVPILOT_SECRETS_DIR = previousDirectory;
  }
});

test("a prompt secret with a mismatched origin is not sent to the page", async () => {
  const dialog = { kind: "prompt" as const, message: "Code", defaultPrompt: "" };
  const fixtureCase = fixture({
    outcomes: [{ type: "act", action: action() }],
    execute: () => ({ ...changed(), outcome: "dialog-opened", dialog }),
    options: {
      values: {
        code: { secret_ref: "env:SECRET_PATH_NOT_SHOWN", origins: ["http://elsewhere.test"] },
      },
    },
  });
  let handled = false;
  fixtureCase.page.handleDialog = async () => {
    handled = true;
  };
  try {
    assert.equal((await fixtureCase.session.run()).status, "NEEDS_VALUES");
    const result = await fixtureCase.session.resume({
      dialog: { accept: true, value_key: "code" },
    });
    assert.equal(result.status, "NEEDS_VALUES");
    assert.equal(handled, false);
    assert.doesNotMatch(JSON.stringify(result), /SECRET_PATH_NOT_SHOWN/u);
  } finally {
    await fixtureCase.session.close();
  }
});

test("close and idle reclaim close the original tab and switched popup", async () => {
  for (const idle of [false, true]) {
    const clock = { now: 0 };
    const popup = new FakePageHandle();
    const fixtureCase = fixture({
      clock,
      outcomes: [{ type: "act", action: action() }],
      options: { budget: { steps: 1 }, idleTimeoutMs: 10 },
      execute: () => {
        fixtureCase.page.emit("popup", popup);
        return changed();
      },
    });
    const closed: string[] = [];
    fixtureCase.page.close = async () => {
      closed.push("original");
    };
    popup.close = async () => {
      closed.push("popup");
    };
    const originalExecute = fixtureCase.session;
    try {
      assert.equal((await originalExecute.run()).status, "BUDGET_EXHAUSTED");
      assert.equal(originalExecute.page, popup);
      if (idle) {
        clock.now = 11;
        assert.equal(await originalExecute.reclaimIdle(), true);
      } else await originalExecute.close();
      assert.deepEqual(closed.sort(), ["original", "popup"]);
    } finally {
      await originalExecute.close();
    }
  }
});

test("R1: a secret is not typed into a field of a cross-origin frame", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevpilot-r1-secret-"));
  const secretFile = join(directory, "value.txt");
  await writeFile(secretFile, "fixture-secret", "utf8");
  const previousDirectory = process.env.JEVPILOT_SECRETS_DIR;
  process.env.JEVPILOT_SECRETS_DIR = directory;
  const field = element("Password", "textbox", {
    tag: "input",
    inputType: "password",
    framePath: "frame:child/",
    origin: "http://child.test",
  });
  const instance = fixture({
    observations: [observation([field])],
    options: {
      values: { password: { secret_ref: `file:${secretFile}`, origins: ["http://example.test"] } },
    },
    execute: () => {
      throw new Error("cross-origin field was typed");
    },
  });
  try {
    const result = await instance.session.act([
      { action: "type", ref: "e1", value_key: "password" },
    ]);
    assert.equal(result.status, "NEEDS_VALUES");
    assert.equal(instance.seen.actions.length, 0);
  } finally {
    await instance.session.close();
    if (previousDirectory === undefined) delete process.env.JEVPILOT_SECRETS_DIR;
    else process.env.JEVPILOT_SECRETS_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test("R1: a secret is not sent to a prompt opened by a cross-origin frame", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevpilot-r1-prompt-"));
  const secretFile = join(directory, "value.txt");
  await writeFile(secretFile, "fixture-secret", "utf8");
  const previousDirectory = process.env.JEVPILOT_SECRETS_DIR;
  process.env.JEVPILOT_SECRETS_DIR = directory;
  const instance = fixture({
    options: {
      values: { password: { secret_ref: `file:${secretFile}`, origins: ["http://example.test"] } },
    },
  });
  const handled: string[] = [];
  instance.page.handleDialog = async (_accept, text) => {
    handled.push(text ?? "");
  };
  try {
    assert.equal((await instance.session.observe()).status, "RUNNING");
    instance.page.emit("dialog", {
      kind: "prompt",
      message: "Password",
      defaultPrompt: "",
      url: "http://child.test/prompt",
      frame: "child",
    });
    const result = await instance.session.act([
      { action: "dialog", accept: true, value_key: "password" },
    ]);
    assert.equal(result.status, "NEEDS_VALUES");
    assert.deepEqual(handled, []);
    instance.page.emit("dialog", {
      kind: "prompt",
      message: "Password",
      defaultPrompt: "",
      url: "http://example.test/prompt",
    });
    const allowed = await instance.session.act([
      { action: "dialog", accept: true, value_key: "password" },
    ]);
    assert.equal(allowed.status, "RUNNING");
    assert.deepEqual(handled, ["fixture-secret"]);
  } finally {
    await instance.session.close();
    if (previousDirectory === undefined) delete process.env.JEVPILOT_SECRETS_DIR;
    else process.env.JEVPILOT_SECRETS_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test("R1: a page that keeps navigating does not hold browser_run past its budget", async () => {
  const clock = { now: 0 };
  let samples = 0;
  let instance: ReturnType<typeof fixture>;
  instance = fixture({
    clock,
    options: { budget: { seconds: 1 } },
    observe: async () => {
      samples++;
      clock.now += 400;
      instance.page.emit("navigated", { url: "http://example.test/again" });
      return observation();
    },
  });
  try {
    const result = await instance.session.run();
    assert.equal(result.status, "BUDGET_EXHAUSTED");
    assert.ok(samples <= 5, `sampled ${samples} times`);
  } finally {
    await instance.session.close();
  }
});

test("R3: Enter or Space on a focused irreversible control waits for approval", async () => {
  const items = [
    element("Buy now", "button", { ref: "e1", tag: "button", inputType: "button" }),
    element("Delete account", "link", {
      ref: "e2",
      tag: "a",
      href: "http://example.test/delete",
    }),
    element("Delete draft", "button", {
      ref: "e3",
      tag: "button",
      inputType: "button",
      formId: "form:draft",
    }),
    element("Title", "textbox", {
      ref: "e4",
      tag: "input",
      inputType: "text",
      formId: "form:draft",
    }),
    element("Save", "button", {
      ref: "e5",
      tag: "button",
      inputType: "submit",
      formId: "form:draft",
    }),
    element("Next", "button", { ref: "e6", tag: "button", inputType: "button" }),
  ];
  const make = (allow = false) =>
    fixture({
      observations: [observation(items)],
      options: { constraints: { allow_irreversible: allow }, budget: { steps: 1 } },
    });
  for (const [ref, key] of [
    ["e1", "Enter"],
    ["e1", "Space"],
    ["e1", " "],
    ["e1", "Control+Enter"],
    ["e2", "Enter"],
    ["e3", "Space"],
    ["e3", "Enter"],
  ] as const) {
    const gated = make();
    const allowed = make(true);
    try {
      gated.page.results.push(true);
      const blocked = await gated.session.act([{ action: "press_key", ref, key }]);
      assert.equal(blocked.status, "CONFIRM_REQUIRED", `${ref} ${key}`);
      assert.equal(gated.seen.actions.length, 0, `${ref} ${key}`);
      const approved = await gated.session.resume({ allow_irreversible: true });
      assert.equal(approved.status, "BUDGET_EXHAUSTED", `${ref} ${key}`);
      assert.equal(gated.seen.actions.length, 1, `${ref} ${key}`);
      const pressed = gated.seen.actions[0] as Extract<Action, { kind: "key" }>;
      assert.equal(pressed.kind, "key");
      assert.equal(pressed.name, key);
      assert.equal(pressed.target?.ref, ref);
      allowed.page.results.push(true);
      assert.notEqual(
        (await allowed.session.act([{ action: "press_key", ref, key }])).status,
        "CONFIRM_REQUIRED",
        `${ref} ${key}`,
      );
      assert.equal(allowed.seen.actions.length, 1, `${ref} ${key}`);
    } finally {
      await gated.session.close();
      await allowed.session.close();
    }
  }
  // A harmless button, a plain field, and keys that do not activate anything are not gated.
  for (const [ref, key] of [
    ["e6", "Enter"],
    ["e6", "Space"],
    ["e4", "Enter"],
    ["e1", "Tab"],
    ["e1", "Escape"],
  ] as const) {
    const instance = make();
    try {
      instance.page.results.push(true);
      const result = await instance.session.act([{ action: "press_key", ref, key }]);
      assert.notEqual(result.status, "CONFIRM_REQUIRED", `${ref} ${key}`);
      assert.equal(instance.seen.actions.length, 1, `${ref} ${key}`);
    } finally {
      await instance.session.close();
    }
  }
});

test("R3: Enter after focusing a control without a ref waits for approval", async () => {
  const buy = element("Buy now", "button", { ref: "e1", tag: "button", inputType: "button" });
  const instance = fixture({
    observations: [observation([buy])],
    options: { budget: { steps: 1 } },
  });
  try {
    instance.page.results.push("e1");
    const blocked = await instance.session.act([{ action: "press_key", key: "Enter" }]);
    assert.equal(blocked.status, "CONFIRM_REQUIRED");
    assert.equal(instance.seen.actions.length, 0);
  } finally {
    await instance.session.close();
  }
});

test("R3: typing with submit into a form with an irreversible submit button waits for approval", async () => {
  const field = element("Quantity", "textbox", {
    ref: "e1",
    tag: "input",
    inputType: "text",
    formId: "form:order",
  });
  const buy = element("Place order", "button", {
    ref: "e2",
    tag: "button",
    inputType: "submit",
    formId: "form:order",
  });
  const search = element("Search", "textbox", { ref: "e3", tag: "input", inputType: "search" });
  const make = (allow = false) =>
    fixture({
      observations: [observation([field, buy, search])],
      options: {
        constraints: { allow_irreversible: allow },
        budget: { steps: 1 },
        values: { quantity: "2" },
      },
    });
  for (const op of [
    { action: "type", ref: "e1", text: "2", submit: true },
    { action: "type", ref: "e1", value_key: "quantity", submit: true },
  ] as const) {
    const gated = make();
    const allowed = make(true);
    try {
      const blocked = await gated.session.act([op]);
      assert.equal(blocked.status, "CONFIRM_REQUIRED", JSON.stringify(op));
      assert.equal(gated.seen.actions.length, 0, JSON.stringify(op));
      const approved = await gated.session.resume({ allow_irreversible: true });
      assert.equal(approved.status, "BUDGET_EXHAUSTED", JSON.stringify(op));
      const typed = gated.seen.actions[0] as Extract<Action, { kind: "type" }>;
      assert.equal(typed.kind, "type");
      assert.equal(typed.submit, true);
      assert.notEqual((await allowed.session.act([op])).status, "CONFIRM_REQUIRED");
      assert.equal(allowed.seen.actions.length, 1);
    } finally {
      await gated.session.close();
      await allowed.session.close();
    }
  }
  const outside = make();
  try {
    const result = await outside.session.act([
      { action: "type", ref: "e3", text: "shoes", submit: true },
    ]);
    assert.notEqual(result.status, "CONFIRM_REQUIRED");
    assert.equal(outside.seen.actions.length, 1);
    const notSubmitting = make();
    try {
      await notSubmitting.session.act([{ action: "type", ref: "e1", text: "2" }]);
      assert.equal(notSubmitting.seen.actions.length, 1);
    } finally {
      await notSubmitting.session.close();
    }
  } finally {
    await outside.session.close();
  }
});

test("R4: encoded and cut-off echoes of a secret are redacted in results and decision requests", async () => {
  const secret = "Pa$$ w0rd/9?&=+ long-token-value-0123456789-abcdefghijklmnopqrstuvwxyz-tail";
  const encoded = encodeURIComponent(secret);
  const cutOff = `${secret.slice(0, 60)}…`;
  const page = observation(
    [
      element("Show password", "button", { ref: "e1" }),
      element("Token", "textbox", { ref: "e2", tag: "input", inputType: "text", value: cutOff }),
      element(`Copy ${cutOff}`, "button", { ref: "e3", containerText: `Signed in ${encoded}` }),
    ],
    "start",
    `http://example.test/login?password=${encoded}`,
  );
  page.title = `Sign in ${encoded.slice(0, 20)}…`;
  page.text = `Wrong password ${secret.replace(/ /gu, "+")} for user`;
  const seen: string[] = [];
  const instance = fixture({
    observations: [page],
    buildDecisionState: (input) => {
      seen.push(JSON.stringify(input.observation));
      return { state: { observation: input.observation }, questions: {}, reductions: [] };
    },
    decide: async (request) => {
      seen.push(JSON.stringify(request));
      return decision;
    },
    outcomes: [{ type: "handoff", reason: "uncertain", source: "code", details: {} }],
  });
  (instance.session as unknown as { secretLiterals: Set<string> }).secretLiterals.add(secret);
  try {
    const result = await instance.session.run();
    const returned = JSON.stringify(result);
    for (const text of [...seen, returned]) {
      assert.ok(text.includes("[REDACTED]"));
      for (const leak of [
        encoded,
        encoded.slice(0, 20),
        cutOff,
        cutOff.slice(0, 12),
        secret.replace(/ /gu, "+"),
      ])
        assert.equal(text.includes(leak), false, leak);
    }
    assert.equal(seen.length, 2);
  } finally {
    await instance.session.close();
  }
});

test("R6: an approval does not carry over to another page", async () => {
  const buy = element("Buy now", "button", { ref: "e1" });
  for (const [next, expected] of [
    ["http://example.test/start#details", "executed"],
    ["http://example.test/other", "refused"],
    ["http://other.test/start", "refused"],
  ] as const) {
    let url = "http://example.test/start";
    const instance = fixture({
      observe: async () => observation([buy], "start", url),
      outcomes: [{ type: "act", action: action(buy) }],
      options: { budget: { steps: 1 } },
    });
    try {
      assert.equal((await instance.session.run()).status, "CONFIRM_REQUIRED");
      url = next;
      const resumed = await instance.session.resume({ allow_irreversible: true });
      if (expected === "executed") {
        assert.equal(instance.seen.actions.length, 1, next);
      } else {
        assert.equal(resumed.status, "UNCERTAIN", next);
        assert.match(resumed.question, /stored target changed/u);
        assert.equal(instance.seen.actions.length, 0, next);
        // The approval is spent: coming back to the page does not revive it.
        url = "http://example.test/start";
        const again = await instance.session.resume({ allow_irreversible: true });
        assert.notEqual(again.status, "DONE_VERIFIED");
        assert.equal(instance.seen.actions.length, 0, next);
      }
    } finally {
      await instance.session.close();
    }
  }
});

test("R6: a dialog that is already gone no longer holds the session", async () => {
  const dialog = { kind: "confirm" as const, message: "Proceed?", defaultPrompt: "" };
  for (const answer of ["resume", "act"] as const) {
    const instance = fixture({
      detect,
      outcomes: [
        { type: "act", action: action() },
        { type: "handoff", reason: "info_not_on_page", source: "code", details: {} },
      ],
      execute: () => ({ ...changed(), outcome: "dialog-opened", dialog }),
    });
    let attempts = 0;
    instance.page.handleDialog = async () => {
      attempts++;
      throw new CdpProtocolError(-32602, "No dialog is showing", "Page.handleJavaScriptDialog");
    };
    try {
      assert.equal((await instance.session.run()).status, "CONFIRM_REQUIRED");
      const answered =
        answer === "resume"
          ? await instance.session.resume({ dialog: { accept: true } })
          : await instance.session.act([{ action: "dialog", accept: true }]);
      assert.notEqual(answered.reason, "operation_failed", answer);
      assert.equal(attempts, 1, answer);
      assert.notEqual((await instance.session.observe()).status, "CONFIRM_REQUIRED", answer);
      assert.equal(attempts, 1, answer);
    } finally {
      await instance.session.close();
    }
  }
  // Any other failure to answer is still reported.
  const failing = fixture({
    detect,
    outcomes: [{ type: "act", action: action() }],
    execute: () => ({ ...changed(), outcome: "dialog-opened", dialog }),
  });
  failing.page.handleDialog = async () => {
    throw new CdpProtocolError(-32000, "Something else failed", "Page.handleJavaScriptDialog");
  };
  try {
    assert.equal((await failing.session.run()).status, "CONFIRM_REQUIRED");
    const result = await failing.session.resume({ dialog: { accept: true } });
    assert.equal(result.status, "FAILED");
    assert.equal((await failing.session.observe()).status, "CONFIRM_REQUIRED");
  } finally {
    await failing.session.close();
  }
});

test("M7b: handoff screenshots are skipped while a session holds unused secret refs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevpilot-m7b-secret-handoff-"));
  const instance = fixture({
    outcomes: [{ type: "handoff", reason: "needs_values", source: "code", details: {} }],
    options: {
      values: {
        password: { secret_ref: "env:JEVPILOT_SECRET_M7B", origins: ["http://example.test"] },
      },
    },
    tempDir: async () => directory,
  });
  let screenshotCalled = false;
  instance.page.screenshot = async () => {
    screenshotCalled = true;
    return new Uint8Array([0xff, 0xd8]);
  };
  try {
    const result = await instance.session.run();
    assert.equal(result.status, "NEEDS_VALUES");
    assert.equal(result.screenshot_path, undefined);
    assert.equal(screenshotCalled, false);
    assert.equal(
      existsSync(join(directory, "handoff-0.jpg")),
      false,
      "no handoff screenshot is written",
    );
  } finally {
    await instance.session.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("M7c: a ref screenshot drops the cached observation so the next hover uses fresh coordinates", async () => {
  let current = observation();
  const instance = fixture({ observe: async () => current });
  instance.page.callIsolated = async (fn) => {
    if (fn.name === "resolveRefInPage")
      return { status: "ok", rect: current.elements[0]!.rect } as never;
    if (fn.name === "refOutsideViewport") return false as never;
    return undefined as never;
  };
  try {
    await instance.session.act([{ action: "click", ref: "e1" }]);
    assert.equal(instance.seen.actions.length, 1);
    assert.ok((await instance.session.screenshot({ ref: "e1" })).ok);
    current = observation([
      element("Next", "button", {
        rect: { x: 300, y: 200, width: 80, height: 40 },
      }),
    ]);
    await instance.session.act([{ action: "hover", ref: "e1" }]);
    assert.deepEqual(instance.page.calls.find((call) => call.name === "hover")?.args, [340, 220]);
  } finally {
    await instance.session.close();
  }
});
