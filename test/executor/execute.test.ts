import assert from "node:assert/strict";
import { test } from "node:test";
import {
  executeAction,
  diffState,
  selectKeySteps,
  settleStrategy,
} from "../../src/executor/execute.ts";
import { ActionValidationError, type Action } from "../../src/executor/types.ts";
import type { Observation } from "../../src/observer/types.ts";
import { FakePageHandle } from "../support/fake-engine.ts";

const target = { epoch: 1, ref: "e1", fingerprint: "abc" };
const observation: Observation = {
  url: "https://fixture.test/",
  title: "Fixture",
  readyState: "complete",
  epoch: 1,
  viewport: { width: 800, height: 600 },
  scroll: { x: 0, y: 0, maxY: 0 },
  elements: [],
  text: "",
  headings: [],
  forms: [],
  signals: {
    passwordFieldVisible: false,
    modalOverlay: false,
    dialogOpen: false,
    iframeOrigins: [],
    scriptOrigins: [],
  },
  pageHash: "one",
  timings: { snapshotMs: 0, totalMs: 0 },
};

test("type requires caller valueKey and never includes secret in errors", async () => {
  const page = new FakePageHandle();
  const action: Action = { kind: "type", target, valueKey: "password" };
  await assert.rejects(executeAction(page, observation, action), (error: unknown) => {
    assert.ok(error instanceof ActionValidationError);
    assert.equal(error.code, "missing-value");
    assert.doesNotMatch(error.message, /secret/u);
    return true;
  });
  assert.equal(page.calls.length, 0);
});

test("O9e: typing ends with a key press that carries the full value", async () => {
  const page = new FakePageHandle();
  page.results.push(
    { status: "ok", visible: true, enabled: true },
    { status: "ok" },
    true,
    observation,
  );
  const field = { ...target, fingerprint: "abc" };
  await executeAction(
    page,
    {
      ...observation,
      elements: [
        {
          ref: "e1",
          framePath: "",
          fingerprint: "abc",
          role: "textbox",
          name: "Text",
          tag: "input",
          inputType: "text",
          checked: false,
          selected: false,
          disabled: false,
          readonly: false,
          required: false,
          invalid: false,
          rect: { x: 0, y: 0, width: 100, height: 20 },
          inViewport: true,
          distanceBelowFold: 0,
        },
      ],
    },
    { kind: "type", target: field, text: "价格 👍🏽", submit: true },
  );
  assert.deepEqual(
    page.calls
      .filter((call) => ["insertText", "tapShift", "key"].includes(call.name))
      .map((call) => [call.name, call.args[0]]),
    [
      ["insertText", "价格 👍🏽"],
      ["tapShift", undefined],
      ["key", "Enter"],
    ],
  );
});

test("stale ref short circuits all input", async () => {
  const page = new FakePageHandle({ status: "identity-changed" });
  const result = await executeAction(page, observation, { kind: "click", target });
  assert.equal(result.outcome, "stale");
  assert.equal(
    page.calls.some((call) => call.name === "click"),
    false,
  );
});

test("observation quiet wait counts as executor settle time", async () => {
  class TimedPage extends FakePageHandle {
    override async callIsolated<A extends unknown[], R>(
      fn: (...args: A) => R | Promise<R>,
      args: A,
    ): Promise<R> {
      const value = await super.callIsolated(fn, args);
      return (fn.name === "waitForNavigationQuiet" ? 300 : value) as R;
    }
  }
  const page = new TimedPage(undefined, observation);
  const result = await executeAction(page, observation, { kind: "wait" });
  assert.ok(result.timings.settleMs >= 300);
  assert.ok(result.timings.harnessMs < 100);
});

test("M6d: WAIT waits for a page change up to its bound", async () => {
  class ChangingPage extends FakePageHandle {
    override async callIsolated<A extends unknown[], R>(
      fn: (...args: A) => R | Promise<R>,
      args: A,
    ): Promise<R> {
      if (fn.name === "settleInPage") {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return true as R;
      }
      return super.callIsolated(fn, args);
    }
  }
  const page = new ChangingPage({ ...observation, pageHash: "two" });
  const result = await executeAction(
    page,
    observation,
    { kind: "wait" },
    {},
    { waitTimeoutMs: 3000 },
  );
  assert.equal(result.outcome, "changed");
  assert.ok((result.timings.waitMs ?? 0) >= 35);
  assert.ok((result.timings.waitMs ?? 0) < 1000);
});

