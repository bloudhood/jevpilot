import assert from "node:assert/strict";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { sanitizeDownloadName } from "../../src/util/download.ts";
import {
  downloadEvent,
  downloadRoot,
  downloadSession,
  downloadStates,
} from "../support/download-fixture.ts";

async function cleanup(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

test("slow CSV completes across resume", async () => {
  const root = await downloadRoot();
  const { page, session } = downloadSession({ downloadPath: root });
  try {
    page.emit("download", downloadEvent("csv-guid", "report.csv", "started"));
    assert.deepEqual(downloadStates(await session.observe()), ["in_progress"]);
    const guidPath = join(root, "csv-guid");
    await writeFile(guidPath, "a,b\n1,2\n");
    page.emit("download", downloadEvent("csv-guid", "report.csv", "completed", guidPath));
    const result = await session.resume();
    const entry = result.downloads?.[0];
    assert.equal(entry?.state, "completed");
    assert.match(entry?.path ?? "", /-report\.csv$/u);
    assert.equal(entry?.size_bytes, 8);
  } finally {
    await session.close();
    await cleanup(root);
  }
});

test("canceled or missing file cannot verify success", async () => {
  const root = await downloadRoot();
  const { page, session } = downloadSession({
    downloadPath: root,
    success: { download_completed: true },
  });
  try {
    page.emit("download", downloadEvent("cancel", "cancel.csv", "canceled"));
    let result = await session.observe();
    assert.notEqual(result.status, "DONE_VERIFIED");
    assert.equal(result.downloads?.[0]?.state, "canceled");
    page.emit(
      "download",
      downloadEvent("missing", "missing.csv", "completed", join(root, "missing")),
    );
    result = await session.observe();
    assert.notEqual(result.status, "DONE_VERIFIED");
    assert.equal(result.downloads?.find((entry) => entry.id === "missing")?.state, "unavailable");
    assert.equal(result.downloads?.find((entry) => entry.id === "missing")?.path, undefined);
    if (process.platform !== "win32") {
      const outside = await downloadRoot();
      try {
        const outsideFile = join(outside, "outside");
        const link = join(root, "link");
        await writeFile(outsideFile, "outside");
        await symlink(outsideFile, link);
        page.emit("download", downloadEvent("symlink", "link.csv", "completed", link));
        result = await session.observe();
        assert.equal(
          result.downloads?.find((entry) => entry.id === "symlink")?.state,
          "unavailable",
        );
      } finally {
        await cleanup(outside);
      }
    }
  } finally {
    await session.close();
    await cleanup(root);
  }
});

test("two sessions cannot see each other's downloads", async () => {
  const root = await downloadRoot();
  const first = downloadSession({ downloadPath: root });
  const second = downloadSession({ downloadPath: root });
  try {
    first.page.emit("download", downloadEvent("one", "one.txt", "started"));
    second.page.emit("download", downloadEvent("two", "two.txt", "started"));
    assert.deepEqual(
      (await first.session.observe()).downloads?.map((entry) => entry.id),
      ["one"],
    );
    assert.deepEqual(
      (await second.session.observe()).downloads?.map((entry) => entry.id),
      ["two"],
    );
  } finally {
    await first.session.close();
    await second.session.close();
    await cleanup(root);
  }
});

test("metadata target and path escape are refused", async () => {
  const root = await downloadRoot();
  const outside = await downloadRoot();
  const { page, session } = downloadSession({ downloadPath: root });
  try {
    const outsidePath = join(outside, "evil");
    await writeFile(outsidePath, "secret");
    page.emit("download", downloadEvent("escape", "../x", "completed", outsidePath));
    const result = await session.observe();
    assert.equal(result.downloads?.[0]?.state, "unavailable");
    assert.equal(result.downloads?.[0]?.path, undefined);
    assert.equal(sanitizeDownloadName("..\\..\\evil.bat"), "evil.bat");
    assert.equal(sanitizeDownloadName("../x"), "x");
    assert.equal(sanitizeDownloadName("CON.txt"), "download");
    assert.match(sanitizeDownloadName("bad\u0001name.csv"), /^[^\\/]+$/u);
  } finally {
    await session.close();
    await cleanup(root);
    await cleanup(outside);
  }
});

test("secret session returns scrubbed metadata only", async () => {
  const root = await downloadRoot();
  const { page, session } = downloadSession({ downloadPath: root });
  try {
    (session as unknown as { secretLiterals: Set<string> }).secretLiterals.add("SECRET");
    page.emit("download", downloadEvent("secret", "SECRET-report.csv", "started"));
    const result = await session.observe();
    assert.equal(result.downloads?.[0]?.name, "[REDACTED]-report.csv");
    assert.equal("url" in (result.downloads?.[0] ?? {}), false);
    // The renamed file must not carry the secret, and the reported path must still exist.
    const guidPath = join(root, "secret");
    await writeFile(guidPath, "secret bytes");
    page.emit("download", downloadEvent("secret", "SECRET-report.csv", "completed", guidPath));
    const completed = (await session.observe()).downloads?.[0];
    assert.equal(completed?.state, "completed");
    assert.doesNotMatch(completed?.path ?? "", /SECRET/u);
    assert.equal(await readFile(completed!.path!, "utf8"), "secret bytes");
  } finally {
    await session.close();
    await cleanup(root);
  }
});

test("persistent artifacts survive cleanup", async () => {
  const root = await downloadRoot();
  const { page, session } = downloadSession({ downloadPath: root });
  const guidPath = join(root, "persist-guid");
  try {
    await writeFile(guidPath, "persistent");
    page.emit("download", downloadEvent("persist-guid", "persist.txt", "completed", guidPath));
    const result = await session.observe();
    const renamed = result.downloads?.[0]?.path;
    assert.ok(renamed);
    await session.close();
    assert.equal(await readFile(renamed!, "utf8"), "persistent");
    const target = join(root, "persist-guid".slice(0, 8) + "-persist.txt");
    await writeFile(target, "existing");
    const second = downloadSession({ downloadPath: root });
    try {
      const secondPath = join(root, "persist2");
      await writeFile(secondPath, "new");
      second.page.emit(
        "download",
        downloadEvent("persist-2", "persist.txt", "completed", secondPath),
      );
      const secondResult = await second.session.observe();
      assert.equal(await readFile(target, "utf8"), "existing");
      assert.equal(secondResult.downloads?.[0]?.path, secondPath);
    } finally {
      await second.session.close();
    }
  } finally {
    await cleanup(root);
  }
});
