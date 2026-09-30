import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runInNewContext } from "node:vm";
import { estimateTokens } from "../../src/decision/limits.ts";
import {
  formatObservation,
  observe,
  isPaginationElement,
  rankByGoal,
  selectPageText,
  selectElements,
  shortenHref,
  tokenize,
} from "../../src/observer/observe.ts";
import { pageSnapshot, resolveRef, resolveRefInPage } from "../../src/observer/page-snapshot.ts";
import { installObserverLibrary } from "../../src/observer/page-library.ts";
import type { Observation, ObservedElement } from "../../src/observer/types.ts";
import { FakePageHandle } from "../support/fake-engine.ts";
import { PageUnresponsiveError, type FrameHandle } from "../../src/engine/types.ts";

test("observe settles and applies budget, ranking and formatting", async () => {
  const elements = Array.from({ length: 150 }, (_, index) => element(index + 1, `Other ${index}`));
  elements.push(element(151, "Quantum report"));
  const snapshot = observation(elements);
  const { timings: _timings, ...scriptedSnapshot } = snapshot;
  const page = new FakePageHandle(scriptedSnapshot);
  const state = await observe(page, { goal: "Quantum report", maxElements: 5 });
  assert.deepEqual(
    page.calls.map((call) => call.name),
    ["waitForNavigationQuiet", "pageSnapshot"],
  );
  assert.deepEqual(page.calls[0]?.args, [false]);
  assert.equal(state.elements.length, 5);
  assert.ok(state.elements.some((item) => item.name === "Quantum report"));
  assert.match(formatObservation(state), /Quantum report/u);
  assert.ok(estimateTokens(formatObservation(state)) <= 3000);
});

test("observe requests a quiet wait for same-URL navigation events", async () => {
  const { timings: _timings, ...snapshot } = observation([]);
  const page = new FakePageHandle(snapshot);
  await observe(page, { settleNavigation: true });
  assert.deepEqual(page.calls[0]?.args, [true]);
});

test("resolveRef uses the page isolated call", async () => {
  const page = new FakePageHandle({ status: "stale-epoch" });
  assert.deepEqual(await resolveRef(page, 2, "e1", "hash"), { status: "stale-epoch" });
  assert.deepEqual(page.calls, [{ name: "resolveRefInPage", args: [2, "e1", "hash"] }]);
});

test("observer merges cross-origin frame refs and resolves child coordinates", async () => {
  const { timings: _mainTimings, ...main } = observation([
    element(1, "placeholder", {
      role: "frame",
      tag: "iframe",
      rect: { x: 99, y: 199, width: 400, height: 200 },
    }),
  ]);
  const { timings: _childTimings, ...child } = observation([
    element(1, "Inside", {
      role: "input",
      tag: "input",
      rect: { x: 4, y: 6, width: 80, height: 20 },
    }),
  ]);
  child.epoch = 7;
  const { timings: _nestedTimings, ...nested } = observation([
    element(1, "Nested", {
      role: "button",
      tag: "button",
      rect: { x: 3, y: 5, width: 60, height: 20 },
    }),
  ]);
  nested.epoch = 9;
  const page = new FakePageHandle(main);
  const calls: unknown[][] = [];
  page.frameHandles = [
    {
      id: "child",
      offset: { x: 100, y: 200 },
      async callIsolated(fn, args) {
        if (fn.name !== "installObserverLibrary") calls.push(args);
        return (
          fn.name === "pageSnapshot"
            ? child
            : {
                status: "ok",
                rect: { x: 4, y: 6, width: 80, height: 20 },
                visible: true,
                enabled: true,
              }
        ) as Awaited<ReturnType<typeof fn>>;
      },
    },
    {
      id: "nested",
      offset: { x: 124, y: 228 },
      async callIsolated(fn) {
        return (fn.name === "pageSnapshot" ? nested : { status: "missing" }) as Awaited<
          ReturnType<typeof fn>
        >;
      },
    },
  ];
  const state = await observe(page);
  assert.equal(state.elements.length, 2);
  const field = state.elements.find((item) => item.name === "Inside");
  if (!field) throw new Error("missing frame field");
  assert.equal(field.ref, "frame:child@7/e1");
  assert.deepEqual(field.rect, { x: 104, y: 206, width: 80, height: 20 });
  assert.deepEqual(await resolveRef(page, state.epoch, field.ref, field.fingerprint), {
    status: "ok",
    rect: field.rect,
    visible: true,
    enabled: true,
  });
  assert.deepEqual(calls[1], [7, "e1", "hash"]);
  const nestedElement = state.elements.find((item) => item.name === "Nested");
  assert.equal(nestedElement?.ref, "frame:nested@9/e1");
  assert.deepEqual(nestedElement?.rect, { x: 127, y: 233, width: 60, height: 20 });
});

