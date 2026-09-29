import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createOwnedTempDir, sweepStaleTempDirs } from "../../src/util/owned-temp.ts";

test("M6c: owned temp dirs carry an owner marker", async () => {
  const directory = await createOwnedTempDir("jevpilot-owned-test-");
  try {
    const owner = JSON.parse(await readFile(join(directory, ".jevpilot-owner.json"), "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.ok(!Number.isNaN(Date.parse(owner.created)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("M6c: stale sweep removes dead-owner dirs only", async () => {
  const root = await mkdtemp(join(tmpdir(), "owned-temp-test-"));
  const seed = async (name: string, contents?: string) => {
    const directory = join(root, name);
    await mkdir(directory);
    if (contents !== undefined) await writeFile(join(directory, ".jevpilot-owner.json"), contents);
  };
  try {
    await seed("jevpilot-dead", JSON.stringify({ pid: 1001 }));
    await seed("jevpilot-alive", JSON.stringify({ pid: 1002 }));
    await seed("jevpilot-own", JSON.stringify({ pid: process.pid }));
    await seed("jevpilot-nomarker");
    await seed("jevpilot-malformed", "{");
    await seed("other-dead", JSON.stringify({ pid: 1001 }));
    await writeFile(join(root, "jevpilot-file"), "file");
    assert.equal(await sweepStaleTempDirs(root, (pid) => pid === 1002), 1);
    assert.equal(existsSync(join(root, "jevpilot-dead")), false);
    for (const name of [
      "jevpilot-alive",
      "jevpilot-own",
      "jevpilot-nomarker",
      "jevpilot-malformed",
      "other-dead",
      "jevpilot-file",
    ])
      assert.equal(existsSync(join(root, name)), true, name);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("M6c: stale sweep does not follow links", async () => {
  const root = await mkdtemp(join(tmpdir(), "owned-temp-links-test-"));
  const target = join(root, "target");
  const link = join(root, "jevpilot-link");
  try {
    await mkdir(target);
    await writeFile(join(target, ".jevpilot-owner.json"), JSON.stringify({ pid: 1001 }));
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    assert.equal(await sweepStaleTempDirs(root, () => false), 0);
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(existsSync(join(target, ".jevpilot-owner.json")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
