import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = join(root, ".npm-cache");
const temp = await mkdtemp(join(tmpdir(), "jevpilot-pack-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

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
  const project = join(temp, "project");
  await mkdir(project);
  await run(
    npm,
    [
      "install",
      join(temp, packed[0].filename),
      "--cache",
      cache,
      "--prefer-offline",
      "--no-audit",
      "--no-fund",
    ],
    project,
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
  const installedRequire = createRequire(join(installed, "package.json"));
  const { Client } = await import(
    pathToFileURL(installedRequire.resolve("@modelcontextprotocol/sdk/client/index.js")).href
  );
  const { StdioClientTransport } = await import(
    pathToFileURL(installedRequire.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href
  );
  const client = new Client({ name: "pack-smoke", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(installed, pkg.bin["jevpilot-mcp"])],
    env: { ...process.env, JEVPILOT_SKIP_BROWSER: "1" },
  });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    console.log(names.join("\n"));
    assert.ok(names.includes("browser_run"));
  } finally {
    await client.close();
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