test("M6s: a child frame that does not answer in time is skipped without delaying the snapshot", async () => {
  const { timings: _mainTimings, ...main } = observation([element(1, "Parent")]);
  const { timings: _childTimings, ...child } = observation([element(1, "Other frame")]);
  const page = new FakePageHandle(main);
  page.frameHandles = [
    {
      id: "busy",
      offset: { x: 0, y: 0 },
      callIsolated: () => new Promise<never>(() => {}),
    },
    {
      id: "other",
      offset: { x: 0, y: 0 },
      async callIsolated(fn) {
        return (fn.name === "pageSnapshot" ? child : undefined) as Awaited<ReturnType<typeof fn>>;
      },
    },
  ];
  const started = performance.now();
  const state = await observe(page, { frameTimeoutMs: 80 });
  assert.ok(performance.now() - started < 300);
  assert.deepEqual(
    state.elements.map((item) => item.name),
    ["Parent", "Other frame"],
  );
  assert.equal(state.timings.framesSkipped, 1);
});

test("M6v: frames skipped inside frames() are counted in framesSkipped", async () => {
  const { timings: _timings, ...main } = observation([element(1, "Parent")]);
  const page = new FakePageHandle(main);
  Object.defineProperty(page.frameHandles, "framesSkipped", { value: 2 });
  const state = await observe(page, { frameTimeoutMs: 50 });
  assert.deepEqual(
    state.elements.map((item) => item.name),
    ["Parent"],
  );
  assert.equal(state.timings.framesSkipped, 2);
});

test("M6s: child frames are snapshotted concurrently and merged in document order", async () => {
  const { timings: _mainTimings, ...main } = observation([element(1, "Parent")]);
  const page = new FakePageHandle(main);
  const delays = [105, 80, 55];
  page.frameHandles = delays.map((delay, index): FrameHandle => {
    const { timings: _timings, ...child } = observation([element(1, `Child ${index}`)]);
    child.epoch = index + 2;
    child.pageHash = `hash-${index}`;
    return {
      id: `child-${index}`,
      offset: { x: 0, y: 0 },
      async callIsolated(fn) {
        if (fn.name === "pageSnapshot") {
          await new Promise((resolve) => setTimeout(resolve, delay));
          return child as Awaited<ReturnType<typeof fn>>;
        }
        return undefined as Awaited<ReturnType<typeof fn>>;
      },
    };
  });
  const started = performance.now();
  const state = await observe(page, { frameTimeoutMs: 500 });
  assert.ok(performance.now() - started < 205);
  assert.deepEqual(
    state.elements.map((item) => item.name),
    ["Parent", "Child 0", "Child 1", "Child 2"],
  );
  assert.deepEqual(
    state.elements.slice(1).map((item) => item.ref),
    ["frame:child-0@2/e1", "frame:child-1@3/e1", "frame:child-2@4/e1"],
  );
  assert.equal(state.pageHash, "same:child-0:hash-0:child-1:hash-1:child-2:hash-2");
  assert.equal(state.timings.framesSkipped, undefined);
});

test("M6s: a child-frame timeout never reports the page as unresponsive", async () => {
  const { timings: _timings, ...main } = observation([element(1, "Parent")]);
  const page = new FakePageHandle(main);
  page.frameHandles = [
    {
      id: "timeout",
      offset: { x: 0, y: 0 },
      async callIsolated() {
        throw new PageUnresponsiveError();
      },
    },
  ];
  const state = await observe(page, { frameTimeoutMs: 30 });
  assert.deepEqual(
    state.elements.map((item) => item.name),
    ["Parent"],
  );
  assert.equal(state.timings.framesSkipped, 1);
  const unresponsiveMain = new FakePageHandle(main);
  unresponsiveMain.callIsolated = async (fn, args, options) => {
    if (fn.name === "pageSnapshot") throw new PageUnresponsiveError();
    return page.callIsolated(fn, args, options);
  };
  await assert.rejects(observe(unresponsiveMain, { frameTimeoutMs: 30 }), PageUnresponsiveError);
});

test("M6s-3: a child frame whose snapshot throws is skipped and counted", async () => {
  const { timings: _timings, ...main } = observation([element(1, "Parent")]);
  const { timings: _childTimings, ...child } = observation([element(1, "Healthy child")]);
  const evaluationError = new Error("missing document root");
  evaluationError.name = "EvaluationError";
  const page = new FakePageHandle(main);
  page.frameHandles = [
    {
      id: "broken",
      offset: { x: 0, y: 0 },
      async callIsolated(fn) {
        if (fn.name === "pageSnapshot") throw evaluationError;
        return undefined as Awaited<ReturnType<typeof fn>>;
      },
    },
    {
      id: "healthy",
      offset: { x: 0, y: 0 },
      async callIsolated(fn) {
        return (fn.name === "pageSnapshot" ? child : undefined) as Awaited<ReturnType<typeof fn>>;
      },
    },
  ];
  const state = await observe(page);
  assert.deepEqual(
    state.elements.map((item) => item.name),
    ["Parent", "Healthy child"],
  );
  assert.equal(state.timings.framesFailed, 1);
  assert.equal(state.timings.framesSkipped, undefined);
  const brokenMain = new FakePageHandle(main);
  brokenMain.callIsolated = async (fn, args, options) => {
    if (fn.name === "pageSnapshot") throw evaluationError;
    return page.callIsolated(fn, args, options);
  };
  await assert.rejects(observe(brokenMain), evaluationError);
});

