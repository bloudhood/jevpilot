#!/usr/bin/env node

const args = process.argv.slice(2);
const usage =
  "Usage: node scripts/profile-observer.mjs --run [--runs N] [--scale N] [--url URL] [--goal TEXT] [--at load|dcl] [--json PATH]";
if (!args.includes("--run")) {
  console.error(usage);
  process.exit(2);
}

async function main() {
  const options = { runs: 5, scale: 1, goal: "查看词条的主要信息", at: "load" };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--run") continue;
    const name = flag?.slice(2);
    if (!["runs", "scale", "url", "goal", "at", "json"].includes(name) || !args[index + 1])
      throw new Error(usage);
    options[name] = args[++index];
  }
  options.runs = Number(options.runs);
  options.scale = Number(options.scale);
  if (!Number.isInteger(options.runs) || options.runs < 1)
    throw new Error("--runs must be a positive integer");
  if (!Number.isInteger(options.scale) || options.scale < 1 || options.scale > 8)
    throw new Error("--scale must be an integer from 1 to 8");
  if (!["load", "dcl"].includes(options.at)) throw new Error("--at must be load or dcl");

  const { createServer } = await import("node:http");
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { findChrome } = await import("../src/browser/launcher.ts");
  const { createCdpDriver } = await import("../src/engine/cdp/driver.ts");
  const { testProfile } = await import("../test/support/browser-profile.ts");
  const { observe } = await import("../src/observer/observe.ts");
  const { detectorMarkerSelectors } = await import("../src/detectors/detect.ts");
  const executable = await findChrome();
  if (!executable) throw new Error("Chrome executable not found");
  const fields = [
    "settleMs",
    "mainFrameMs",
    "framesMs",
    "childFramesMs",
    "snapshotMs",
    "totalMs",
    "elements",
    "textChars",
  ];
  const record = (observation) => ({
    settleMs: observation.timings.settleMs,
    mainFrameMs: observation.timings.mainFrameMs,
    framesMs: observation.timings.framesMs,
    childFramesMs: observation.timings.childFramesMs,
    snapshotMs: observation.timings.snapshotMs,
    totalMs: observation.timings.totalMs,
    elements: observation.elements.length,
    textChars: observation.text.length,
  });
  const median = (values) => {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  let directory;
  let primary;
  let cross;
  let browser;
  const pages = new Set();
  const closeServer = (server) =>
    server
      ? new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      : Promise.resolve();
  try {
    let target = options.url;
    if (!target) {
      const html = await readFile(
        new URL("../test/fixtures/pages/large-page.html", import.meta.url),
        "utf8",
      );
      cross = createServer((_request, response) => {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end("<form><label>框内字段<input></label><button>框内按钮</button></form>");
      });
      await new Promise((resolve) => cross.listen(0, "127.0.0.1", resolve));
      primary = createServer((_request, response) => {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(html);
      });
      await new Promise((resolve) => primary.listen(0, "127.0.0.1", resolve));
      target = `http://127.0.0.1:${primary.address().port}/?scale=${options.scale}&frame=${encodeURIComponent(`http://127.0.0.1:${cross.address().port}/frame`)}`;
    }
    directory = await mkdtemp(join(tmpdir(), "jevpilot-profile-observer-"));
    const profile = testProfile(directory);
    console.log(`Display: ${profile.display}`);
    browser = await createCdpDriver().launch({ ...profile, executable }, { timeoutMs: 15000 });
    const runs = [];
    for (let index = 0; index < options.runs; index++) {
      const page = await browser.newPage();
      pages.add(page);
      try {
        // A failed or timed-out navigation would profile a partial page; stop instead.
        const navigation = await page.navigate(target, { timeoutMs: 30000 });
        if (navigation.failure)
          throw new Error(`navigation to ${target} failed: ${navigation.failure}`);
        // --at dcl observes as soon as navigate() returns (DOMContentLoaded), like the observation
        // after an action that navigated, while the page's own scripts may still be running.
        if (options.at === "load")
          await page.callIsolated(async () => {
            if (document.readyState !== "complete")
              await new Promise((resolve) =>
                addEventListener("load", () => resolve(), { once: true }),
              );
          }, []);
        const executor = record(await observe(page, { settleNavigation: true }));
        const session = record(
          await observe(page, {
            goal: options.goal,
            markerSelectors: detectorMarkerSelectors(),
            settleNavigation: false,
          }),
        );
        // Counted after the observations so the count does not wait out the page's work first.
        const { domElements, links } = await page.callIsolated(
          () => ({
            domElements: document.querySelectorAll("*").length,
            links: document.links.length,
          }),
          [],
        );
        runs.push({ executor, session, domElements, links });
      } finally {
        await page.close();
        pages.delete(page);
      }
    }
    const medians = Object.fromEntries(
      ["executor", "session"].map((kind) => [
        kind,
        Object.fromEntries(
          fields.map((field) => [field, median(runs.map((run) => run[kind][field]))]),
        ),
      ]),
    );
    for (const kind of ["executor", "session"]) {
      console.log(`\n${kind}`);
      console.log(["run", ...fields].join("\t"));
      for (const [index, run] of runs.entries())
        console.log([index + 1, ...fields.map((field) => run[kind][field])].join("\t"));
      console.log(["median", ...fields.map((field) => medians[kind][field])].join("\t"));
    }
    if (options.json)
      await writeFile(
        options.json,
        JSON.stringify(
          {
            target,
            scale: options.scale,
            at: options.at,
            display: profile.display,
            runs,
            median: medians,
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
  } finally {
    // Attempt every cleanup even when another close fails.
    const cleanup = await Promise.allSettled([
      ...[...pages].map((page) => page.close()),
      browser?.close(),
      closeServer(primary),
      closeServer(cross),
    ]);
    if (directory)
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    const failure = cleanup.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
