import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const root = fileURLToPath(new URL("../../", import.meta.url));

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    }),
  );
  return nested.flat();
}

test("O2: the build emits dist/mcp/main.js with its shebang and only .js relative imports", async () => {
  const temp = await mkdtemp(join(tmpdir(), "jevpilot-build-"));
  try {
    const output = join(temp, "dist");
    const result = spawnSync(
      process.execPath,
      ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json", "--outDir", output],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const sourceFiles = new Set(
      (await files(join(root, "src"))).map((path) => relative(join(root, "src"), path)),
    );
    const emitted = await files(output);
    for (const path of emitted) {
      const source = relative(output, path).replace(/\.js$/u, ".ts");
      assert.ok(
        path.endsWith(".js") && sourceFiles.has(source),
        `unexpected emitted file: ${path}`,
      );
    }
    const entry = join(output, "mcp", "main.js");
    assert.match(await readFile(entry, "utf8"), /^#!\/usr\/bin\/env node\r?\n/u);
    const visited = new Set<string>();
    async function visit(path: string): Promise<void> {
      if (visited.has(path)) return;
      visited.add(path);
      const code = await readFile(path, "utf8");
      const ast = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const imports: string[] = [];
      function scan(node: ts.Node): void {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          imports.push(node.moduleSpecifier.text);
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments.length === 1 &&
          ts.isStringLiteral(node.arguments[0]!)
        )
          imports.push(node.arguments[0]!.text);
        ts.forEachChild(node, scan);
      }
      scan(ast);
      for (const specifier of imports.filter((value) => value.startsWith("."))) {
        assert.ok(specifier.endsWith(".js"), `${path}: ${specifier}`);
        const target = resolve(dirname(path), specifier);
        assert.ok(emitted.includes(target), `${path}: missing ${specifier}`);
        await visit(target);
      }
    }
    await visit(entry);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("O2: package.json bin, files and engines describe the built package", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    bin: Record<string, string>;
    files: string[];
    engines: { node: string };
    scripts: Record<string, string>;
  };
  const config = JSON.parse(await readFile(join(root, "tsconfig.build.json"), "utf8")) as {
    compilerOptions: { rootDir: string; outDir: string };
  };
  assert.equal(pkg.bin["jevpilot-mcp"], `./${config.compilerOptions.outDir}/mcp/main.js`);
  assert.equal(config.compilerOptions.rootDir, "src");
  assert.deepEqual(pkg.files, ["dist"]);
  assert.equal(pkg.engines.node, ">=22");
  assert.match(pkg.scripts.prepack!, /npm run build/u);
});
