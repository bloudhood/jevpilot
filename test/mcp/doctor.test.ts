import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runDoctor } from "../../src/mcp/doctor.ts";
import type { BrowserHandle, EngineDriver, LaunchOptions } from "../../src/engine/types.ts";
import type { DecisionPort } from "../../src/decision/types.ts";

const fakeBrowser = (
  checks: { name: string; ok: boolean; required: boolean; value: unknown }[] = [],
) => {
  let closed = false;
  const browser = {
    engine: { name: "default", driver: "cdp", stealthLevel: "low" },
    selfCheck: { ok: checks.every((item) => !item.required || item.ok), checks, stealth: "low" },
    close: async () => {
      closed = true;
    },
  } as unknown as BrowserHandle;
  return { browser, isClosed: () => closed };
};

const fakeEngine =
  (browser: BrowserHandle, launched: LaunchOptions[] = []) =>
  () => ({
    resolve: () => ({
      launch: async (options?: LaunchOptions) => {
        launched.push(options ?? {});
        return browser;
      },
    }),
  });

const fakePort: DecisionPort = {
  decide: async (request) => {
    assert.equal(request.questions.ready?.type, "choice");
    return {
      answers: {
        ready: { type: "choice", choice: "yes", probabilities: { yes: 1 }, confidence: 1 },
      },
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "test-model",
      provider: "typesafe",
      latencyMs: 12,
      attempts: 1,
    };
  },
};

const env = {
  JEV_PROVIDER: "typesafe",
  JEV_API_KEY: "example-key",
  JEVPILOT_USER_DATA_DIR: "doctor-test-profile",
};
const temp = { tempCreate: async () => "fake-temp", tempRemove: async () => {} };

test("O8: doctor reports every check and exits 1 when a required check fails", async () => {
  const { browser, isClosed } = fakeBrowser([
    { name: "webdriver", ok: false, required: true, value: true },
  ]);
  const launched: LaunchOptions[] = [];
  const lines: string[] = [];
  const result = await runDoctor({
    env,
    engineFactory: fakeEngine(browser, launched),
    decisionPortFactory: () => fakePort,
    out: (line) => lines.push(line),
    ...temp,
  });
  assert.deepEqual(
    result.checks.map((check) => check.name),
    ["node", "config", "browser", "decision", "temp"],
  );
  assert.equal(result.ok, false);
  assert.equal(result.checks[2]?.status, "fail");
  // A launched profile without an explicit executable reports the discovered browser, not "attach".
  assert.doesNotMatch(result.checks[1]?.detail ?? "", /executable=attach/u);
  assert.equal(launched[0]?.selfCheck, true);
  assert.equal(launched[0]?.timeoutMs, 30_000);
  assert.equal(isClosed(), true);
  assert.match(lines.at(-1) ?? "", /^fail summary:/u);
});

test("O8: doctor reports failed required and informational self-check items separately", async () => {
  const { browser } = fakeBrowser([
    { name: "webdriver", ok: false, required: true, value: true },
    { name: "renderer", ok: false, required: false, value: "software" },
  ]);
  const result = await runDoctor({
    env,
    engineFactory: fakeEngine(browser),
    decisionPortFactory: () => fakePort,
    out: () => {},
    ...temp,
  });
  assert.match(result.checks[2]?.detail ?? "", /failed required: webdriver/u);
  assert.match(result.checks[2]?.detail ?? "", /failed informational: renderer/u);
  assert.equal(result.checks[2]?.status, "fail");
  // Informational failures alone (e.g. software rendering on a server) only warn.
  const informational = await runDoctor({
    env,
    engineFactory: fakeEngine(
      fakeBrowser([
        { name: "webdriver", ok: true, required: true, value: false },
        { name: "renderer", ok: false, required: false, value: "software" },
      ]).browser,
    ),
    decisionPortFactory: () => fakePort,
    out: () => {},
    ...temp,
  });
  assert.equal(informational.checks[2]?.status, "warn");
  assert.doesNotMatch(informational.checks[2]?.detail ?? "", /failed required/u);
  assert.equal(informational.ok, true);
});

test("O8: doctor warns without a decision provider and reports the decision error category", async () => {
  const without = await runDoctor({
    env: { JEVPILOT_USER_DATA_DIR: "doctor-test-profile" },
    noBrowser: true,
    out: () => {},
    ...temp,
  });
  assert.equal(without.checks[3]?.status, "warn");
  assert.match(without.checks[3]?.detail ?? "", /browser_run needs JEV_PROVIDER/u);
  const withError = await runDoctor({
    env,
    noBrowser: true,
    decisionPortFactory: () => ({
      decide: async () => {
        const error = new Error("secret response");
        error.name = "DecisionTimeoutError";
        throw error;
      },
    }),
    out: () => {},
    ...temp,
  });
  assert.deepEqual(withError.checks[3], {
    name: "decision",
    status: "fail",
    detail: "decision timeout error",
  });
});

