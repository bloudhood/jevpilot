import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer, type McpDeps } from "../../src/mcp/server.ts";
import { startHttpServer } from "../../src/mcp/http.ts";
import { fakeMcpDeps } from "../support/mcp-fixture.ts";

const expected = {
  browser_run: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  browser_resume: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  browser_act: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  browser_navigate: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  browser_tabs: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  browser_observe: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  browser_close: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  browser_screenshot: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  jev_decide: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

async function listed(deps: McpDeps) {
  const app = createServer(deps);
  const client = new Client({ name: "annotations-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await app.close();
  }
}

test("every listed tool has four boolean hints", async () => {
  const tools = await listed(fakeMcpDeps());
  assert.deepEqual(
    Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations])),
    expected,
  );
  for (const tool of tools) {
    assert.deepEqual(Object.keys(tool.annotations ?? {}).sort(), [
      "destructiveHint",
      "idempotentHint",
      "openWorldHint",
      "readOnlyHint",
    ]);
    for (const value of Object.values(tool.annotations ?? {}))
      assert.equal(typeof value, "boolean");
  }
});

test("hints are correct without a decision port", async () => {
  const deps = fakeMcpDeps();
  delete deps.decisionPort;
  const withoutDecision = await listed(deps);
  assert.deepEqual(
    Object.fromEntries(withoutDecision.map((tool) => [tool.name, tool.annotations])),
    Object.fromEntries(Object.entries(expected).filter(([name]) => name !== "jev_decide")),
  );
  const withDecision = await listed(fakeMcpDeps());
  assert.deepEqual(
    withDecision.find((tool) => tool.name === "jev_decide")?.annotations,
    expected.jev_decide,
  );
});

test("HTTP server registrations preserve hints", async () => {
  const app = createServer(fakeMcpDeps());
  const http = await startHttpServer(
    { host: "127.0.0.1", port: 0, token: "0123456789abcdef", allowedHosts: [], allowedOrigins: [] },
    app.createMcpServer,
  );
  let client: Client | undefined;
  try {
    client = new Client({ name: "annotations-http-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`), {
        requestInit: { headers: { authorization: "Bearer 0123456789abcdef" } },
      }) as never,
    );
    const tools = (await client.listTools()).tools;
    assert.deepEqual(
      Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations])),
      expected,
    );
  } finally {
    await client?.close().catch(() => {});
    await http.close();
    await app.close();
  }
});

test("screenshot remains content-only without outputSchema or structuredContent", async () => {
  const app = createServer(fakeMcpDeps());
  const client = new Client({ name: "annotations-screenshot-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  try {
    const tool = (await client.listTools()).tools.find(
      (item) => item.name === "browser_screenshot",
    );
    assert.deepEqual(tool?.annotations, expected.browser_screenshot);
    assert.equal(tool?.outputSchema, undefined);
    const run = (await client.callTool({ name: "browser_run", arguments: { goal: "Finish" } })) as {
      structuredContent?: { session?: string };
    };
    const result = (await client.callTool({
      name: "browser_screenshot",
      arguments: { session: run.structuredContent!.session },
    })) as { structuredContent?: unknown; content: Array<{ type: string }> };
    assert.equal(result.structuredContent, undefined);
    assert.equal(
      result.content.some((item) => item.type === "image"),
      true,
    );
  } finally {
    await client.close();
    await app.close();
  }
});
