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

test("M7a: tool modules import only allowed modules", async () => {
  const toolsDirectory = new URL("../../src/mcp/tools/", import.meta.url);
  const entries = await readdir(toolsDirectory, { withFileTypes: true });
  const allowed = [
    /^zod$/u,
    /^node:(?:crypto|path|fs\/promises)$/u,
    /^@modelcontextprotocol\/sdk\/types\.js$/u,
    /^\.\.\/host\.ts$/u,
    /^\.\.\/schemas\.ts$/u,
    /^\.\.\/errors\.ts$/u,
    /^\.\.\/thresholds\.ts$/u,
    /^\.\.\/\.\.\/orchestrator\/session\.ts$/u,
    /^\.\.\/\.\.\/orchestrator\/result\.ts$/u,
    /^\.\.\/\.\.\/engine\/types\.ts$/u,
    /^\.\.\/\.\.\/decision\/types\.ts$/u,
    /^\.\/[A-Za-z0-9_-]+\.ts$/u,
  ];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const source = await readFile(new URL(entry.name, toolsDirectory), "utf8");
    const specifiers = [
      ...[...source.matchAll(/from ["']([^"']+)["']/gu)].map((match) => match[1]!),
      ...[...source.matchAll(/import ["']([^"']+)["'];/gu)].map((match) => match[1]!),
    ];
    for (const specifier of specifiers) {
      assert.ok(
        allowed.some((pattern) => pattern.test(specifier)),
        `${entry.name} imports a module outside the allowlist: ${specifier}`,
      );
    }
  }
});

test("M7a: tool modules keep no module-level mutable state", async () => {
  const toolsDirectory = new URL("../../src/mcp/tools/", import.meta.url);
  const entries = await readdir(toolsDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const source = await readFile(new URL(entry.name, toolsDirectory), "utf8");
    const topLevel = source
      .split(/\r?\n/u)
      .filter((line) => /^[^ \t}]/u.test(line) && !line.startsWith("//"));
    for (const line of topLevel) {
      assert.doesNotMatch(line, /^let /u, `${entry.name} keeps a module-level let: ${line}`);
      assert.doesNotMatch(line, /^var /u, `${entry.name} keeps a module-level var: ${line}`);
      assert.doesNotMatch(
        line,
        /new Map\(/u,
        `${entry.name} keeps module-level mutable state: ${line}`,
      );
      assert.doesNotMatch(
        line,
        /new Set\(/u,
        `${entry.name} keeps module-level mutable state: ${line}`,
      );
    }
  }
});
