import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer, type McpDeps } from "../../src/mcp/server.ts";
import { parseHttpConfig, startHttpServer, type HttpConfig } from "../../src/mcp/http.ts";
import { fakeMcpDeps } from "../support/mcp-fixture.ts";

const token = "0123456789abcdef";
const initialize = (name: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name, version: "1" } },
  });

async function running(
  deps: McpDeps = fakeMcpDeps(),
  config: Partial<HttpConfig> = {},
  options: { sessionIdleMs?: number } = {},
) {
  const app = createServer(deps);
  const http = await startHttpServer(
    { host: "127.0.0.1", port: 0, token, allowedHosts: [], allowedOrigins: [], ...config },
    app.createMcpServer,
    options,
  );
  return {
    app,
    http,
    close: async () => {
      await http.close();
      await app.close();
    },
  };
}

// node:http so the Host header can be chosen freely (fetch fixes it).
function send(
  port: number,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: options.method ?? "POST",
        headers: {
          host: `127.0.0.1:${port}`,
          authorization: `Bearer ${token}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...options.headers,
        },
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

async function connect(port: number): Promise<Client> {
  const client = new Client({ name: "http-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }) as never,
  );
  return client;
}

const data = (result: unknown): Record<string, unknown> =>
  (result as { structuredContent: Record<string, unknown> }).structuredContent;

test("R1: rejected HTTP requests do not leave MCP transports behind", async () => {
  const app = createServer(fakeMcpDeps());
  const created: ReturnType<typeof app.createMcpServer>[] = [];
  const http = await startHttpServer(
    { host: "127.0.0.1", port: 0, token, allowedHosts: [], allowedOrigins: [] },
    () => {
      const server = app.createMcpServer();
      created.push(server);
      return server;
    },
  );
  try {
    assert.equal((await send(http.port, { body: "{" })).status, 400);
    assert.equal((await send(http.port, { body: "x".repeat(4 * 1024 * 1024 + 1) })).status, 413);
    assert.equal(created.length, 0);
    const rejected = await send(http.port, {
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.headers["mcp-session-id"], undefined);
    assert.equal(created.length, 1);
    assert.equal(created[0]?.isConnected(), false);
    assert.equal((await send(http.port, { body: initialize("valid") })).status, 200);
    assert.equal(created.length, 2);
  } finally {
    await http.close();
    await app.close();
  }
});

test("O4: http transport settings are validated at startup", () => {
  assert.equal(parseHttpConfig({}).transport, "stdio");
  assert.throws(() => parseHttpConfig({ JEVPILOT_TRANSPORT: "sse" }), /JEVPILOT_TRANSPORT/u);
  assert.throws(() => parseHttpConfig({ JEVPILOT_TRANSPORT: "http" }), /JEVPILOT_HTTP_TOKEN/u);
  assert.throws(
    () => parseHttpConfig({ JEVPILOT_TRANSPORT: "http", JEVPILOT_HTTP_TOKEN: "too-short" }),
    /JEVPILOT_HTTP_TOKEN/u,
  );
  for (const port of ["70000", "abc", "-1"])
    assert.throws(
      () =>
        parseHttpConfig({
          JEVPILOT_TRANSPORT: "http",
          JEVPILOT_HTTP_TOKEN: token,
          JEVPILOT_HTTP_PORT: port,
        }),
      /JEVPILOT_HTTP_PORT/u,
      port,
    );
  const parsed = parseHttpConfig({
    JEVPILOT_TRANSPORT: "http",
    JEVPILOT_HTTP_TOKEN: token,
    JEVPILOT_HTTP_ALLOWED_ORIGINS: "https://a.test, https://b.test",
  }).http;
  assert.equal(parsed?.host, "127.0.0.1");
  assert.equal(parsed?.port, 8940);
  assert.deepEqual(parsed?.allowedOrigins, ["https://a.test", "https://b.test"]);
});

test("O4: requests without the right bearer token are rejected before any MCP handling", async () => {
  const deps = fakeMcpDeps();
  const server = await running(deps);
  try {
    for (const authorization of [
      undefined,
      `Bearer ${token}x`,
      "Bearer wrong-token-0000000",
      `Basic ${Buffer.from(`user:${token}`).toString("base64")}`,
    ]) {
      const headers: Record<string, string> = authorization ? { authorization } : {};
      if (!authorization) headers.authorization = "";
      const response = await send(server.http.port, { headers, body: initialize("intruder") });
      assert.equal(response.status, 401, String(authorization));
      assert.equal(response.headers["www-authenticate"], "Bearer");
      assert.equal(response.headers["mcp-session-id"], undefined, "no MCP session was created");
    }
    assert.equal(deps.launches(), 0, "no browser work happened");
    // Positive control: the right token (scheme case does not matter) initializes a session.
    const accepted = await send(server.http.port, {
      headers: { authorization: `bearer ${token}` },
      body: initialize("owner"),
    });
    assert.equal(accepted.status, 200);
    assert.ok(accepted.headers["mcp-session-id"]);
  } finally {
    await server.close();
  }
});

test("O4: a foreign Host or an unlisted Origin is rejected on a loopback bind", async () => {
  const server = await running(fakeMcpDeps(), { allowedOrigins: ["https://app.test"] });
  try {
    const port = server.http.port;
    for (const host of ["evil.test", `evil.test:${port}`, `127.0.0.1:${port + 1}`])
      assert.equal(
        (await send(port, { headers: { host }, body: initialize("rebind") })).status,
        403,
        host,
      );
    assert.equal(
      (await send(port, { headers: { origin: "https://evil.test" }, body: initialize("page") }))
        .status,
      403,
    );
    assert.equal(
      (await send(port, { headers: { origin: "https://app.test" }, body: initialize("app") }))
        .status,
      200,
    );
    assert.equal(
      (await send(port, { headers: { host: `localhost:${port}` }, body: initialize("local") }))
        .status,
      200,
    );
  } finally {
    await server.close();
  }
});

test("O4: an HTTP client with the token runs browser_run and browser_close", async () => {
  const deps = fakeMcpDeps();
  const server = await running(deps);
  let client: Client | undefined;
  // Everything after the server starts sits inside try, so a failure still closes the listener.
  try {
    client = await connect(server.http.port);
    const run = data(await client.callTool({ name: "browser_run", arguments: { goal: "Finish" } }));
    assert.equal(typeof run.session, "string");
    assert.notEqual(run.session, "");
    assert.equal(deps.pages.length, 1);
    const closed = data(
      await client.callTool({ name: "browser_close", arguments: { session: run.session } }),
    );
    assert.equal(closed.closed, true);
    const after = await client.callTool({
      name: "browser_observe",
      arguments: { session: run.session },
    });
    assert.equal(after.isError, true, "the closed session is gone");
  } finally {
    await client?.close().catch(() => {});
    await server.close();
  }
});

test("O4: two HTTP clients share browser sessions and the session limit", async () => {
  const server = await running({ ...fakeMcpDeps(), maxSessions: 1 });
  const clients: Client[] = [];
  try {
    const a = await connect(server.http.port);
    clients.push(a);
    const b = await connect(server.http.port);
    clients.push(b);
    const run = data(await a.callTool({ name: "browser_run", arguments: { goal: "Finish" } }));
    const observed = await b.callTool({
      name: "browser_observe",
      arguments: { session: run.session },
    });
    assert.notEqual(observed.isError, true, "client B sees client A's browser session");
    const refused = data(await b.callTool({ name: "browser_run", arguments: { goal: "Finish" } }));
    assert.equal(refused.reason, "too_many_sessions", "the limit counts both clients");
    await a.callTool({ name: "browser_close", arguments: { session: run.session } });
    const admitted = data(await b.callTool({ name: "browser_run", arguments: { goal: "Finish" } }));
    assert.notEqual(admitted.reason, "too_many_sessions");
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await server.close();
  }
});

test("O4: an idle or deleted MCP session releases its transport", async () => {
  const server = await running(fakeMcpDeps(), {}, { sessionIdleMs: 100 });
  const port = server.http.port;
  const open = async (name: string) => {
    const response = await send(port, { body: initialize(name) });
    const id = String(response.headers["mcp-session-id"]);
    await send(port, {
      headers: { "mcp-session-id": id },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    return id;
  };
  const list = (id: string) =>
    send(port, {
      headers: { "mcp-session-id": id },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
  try {
    const deleted = await open("deleted");
    assert.equal((await list(deleted)).status, 200, "a live session answers");
    assert.equal(
      (await send(port, { method: "DELETE", headers: { "mcp-session-id": deleted } })).status,
      200,
    );
    assert.equal((await list(deleted)).status, 404, "a deleted session is gone");
    const idle = await open("idle");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal((await list(idle)).status, 404, "an idle session is closed");
  } finally {
    await server.close();
  }
});

test("O4: jevpilot-mcp serves HTTP from the environment without stdin", async () => {
  const child = spawn(process.execPath, ["src/mcp/main.ts"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      JEVPILOT_TRANSPORT: "http",
      JEVPILOT_HTTP_PORT: "0",
      JEVPILOT_HTTP_TOKEN: token,
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no listening line: ${stderr}`)), 10000);
      const check = () => {
        const match = /listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/u.exec(stderr);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        } else setTimeout(check, 10);
      };
      check();
    });
    // stdin is closed from the start; an http server must not stop because of it.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(child.exitCode, null, "still running with stdin closed");
    const client = await connect(port);
    try {
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      assert.ok(tools.includes("browser_run"));
    } finally {
      await client.close().catch(() => {});
    }
    assert.doesNotMatch(stderr, new RegExp(token, "u"), "the token is never printed");
  } finally {
    child.kill();
    await new Promise<void>((resolve) =>
      child.exitCode === null ? child.once("exit", () => resolve()) : resolve(),
    );
  }
});
