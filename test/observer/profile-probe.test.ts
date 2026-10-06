import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("probe requires explicit execution", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = await new Promise<{
    code: number | string | null | undefined;
    stdout: string;
    stderr: string;
    killed: boolean;
  }>((resolve) => {
    execFile(
      process.execPath,
      ["scripts/profile-observer.mjs"],
      { cwd: root, timeout: 5000, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({ code: error?.code, stdout, stderr, killed: error?.killed ?? false });
      },
    );
  });
  assert.equal(result.code, 2);
  assert.equal(result.killed, false);
  assert.match(result.stderr, /--run/u);
  assert.equal(result.stdout, "");
  const pkg = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.ok(Object.values(pkg.scripts).every((script) => !script.includes("profile-observer")));
});
