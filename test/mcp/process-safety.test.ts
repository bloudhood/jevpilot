import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("R9: uncaught exception cleanup has a 30-second unref'd exit deadline", () => {
  const moduleUrl = new URL("../../src/mcp/process-safety.ts", import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    import { installProcessSafety } from ${JSON.stringify(moduleUrl)};
    let shutdowns = 0;
    let unrefs = 0;
    let exits = 0;
    mock.timers.enable({ apis: ["setTimeout"] });
    const schedule = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay) => {
      assert.equal(delay, 30_000);
      const timer = schedule(callback, delay);
      timer.unref = () => { unrefs++; return timer; };
      return timer;
    };
    mock.method(process, "exit", (code) => { assert.equal(code, 1); exits++; });
    installProcessSafety(async () => { shutdowns++; await new Promise(() => {}); });
    process.emit("uncaughtException", new Error("test"));
    assert.equal(shutdowns, 1);
    assert.equal(unrefs, 1);
    assert.equal(process.exitCode, 1);
    mock.timers.tick(10_000);
    assert.equal(exits, 0, "CDP timeout must leave time for browser cleanup");
    mock.timers.tick(19_999);
    assert.equal(exits, 0);
    mock.timers.tick(1);
    assert.equal(exits, 1);
    process.exitCode = 0;
  `,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
