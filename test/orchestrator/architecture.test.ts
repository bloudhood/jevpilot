import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = new URL("../../src/", import.meta.url);
const imports = (text: string): string[] =>
  [...text.matchAll(/(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu)].map(
    (match) => match[1] ?? "",
  );

test("orchestrator imports only its allowed module boundary", async () => {
  const directory = new URL("orchestrator/", source);
  for (const entry of await readdir(directory)) {
    if (!entry.endsWith(".ts")) continue;
    const contents = await readFile(new URL(entry, directory), "utf8");
    for (const specifier of imports(contents))
      assert.match(
        specifier,
        /^(?:zod|node:(?:crypto|fs\/promises|os|path)|\.\/[a-z-]+\.ts|\.\.\/(?:engine\/types|observer\/[^/]+|util\/[^/]+|detectors\/[^/]+|policy\/[^/]+|executor\/[^/]+|decision\/[^/]+)\.ts)$/u,
        `${entry}: ${specifier}`,
      );
  }
});

test("other source modules do not import orchestrator", async () => {
  async function walk(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) files.push(...(await walk(path)));
      else if (path.endsWith(".ts")) files.push(path);
    }
    return files;
  }
  const sourcePath = fileURLToPath(source);
  for (const path of await walk(sourcePath)) {
    const parts = relative(sourcePath, path).split(sep);
    if (parts[0] === "orchestrator" || parts[0] === "mcp") continue;
    if (parts.length === 1 && parts[0] === "index.ts") continue;
    for (const specifier of imports(await readFile(path, "utf8")))
      assert.doesNotMatch(specifier, /(?:^|\/)orchestrator\//u, path);
  }
});
