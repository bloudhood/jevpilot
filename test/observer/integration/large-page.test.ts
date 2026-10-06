import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { findChrome } from "../../../src/browser/launcher.ts";
import { createCdpDriver } from "../../../src/engine/cdp/driver.ts";
import type { BrowserHandle } from "../../../src/engine/types.ts";
import { observe } from "../../../src/observer/observe.ts";
import { testProfile } from "../../support/browser-profile.ts";

const executable = await findChrome();
const skipped =
  process.env.JEVPILOT_SKIP_BROWSER === "1"
    ? "JEVPILOT_SKIP_BROWSER=1"
    : !executable
      ? "Chrome executable not found"
      : undefined;

describe("large-page Observer tools", { skip: skipped }, () => {
  let browser: BrowserHandle;
  let directory: string;
  let primary: Server;
  let cross: Server;
  let target: string;
  before(async () => {
    const html = await readFile(
      new URL("../../fixtures/pages/large-page.html", import.meta.url),
      "utf8",
    );
    cross = createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<form><label>框内字段<input></label><button>框内按钮</button></form>");
    });
    await new Promise<void>((resolve) => cross.listen(0, "127.0.0.1", resolve));
    const crossAddress = cross.address();
    if (!crossAddress || typeof crossAddress !== "object") throw new Error("missing cross port");
    primary = createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(html);
    });
    await new Promise<void>((resolve) => primary.listen(0, "127.0.0.1", resolve));
    const address = primary.address();
    if (!address || typeof address !== "object") throw new Error("missing primary port");
    target = `http://127.0.0.1:${address.port}/?scale=1&frame=${encodeURIComponent(`http://127.0.0.1:${crossAddress.port}/frame`)}`;
    directory = await mkdtemp(join(tmpdir(), "jevpilot-large-page-"));
    browser = await createCdpDriver().launch(
      { ...testProfile(directory), ...(executable ? { executable } : {}) },
      { timeoutMs: 15000 },
    );
  });
  after(async () => {
    try {
      await browser?.close();
    } finally {
      try {
        if (primary) await new Promise<void>((resolve) => primary.close(() => resolve()));
      } finally {
        if (cross) await new Promise<void>((resolve) => cross.close(() => resolve()));
        if (directory)
          await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  });

  test("fixture contains required controls and text", async () => {
    const page = await browser.newPage();
    try {
      await page.navigate(target);
      await page.callIsolated(async () => {
        if (document.readyState !== "complete")
          await new Promise<void>((resolve) =>
            addEventListener("load", () => resolve(), { once: true }),
          );
      }, []);
      const counts = await page.callIsolated(
        () => ({
          elements: document.querySelectorAll("*").length,
          links: document.links.length,
          tables: document.querySelectorAll(".data-table").length,
          toggles: document.querySelectorAll(".navbox-toggle").length,
          collapsed: [...document.querySelectorAll(".navbox-toggle")].filter(
            (button) => button.textContent === "展开",
          ).length,
          lastReference: document.querySelector(".references li:last-child a:last-child")
            ?.textContent,
        }),
        [],
      );
      assert.ok(counts.elements >= 15000);
      assert.ok(counts.links >= 4000);
      assert.equal(counts.tables, 20);
      assert.equal(counts.toggles, 15);
      assert.equal(counts.collapsed, 13);
      assert.equal(counts.lastReference, "参考资料 400");
      const state = await observe(page, {});
      assert.ok(
        state.elements.some(
          (item) => item.role === "input" && item.inputType === "text" && item.name === "搜索",
        ),
      );
      assert.ok(state.elements.some((item) => item.role === "link" && item.name === "编辑"));
      assert.ok(
        state.elements.some(
          (item) =>
            item.role === "button" && item.name === "框内按钮" && item.ref.startsWith("frame:"),
        ),
      );
    } finally {
      await page.close();
    }
  });
  test("probe reports distinct main-frame and child-frame phases", async () => {
    const reportDirectory = await mkdtemp(join(tmpdir(), "jevpilot-probe-report-"));
    const reportPath = join(reportDirectory, "report.json");
    try {
      await promisify(execFile)(
        process.execPath,
        ["scripts/profile-observer.mjs", "--run", "--runs", "1", "--json", reportPath],
        {
          cwd: fileURLToPath(new URL("../../../", import.meta.url)),
          timeout: 180000,
          windowsHide: true,
        },
      );
      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        runs: {
          executor: Record<string, number>;
          session: Record<string, number>;
          domElements: number;
          links: number;
        }[];
        median: { executor: Record<string, number>; session: Record<string, number> };
      };
      assert.equal(report.runs.length, 1);
      const run = report.runs[0]!;
      for (const kind of ["executor", "session"] as const) {
        for (const field of ["mainFrameMs", "childFramesMs", "framesMs", "settleMs", "totalMs"]) {
          assert.ok(Number.isFinite(run[kind][field]), `${kind}.${field}`);
          assert.ok(run[kind][field]! >= 0, `${kind}.${field}`);
        }
        assert.equal(typeof report.median[kind], "object");
      }
      assert.ok(run.domElements > 0);
      assert.ok(run.links > 0);
      assert.equal(typeof report.median, "object");
    } finally {
      await rm(reportPath, { force: true });
      await rm(reportDirectory, { recursive: true, force: true });
    }
  });
});