function element(
  ref: number,
  name: string,
  overrides: Partial<ObservedElement> = {},
): ObservedElement {
  return {
    ref: `e${ref}`,
    framePath: "",
    fingerprint: "hash",
    role: "link",
    name,
    tag: "a",
    checked: false,
    selected: false,
    disabled: false,
    readonly: false,
    required: false,
    invalid: false,
    rect: { x: 0, y: ref, width: 50, height: 20 },
    inViewport: true,
    distanceBelowFold: 0,
    ...overrides,
  };
}
function observation(elements: ObservedElement[]): Observation {
  return {
    url: "https://example.test/",
    title: "Test",
    readyState: "complete",
    epoch: 1,
    viewport: { width: 800, height: 600 },
    scroll: { x: 0, y: 0, maxY: 0 },
    elements,
    text: "Body",
    headings: [],
    forms: [],
    signals: {
      passwordFieldVisible: false,
      modalOverlay: false,
      dialogOpen: false,
      iframeOrigins: [],
      scriptOrigins: [],
    },
    pageHash: "same",
    timings: { snapshotMs: 1, totalMs: 2 },
  };
}

function fakeDomElement(
  tag: string,
  attributes: Record<string, string>,
  textContent = "",
): Record<string, unknown> {
  const element: Record<string, unknown> = {
    localName: tag,
    id: attributes.id ?? "",
    textContent,
    childNodes: [],
    parentElement: null,
    previousElementSibling: null,
    isConnected: true,
    type: attributes.type ?? "text",
    required: attributes.required !== undefined,
    getAttribute: (name: string) => attributes[name] ?? null,
    hasAttribute: (name: string) => attributes[name] !== undefined,
    closest: () => null,
    querySelector: () => null,
    getRootNode: () => element.ownerDocument,
    getBoundingClientRect: () => ({ x: 1, y: 2, width: 80, height: 20 }),
  };
  return element;
}

function snapshotInFakePage(elements: Record<string, unknown>[]): ReturnType<typeof pageSnapshot> {
  const document = {
    title: "Test",
    readyState: "complete",
    documentElement: { scrollHeight: 600 },
    body: { textContent: "" },
    forms: [],
    activeElement: null,
    querySelector: () => null,
    querySelectorAll: (query: string) => (query === "*" ? elements : []),
    createTreeWalker: (target: Record<string, unknown>) => {
      const texts = (target.textNodes as string[] | undefined) ?? [];
      let index = 0;
      return {
        nextNode: () =>
          index < texts.length ? { textContent: texts[index++], parentElement: target } : null,
      };
    },
  };
  for (const element of elements) element.ownerDocument = document;
  const context = {
    window: { innerWidth: 800, innerHeight: 600 },
    document,
    location: { href: "https://example.test/" },
    scrollX: 0,
    scrollY: 0,
    NodeFilter: { SHOW_TEXT: 4 },
    ShadowRoot: class {},
    getComputedStyle: () => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
      position: "static",
      cursor: "auto",
    }),
    Map,
    WeakRef,
    Set,
    Math,
    URL,
  };
  runInNewContext(`(${installObserverLibrary.toString()})()`, context);
  const snapshot = runInNewContext(`(${pageSnapshot.toString()})`, context) as typeof pageSnapshot;
  return snapshot({ maxTextChars: 100 });
}