test("M6c: executor harness excludes wait, input and settle time", async () => {
  class TimedPage extends FakePageHandle {
    override async key(name: string) {
      await new Promise((resolve) => setTimeout(resolve, 45));
      return super.key(name);
    }
  }
  const page = new TimedPage(undefined, observation);
  const started = performance.now();
  const result = await executeAction(page, observation, { kind: "key", name: "Tab" });
  const total = performance.now() - started;
  const timings = result.timings;
  assert.ok(timings.inputMs >= 40);
  assert.ok(timings.harnessMs < 20, `harness ${timings.harnessMs}`);
  assert.ok(
    Math.abs(
      timings.harnessMs + (timings.waitMs ?? 0) + timings.inputMs + timings.settleMs - total,
    ) <= 10,
  );
});

test("M6x: the executor waits for a popup that starts opening during the action", async () => {
  class PopupPage extends FakePageHandle {
    override async key(name: string) {
      const result = await super.key(name);
      this.emit("popupOpening", { targetId: "fake-page" });
      setTimeout(() => this.emit("popup", new FakePageHandle()), 20);
      return result;
    }
  }
  const page = new PopupPage(0, observation);
  const result = await executeAction(page, observation, { kind: "key", name: "Enter" });
  assert.equal(result.popup, "opened");
  assert.ok((result.timings.waitMs ?? 0) >= 15);
});

test("M6x: the executor does not wait when no popup is opening", async () => {
  const page = new FakePageHandle(0, observation);
  const started = performance.now();
  const result = await executeAction(page, observation, { kind: "key", name: "Enter" });
  assert.equal(result.popup, undefined);
  assert.ok(performance.now() - started < 500);
});

test("M6x: a popup that never attaches ends the executor wait within popupWaitMs", async () => {
  class OpeningPage extends FakePageHandle {
    override async key(name: string) {
      const result = await super.key(name);
      this.emit("popupOpening", { targetId: "missing" });
      return result;
    }
  }
  const page = new OpeningPage(0, observation);
  const started = performance.now();
  const result = await executeAction(
    page,
    observation,
    { kind: "key", name: "Enter" },
    {},
    { popupWaitMs: 35 },
  );
  assert.equal(result.popup, "pending");
  assert.ok(performance.now() - started < 500);
});

test("M6r: executor timings report the post-action resolve and observe time", async () => {
  class TimedPage extends FakePageHandle {
    override async callIsolated<A extends unknown[], R>(
      fn: (...args: A) => R | Promise<R>,
      args: A,
    ): Promise<R> {
      if (fn.name === "waitForNavigationQuiet") {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return 20 as R;
      }
      if (fn.name === "resolveRefInPage") await new Promise((resolve) => setTimeout(resolve, 15));
      return super.callIsolated(fn, args);
    }
  }
  const page = new TimedPage(
    { status: "ok", visible: true, enabled: true },
    false,
    { status: "ok" },
    observation,
  );
  const result = await executeAction(page, observation, { kind: "click", target });
  assert.ok(result.timings.resolveMs !== undefined && result.timings.resolveMs >= 10);
  assert.ok(result.timings.observeMs !== undefined && result.timings.observeMs >= 20);
  assert.ok(result.timings.observeMs >= result.timings.settleMs - 1);

  class NavigatingPage extends TimedPage {
    override async click(x: number, y: number) {
      const input = await super.click(x, y);
      this.emit("navigationRequested", { url: "https://fixture.test/next" });
      this.emit("domContentLoaded", { url: "https://fixture.test/next" });
      return input;
    }
  }
  const navigating = new NavigatingPage(
    { status: "ok", visible: true, enabled: true },
    observation,
  );
  const navigated = await executeAction(navigating, observation, { kind: "click", target });
  assert.equal(navigated.timings.resolveMs, 0);
  assert.ok(navigated.timings.observeMs !== undefined && navigated.timings.observeMs >= 20);
});

