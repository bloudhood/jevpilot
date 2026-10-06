import assert from "node:assert/strict";
import fsPromises, { readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { FakePageHandle } from "../support/fake-engine.ts";
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

test("download name redacts a secret before shortening", async () => {
  const root = await downloadRoot();
  const { page, session } = downloadSession({ downloadPath: root });
  const secret = "private-token-" + "s".repeat(130);
  (session as unknown as { secretLiterals: Set<string> }).secretLiterals.add(secret);
  try {
    const source = join(root, "long-secret");
    await writeFile(source, "bytes");
    page.emit("download", downloadEvent("long-secret", secret + ".csv", "completed", source));
    const record = (await session.observe()).downloads?.[0];
    assert.equal(record?.name, "[REDACTED].csv");
    assert.doesNotMatch(record?.path ?? "", /private-token/u);
    assert.equal(await readFile(record!.path!, "utf8"), "bytes");
  } finally {
    await session.close();
    await cleanup(root);
  }
});

test("download name redacts a secret containing path characters", async () => {
  const root = await downloadRoot();
  const { page, session } = downloadSession({ downloadPath: root });
  const secret = 'token:/\\|<>?*"private';
  (session as unknown as { secretLiterals: Set<string> }).secretLiterals.add(secret);
  try {
    const source = join(root, "path-secret");
    await writeFile(source, "bytes");
    page.emit("download", downloadEvent("path-secret", secret + ".csv", "completed", source));
    const record = (await session.observe()).downloads?.[0];
    assert.equal(record?.name, "[REDACTED].csv");
    assert.doesNotMatch(record?.path ?? "", /token|private/u);
    assert.equal(await readFile(record!.path!, "utf8"), "bytes");
  } finally {
    await session.close();
    await cleanup(root);
  }
});

test("downloads keep completing after the session switches tabs", async () => {
  const root = await downloadRoot();
  const { page, session } = downloadSession({
    downloadPath: root,
    success: { download_completed: true },
  });
  const popup = new FakePageHandle();
  Object.defineProperty(popup, "id", { value: "popup" });
  try {
    page.emit("download", downloadEvent("switch", "report.csv", "started"));
    page.emit("popup", popup);
    await session.selectTab(popup.id);
    assert.equal(session.page, popup);
    const source = join(root, "switch");
    await writeFile(source, "finished");
    page.emit("download", downloadEvent("switch", "report.csv", "completed", source));
    const result = await session.observe();
    assert.equal(result.status, "DONE_VERIFIED");
    assert.equal(result.downloads?.[0]?.state, "completed");
    assert.equal(await readFile(result.downloads![0]!.path!, "utf8"), "finished");
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

test("concurrent downloads with the same name do not overwrite each other", async () => {
  const root = await downloadRoot();
  const first = downloadSession({ downloadPath: root });
  const second = downloadSession({ downloadPath: root });
  try {
    const sources = [join(root, "source-one"), join(root, "source-two")];
    const occupied = join(root, "12345678-report.csv");
    await writeFile(occupied, "existing");
    await Promise.all(sources.map((source, index) => writeFile(source, `payload-${index}`)));
    first.page.emit(
      "download",
      downloadEvent("12345678-one", "report.csv", "completed", sources[0]),
    );
    second.page.emit(
      "download",
      downloadEvent("12345678-two", "report.csv", "completed", sources[1]),
    );
    const results = await Promise.all([first.session.observe(), second.session.observe()]);
    const records = results.map((result) => result.downloads![0]!);
    assert.ok(records.every((entry) => entry.state === "completed"));
    assert.notEqual(records[0]!.path, records[1]!.path);
    assert.deepEqual(
      new Set(records.map((entry) => entry.path)),
      // Reported paths are canonical (e.g. a long name where TEMP is an 8.3 short path).
      new Set([
        join(await realpath(root), "12345678-2-report.csv"),
        join(await realpath(root), "12345678-3-report.csv"),
      ]),
    );
    assert.equal(await readFile(occupied, "utf8"), "existing");
    assert.deepEqual(await Promise.all(records.map((entry) => readFile(entry.path!, "utf8"))), [
      "payload-0",
      "payload-1",
    ]);
    assert.ok(records.every((entry) => entry.size_bytes === 9));
  } finally {
    await first.session.close();
    await second.session.close();
    await cleanup(root);
  }
});

test("a download that cannot be moved is not reported complete", async (t) => {
  const root = await downloadRoot();
  const { page, session } = downloadSession({
    downloadPath: root,
    success: { download_completed: true },
  });
  try {
    const source = join(root, "cannot-move");
    await writeFile(source, "payload");
    const originalLink = fsPromises.link;
    t.mock.method(fsPromises, "link", async (...args: Parameters<typeof originalLink>) => {
      if (args[0] === source) throw Object.assign(new Error("move refused"), { code: "EACCES" });
      return originalLink(...args);
    });
    syncBuiltinESMExports();
    page.emit("download", downloadEvent("cannot-move", "report.csv", "completed", source));
    const result = await session.observe();
    assert.equal(result.downloads?.[0]?.state, "unavailable");
    assert.equal(result.downloads?.[0]?.path, undefined);
    assert.notEqual(result.status, "DONE_VERIFIED");
    assert.equal(await readFile(source, "utf8"), "payload");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await session.close();
    await cleanup(root);
  }
});

test("a download moves by exclusive copy where hard links are unsupported", async (t) => {
  const root = await downloadRoot();
  const { page, session } = downloadSession({
    downloadPath: root,
    success: { download_completed: true },
  });
  try {
    const source = join(root, "no-links");
    const occupied = join(root, "no-links-report.csv");
    await writeFile(source, "payload");
    await writeFile(occupied, "existing");
    const originalLink = fsPromises.link;
    t.mock.method(fsPromises, "link", async (...args: Parameters<typeof originalLink>) => {
      if (args[0] === source) throw Object.assign(new Error("no hard links"), { code: "EPERM" });
      return originalLink(...args);
    });
    syncBuiltinESMExports();
    page.emit("download", downloadEvent("no-links", "report.csv", "completed", source));
    const result = await session.observe();
    const record = result.downloads?.[0];
    assert.equal(record?.state, "completed");
    assert.equal(record?.path, join(await realpath(root), "no-links-2-report.csv"));
    assert.equal(await readFile(record!.path!, "utf8"), "payload");
    assert.equal(await readFile(occupied, "utf8"), "existing");
    await assert.rejects(readFile(source));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await session.close();
    await cleanup(root);
  }
});

test("finished download is checked after moving", async (t) => {
  for (const removed of [false, true]) {
    const root = await downloadRoot();
    const { page, session } = downloadSession({
      downloadPath: root,
      success: { download_completed: true },
    });
    const source = join(root, "checked");
    const target = join(root, "checked-report.csv");
    const originalUnlink = fsPromises.unlink;
    try {
      await writeFile(source, "payload");
      t.mock.method(fsPromises, "unlink", async (path: Parameters<typeof originalUnlink>[0]) => {
        await originalUnlink(path);
        if (path === source) {
          if (removed) await rm(target);
          else await writeFile(target, "changed size");
        }
      });
      syncBuiltinESMExports();
      page.emit("download", downloadEvent("checked", "report.csv", "completed", source));
      const result = await session.observe();
      assert.equal(result.downloads?.[0]?.state, "unavailable");
      assert.equal(result.downloads?.[0]?.path, undefined);
      assert.notEqual(result.status, "DONE_VERIFIED");
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await session.close();
      await cleanup(root);
    }
  }
});

test("verified download completion survives record eviction", async () => {
  const root = await downloadRoot();
  const { page, session } = downloadSession({
    downloadPath: root,
    success: { download_completed: true },
  });
  try {
    const source = join(root, "verified");
    await writeFile(source, "done");
    page.emit("download", downloadEvent("verified", "done.csv", "completed", source));
    assert.equal((await session.observe()).status, "DONE_VERIFIED");
    for (let index = 0; index < 100; index++)
      page.emit("download", downloadEvent(`later-${index}`, "later.csv", "started"));
    const result = await session.observe();
    assert.equal(result.status, "DONE_VERIFIED");
    assert.ok(result.downloads?.every((entry) => entry.state === "in_progress"));
    assert.equal(
      result.downloads?.some((entry) => entry.id === "verified"),
      false,
    );
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
      assert.notEqual(secondResult.downloads?.[0]?.path, target);
      assert.equal(await readFile(secondResult.downloads![0]!.path!, "utf8"), "new");
    } finally {
      await second.session.close();
    }
  } finally {
    await cleanup(root);
  }
});