test("O8: doctor never prints the API key, the HTTP token or secret values", async () => {
  const sensitive = {
    ...env,
    JEV_API_KEY: "secret-api-123",
    JEVPILOT_TRANSPORT: "http",
    JEVPILOT_HTTP_TOKEN: "secret-http-123456",
    JEVPILOT_SECRET_LOGIN: "secret-login-123",
    // A secret that ends up in ordinary output (here the browser path) must still be redacted.
    JEVPILOT_BROWSER_PATH: "C:/secret-login-123/chrome.exe",
  };
  const secrets = [
    sensitive.JEV_API_KEY,
    sensitive.JEVPILOT_HTTP_TOKEN,
    sensitive.JEVPILOT_SECRET_LOGIN,
  ];
  // Always inject the port: a unit test must never reach the real decision service.
  const echoing: DecisionPort = {
    decide: async (request) => ({
      ...(await fakePort.decide(request)),
      model: `model-${sensitive.JEV_API_KEY}`,
    }),
  };
  const failing: DecisionPort = {
    decide: async () => {
      throw new Error(`401 for ${sensitive.JEV_API_KEY} and ${sensitive.JEVPILOT_HTTP_TOKEN}`);
    },
  };
  const text: string[] = [];
  await runDoctor({
    env: sensitive,
    noBrowser: true,
    decisionPortFactory: () => echoing,
    out: (line) => text.push(line),
    ...temp,
  });
  const json: string[] = [];
  await runDoctor({
    env: sensitive,
    json: true,
    noBrowser: true,
    decisionPortFactory: () => failing,
    out: (line) => json.push(line),
    ...temp,
  });
  for (const output of [text.join("\n"), json.join("\n")])
    for (const secret of secrets) assert.equal(output.includes(secret), false, secret);
  assert.match(text.join("\n"), /\[REDACTED\]/u, "the redaction path was exercised");
  assert.match(json.join("\n"), /decision auth error/u);
});

test("O8: doctor --json prints one JSON object and nothing else", async () => {
  const lines: string[] = [];
  const result = await runDoctor({
    env: {},
    json: true,
    noBrowser: true,
    out: (line) => lines.push(line),
    ...temp,
  });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), result);
});

test("O8: an invalid environment setting fails the config check instead of crashing", async () => {
  const result = await runDoctor({
    env: { JEVPILOT_NETWORK_GUARD: "invalid" },
    noBrowser: true,
    out: () => {},
    ...temp,
  });
  assert.equal(result.checks[1]?.status, "fail");
  assert.match(result.checks[1]?.detail ?? "", /JEVPILOT_NETWORK_GUARD/u);
  assert.equal(result.ok, false);
});

test("doctor reports the call deadline", async () => {
  const run = (deadline?: string) =>
    runDoctor({
      env: deadline === undefined ? {} : { JEVPILOT_CALL_DEADLINE_MS: deadline },
      noBrowser: true,
      out: () => {},
      ...temp,
    });
  const defaultResult = await run();
  assert.equal(defaultResult.checks[1]?.status, "ok");
  assert.match(defaultResult.checks[1]?.detail ?? "", /call-deadline=45000ms/u);
  const offResult = await run("0");
  assert.equal(offResult.checks[1]?.status, "ok");
  assert.match(offResult.checks[1]?.detail ?? "", /call-deadline=off/u);
  const invalidResult = await run("abc");
  assert.equal(invalidResult.checks[1]?.status, "fail");
  assert.equal(
    invalidResult.checks[1]?.detail,
    "JEVPILOT_CALL_DEADLINE_MS must be between 0 and 2147483647.",
  );
});

test("R2: doctor fails the configuration check for an unsupported engine", async () => {
  const result = await runDoctor({
    env: { JEVPILOT_ENGINE: "unsupported" },
    noBrowser: true,
    out: () => {},
    ...temp,
  });
  assert.equal(result.checks.find((check) => check.name === "config")?.status, "fail");
  assert.match(result.checks.find((check) => check.name === "config")?.detail ?? "", /CDP driver/u);
  assert.equal(result.ok, false);
});

test("R8: doctor finishes and reports when the decision service keeps failing with a retryable status", async () => {
  // Run as its own process: with nothing else holding the event loop, a retry wait that does not keep the
  // process alive lets doctor exit in the middle of the retry, printing nothing and returning 0.
  const server = createServer((_request, response) => {
    response.statusCode = 503;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server has no port");
  try {
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../../src/mcp/main.ts", import.meta.url)),
          "doctor",
          "--no-browser",
          "--json",
        ],
        {
          env: {
            ...process.env,
            JEV_PROVIDER: "custom",
            JEV_API_KEY: "doctor-test-key-0123456789",
            JEV_BASE_URL: `http://127.0.0.1:${address.port}/decide`,
            JEV_MAX_RETRIES: "1",
            JEVPILOT_DISPLAY: "headless",
          },
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.once("error", reject);
      child.once("exit", (code) => resolve({ code, stdout }));
    });
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: { name: string; status: string }[];
    };
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((check) => check.name === "decision")?.status, "fail");
    assert.equal(result.code, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("doctor rejects what the server rejects", async () => {
  for (const [name, value, message] of [
    ["JEVPILOT_IMAGE_RESPONSES", "bad", "JEVPILOT_IMAGE_RESPONSES must be allow or omit."],
    [
      "JEVPILOT_SCREENSHOT_DIR",
      "relative-dir",
      "JEVPILOT_SCREENSHOT_DIR must be an absolute path.",
    ],
    [
      "JEVPILOT_DISABLED_TOOLS",
      "browser_close",
      "browser_run and browser_close cannot be disabled.",
    ],
    [
      "JEVPILOT_DISABLED_TOOLS",
      "unknown_tool",
      "Unknown tool in JEVPILOT_DISABLED_TOOLS: unknown_tool.",
    ],
  ] as const) {
    const testEnv = { JEVPILOT_USER_DATA_DIR: "doctor-test-profile", [name]: value };
    const client = new Client({ name: "doctor-parity", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../../src/mcp/main.ts", import.meta.url))],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        ...testEnv,
      },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      await assert.rejects(client.connect(transport));
      assert.ok(stderr.includes(message), stderr);
    } finally {
      await client.close();
    }
    const report = await runDoctor({ env: testEnv, noBrowser: true, out: () => {}, ...temp });
    assert.equal(report.ok, false);
    assert.deepEqual(
      report.checks.find((check) => check.name === "config"),
      {
        name: "config",
        status: "fail",
        detail: message,
      },
    );
  }
});
