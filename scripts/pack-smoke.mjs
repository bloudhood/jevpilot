import assert from "node:assert/strict";
import { selectOwnNpxInstalls } from "./pack-smoke-cleanup.mjs";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = join(root, ".npm-cache");
const temp = await mkdtemp(join(tmpdir(), "jevpilot-pack-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: command.endsWith(".cmd"),
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolveRun(stdout) : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`${name}: ok`);
  } catch (error) {
    console.log(`${name}: fail`);
    throw error;
  }
}

async function listTools(installed, server) {
  const installedRequire = createRequire(join(installed, "package.json"));
  const { Client } = await import(
    pathToFileURL(installedRequire.resolve("@modelcontextprotocol/sdk/client/index.js")).href
  );
  const { StdioClientTransport } = await import(
    pathToFileURL(installedRequire.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href
  );
  const client = new Client({ name: "pack-smoke", version: "1" });
  const transport = new StdioClientTransport({
    ...server,
    env: { ...process.env, JEVPILOT_SKIP_BROWSER: "1" },
  });
  try {
    await client.connect(transport);
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

try {
  const packed = JSON.parse(
    await run(
      npm,
      [
        "pack",
        "--json",
        "--pack-destination",
        temp,
        "--cache",
        cache,
        "--prefer-offline",
        "--no-audit",
        "--no-fund",
      ],
      root,
    ),
  );
  const tarball = join(temp, packed[0].filename);
  await check("package contains only intended distributable files", async () => {
    const allowed = (path) =>
      path === "package.json" ||
      path === "README.md" ||
      path === "README.zh-CN.md" ||
      path === "LICENSE" ||
      path.startsWith("dist/");
    const unexpected = packed[0].files.map(({ path }) => path).filter((path) => !allowed(path));
    assert.deepEqual(unexpected, [], `unexpected packed paths: ${unexpected.join(", ")}`);
  });

  const project = join(temp, "project");
  await mkdir(project);
  await check("packed package installs in a disposable project", () =>
    run(
      npm,
      ["install", tarball, "--cache", cache, "--offline", "--no-audit", "--no-fund"],
      project,
    ),
  );

  const installed = join(project, "node_modules", "jevpilot");
  const pkg = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  await access(
    join(
      project,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "jevpilot-mcp.cmd" : "jevpilot-mcp",
    ),
  );
  await check("installed CLI initializes and lists tools", async () => {
    const names = await listTools(installed, {
      command: process.execPath,
      args: [resolve(installed, pkg.bin["jevpilot-mcp"])],
    });
    assert.ok(names.includes("browser_run"));
  });

  // An empty directory, so npx installs the tarball itself instead of reusing the project's copy.
  const empty = join(temp, "npx");
  await mkdir(empty);
  const npxCache = join(cache, "_npx");
  const before = new Set(await readdir(npxCache).catch(() => []));
  try {
    await check("documented pinned command works", async () => {
      const names = await listTools(installed, {
        command: npx,
        args: ["--yes", "--offline", "--cache", cache, "--package", tarball, "jevpilot-mcp"],
        cwd: empty,
      });
      assert.ok(names.includes("browser_run"));
    });
  } finally {
    // Each tarball path gets its own npx install; drop this run's so the cache does not grow.
    const entries = await Promise.all(
      (await readdir(npxCache).catch(() => [])).map(async (name) => ({
        name,
        packageJson: await readFile(join(npxCache, name, "package.json"), "utf8")
          .then((contents) => JSON.parse(contents))
          .catch(() => undefined),
      })),
    );
    for (const entry of selectOwnNpxInstalls(entries, before, tarball))
      await rm(join(npxCache, entry), { recursive: true, force: true });
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
