import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { findChrome } from "../../../src/browser/launcher.ts";
import { sessionResultSchema } from "../../../src/orchestrator/result.ts";
import { TestStdioTransport } from "../../support/mcp-stdio.ts";

const browserPath = process.env.JEVPILOT_SKIP_BROWSER === "1" ? undefined : await findChrome();

test(
  "MCP real Chrome run to handoff to resume to verified done",
  { skip: browserPath ? undefined : "Chrome unavailable or JEVPILOT_SKIP_BROWSER=1" },
  async () => {
    const site: Server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(
        "<title>Buy</title><button onclick=\"document.body.innerHTML='<h1>Purchased</h1>'\">Buy now</button>",
      );
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    const address = site.address();
    if (!address || typeof address === "string") throw new Error("fixture site has no port");
    const directory = await mkdtemp(join(tmpdir(), "jevpilot-mcp-integration-"));
    const transport = new TestStdioTransport({
      ...process.env,
      JEVPILOT_TEST_REAL: "1",
      JEVPILOT_BROWSER_PATH: browserPath!,
      JEVPILOT_USER_DATA_DIR: directory,
    });
    const client = new Client({ name: "mcp-real-test", version: "1" });
    try {
      await client.connect(transport);
      const run = await client.callTool({
        name: "browser_run",
        arguments: {
          goal: "Buy the item",
          url: `http://127.0.0.1:${address.port}/buy`,
          success: { text_present: "Purchased" },
        },
      });
      assert.equal((run.structuredContent as Record<string, unknown>).status, "CONFIRM_REQUIRED");
      const session = String((run.structuredContent as Record<string, unknown>).session);
      const resumed = await client.callTool({
        name: "browser_resume",
        arguments: { session, allow_irreversible: true },
      });
      assert.equal((resumed.structuredContent as Record<string, unknown>).status, "DONE_VERIFIED");
      await client.callTool({ name: "browser_close", arguments: { session } });
    } catch (error) {
      const tail = transport.stderrLines.join("").slice(-4000);
      const last = transport.stdoutLines.at(-1) ?? "<none>";
      throw new Error(
        `MCP browser integration failed: ${String(error)}\nserver stderr tail:\n${tail}\nlast tool result:\n${last}`,
      );
    } finally {
      await client.close();
      await transport.exited();
      await new Promise<void>((resolve) => site.close(() => resolve()));
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  },
);

test(
  "M5a: every takeover op is accepted by the stdio MCP schema",
  { skip: browserPath ? undefined : "Chrome unavailable or JEVPILOT_SKIP_BROWSER=1" },
  async () => {
    const site = createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      response.end(
        path === "/ops"
          ? `<title>Operations</title><h1>MCP fixture ready</h1>
        <button id="hover" style="width:80px;height:40px">Hover target</button>
        <button id="drag" draggable="true" style="width:80px;height:40px">Drag source</button>
        <button id="drop" style="width:80px;height:40px">Drop target</button>
        <label>Upload <input type="file"></label>
        <form action="/result"><label>Query <input name="q"></label><button>Search</button></form>`
          : "<title>Result</title><h1>Result page</h1>",
      );
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    const address = site.address();
    if (!address || typeof address === "string") throw new Error("fixture site has no port");
    const directory = await mkdtemp(join(tmpdir(), "jevpilot-mcp-takeover-"));
    const upload = join(directory, "uploads");
    await mkdir(upload);
    const file = join(upload, "sample.txt");
    await writeFile(file, "fixture", "utf8");
    const transport = new TestStdioTransport({
      ...process.env,
      JEVPILOT_TEST_REAL: "1",
      JEVPILOT_BROWSER_PATH: browserPath!,
      JEVPILOT_USER_DATA_DIR: join(directory, "profile"),
      JEVPILOT_UPLOAD_DIR: upload,
    });
    const client = new Client({ name: "mcp-takeover-test", version: "1" });
    const base = `http://127.0.0.1:${address.port}`;
    try {
      await client.connect(transport);
      const run = await client.callTool({
        name: "browser_run",
        arguments: {
          goal: "Inspect fixture",
          url: `${base}/ops`,
          success: { text_present: "MCP fixture ready" },
          constraints: { allowed_domains: ["127.0.0.1"] },
        },
      });
      assert.equal(run.isError, undefined);
      const parsed = sessionResultSchema.parse(run.structuredContent);
      const session = parsed.session;
      const observed = await client.callTool({ name: "browser_observe", arguments: { session } });
      assert.equal(observed.isError, undefined);
      const snapshot = sessionResultSchema.parse(observed.structuredContent).snapshot;
      const ref = (name: string): string => {
        const line = snapshot.split("\n").find((entry) => entry.includes(JSON.stringify(name)));
        const match = line?.match(/^(e\d+)\s/u);
        assert.ok(match, `missing ${name}: ${snapshot}`);
        return match[1]!;
      };
      const calls = [
        [{ action: "hover", ref: ref("Hover target") }],
        [{ action: "drag", ref: ref("Drag source"), to_ref: ref("Drop target") }],
        [{ action: "upload", ref: ref("Upload"), paths: [file] }],
        [{ action: "wait_for", text: "MCP fixture ready", timeout_ms: 1000 }],
        [{ action: "press_key", name: "Tab" }],
        [{ action: "type", ref: ref("Query"), text: "cedar", submit: true }],
      ];
      for (const ops of calls) {
        const result = await client.callTool({ name: "browser_act", arguments: { session, ops } });
        assert.equal(result.isError, undefined, JSON.stringify({ ops, result }));
        sessionResultSchema.parse(result.structuredContent);
      }
      const navigated = await client.callTool({
        name: "browser_navigate",
        arguments: { session, url: `${base}/ops` },
      });
      assert.equal(navigated.isError, undefined);
      sessionResultSchema.parse(navigated.structuredContent);
      const tabs = await client.callTool({
        name: "browser_tabs",
        arguments: { session, action: "list" },
      });
      assert.equal(tabs.isError, undefined);
      const listed = z
        .object({
          session: z.string(),
          tabs: z.array(z.object({ tab_id: z.string(), url: z.string(), selected: z.boolean() })),
        })
        .parse(tabs.structuredContent);
      assert.equal(listed.session, session);
      assert.ok(listed.tabs.length > 0);
      await client.callTool({ name: "browser_close", arguments: { session } });
    } catch (error) {
      throw new Error(
        `MCP takeover integration failed: ${String(error)}\n${transport.stderrLines.join("").slice(-4000)}`,
      );
    } finally {
      await client.close();
      await transport.exited();
      await new Promise<void>((resolve) => site.close(() => resolve()));
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  },
);