test("a click that starts a download does not wait for navigation", async () => {
  class DownloadPage extends FakePageHandle {
    override async click(x: number, y: number) {
      const input = await super.click(x, y);
      this.emit("navigationRequested", { url: "https://fixture.test/file" });
      this.emit("download", {
        id: "download-guid",
        url: "https://signed.example/file",
        suggestedFilename: "file.csv",
        state: "started",
      });
      return input;
    }
  }
  const downloadPage = new DownloadPage(
    { status: "ok", visible: true, enabled: true },
    observation,
  );
  const started = performance.now();
  await executeAction(
    downloadPage,
    observation,
    { kind: "click", target },
    {},
    {
      navigationTimeoutMs: 30_000,
    },
  );
  assert.ok(performance.now() - started < 1000);

  class RealNavigationPage extends FakePageHandle {
    override async click(x: number, y: number) {
      const input = await super.click(x, y);
      this.emit("navigationRequested", { url: "https://fixture.test/next" });
      setTimeout(() => {
        this.emit("navigated", { url: "https://fixture.test/next" });
        this.emit("domContentLoaded", { url: "https://fixture.test/next" });
      }, 50);
      return input;
    }
  }
  const navigationPage = new RealNavigationPage(
    { status: "ok", visible: true, enabled: true },
    observation,
  );
  const navigationStarted = performance.now();
  await executeAction(
    navigationPage,
    observation,
    { kind: "click", target },
    {},
    {
      navigationTimeoutMs: 30_000,
    },
  );
  assert.ok(performance.now() - navigationStarted >= 40);
});

test("M6s-3: observation and trace carry frames and child-frame timings", async () => {
  const page = new FakePageHandle(undefined, observation);
  page.frames = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return [
      {
        id: "child",
        offset: { x: 0, y: 0 },
        async callIsolated<A extends unknown[], R>(fn: (...args: A) => R | Promise<R>): Promise<R> {
          if (fn.name === "pageSnapshot") {
            await new Promise((resolve) => setTimeout(resolve, 20));
            const { timings: _timings, ...snapshot } = observation;
            return snapshot as R;
          }
          return undefined as R;
        },
      },
    ];
  };
  const result = await executeAction(page, observation, { kind: "key", name: "Tab" });
  assert.ok(result.timings.observeFramesMs !== undefined && result.timings.observeFramesMs >= 15);
  assert.ok(
    result.timings.observeChildFramesMs !== undefined && result.timings.observeChildFramesMs >= 15,
  );
});

test("SUBMIT uses trusted Enter on eligible focus before resolving a stale ref", async () => {
  const state = {
    ...observation,
    elements: [
      {
        ref: "e1",
        framePath: "",
        fingerprint: "abc",
        role: "searchbox",
        name: "Search",
        tag: "input",
        inputType: "search",
        formId: "form:search",
        value: "query",
        checked: false,
        selected: false,
        disabled: false,
        readonly: false,
        required: false,
        invalid: false,
        rect: { x: 0, y: 0, width: 100, height: 20 },
        inViewport: true,
        distanceBelowFold: 0,
      },
    ],
  } satisfies Observation;
  const focused = new FakePageHandle(
    undefined,
    { status: "missing" },
    { ...state, pageHash: "two" },
  );
  focused.focusedSubmit = true;
  const outcome = await executeAction(focused, state, { kind: "submit", target });
  assert.equal(outcome.outcome, "changed");
  assert.deepEqual(focused.calls.filter((call) => call.name === "focusedSubmitTarget")[0]?.args, [
    1,
    "e1",
    "form:search",
    true,
  ]);
  assert.ok(focused.calls.some((call) => call.name === "key" && call.args[0] === "Enter"));
  assert.ok(!focused.calls.some((call) => call.name === "focusRefInPage"));
});

