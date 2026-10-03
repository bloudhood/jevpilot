import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { TestStdioTransport } from "../support/mcp-stdio.ts";

test("stdio SDK client initializes, runs, closes and exits on stdin close", async () => {
  const transport = new TestStdioTransport({ ...process.env, JEVPILOT_SKIP_BROWSER: "1" });
  const client = new Client({ name: "stdio-test", version: "1" });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 9);
    const run = await client.callTool({ name: "browser_run", arguments: { goal: "Finish" } });
    assert.equal((run.structuredContent as Record<string, unknown>).status, "NEEDS_VALUES");
    const session = String((run.structuredContent as Record<string, unknown>).session);
    const closed = await client.callTool({ name: "browser_close", arguments: { session } });
    assert.deepEqual(closed.structuredContent, { session, closed: true });
  } finally {
    await client.close();
    await transport.exited();
  }
  assert.ok(transport.stdoutLines.length >= 4);
  for (const line of transport.stdoutLines) {
    const parsed = JSON.parse(line) as { jsonrpc?: string };
    assert.equal(parsed.jsonrpc, "2.0");
  }
  assert.equal(transport.child.exitCode, 0);
});

test("stdio server survives a late rejection and answers the next call", async () => {
  const transport = new TestStdioTransport({
    ...process.env,
    JEVPILOT_SKIP_BROWSER: "1",
    JEVPILOT_TEST_LATE_REJECTION: "1",
  });
  const client = new Client({ name: "stdio-late-rejection", version: "1" });
  try {
    await client.connect(transport);
    const run = await client.callTool({ name: "browser_run", arguments: { goal: "Finish" } });
    assert.equal((run.structuredContent as Record<string, unknown>).status, "NEEDS_VALUES");
    for (
      let attempt = 0;
      attempt < 50 && !transport.stderrLines.join("").includes("unhandledRejection");
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(
      transport.stderrLines.join(""),
      /jevpilot-mcp unhandledRejection: CdpTimeoutError\n/u,
    );
    assert.doesNotMatch(transport.stderrLines.join(""), /SECRET_MARKER/u);
    const session = String((run.structuredContent as Record<string, unknown>).session);
    const observed = await client.callTool({ name: "browser_observe", arguments: { session } });
    assert.equal((observed.structuredContent as Record<string, unknown>).status, "RUNNING");
  } finally {
    await client.close();
    await transport.exited();
  }
  assert.equal(transport.child.exitCode, 0);
});

test("stdio server shuts down with exit code 1 after an uncaught exception", async () => {
  const transport = new TestStdioTransport({
    ...process.env,
    JEVPILOT_SKIP_BROWSER: "1",
    JEVPILOT_TEST_UNCAUGHT: "1",
  });
  const client = new Client({ name: "stdio-uncaught", version: "1" });
  try {
    await client.connect(transport);
    await client
      .callTool({ name: "browser_run", arguments: { goal: "Finish" } })
      .catch(() => undefined);
    await transport.exited();
    assert.equal(transport.child.exitCode, 1);
    assert.match(
      transport.stderrLines.join(""),
      /jevpilot-mcp uncaughtException: CdpTimeoutError\n/u,
    );
    assert.doesNotMatch(transport.stderrLines.join(""), /SECRET_MARKER/u);
  } finally {
    await client.close().catch(() => {});
    if (transport.child.exitCode === null) {
      await transport.close();
      await transport.exited();
    }
  }
});

test("M6c: stdio server leaves no temp dirs after an uncaught exception", async () => {
  const root = await mkdtemp(join(tmpdir(), "stdio-temp-test-"));
  const transport = new TestStdioTransport({
    ...process.env,
    TEMP: root,
    TMP: root,
    TMPDIR: root,
    JEVPILOT_SKIP_BROWSER: "1",
    JEVPILOT_TEST_UNCAUGHT: "1",
  });
  const client = new Client({ name: "stdio-temp-race", version: "1" });
  try {
    await client.connect(transport);
    await client
      .callTool({ name: "browser_run", arguments: { goal: "Finish" } })
      .catch(() => undefined);
    await transport.exited();
    assert.equal(transport.child.exitCode, 1);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await client.close().catch(() => {});
    if (transport.child.exitCode === null) {
      await transport.close();
      await transport.exited();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("M6c: MCP server sweeps dead-owner temp dirs at startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "stdio-sweep-test-"));
  const dead = join(root, "jevpilot-dead");
  const unmarked = join(root, "jevpilot-nomarker");
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadPid = child.pid;
  assert.ok(deadPid);
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await mkdir(dead);
  await mkdir(unmarked);
  await writeFile(
    join(dead, ".jevpilot-owner.json"),
    JSON.stringify({ pid: deadPid, created: new Date().toISOString() }),
  );
  const transport = new TestStdioTransport(
    {
      ...process.env,
      TEMP: root,
      TMP: root,
      TMPDIR: root,
      JEVPILOT_SKIP_BROWSER: "1",
      JEVPILOT_USER_DATA_DIR: join(root, "profile"),
    },
    new URL("../../src/mcp/main.ts", import.meta.url),
  );
  const client = new Client({ name: "stdio-sweep", version: "1" });
  try {
    await client.connect(transport);
    for (let attempt = 0; existsSync(dead) && attempt < 100; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(existsSync(dead), false);
    assert.equal(existsSync(unmarked), true);
  } finally {
    await client.close();
    await transport.exited();
    await rm(root, { recursive: true, force: true });
  }
});
