import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/mcp/server.ts";
import { fakeMcpDeps } from "../support/mcp-fixture.ts";

const fixturePath = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures/tools-list.json");

test("M7a: tools/list output is unchanged", async () => {
  const app = createServer(fakeMcpDeps());
  const client = new Client({ name: "tools-list-golden", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  let tools: unknown;
  try {
    tools = (await client.listTools()).tools;
  } finally {
    await client.close();
    await app.close();
  }
  if (process.env.JEVPILOT_UPDATE_GOLDEN === "1") {
    await mkdir(new URL(".", `file://${fixturePath}`), { recursive: true });
    await writeFile(fixturePath, `${JSON.stringify(tools, null, 2)}\n`);
    return;
  }
  const golden: unknown = JSON.parse(await readFile(fixturePath, "utf8"));
  // JSON in and out drops keys with undefined values (title, annotations), so the
  // comparison happens on the serialized form, which is also what clients receive.
  assert.equal(JSON.stringify(tools), JSON.stringify(golden));
});