test("covered and disabled refs short circuit all input", async () => {
  const covered = new FakePageHandle({
    status: "ok",
    visible: true,
    enabled: true,
    coveredBy: { role: "banner", name: "Cookies" },
  });
  const result = await executeAction(covered, observation, { kind: "click", target });
  assert.equal(result.outcome, "covered");
  assert.deepEqual(result.coveredBy, { role: "banner", name: "Cookies" });
  assert.equal(
    covered.calls.some((call) => call.name === "click"),
    false,
  );
  const disabled = new FakePageHandle({ status: "ok", visible: true, enabled: false });
  assert.equal(
    (await executeAction(disabled, observation, { kind: "click", target })).outcome,
    "disabled",
  );
  assert.equal(
    disabled.calls.some((call) => call.name === "click"),
    false,
  );
});

test("M6b: wait decision returns at once when ready", async () => {
  const page = new FakePageHandle(
    { status: "ok", visible: true, enabled: true, waitMs: 0 },
    undefined,
    { status: "ok" },
    observation,
  );
  const result = await executeAction(page, observation, { kind: "click", target });
  assert.equal(result.timings.waitMs, 0);
  assert.equal(page.calls.find((call) => call.name === "resolveRefInPage")?.args[5], "click");
});

test("M6b: wait decision proceeds when the target becomes enabled", async () => {
  const page = new FakePageHandle(
    { status: "ok", visible: true, enabled: true, waitMs: 302 },
    undefined,
    { status: "ok" },
    observation,
  );
  const result = await executeAction(
    page,
    observation,
    { kind: "click", target },
    {},
    { actionabilityTimeoutMs: 750 },
  );
  assert.equal(result.timings.waitMs, 302);
  assert.ok(page.calls.some((call) => call.name === "click"));
  assert.equal(page.calls.find((call) => call.name === "resolveRefInPage")?.args[6], 750);
});

test("M6b: wait decision times out with the first unmet check", async () => {
  const page = new FakePageHandle({
    status: "ok",
    visible: false,
    enabled: false,
    unmet: "invisible",
    waitMs: 25,
  });
  const result = await executeAction(page, observation, { kind: "click", target });
  assert.equal(result.outcome, "invisible");
  assert.equal(result.timings.waitMs, 25);
});

test("M6b: transient popup cover returns covered without waiting", async () => {
  const page = new FakePageHandle({
    status: "ok",
    visible: true,
    enabled: true,
    unmet: "covered",
    coveredBy: { role: "listbox", name: "Choices" },
    waitMs: 0,
  });
  const result = await executeAction(page, observation, { kind: "click", target });
  assert.equal(result.outcome, "covered");
  assert.equal(result.timings.waitMs, 0);
});

test("M6b: identity change returns stale without waiting", async () => {
  const page = new FakePageHandle({ status: "identity-changed", waitMs: 0 });
  const result = await executeAction(page, observation, { kind: "click", target });
  assert.equal(result.outcome, "stale");
  assert.equal(result.timings.waitMs, 0);
});

test("M6b: non-interactive cover over an editable field selects the focus path", async () => {
  const page = new FakePageHandle(
    { status: "ok", visible: true, enabled: true, focusPath: true, waitMs: 0 },
    undefined,
    undefined,
    { status: "ok" },
    observation,
  );
  await executeAction(page, observation, { kind: "type", target, text: "value" });
  assert.ok(page.calls.some((call) => call.name === "focusRefInPage"));
  assert.ok(page.calls.some((call) => call.name === "insertText"));
  assert.ok(!page.calls.some((call) => call.name === "click"));
});

