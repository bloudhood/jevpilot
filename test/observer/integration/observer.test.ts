import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { findChrome } from "../../../src/browser/launcher.ts";
import { createCdpDriver } from "../../../src/engine/cdp/driver.ts";
import type { BrowserHandle, PageHandle } from "../../../src/engine/types.ts";
import { observe, formatObservation } from "../../../src/observer/observe.ts";
import { resolveRef } from "../../../src/observer/page-snapshot.ts";
import { estimateTokens } from "../../../src/decision/limits.ts";
import { buildQuestions } from "../../../src/policy/index.ts";
import { chromeAccessibleName } from "../../support/ax-name.ts";
import { testProfile } from "../../support/browser-profile.ts";

const executable = await findChrome();
const skipped =
  process.env.JEVPILOT_SKIP_BROWSER === "1"
    ? "JEVPILOT_SKIP_BROWSER=1"
    : !executable
      ? "Chrome executable not found"
      : undefined;
const fixtures = fileURLToPath(new URL("../../fixtures/pages/", import.meta.url));

describe("real Chrome page Observer", { skip: skipped }, () => {
  let browser: BrowserHandle;
  let directory: string;
  let primary: Server;
  let cross: Server;
  let baseUrl: string;
  let crossUrl: string;
  before(async () => {
    const observerHtml = await readFile(join(fixtures, "observer.html"), "utf8");
    const longHtml = await readFile(join(fixtures, "long.html"), "utf8");
    const cardsHtml = await readFile(join(fixtures, "product-cards.html"), "utf8");
    const articleHtml = await readFile(join(fixtures, "article-deep.html"), "utf8");
    const shadowHtml = await readFile(join(fixtures, "shadow-content.html"), "utf8");
    const delayedHtml = await readFile(join(fixtures, "delayed-content.html"), "utf8");
    const namesHtml = await readFile(join(fixtures, "m6a-names.html"), "utf8");
    const storiesHtml = await readFile(join(fixtures, "m6a-stories.html"), "utf8");
    const m6wHtml = await readFile(join(fixtures, "m6w-icons.html"), "utf8");
    cross = createServer((request, response) => {
      // Without a charset, zh-CN Chrome decodes as GBK and the Chinese label becomes mojibake.
      response.setHeader("content-type", "text/html; charset=utf-8");
      if (request.url === "/busy")
        response.end(
          // postMessage leaves the frame only after the current task, so the busy loop runs in a later task.
          '<script>window.addEventListener("load", () => { parent.postMessage("busy-start", "*"); setTimeout(() => { const end = performance.now() + 5000; while (performance.now() < end) {} }, 300); });</script>',
        );
      else if (request.url === "/no-root")
        response.end(
          '<script>addEventListener("load", () => { document.documentElement.remove(); parent.postMessage("root-removed", "*") })</script>',
        );
      else response.end("<p>Cross origin frame</p><button>跨源按钮</button>");
    });
    await new Promise<void>((resolve) => cross.listen(0, "127.0.0.1", resolve));
    const crossAddress = cross.address();
    if (typeof crossAddress !== "object" || !crossAddress) throw new Error("missing cross port");
    crossUrl = `http://127.0.0.1:${crossAddress.port}/cross`;
    primary = createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      if (request.url === "/frame")
        response.end('<form><label>框内字段<input id="frame-field"></label></form>');
      else if (request.url === "/long") response.end(longHtml);
      else if (request.url === "/products") response.end(cardsHtml);
      else if (request.url === "/article-deep") response.end(articleHtml);
      else if (request.url === "/shadow-content") response.end(shadowHtml);
      else if (request.url === "/delayed-content") response.end(delayedHtml);
      else if (request.url === "/m6a-names") response.end(namesHtml);
      else if (request.url === "/m6a-stories") response.end(storiesHtml);
      else if (request.url === "/m6w-icons") response.end(m6wHtml);
      else if (request.url === "/busy-frame")
        response.end(
          `<button>Parent action</button><script>addEventListener("message", event => { if (event.data === "busy-start") document.body.dataset.busy = "yes" })</script><iframe src="${crossUrl.replace("127.0.0.1", "localhost").replace("/cross", "/busy")}"></iframe>`,
        );
      else if (request.url === "/no-root-frame")
        response.end(
          `<button>Parent action</button><script>addEventListener("message", event => { if (event.data === "root-removed") document.body.dataset.rootRemoved = "yes" })</script><iframe src="${crossUrl.replace("127.0.0.1", "localhost").replace("/cross", "/no-root")}"></iframe>`,
        );
      else response.end(observerHtml.replace("{{CROSS_URL}}", crossUrl));
    });
    await new Promise<void>((resolve) => primary.listen(0, "127.0.0.1", resolve));
    const address = primary.address();
    if (typeof address !== "object" || !address) throw new Error("missing primary port");
    baseUrl = `http://127.0.0.1:${address.port}`;
    directory = await mkdtemp(join(tmpdir(), "jevpilot-observer-"));
    browser = await createCdpDriver().launch(
      { ...testProfile(directory), ...(executable ? { executable } : {}) },
      { timeoutMs: 15000 },
    );
  });
  after(async () => {
    await browser?.close();
    if (primary) await new Promise<void>((resolve) => primary.close(() => resolve()));
    if (cross) await new Promise<void>((resolve) => cross.close(() => resolve()));
    if (directory)
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  async function withPage<T>(path: string, run: (page: PageHandle) => Promise<T>): Promise<T> {
    const page = await browser.newPage();
    try {
      await page.navigate(`${baseUrl}${path}`);
      return await run(page);
    } finally {
      await page.close();
    }
  }
  test("M6a: every observed ref resolves ok immediately after observe", async () => {
    for (const path of ["/products", "/m6a-stories", "/", "/shadow-content", "/m6a-names"]) {
      await withPage(path, async (page) => {
        for (const filled of path === "/m6a-names" ? [false, true] : [false]) {
          if (filled)
            await page.callIsolated(() => {
              (document.querySelector("#placeholder") as HTMLInputElement).value = "books";
            }, []);
          const state = await observe(page, { maxElements: 255 });
          if (path === "/products")
            assert.equal(state.elements.filter((item) => item.name === "Add to cart").length, 6);
          if (path === "/m6a-stories")
            assert.ok(state.elements.filter((item) => /comments/u.test(item.name)).length >= 3);
          for (const item of state.elements) {
            const resolved = await resolveRef(page, state.epoch, item.ref, item.fingerprint);
            assert.equal(
              resolved.status,
              "ok",
              `${path}: ${item.ref} ${item.name}: ${resolved.status}`,
            );
          }
        }
      });
    }
  });
  test("M6a: accessible names match expectations and Chrome's accessibility tree", async () =>
    withPage("/m6a-names", async (page) => {
      const state = await observe(page);
      const expected = [
        ["shadow-button", "Buy now"],
        ["nested", "Checkout"],
        ["submit", "确认支付"],
        ["image", "Search image"],
        ["labelled", "Close dialog"],
        ["pseudo", "Next page"],
        ["svg", "Settings"],
        ["placeholder", "Search books"],
        ["email", "Email"],
        ["choice", "Choice"],
        ["logo", "Wikipedia"],
      ] as const;
      const observedNames = await page.callIsolated(() => {
        const library = (
          globalThis as typeof globalThis & {
            __jevpilotObserverLibrary: { nameOf(element: Element): string };
          }
        ).__jevpilotObserverLibrary;
        return Object.fromEntries(
          [
            "shadow-button",
            "nested",
            "submit",
            "image",
            "labelled",
            "pseudo",
            "svg",
            "placeholder",
            "email",
            "choice",
            "logo",
          ].map((id) => [
            id,
            library.nameOf(
              document.querySelector(`#${id}`) ??
                document.querySelector("x-btn")!.shadowRoot!.querySelector(`#${id}`)!,
            ),
          ]),
        );
      }, []);
      const allowedDifferences = new Map<string, string>();
      for (const [id, name] of expected) {
        assert.equal(observedNames[id], name, id);
        assert.ok(
          state.elements.some((item) => item.identityName === name),
          `${id} absent from observation`,
        );
        // Chrome returns the raw computed string (e.g. "Email " from the label's text node).
        const chromeName = (await chromeAccessibleName(page, id))?.replace(/\s+/gu, " ").trim();
        if (chromeName !== name)
          assert.ok(
            allowedDifferences.has(id),
            `${id}: Chrome ${JSON.stringify(chromeName)}, library ${JSON.stringify(name)}`,
          );
      }
    }));
  test("six product cards expose title and ordinal in same-name button criteria", async () =>
    withPage("/products", async (page) => {
      const state = await observe(page, { goal: "Add Sauce Labs Backpack" });
      const buttons = state.elements.filter((item) => item.name === "Add to cart");
      assert.equal(buttons.length, 6);
      const question = buildQuestions(state, { goal: "Add Sauce Labs Backpack" }).click_target;
      assert.equal(question?.type, "choice");
      if (question?.type === "choice") {
        assert.match(
          String(question.criteria[buttons[0]!.ref]),
          /Sauce Labs Backpack.*item 1 of 6/u,
        );
        test("open shadow-root text and headings enter the observation", async () =>
          withPage("/shadow-content", async (page) => {
            const state = await observe(page);
            assert.match(state.text, /Archive collection details/u);
            assert.ok(state.headings.some((heading) => heading.text === "Shadow headline"));
            assert.ok(state.elements.some((element) => element.name === "Open item"));
          }));
        test("first observation waits for delayed content after navigation", async () =>
          withPage("/delayed-content", async (page) => {
            const state = await observe(page);
            assert.match(state.text, /Complete after delay/u);
            assert.ok((state.timings.settleMs ?? 0) >= 700);
          }));
        assert.match(
          String(question.criteria[buttons[5]!.ref]),
          /Test\.allTheThings T-Shirt.*item 6 of 6/u,
        );
      }
    }));

  test("long article selects a late fact for its goal", async () =>
    withPage("/article-deep", async (page) => {
      const fullTextLength = await page.callIsolated(
        () =>
          (document.querySelector("main")?.textContent ?? "").replace(/\s+/gu, " ").trim().length,
        [],
      );
      assert.ok(fullTextLength >= 4000, `fixture text is only ${fullTextLength} characters`);
      const matching = await observe(page, { goal: "Eiffel Tower height" });
      const unrelated = await observe(page, { goal: "ticketing arrangements" });
      assert.match(matching.text, /Eiffel Tower is 330 metres tall/u);
      assert.doesNotMatch(unrelated.text, /330 metres/u);
      assert.ok(matching.text.length <= 1500);
    }));
  test("labels: no-type input, wrapping, for, aria-labelledby, placeholder and title", async () =>
    withPage("/", async (page) => {
      const state = await observe(page);
      for (const name of ["姓名", "包裹标签", "引用标签", "仅占位符", "仅标题"])
        assert.ok(
          state.elements.some((item) => item.name.includes(name)),
          name,
        );
      assert.equal(state.elements.find((item) => item.name === "姓名")?.inputType, "text");
    }));
  test("filled placeholder-only field has no placeholder name", async () =>
    withPage("/", async (page) => {
      const state = await observe(page);
      const field = state.elements.find((item) => item.value === "查询词");
      assert.equal(field?.name, "");
      assert.equal(field.placeholder, "今日热搜");
      assert.doesNotMatch(formatObservation(state), /placeholder "今日热搜"/u);
    }));
  test("select 30 options, groups, required and masked password and card", async () =>
    withPage("/", async (page) => {
      const state = await observe(page);
      const select = state.elements.find((item) => item.role === "select");
      assert.equal(select?.optionCount, 30);
      assert.equal(select?.options?.length, 20);
      assert.equal(select?.optionLabel, "Medium");
      assert.ok(state.elements.some((item) => item.role === "checkbox"));
      assert.ok(state.elements.some((item) => item.role === "radio"));
      assert.ok(
        state.forms.some((form) => form.fields.some((field) => field.required && field.empty)),
      );
      assert.equal(state.elements.find((item) => item.inputType === "password")?.value, "***");
      assert.equal(state.elements.find((item) => item.name === "卡号")?.value, "***");
      assert.doesNotMatch(JSON.stringify(state), /do-not-leak|4111111111111111/u);
    }));
  test("filled secrets are masked and not empty while empty passwords stay empty", async () =>
    withPage("/", async (page) => {
      const state = await observe(page);
      for (const name of ["当前密码", "新密码", "验证码", "显示密码", "安全码"]) {
        const field = state.elements.find((item) => item.name === name);
        assert.equal(field?.value, "***", name);
        assert.equal(
          state.forms.flatMap((form) => form.fields).find((item) => item.ref === field?.ref)?.empty,
          false,
          name,
        );
      }
      const empty = state.elements.find((item) => item.name === "空密码");
      assert.equal(empty?.value, "");
      assert.equal(
        state.forms.flatMap((form) => form.fields).find((item) => item.ref === empty?.ref)?.empty,
        true,
      );
      assert.doesNotMatch(
        JSON.stringify(state),
        /current-secret|new-secret|123456|toggled-secret|"999"/u,
      );
    }));
  test("contenteditable and ARIA button and combobox", async () =>
    withPage("/", async (page) => {
      const state = await observe(page);
      for (const role of ["textbox", "button", "combobox"])
        assert.ok(state.elements.some((item) => item.role === role));
    }));
  test("icon links use descendant names and card text nodes have spaces", async () =>
    withPage("/", async (page) => {
      const state = await observe(page);
      for (const name of ["站点标志", "矢量标题", "子级标签", "链接标题", "稍后再看 14.2万 275"])
        assert.ok(
          state.elements.some((item) => item.name === name),
          name,
        );
    }));
  test("Wikipedia-style logo ignores collapsed menu and vote arrow uses descendant title", async () =>
    withPage("/", async (page) => {
      const state = await observe(page);
      assert.equal(
        state.elements.find((item) => item.href === "/wiki/Main_Page")?.name,
        "Wikipedia",
      );
      assert.equal(state.elements.find((item) => item.href === "/vote")?.name, "upvote");
    }));
  test("open and nested shadow DOM fields", async () =>
    withPage("/", async (page) => {
      const state = await observe(page);
      for (const name of ["影子字段", "嵌套字段"])
        assert.ok(state.elements.some((item) => item.name.includes(name)));
    }));
  // Since M1c, cross-origin frames are read through per-frame isolated worlds instead of
  // being reported as a placeholder.
  test("same-origin and cross-origin iframe fields are observed with frame paths", async () =>
    withPage("/", async (page) => {
      // Frames load asynchronously after the parent's DOMContentLoaded; poll briefly.
      let state = await observe(page);
      for (
        let attempt = 0;
        attempt < 30 && !state.elements.some((item) => item.name === "跨源按钮");
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        state = await observe(page);
      }
      const inner = state.elements.find((item) => item.name.includes("框内字段"));
      assert.ok(inner?.framePath);
      assert.ok((inner?.rect.y ?? 0) > 0);
      const crossButton = state.elements.find((item) => item.name === "跨源按钮");
      assert.ok(crossButton?.framePath, `cross-origin button missing (${crossUrl})`);
      assert.ok((crossButton?.rect.y ?? 0) > 0);
      assert.equal(
        state.elements.some((item) => item.role === "frame"),
        false,
      );
    }));
  test("M6s: a busy cross-origin iframe does not stall observation", async () =>
    withPage("/busy-frame", async (page) => {
      const started = performance.now();
      while (
        !(await page.callIsolated(() => document.body.dataset.busy === "yes", [])) &&
        performance.now() - started < 4000
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(performance.now() - started < 4000, "busy frame did not start");
      // The frame starts its 5 s busy loop 300 ms after signalling.
      await new Promise((resolve) => setTimeout(resolve, 600));
      const observationStarted = performance.now();
      const state = await observe(page);
      assert.ok(performance.now() - observationStarted < 3000);
      assert.ok(state.elements.some((item) => item.name === "Parent action"));
      assert.equal(state.timings.framesSkipped, 1);
    }));
  test("M6s-3: a frame document without a root element does not break observation", async () =>
    withPage("/no-root-frame", async (page) => {
      const started = performance.now();
      while (
        !(await page.callIsolated(() => document.body.dataset.rootRemoved === "yes", [])) &&
        performance.now() - started < 4000
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(performance.now() - started < 4000, "child root was not removed");
      const state = await observe(page);
      assert.ok(state.elements.some((item) => item.name === "Parent action"));
      assert.equal(state.timings.framesFailed, undefined);
    }));
  test("hidden variants are excluded", async () =>
    withPage("/", async (page) => {
      const names = (await observe(page)).elements.map((item) => item.name).join("|");
      for (const hidden of [
        "Display hidden",
        "Visibility hidden",
        "Opacity hidden",
        "Zero size",
        "ARIA hidden",
        "Inert hidden",
      ])
        assert.equal(names.includes(hidden), false, hidden);
    }));
  test("modal overlay and open dialog signals", async () =>
    withPage("/", async (page) => {
      await page.callIsolated(() => {
        (document.querySelector("#overlay") as HTMLElement).style.display = "block";
        (document.querySelector("#dialog") as HTMLDialogElement).showModal();
      }, []);
      const state = await observe(page);
      assert.equal(state.signals.modalOverlay, true);
      assert.equal(state.signals.dialogOpen, true);
    }));
  test("2000 links respect budget and retain search, pagination and goal match", async () =>
    withPage("/long", async (page) => {
      const state = await observe(page, {
        goal: "量子计算专题报告",
        maxElements: 120,
        belowFoldScreens: 100,
      });
      assert.ok(state.elements.length <= 120);
      for (const name of ["站内搜索", "下一页", "Next", "量子计算专题报告"])
        assert.ok(
          state.elements.some((item) => item.name === name),
          name,
        );
    }));
  test("far below fold rel next More and Chinese pager survive the 120 budget", async () =>
    withPage("/long", async (page) => {
      const state = await observe(page, { maxElements: 120 });
      assert.ok(state.elements.length <= 120);
      for (const name of ["More", "下一页"]) {
        const pager = state.elements.find(
          (item) => item.name === name && item.rect.y > state.viewport.height * 2,
        );
        assert.ok(pager, name);
      }
    }));
  test("far below fold rel next icon survives without name or href pagination clues", async () =>
    withPage("/long", async (page) => {
      const state = await observe(page, { maxElements: 120 });
      const pager = state.elements.find((item) => item.href === "/archive");
      assert.equal(pager?.name, "Show older posts");
      assert.ok((pager?.rect.y ?? 0) > state.viewport.height * 2);
    }));
  test("Chinese labels remain intact", async () =>
    withPage("/", async (page) => {
      const state = await observe(page);
      assert.ok(state.elements.some((item) => item.name === "姓名"));
      assert.match(state.text, /中文内容保持完整/u);
    }));
  test("re-render yields missing or stale epoch and changed fingerprint", async () =>
    withPage("/", async (page) => {
      const first = await observe(page);
      const target = first.elements.find((item) => item.name === "Replace me");
      assert.ok(target);
      await page.callIsolated(() => {
        document.querySelector("#replace")?.replaceWith(document.createElement("button"));
      }, []);
      const missing = await resolveRef(page, first.epoch, target.ref, target.fingerprint);
      assert.equal(missing.status, "missing");
      const second = await observe(page);
      const stale = await resolveRef(page, first.epoch, target.ref, target.fingerprint);
      assert.equal(stale.status, "stale-epoch");
      const changed = second.elements.find((item) => item.name === "伪按钮");
      assert.ok(changed);
      await page.callIsolated(() => {
        document.querySelector("#pseudo")?.setAttribute("aria-label", "Changed");
      }, []);
      const mismatch = await resolveRef(page, second.epoch, changed.ref, changed.fingerprint);
      assert.equal(mismatch.status, "identity-changed");
    }));
  test("pointer onclick pseudo-button is clickable", async () =>
    withPage("/", async (page) => {
      assert.ok(
        (await observe(page)).elements.some(
          (item) => item.role === "clickable" && item.name === "伪按钮",
        ),
      );
    }));
  test("M6w: an icon-only pointer control with a known icon class is observed with its icon hint", async () =>
    withPage("/m6w-icons", async (page) => {
      const state = await observe(page);
      const item = state.elements.find((candidate) => candidate.iconHint === "search");
      assert.equal(item?.role, "clickable");
      assert.equal(item?.name, "");
      if (!item) throw new Error("missing search toggle");
      await page.click(item.rect.x + item.rect.width / 2, item.rect.y + item.rect.height / 2);
      assert.ok(
        (await observe(page)).elements.some((candidate) => candidate.name === "Search field"),
      );
    }));
  test("M6w: a nameless button gets an icon hint from its svg use reference", async () =>
    withPage("/m6w-icons", async (page) => {
      const item = (await observe(page)).elements.find(
        (candidate) => candidate.ref && candidate.tag === "button",
      );
      assert.equal(item?.name, "");
      assert.equal(item?.iconHint, "menu");
    }));
  test("M6w: a nameless pointer control without a known icon token stays out of the observation", async () =>
    withPage("/m6w-icons", async (page) => {
      assert.equal(
        (await observe(page)).elements.some(
          (candidate) =>
            candidate.iconHint === undefined &&
            candidate.tag === "div" &&
            candidate.rect.width === 41,
        ),
        false,
      );
    }));
  test(
    "2000-link observation is under 150 ms and formatted state under 3000 tokens",
    {
      skip:
        process.env.JEVPILOT_TEST_PROFILE === "server-plain" ? "desktop-chrome only" : undefined,
    },
    async () =>
      withPage("/long", async (page) => {
        const states = [];
        for (let attempt = 0; attempt < 3; attempt++)
          states.push(await observe(page, { goal: "量子计算专题报告", belowFoldScreens: 100 }));
        const state = states.sort(
          (left, right) => left.timings.snapshotMs - right.timings.snapshotMs,
        )[0]!;
        assert.ok(
          state.timings.snapshotMs < 150,
          `best snapshot took ${state.timings.snapshotMs} ms`,
        );
        assert.ok(estimateTokens(formatObservation(state)) <= 3000);
      }),
  );
});