describe("observer selection", () => {
  test("goal-ranked text includes a late fact only for a matching goal", () => {
    const long = `${"Opening context about landmarks.\n".repeat(60)}The Eiffel Tower is 330 metres tall.\nOther records describe ticketing arrangements.`;
    const matching = selectPageText(long, "Eiffel Tower height", 500);
    const unrelated = selectPageText(long, "ticketing arrangements", 500);
    assert.match(matching, /Eiffel Tower is 330 metres tall/u);
    assert.doesNotMatch(unrelated, /330 metres/u);
    assert.ok(matching.length <= 500);
    assert.match(matching, /…/u);
  });

  test("snapshot computes positions from sibling card containers", () => {
    const list = fakeDomElement("section", {});
    list.children = [] as Record<string, unknown>[];
    const buttons = Array.from({ length: 6 }, (_, index) => {
      const card = fakeDomElement("article", {}, `Product ${index + 1}`);
      card.parentElement = list;
      card.matches = () => true;
      card.textNodes = [`Product ${index + 1}`];
      (list.children as Record<string, unknown>[]).push(card);
      const button = fakeDomElement("button", {}, "Add to cart");
      button.parentElement = card;
      button.closest = (selector: string) => (selector.includes("card") ? card : null);
      button.contains = () => false;
      return button;
    });
    const state = snapshotInFakePage(buttons);
    assert.deepEqual(
      Array.from(state.elements, (item) => item.itemPosition),
      [1, 2, 3, 4, 5, 6],
    );
    assert.equal(state.elements[0]?.itemCount, 6);
    assert.equal(state.elements[0]?.containerText, "Product 1");
  });
  test("BM25 ranks Latin and CJK goal matches", () => {
    assert.deepEqual(tokenize("Search 中文页面"), ["search", "中文", "文页", "页面"]);
    const ranked = rankByGoal(
      [element(1, "Sports"), element(2, "中文页面"), element(3, "Search results")],
      "中文页面 search",
    );
    assert.equal(ranked[0]?.ref, "e2");
    assert.equal(ranked[1]?.ref, "e3");
  });
  test("keeps active fields and navigation skeleton when over budget", () => {
    const items = Array.from({ length: 200 }, (_, index) => element(index + 1, `Item ${index}`));
    items[150] = element(151, "Query", { role: "input", inputType: "search", formId: "form" });
    items[151] = element(152, "下一页");
    items[152] = element(153, "Primary", { landmark: "nav" });
    const state = observation(items);
    state.forms = [
      { id: "form", active: true, fields: [{ ref: "e151", required: false, empty: true }] },
    ];
    const selected = selectElements(state, { maxElements: 10 });
    assert.equal(selected.length, 10);
    for (const ref of ["e151", "e152", "e153"])
      assert.equal(
        selected.some((item) => item.ref === ref),
        true,
      );
  });
  test("enforces the 255 choice cap", () => {
    const selected = selectElements(
      observation(Array.from({ length: 300 }, (_, index) => element(index + 1, `Item ${index}`))),
      { maxElements: 300 },
    );
    assert.equal(selected.length, 255);
  });
  test("recognizes pagination by rel, aria label, name, page URL and numbered container", () => {
    const examples = [
      element(1, "More", {
        rel: "next",
        inViewport: false,
        rect: { x: 0, y: 9000, width: 40, height: 20 },
        distanceBelowFold: 8400,
      }),
      element(2, "继续", { ariaLabel: "下一页", inViewport: false }),
      element(3, "›"),
      element(4, "加载更多"),
      element(5, "Results", { href: "/page/3" }),
      element(6, "Results", { href: "/list?page=3" }),
      element(7, "Results", { href: "/list?p=3" }),
      element(8, "4", { paginationContainer: true }),
      element(9, "Show older posts", { rel: "next", href: "/archive" }),
    ];
    for (const item of examples) assert.equal(isPaginationElement(item), true, item.ref);
    assert.equal(isPaginationElement(element(10, "4")), false);
    assert.equal(isPaginationElement(element(11, "Ordinary")), false);
    const selected = selectElements(
      observation([
        ...Array.from({ length: 200 }, (_, index) => element(index + 11, `Item ${index}`)),
        examples[0] as ObservedElement,
      ]),
      { maxElements: 10 },
    );
    assert.ok(selected.some((item) => item.ref === "e1"));
  });
});

