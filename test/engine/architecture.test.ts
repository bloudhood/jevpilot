import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const source = fileURLToPath(new URL("../../src/", import.meta.url));

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
    }),
  );
  return paths.flat();
}

test("non-driver modules do not import CDP implementation or protocol types", async () => {
  const files = (await sourceFiles(source)).filter((path) => {
    const name = relative(source, path).replaceAll("\\", "/");
    // The engine composition root is where the concrete driver is registered.
    return (
      !name.startsWith("browser/") &&
      !name.startsWith("engine/cdp/") &&
      name !== "engine/default.ts" &&
      name !== "index.ts"
    );
  });
  for (const path of files) {
    const contents = await readFile(path, "utf8");
    const imports = contents.matchAll(
      /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu,
    );
    for (const match of imports) {
      const specifier = match[1] ?? "";
      assert.doesNotMatch(
        specifier,
        /(?:devtools-protocol|(?:^|\/)browser\/|(?:^|\/)engine\/cdp\/)/u,
        relative(source, path),
      );
    }
  }
});

test("executor imports only engine interfaces and observer modules from src", async () => {
  const files = await sourceFiles(join(source, "executor"));
  for (const path of files) {
    const contents = await readFile(path, "utf8");
    for (const match of contents.matchAll(
      /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu,
    )) {
      const specifier = match[1] ?? "";
      assert.match(
        specifier,
        /^(?:\.\/|\.\.\/engine\/types\.ts$|\.\.\/observer\/)/u,
        relative(source, path),
      );
    }
  }
});

test("detectors import only engine interfaces, observer types and executor types", async () => {
  const files = await sourceFiles(join(source, "detectors"));
  for (const path of files) {
    const contents = await readFile(path, "utf8");
    for (const match of contents.matchAll(
      /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu,
    )) {
      assert.match(
        match[1] ?? "",
        /^(?:\.\/|\.\.\/engine\/types\.ts$|\.\.\/observer\/types\.ts$|\.\.\/executor\/types\.ts$)/u,
        relative(source, path),
      );
    }
  }
});

test("policy imports only its permitted pure-code dependencies", async () => {
  for (const path of await sourceFiles(join(source, "policy"))) {
    const contents = await readFile(path, "utf8");
    for (const match of contents.matchAll(
      /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu,
    )) {
      assert.match(
        match[1] ?? "",
        /^(?:\.\/|\.\.\/observer\/(?:types|format)\.ts$|\.\.\/detectors\/[^/]+\.ts$|\.\.\/decision\/(?:types|limits|errors)\.ts$|\.\.\/executor\/types\.ts$)/u,
        relative(source, path),
      );
    }
  }
});
