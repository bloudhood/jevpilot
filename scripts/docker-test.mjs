import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`${args.join(" ")} failed (${code})\n${stdout}\n${stderr}`)),
    );
  });
}

await run(["build", "--target", "test", "-t", "jevpilot:test", "."]);
await run(["build", "-t", "jevpilot:runtime", "."]);
for (const display of ["xvfb", "headless"]) {
  const output = await run([
    "run",
    "--rm",
    "--init",
    "--shm-size=1g",
    "-e",
    `JEVPILOT_TEST_DISPLAY=${display}`,
    "jevpilot:test",
  ]);
  const count = (name) =>
    [...output.matchAll(new RegExp(`^ℹ ${name} (\\d+)$`, "gmu"))].map((match) => match[1]);
  const [tests, pass, skipped] = [count("tests"), count("pass"), count("skipped")];
  assert.equal(tests.length, 2, `missing test counts for ${display}`);
  console.log(
    `${display}: unit ${pass[0]}/${tests[0]} (skipped ${skipped[0]}), integration ${pass[1]}/${tests[1]} (skipped ${skipped[1]})`,
  );
}
const client = new Client({ name: "docker-smoke", version: "1" });
const transport = new StdioClientTransport({
  command: "docker",
  args: ["run", "--rm", "-i", "--shm-size=1g", "jevpilot:runtime"],
});
try {
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === "browser_run"));
  console.log("runtime: browser_run available");
} finally {
  await client.close();
}

// doctor really launches Chromium in the runtime image (the tool list above never starts a browser).
const doctor = JSON.parse(
  await run(["run", "--rm", "--init", "--shm-size=1g", "jevpilot:runtime", "doctor", "--json"]),
);
const browserCheck = doctor.checks.find((check) => check.name === "browser");
assert.ok(doctor.ok, JSON.stringify(doctor));
assert.notEqual(browserCheck?.status, "fail", JSON.stringify(browserCheck));
console.log(`runtime doctor: browser ${browserCheck?.status} (${browserCheck?.detail})`);

// HTTP transport: bound to 0.0.0.0 inside the container, published only on the host's loopback.
const token = randomBytes(24).toString("hex");
const name = `jevpilot-http-smoke-${process.pid}`;
await run([
  "run",
  "--rm",
  "-d",
  "--name",
  name,
  "--shm-size=1g",
  "-e",
  "JEVPILOT_TRANSPORT=http",
  "-e",
  "JEVPILOT_HTTP_HOST=0.0.0.0",
  "-e",
  `JEVPILOT_HTTP_TOKEN=${token}`,
  "-p",
  "127.0.0.1:0:8940",
  "jevpilot:runtime",
]);
try {
  const published = (await run(["port", name, "8940/tcp"])).trim().split(/\r?\n/u)[0];
  const url = `http://${published}/mcp`;
  let unauthorized;
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; ) {
    unauthorized = await fetch(url, { method: "POST" }).catch(() => undefined);
    if (unauthorized) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(unauthorized?.status, 401, "requests without the token are refused");
  const httpClient = new Client({ name: "docker-http-smoke", version: "1" });
  try {
    await httpClient.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    assert.ok((await httpClient.listTools()).tools.some((tool) => tool.name === "browser_run"));
  } finally {
    await httpClient.close().catch(() => {});
  }
  console.log("runtime http: 401 without the token, browser_run with it");
} finally {
  await run(["stop", name]).catch(() => {});
}
