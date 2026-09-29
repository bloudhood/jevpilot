import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("only MCP source imports orchestrator and MCP source does not import CDP", async () => {
  const root = new URL("../../src/", import.meta.url);
  async function files(directory: URL): Promise<URL[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const result: URL[] = [];
    for (const entry of entries) {
      const path = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
      if (entry.isDirectory()) result.push(...(await files(path)));
      else if (entry.name.endsWith(".ts")) result.push(path);
    }
    return result;
  }
  for (const path of await files(root)) {
    const parts = relative(fileURLToPath(root), fileURLToPath(path)).split(sep);
    const source = await readFile(path, "utf8");
    if (parts[0] !== "mcp") {
      if (parts.length !== 1 || parts[0] !== "index.ts")
        assert.doesNotMatch(source, /from ["'][^"']*orchestrator\//u);
    } else assert.doesNotMatch(source, /from ["'][^"']*(?:browser\/|engine\/cdp\/)/u);
  }
});