test("href click waits for a navigation request 150 ms after input", async () => {
  const before: Observation = {
    ...observation,
    elements: [
      {
        ref: "e1",
        framePath: "",
        fingerprint: "abc",
        role: "link",
        name: "Next",
        tag: "a",
        href: "https://fixture.test/next",
        checked: false,
        selected: false,
        disabled: false,
        readonly: false,
        required: false,
        invalid: false,
        rect: { x: 0, y: 0, width: 100, height: 20 },
        inViewport: true,
        distanceBelowFold: 0,
      },
    ],
  };
  class DelayedPage extends FakePageHandle {
    override async click(x: number, y: number) {
      const result = await super.click(x, y);
      setTimeout(() => {
        this.emit("navigationRequested", { url: "https://fixture.test/next" });
        this.emit("navigated", { url: "https://fixture.test/next" });
        this.emit("domContentLoaded", { url: "https://fixture.test/next" });
      }, 150);
      return result;
    }
  }
  const page = new DelayedPage(
    { status: "ok", visible: true, enabled: true, rect: { x: 0, y: 0, width: 100, height: 20 } },
    undefined,
    { ...before, url: "https://fixture.test/next", pageHash: "next" },
  );
  const result = await executeAction(page, before, { kind: "click", target });
  assert.equal(result.changes.url, true);
  assert.equal(result.url, "https://fixture.test/next");
});

test("select direction and suggestion settle strategy", () => {
  assert.deepEqual(selectKeySteps(5, 2), ["ArrowUp", "ArrowUp", "ArrowUp"]);
  assert.deepEqual(selectKeySteps(2, 5), ["ArrowDown", "ArrowDown", "ArrowDown"]);
  assert.deepEqual(selectKeySteps(2, 2), []);
  const action: Action = { kind: "type", target, valueKey: "query" };
  assert.equal(settleStrategy(action, "searchbox"), "suggestions");
  assert.equal(settleStrategy(action, "combobox"), "suggestions");
  assert.equal(settleStrategy(action, "textbox"), "normal");
});

test("native popup select commits keyboard steps with Enter before verifying", async () => {
  const page = new FakePageHandle(
    {
      status: "ok",
      visible: true,
      enabled: true,
      rect: { x: 10, y: 10, width: 80, height: 20 },
      selectedIndex: 0,
      selectedLabel: "First",
      optionLabels: ["First", "Second", "Third"],
      selectPopup: true,
    },
    undefined,
    { status: "ok", selectedLabel: "Third" },
    { ...observation, pageHash: "two" },
  );
  const result = await executeAction(page, observation, {
    kind: "select",
    target,
    optionLabel: "Third",
  });
  assert.equal(result.outcome, "changed");
  assert.deepEqual(
    page.calls.filter((call) => call.name === "key").map((call) => call.args[0]),
    ["ArrowDown", "ArrowDown", "Enter"],
  );
});

test("listbox select focuses in isolated world and verifies after arrow keys", async () => {
  const page = new FakePageHandle(
    {
      status: "ok",
      visible: true,
      enabled: true,
      rect: { x: 10, y: 10, width: 80, height: 20 },
      selectedIndex: 0,
      selectedLabel: "First",
      optionLabels: ["First", "Second"],
      selectPopup: false,
    },
    undefined,
    undefined,
    { status: "ok", selectedLabel: "Second" },
    { ...observation, pageHash: "two" },
  );
  const result = await executeAction(page, observation, {
    kind: "select",
    target,
    optionLabel: "Second",
  });
  assert.equal(result.outcome, "changed");
  assert.ok(page.calls.some((call) => call.name === "focusRefInPage"));
  assert.deepEqual(
    page.calls.filter((call) => call.name === "key").map((call) => call.args[0]),
    ["ArrowDown"],
  );
});

test("post-check diff compares URL, page hash, value and checked without echoing values", () => {
  const changes = diffState(
    observation,
    { ...observation, url: "https://fixture.test/next", pageHash: "two" },
    { valueLength: 2, checked: false, status: "ok" },
    { valueLength: 8, checked: true, status: "ok" },
  );
  assert.deepEqual(changes, { url: true, pageHash: true, value: true, checked: true });
  assert.doesNotMatch(JSON.stringify(changes), /secret/u);
});

test("same-length secret replacement is changed without exposing either value or hash", () => {
  const changes = diffState(
    observation,
    observation,
    { status: "ok", checked: false },
    { status: "ok", checked: false, valueChanged: true },
  );
  assert.deepEqual(changes, { url: false, pageHash: false, value: true, checked: false });
  assert.deepEqual(Object.keys(changes), ["url", "pageHash", "value", "checked"]);
});