describe("observer formatting", () => {
  test("shows placeholder separately only while a field is empty", () => {
    const field = element(1, "", {
      role: "input",
      tag: "input",
      inputType: "search",
      placeholder: "Trending topic",
      value: "",
    });
    assert.match(formatObservation(observation([field])), /placeholder "Trending topic"/u);
    field.value = "query";
    assert.doesNotMatch(formatObservation(observation([field])), /Trending topic/u);
  });
  test("formats exact element lines", () => {
    const state = observation([
      element(3, "姓名", {
        role: "input",
        tag: "input",
        inputType: "text",
        required: true,
        value: "",
      }),
      element(7, "尺寸", {
        role: "select",
        tag: "select",
        optionLabel: "Medium",
        options: ["Small", "Medium", "Large"],
        optionCount: 30,
      }),
      element(9, "112 comments", { href: "/item?id=1" }),
      element(12, "搜索", { role: "button", tag: "button" }),
    ]);
    assert.equal(
      formatObservation(state),
      'url: https://example.test/\ntitle: Test\ne3  input[text]  "姓名"  required  =""\ne7  select  "尺寸"  =Medium  {Small|Medium|Large}+27\ne9  link  "112 comments"  ->/item?id=1\ne12  button  "搜索"\npage: Body',
    );
  });
  test("shrinks text then elements to 3000 estimated tokens", () => {
    const state = observation(
      Array.from({ length: 200 }, (_, index) =>
        element(index + 1, `Long item ${index} ${"x".repeat(100)}`),
      ),
    );
    state.text = "y".repeat(10000);
    assert.ok(estimateTokens(formatObservation(state)) <= 3000);
  });
  test("shortens same-origin and cross-origin URLs only in formatted state", () => {
    const longQuery = `token=${"x".repeat(60)}`;
    const same = `/item?${longQuery}`;
    const cross = "https://ads.example.org/campaign/landing?utm=short";
    const state = observation([
      element(1, "Same", { href: same }),
      element(2, "Ad", { href: cross }),
    ]);
    const formatted = formatObservation(state);
    assert.match(formatted, /->\/item\?…/u);
    assert.match(formatted, /->ads\.example\.org\/campaign\/landing\?utm=short/u);
    assert.equal(state.elements[0]?.href, same);
    assert.equal(state.elements[1]?.href, cross);
    assert.equal(shortenHref(`https://ads.example.org/${"x".repeat(90)}`, state.url).length, 60);
    assert.equal(shortenHref("/item?p=2", state.url), "/item?p=2");
  });
  test("preserves same-document anchors distinctly and fragments on other links", () => {
    const pageUrl = "https://example.test/wiki/Python_(programming_language)";
    assert.equal(shortenHref("#History", pageUrl), "#History");
    assert.equal(shortenHref(`${pageUrl}#Implementations`, pageUrl), "#Implementations");
    assert.equal(shortenHref("/wiki/Other#Notes", pageUrl), "/wiki/Other#Notes");
    assert.equal(
      shortenHref("https://other.test/article#Section", pageUrl),
      "other.test/article#Section",
    );
    const state = observation([
      element(1, "History", { href: "#History" }),
      element(2, "Notes", { href: "#Notes" }),
    ]);
    state.url = pageUrl;
    const formatted = formatObservation(state);
    assert.match(formatted, /->#History/u);
    assert.match(formatted, /->#Notes/u);
  });
});

describe("in-page source", () => {
  test("filled placeholder-only input loses the placeholder name but keeps it as metadata", () => {
    const field = fakeDomElement("input", { placeholder: "Trending topic" });
    field.value = "";
    const empty = snapshotInFakePage([field]).elements[0];
    assert.deepEqual([empty?.name, empty?.placeholder], ["Trending topic", "Trending topic"]);
    field.value = "query";
    const filled = snapshotInFakePage([field]).elements[0];
    assert.deepEqual(
      [filled?.name, filled?.placeholder, filled?.value],
      ["", "Trending topic", "query"],
    );
    assert.doesNotMatch(formatObservation(observation([filled!])), /Trending topic/u);
  });
  test("name chain stops at a suppressed placeholder after explicit labels", () => {
    const field = fakeDomElement("input", { placeholder: "Trending topic" });
    field.parentElement = fakeDomElement("form", {}, "Unrelated form labels");
    field.value = "query";
    assert.equal(snapshotInFakePage([field]).elements[0]?.name, "");

    const labelled = fakeDomElement("input", {
      placeholder: "Trending topic",
      "aria-label": "Search",
    });
    labelled.parentElement = field.parentElement;
    labelled.value = "query";
    assert.equal(snapshotInFakePage([labelled]).elements[0]?.name, "Search");

    const withoutPlaceholder = fakeDomElement("input", {});
    withoutPlaceholder.parentElement = field.parentElement;
    withoutPlaceholder.value = "query";
    assert.equal(
      snapshotInFakePage([withoutPlaceholder]).elements[0]?.name,
      "Unrelated form labels",
    );
    assert.equal(snapshotInFakePage([withoutPlaceholder]).elements[0]?.nameSource, "nearby");
  });
  test("marker scan caps scripts at 200 per frame without duplicate URL lists", () => {
    const scripts = Array.from({ length: 205 }, (_, index) => {
      const script = fakeDomElement("script", {});
      script.src = `https://example.test/script-${index}.js`;
      return script;
    });
    const state = snapshotInFakePage(scripts);
    assert.equal(state.signals.markers?.scripts.length, 200);
    assert.deepEqual(Object.keys(state.signals.markers ?? {}).sort(), [
      "iframes",
      "scanMs",
      "scripts",
      "selectorMatches",
    ]);
  });
  test("filled and empty secrets export only masked values and correct empty flags", () => {
    const cases = [
      {
        attrs: { id: "password", type: "password", "aria-label": "Password", required: "" },
        raw: "filled",
      },
      { attrs: { autocomplete: "current-password", "aria-label": "Current" }, raw: "filled" },
      { attrs: { autocomplete: "one-time-code", "aria-label": "Code" }, raw: "123456" },
      { attrs: { autocomplete: "cc-csc", "aria-label": "CSC" }, raw: "999" },
      { attrs: { name: "password_confirmation", "aria-label": "Toggled" }, raw: "filled" },
      { attrs: { id: "empty-password", type: "password", "aria-label": "Empty" }, raw: "" },
      { attrs: { autocomplete: "one-time-code", "aria-label": "Empty code" }, raw: "" },
    ];
    let reads = 0;
    const inputs = cases.map(({ attrs, raw }) => {
      const input = fakeDomElement("input", attrs);
      Object.defineProperty(input, "value", {
        get: () => {
          reads++;
          return raw;
        },
      });
      return input;
    });
    const state = snapshotInFakePage(inputs);
    assert.equal(reads, cases.length);
    assert.deepEqual(
      Array.from(state.elements, (item) => item.value),
      cases.map(({ raw }) => (raw ? "***" : "")),
    );
    assert.deepEqual(
      Array.from(state.forms[0]?.fields ?? [], (field) => field.empty),
      [false, false, false, false, false, true, true],
    );
    assert.doesNotMatch(JSON.stringify(state), /filled|123456|"999"/u);
  });
  test("identity comparison is installed in the page library and handles drift", () => {
    const context = { Map, Set, Math };
    runInNewContext(`(${installObserverLibrary.toString()})()`, context);
    const library = (
      context as typeof context & {
        __jevpilotObserverLibrary: {
          compareIdentity: (
            expected: { role: string; name: string; formId?: string },
            actual: { role: string; name: string; formId?: string },
            strict?: boolean,
          ) => string;
        };
      }
    ).__jevpilotObserverLibrary;
    assert.equal(
      library.compareIdentity(
        { role: "link", name: "18 comments" },
        { role: "link", name: "18 comments" },
      ),
      "equal",
    );
    assert.equal(
      library.compareIdentity(
        { role: "link", name: "18 comments" },
        { role: "link", name: "19 comments" },
      ),
      "drift",
    );
    assert.equal(
      library.compareIdentity(
        { role: "link", name: "18 comments" },
        { role: "link", name: "19 comments" },
        true,
      ),
      "changed",
    );
    assert.equal(
      library.compareIdentity(
        { role: "link", name: "18 comments", formId: "a" },
        { role: "link", name: "18 comments", formId: "b" },
      ),
      "changed",
    );
  });
  test("submit and image inputs use their HTML accessible names", () => {
    const image = fakeDomElement("input", { type: "image", alt: "Search image" });
    const submit = fakeDomElement("input", { type: "submit", value: "确认支付" });
    const reset = fakeDomElement("input", { type: "reset" });
    assert.deepEqual(
      Array.from(snapshotInFakePage([image, submit, reset]).elements, (item) => item.name),
      ["Search image", "确认支付", "Reset"],
    );
  });
  test("resolveRef fails closed when the stored identity is missing", () => {
    const link = fakeDomElement("a", { href: "/item" }, "Original");
    const context = {
      window: { innerWidth: 800, innerHeight: 600 },
      document: {
        title: "Test",
        readyState: "complete",
        documentElement: { scrollHeight: 600 },
        body: { textContent: "" },
        forms: [],
        activeElement: null,
        querySelector: () => null,
        querySelectorAll: (query: string) => (query === "*" ? [link] : []),
        createTreeWalker: () => ({ nextNode: () => null }),
      },
      location: { href: "https://example.test/" },
      scrollX: 0,
      scrollY: 0,
      NodeFilter: { SHOW_TEXT: 4 },
      ShadowRoot: class {},
      getComputedStyle: () => ({
        display: "block",
        visibility: "visible",
        opacity: "1",
        cursor: "auto",
      }),
      Map,
      WeakRef,
      Set,
      Math,
      URL,
    };
    link.ownerDocument = context.document;
    runInNewContext(`(${installObserverLibrary.toString()})()`, context);
    const snapshot = runInNewContext(
      `(${pageSnapshot.toString()})`,
      context,
    ) as typeof pageSnapshot;
    const resolve = runInNewContext(
      `(${resolveRefInPage.toString()})`,
      context,
    ) as typeof resolveRefInPage;
    const state = snapshot({ maxTextChars: 100 });
    (
      context as typeof context & {
        __jevpilotObserverRegistry: { identities: Map<string, unknown> };
      }
    ).__jevpilotObserverRegistry.identities.clear();
    assert.equal(
      resolve(state.epoch, "e1", state.elements[0]?.fingerprint ?? "").status,
      "identity-changed",
    );
  });
  test("empty icon names use descendants and separate text nodes", () => {
    const image = fakeDomElement("a", { href: "/logo" });
    image.previousElementSibling = fakeDomElement(
      "div",
      {},
      "Main menu Main menu move to sidebar hide Navigation",
    );
    image.childNodes = [{ nodeType: 1, ...fakeDomElement("img", { alt: "Logo alt" }) }];
    const svg = fakeDomElement("a", { href: "/svg" });
    const svgImage = fakeDomElement("svg", {});
    svgImage.childNodes = [{ nodeType: 1, ...fakeDomElement("title", {}, "SVG title") }];
    svg.childNodes = [{ nodeType: 1, ...svgImage }];
    const childLabel = fakeDomElement("button", {});
    childLabel.childNodes = [
      { nodeType: 1, ...fakeDomElement("span", { "aria-label": "Child label" }) },
    ];
    const title = fakeDomElement("a", { href: "/title", title: "Link title" });
    const vote = fakeDomElement("a", { href: "/vote" });
    vote.childNodes = [{ nodeType: 1, ...fakeDomElement("div", { title: "upvote" }) }];
    const card = fakeDomElement("a", { href: "/card" }, "稍后再看14.2万275");
    card.childNodes = ["稍后再看", "14.2万", "275"].map((textContent) => ({
      nodeType: 3,
      textContent,
    }));
    card.textNodes = ["稍后再看", "14.2万", "275"];
    const names = Array.from(
      snapshotInFakePage([image, svg, childLabel, title, vote, card]).elements,
      (item) => item.name,
    );
    assert.deepEqual(names, [
      "Logo alt",
      "SVG title",
      "Child label",
      "Link title",
      "upvote",
      "稍后再看 14.2万 275",
    ]);
  });
  test("geometry skips distant ordinary links but preserves distant pagination", () => {
    const distant = fakeDomElement("a", { href: "/ordinary" }, "Ordinary");
    const pager = fakeDomElement("a", { href: "/page/2", rel: "next" }, "More");
    for (const item of [distant, pager])
      item.getBoundingClientRect = () => ({ x: 1, y: 5000, width: 80, height: 20 });
    const state = snapshotInFakePage([distant, pager]);
    assert.deepEqual(
      Array.from(state.elements, (item) => item.name),
      ["More"],
    );
    assert.equal(state.elements[0]?.pagination, true);
  });
  test("compiles in a fresh realm with no imported bindings", () => {
    for (const fn of [pageSnapshot, resolveRefInPage]) {
      const compiled = runInNewContext(`(${fn.toString()})`);
      assert.equal(typeof compiled, "function");
      assert.doesNotMatch(fn.toString(), /\b(?:estimateTokens|rankByGoal|selectElements)\b/u);
    }
  });
  test("page hash remains stable across identical snapshots", () => {
    const context = {
      window: { innerWidth: 800, innerHeight: 600 },
      document: {
        title: "Test",
        readyState: "complete",
        documentElement: { scrollHeight: 600 },
        body: { textContent: "Hello" },
        querySelector: () => null,
        querySelectorAll: () => [],
        createTreeWalker: () => ({ nextNode: () => null }),
      },
      location: { href: "https://example.test/" },
      NodeFilter: { SHOW_TEXT: 4 },
      scrollX: 0,
      scrollY: 0,
      Map,
      WeakRef,
      Set,
      Math,
      URL,
    };
    runInNewContext(`(${installObserverLibrary.toString()})()`, context);
    const snapshot = runInNewContext(
      `(${pageSnapshot.toString()})`,
      context,
    ) as typeof pageSnapshot;
    const first = snapshot({ maxTextChars: 100 });
    const second = snapshot({ maxTextChars: 100 });
    assert.equal(first.pageHash, second.pageHash);
    assert.equal(second.epoch, first.epoch + 1);
  });
  test("fingerprint is stable and detects a changed accessible name", () => {
    const link = {
      localName: "a",
      textContent: "Original",
      parentElement: null,
      previousElementSibling: null,
      ownerDocument: null as unknown,
      isConnected: true,
      getAttribute: (name: string) => (name === "href" ? "/item" : null),
      hasAttribute: (name: string) => name === "href",
      closest: () => null,
      getRootNode: () => document,
      getBoundingClientRect: () => ({ x: 1, y: 2, width: 50, height: 20 }),
    };
    const document = {
      title: "Test",
      readyState: "complete",
      documentElement: { scrollHeight: 600 },
      body: { textContent: "" },
      forms: [],
      activeElement: null,
      querySelector: () => null,
      querySelectorAll: (query: string) => (query === "*" ? [link] : []),
      createTreeWalker: () => ({ nextNode: () => null }),
    };
    link.ownerDocument = document;
    const context = {
      window: { innerWidth: 800, innerHeight: 600 },
      document,
      location: { href: "https://example.test/" },
      scrollX: 0,
      scrollY: 0,
      NodeFilter: { SHOW_TEXT: 4 },
      ShadowRoot: class {},
      getComputedStyle: () => ({
        display: "block",
        visibility: "visible",
        opacity: "1",
        position: "static",
        cursor: "auto",
      }),
      Map,
      WeakRef,
      Set,
      Math,
      URL,
    };
    runInNewContext(`(${installObserverLibrary.toString()})()`, context);
    const snapshot = runInNewContext(
      `(${pageSnapshot.toString()})`,
      context,
    ) as typeof pageSnapshot;
    const resolve = runInNewContext(
      `(${resolveRefInPage.toString()})`,
      context,
    ) as typeof resolveRefInPage;
    const first = snapshot({ maxTextChars: 100 });
    const second = snapshot({ maxTextChars: 100 });
    assert.equal(first.elements[0]?.fingerprint, second.elements[0]?.fingerprint);
    assert.equal(resolve(second.epoch, "e1", second.elements[0]?.fingerprint ?? "").status, "ok");
    link.textContent = "Changed";
    assert.equal(
      resolve(second.epoch, "e1", second.elements[0]?.fingerprint ?? "").status,
      "identity-changed",
    );
  });
  test("secret resolution compares same-length password and one-time-code values without exporting them", () => {
    const input = {
      localName: "input",
      type: "password",
      value: "aabb",
      checked: false,
      disabled: false,
      labels: [],
      form: null,
      textContent: "",
      isConnected: true,
      ownerDocument: null as unknown,
      getAttribute: (name: string): string | null =>
        name === "aria-label" || name === "placeholder" ? "Password" : null,
      hasAttribute: () => false,
      closest: () => null,
      getBoundingClientRect: () => ({
        x: 10,
        y: 10,
        width: 100,
        height: 20,
        top: 10,
        left: 10,
        right: 110,
        bottom: 30,
      }),
    };
    const document = {
      elementFromPoint: () => input,
    };
    input.ownerDocument = document;
    let fingerprintCode = 2166136261;
    for (const character of "input\u0000Password\u0000implicit") {
      fingerprintCode ^= character.charCodeAt(0);
      fingerprintCode = Math.imul(fingerprintCode, 16777619);
    }
    const context = {
      document,
      innerWidth: 800,
      innerHeight: 600,
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      __jevpilotObserverRegistry: {
        epoch: 1,
        refs: new Map([["e1", new WeakRef(input)]]),
        locations: new Map(),
        identities: new Map([["e1", { role: "input", name: "Password", formId: "implicit" }]]),
      },
      Map,
      Math,
    };
    runInNewContext(`(${installObserverLibrary.toString()})()`, context);
    const resolve = runInNewContext(
      `(${resolveRefInPage.toString()})`,
      context,
    ) as typeof resolveRefInPage;
    const fingerprint = (fingerprintCode >>> 0).toString(36);
    const before = resolve(1, "e1", fingerprint, true);
    assert.equal(before.status, "ok");
    input.value = "ccdd";
    const after = resolve(1, "e1", fingerprint);
    assert.equal(after.valueChanged, true);
    assert.equal(after.value, undefined);
    assert.equal(after.valueLength, undefined);
    assert.doesNotMatch(JSON.stringify({ before, after }), /aabb|ccdd/u);
    assert.deepEqual(
      Object.keys(after).filter((key) => key.toLowerCase().includes("hash")),
      [],
    );
    input.type = "text";
    input.getAttribute = (name: string) =>
      name === "aria-label" || name === "placeholder"
        ? "Password"
        : name === "autocomplete"
          ? "one-time-code"
          : null;
    input.value = "111111";
    const codeBefore = resolve(1, "e1", fingerprint, true);
    input.value = "222222";
    const codeAfter = resolve(1, "e1", fingerprint);
    assert.equal(codeAfter.valueChanged, true);
    assert.equal(codeAfter.value, undefined);
    assert.equal(codeAfter.valueLength, undefined);
    assert.doesNotMatch(JSON.stringify({ codeBefore, codeAfter }), /111111|222222/u);
  });
});

test("R7: a link target written with line breaks cannot add lines to the observation", () => {
  const pageUrl = "https://example.test/start";
  const separator = String.fromCharCode(0x2028);
  const nextLine = String.fromCharCode(0x85);
  const lineBreak = new RegExp(`[\\r\\n${separator}${nextLine}]`, "u");
  for (const href of [
    'javascript:void(0)\ne9  button  "Confirm payment"',
    'mailto:a@example.test\r\ne9  button  "Confirm payment"',
    `tel:123${separator}e9  button  ${nextLine}Pay`,
    'http://[bad\ne9  button  "Pay"',
  ]) {
    const shortened = shortenHref(href, pageUrl);
    assert.doesNotMatch(shortened, lineBreak, JSON.stringify(href));
    assert.ok(shortened.length <= 60, JSON.stringify(href));
    const state = observation([element(1, "Docs", { href })]);
    const lines = formatObservation(state).split(lineBreak);
    assert.equal(lines.filter((line) => line.startsWith("e")).length, 1, JSON.stringify(href));
  }
  assert.equal(shortenHref("javascript:void(0)", pageUrl), "javascript:void(0)");
  assert.equal(shortenHref("/item?p=2", pageUrl), "/item?p=2");
});
