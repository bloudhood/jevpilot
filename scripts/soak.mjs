#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const sessionsCount = Number(valueOf("--sessions", "30"));
const concurrency = Number(valueOf("--concurrency", "4"));
const jsonPath = resolve(
  valueOf("--json", join(tmpdir(), "jevpilot-soak-" + process.pid + ".json")),
);
const skipped = new Set(String(valueOf("--skip", "")).split(",").filter(Boolean));
const firstTimeout = 120;
const maxTimeout = 500;
const expectations = [];
const failures = [];
const phases = {};
const samples = [];
let fixture;
let jev;
let server;
let client;
let serverProfile;
let baselineTemps = [];
let baselineBrowsers = [];

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const expect = (condition, message, evidence) => {
  const item = { ok: Boolean(condition), message, ...(evidence === undefined ? {} : { evidence }) };
  expectations.push(item);
  if (!item.ok) failures.push(item);
  return item.ok;
};
const withTimeout = async (promise, ms, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + " timed out after " + ms + " ms")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const runExec = (command, commandArgs) =>
  new Promise((resolveExec, reject) => {
    execFile(
      command,
      commandArgs,
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolveExec(stdout)),
    );
  });

async function tempEntries() {
  return (await readdir(tmpdir(), { withFileTypes: true }))
    .filter((entry) => entry.name.startsWith("jevpilot-"))
    .map((entry) => entry.name)
    .sort();
}

async function processSnapshot() {
  if (process.platform === "win32") {
    const raw = await runExec("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine,WorkingSetSize | ConvertTo-Json -Compress",
    ]).catch(() => "[]");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map((item) => ({
      pid: Number(item.ProcessId),
      name: String(item.Name || ""),
      command: String(item.CommandLine || ""),
      rss: Math.round(Number(item.WorkingSetSize || 0) / 1024),
    }));
  }
  const raw = await runExec("ps", ["-eo", "pid=,rss=,args="]).catch(() => "");
  return raw.split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    return match
      ? [{ pid: Number(match[1]), rss: Number(match[2]), name: "", command: match[3] }]
      : [];
  });
}

async function addSample(label) {
  const processes = await processSnapshot();
  const profile = serverProfile ? serverProfile.toLowerCase() : "";
  const browsers = processes.filter((item) => {
    const command = item.command.toLowerCase();
    return (
      profile &&
      command.includes(profile) &&
      /(?:chrome|chromium|msedge)/u.test((item.name || "") + " " + command)
    );
  });
  const serverProcess = processes.find((item) => item.pid === (server && server.serverPid));
  const temps = await tempEntries();
  const sample = {
    label,
    server_rss_kb: serverProcess ? serverProcess.rss : null,
    browser_count: browsers.length,
    browser_rss_kb: browsers.reduce((total, item) => total + item.rss, 0),
    temp_dirs: temps.length,
    temp_names: temps,
  };
  samples.push(sample);
  if (label !== "after-exit")
    expect(
      Number.isFinite(sample.server_rss_kb),
      "server RSS is measured while server runs",
      sample,
    );
  return sample;
}

function answerRequest(request) {
  const answers = {};
  for (const [id, question] of Object.entries(request.questions || {})) {
    if (question.type === "noul") {
      answers[id] = { noul: 0 };
      continue;
    }
    if (question.type === "score") {
      answers[id] = { score: 0, confidence: 1, probabilities: {} };
      continue;
    }
    const keys = Object.keys(question.criteria || {});
    const choice =
      id === "op" && keys.includes("CLICK")
        ? "CLICK"
        : id.endsWith("_target") && keys.includes("e1")
          ? "e1"
          : keys.includes("none")
            ? "none"
            : keys.includes("not_provided")
              ? "not_provided"
              : keys[0];
    answers[id] = {
      choice,
      confidence: 1,
      probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])),
    };
  }
  return answers;
}

function pageHtml(kind, token) {
  const next = (path) => '<a id="e1" href="' + path + '">next ' + token + "</a>";
  if (kind === "link")
    return (
      "<!doctype html><title>" +
      token +
      "</title><main><p>link " +
      token +
      "</p>" +
      next("/success?token=" + token) +
      "</main>"
    );
  if (kind === "button")
    return (
      "<!doctype html><title>" +
      token +
      "</title><main><button id=\"e1\" onclick=\"document.querySelector('p').textContent='SUCCESS " +
      token +
      "'\">click " +
      token +
      "</button><p>waiting</p></main>"
    );
  if (kind === "chain1")
    return (
      "<!doctype html><title>" +
      token +
      "</title><main><p>chain " +
      token +
      " step 1</p>" +
      next("/chain2?token=" + token) +
      "</main>"
    );
  if (kind === "chain2")
    return (
      "<!doctype html><title>" +
      token +
      "</title><main><p>chain " +
      token +
      " step 2</p>" +
      next("/success?token=" + token) +
      "</main>"
    );
  if (kind === "popup")
    return (
      "<!doctype html><title>" +
      token +
      '</title><main><a id="e1" target="_blank" href="/success?token=' +
      token +
      '">open ' +
      token +
      "</a></main>"
    );
  if (kind === "success")
    return "<!doctype html><title>" + token + "</title><main><p>SUCCESS " + token + "</p></main>";
  return "";
}

async function startFixtures() {
  let faultMode = "normal";
  let requestNumber = 0;
  fixture = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const token = url.searchParams.get("token") || "missing";
    if (url.pathname === "/hang") return;
    const pages = ["success", "link", "button", "chain1", "chain2", "popup"];
    if (pages.includes(url.pathname.slice(1))) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(pageHtml(url.pathname.slice(1), token));
      return;
    }
    response.writeHead(404).end("not found");
  });
  jev = createServer(async (request, response) => {
    if (request.method !== "POST") return response.writeHead(405).end();
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return response.writeHead(400).end();
    }
    requestNumber++;
    const fault =
      faultMode === "down"
        ? "down"
        : faultMode === "stall"
          ? "stall"
          : faultMode === "drop"
            ? "drop"
            : requestNumber % 7 === 0
              ? requestNumber % 14 === 0
                ? "529"
                : "429"
              : "ok";
    if (fault === "stall") return setTimeout(() => response.end(), firstTimeout * 4);
    if (fault === "drop") return request.socket.destroy();
    if (fault === "429") return response.writeHead(429, { "retry-after": "0.01" }).end();
    if (fault === "529" || fault === "down")
      return response.writeHead(fault === "down" ? 503 : 529).end();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        answers: answerRequest({ questions: body.questions }),
        usage: { input_tokens: 1, output_tokens: 1 },
        model: "soak-heuristic",
      }),
    );
  });
  await Promise.all([
    new Promise((resolveListen) => fixture.listen(0, "127.0.0.1", resolveListen)),
    new Promise((resolveListen) => jev.listen(0, "127.0.0.1", resolveListen)),
  ]);
  return {
    fixtureUrl: "http://127.0.0.1:" + fixture.address().port,
    jevUrl: "http://127.0.0.1:" + jev.address().port + "/decide",
    setFault: (mode) => {
      faultMode = mode;
    },
  };
}

async function spawnServer(endpoint, logPath) {
  const env = {
    ...process.env,
    JEV_PROVIDER: "custom",
    JEV_BASE_URL: endpoint,
    JEV_API_KEY: "soak-dummy-key",
    JEV_FIRST_TIMEOUT_MS: String(firstTimeout),
    JEV_TIMEOUT_MS: String(maxTimeout),
    JEV_MAX_RETRIES: "2",
    JEVPILOT_DECISION_LOG: logPath,
    JEVPILOT_NAVIGATION_TIMEOUT_MS: "1000",
    JEVPILOT_ACTIONABILITY_TIMEOUT_MS: "500",
  };
  for (const name of ["JEVPILOT_DISPLAY", "JEVPILOT_EXTRA_ARGS", "JEVPILOT_BROWSER_PATH"])
    if (process.env[name]) env[name] = process.env[name];
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const mcpClient = new Client({ name: "soak", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "dist/mcp/main.js")],
    env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 12_000) stderr = stderr.slice(-12_000);
  });
  await withTimeout(mcpClient.connect(transport), 10_000, "MCP connect");
  return {
    client: mcpClient,
    transport,
    stderr: () => stderr,
    serverPid: transport.pid,
    get pid() {
      return transport.pid;
    },
    get exitCode() {
      return transport.pid === null ? 0 : null;
    },
    kill: () => transport.close(),
  };
}

async function callTool(name, input, timeout = 10_000) {
  const response = await withTimeout(client.callTool({ name, arguments: input }), timeout, name);
  if (response.structuredContent) return response.structuredContent;
  const text = (response.content && response.content[0] && response.content[0].text) || "";
  try {
    return JSON.parse(text);
  } catch {
    return { status: "FAILED", reason: "tool_error", details: [text] };
  }
}

function flowFor(index) {
  const token = "soak-" + index;
  const flows = [
    { path: "/link", expected: "DONE_UNVERIFIED" },
    { path: "/button", expected: "DONE_UNVERIFIED" },
    { path: "/chain1", expected: "DONE_UNVERIFIED" },
    { path: "/popup", expected: "DONE_UNVERIFIED" },
  ];
  return { ...flows[index % flows.length], token };
}

async function runFlow(base, flow) {
  const started = Date.now();
  const result = await callTool(
    "browser_run",
    {
      goal: "Finish " + flow.token,
      url: base + flow.path + "?token=" + flow.token,
      success: { text_present: "SUCCESS " + flow.token },
      budget: { steps: 8, seconds: 20, decision_tokens: 100 },
    },
    20_000,
  );
  let final = result;
  if (["UNCERTAIN", "CONFIRM_REQUIRED", "NEEDS_VALUES"].includes(final.status))
    final = await callTool("browser_resume", { session: final.session }, 10_000);
  if (final.session)
    await callTool("browser_close", { session: final.session }, 10_000).catch(() => {});
  return {
    status: final.status,
    session: final.session,
    token: flow.token,
    duration_ms: Date.now() - started,
    decision_count:
      final.usage &&
      final.usage.detail &&
      final.usage.detail.call &&
      final.usage.detail.call.decisions,
    result: final,
  };
}

async function sequential(base) {
  if (skipped.has("sequential")) return { skipped: true };
  const results = [];
  for (let index = 0; index < sessionsCount; index++) {
    results.push(await runFlow(base, flowFor(index)));
    if ((index + 1) % 5 === 0) await addSample("sequential-" + (index + 1));
  }
  const bad = results.filter(
    (item) =>
      !item.result || !item.result.url.includes(item.token) || item.status !== "DONE_VERIFIED",
  );
  expect(bad.length === 0, "sequential sessions finish with their own token", bad);
  return { sessions: results, bad };
}

async function concurrencyPhase(base) {
  if (skipped.has("concurrency")) return { skipped: true };
  const rounds = [];
  for (let round = 0; round < 3; round++) {
    const pending = [];
    for (let start = 0; start < concurrency; start++)
      pending.push(runFlow(base, flowFor(100 + round * concurrency + start)));
    const finished = await Promise.all(pending);
    rounds.push(finished);
    expect(
      finished.every(
        (item) =>
          item.result && item.result.url.includes(item.token) && item.status === "DONE_VERIFIED",
      ),
      "concurrency round " + (round + 1) + " has isolated successful results",
    );
  }
  return { rounds };
}

async function jevDown(base, control) {
  if (skipped.has("jev-down")) return { skipped: true };
  control.setFault("down");
  const started = Date.now();
  const result = await runFlow(base, { path: "/link", token: "jev-down", expected: "FAILED" });
  const duration = Date.now() - started;
  control.setFault("normal");
  expect(duration < 8_000, "Jev-down returns within retry bound", {
    duration,
    status: result.status,
  });
  expect(
    ["FAILED", "UNCERTAIN"].includes(result.status),
    "Jev-down returns a clear failure or handoff",
    result,
  );
  return { duration_ms: duration, result };
}

async function pageHang(base) {
  if (skipped.has("page-hang")) return { skipped: true };
  const started = Date.now();
  const result = await runFlow(base, { path: "/hang", token: "page-hang", expected: "ERROR_PAGE" });
  const duration = Date.now() - started;
  expect(duration < 8_000, "page hang returns within bound", { duration, status: result.status });
  expect(result.status !== undefined, "page hang returns a structured result", result);
  return { duration_ms: duration, result };
}

async function crashPhase(base) {
  if (skipped.has("browser-crash")) return { skipped: true };
  const before = await processSnapshot();
  const profile = serverProfile ? serverProfile.toLowerCase() : "";
  const browser = before.find((item) => {
    const command = item.command.toLowerCase();
    return (
      profile &&
      command.includes(profile) &&
      !command.includes("--type=") &&
      /(?:chrome|chromium|msedge)/u.test((item.name || "") + " " + command)
    );
  });
  const oldPids = new Set(
    before
      .filter((item) => profile && item.command.toLowerCase().includes(profile))
      .map((item) => item.pid),
  );
  let killed = false;
  if (browser) {
    try {
      process.kill(browser.pid, "SIGKILL");
      killed = true;
    } catch {
      try {
        process.kill(browser.pid);
        killed = true;
      } catch {}
    }
  }
  expect(killed, "browser crash phase found and killed an attributed browser process", {
    browser_pid: browser && browser.pid,
  });
  const first = await runFlow(base, {
    path: "/link",
    token: "crash-1",
    expected: "DONE_VERIFIED",
  }).catch((error) => ({ status: "HARNESS_ERROR", error: String(error) }));
  const second = await runFlow(base, {
    path: "/button",
    token: "crash-2",
    expected: "DONE_VERIFIED",
  }).catch((error) => ({ status: "HARNESS_ERROR", error: String(error) }));
  expect(
    first.status === "DONE_VERIFIED" || first.status === "FAILED",
    "first run after crash succeeds or fails clearly",
    first,
  );
  expect(second.status === "DONE_VERIFIED", "second run after crash succeeds", second);
  const after = await processSnapshot();
  const oldProcesses = after.filter((item) => oldPids.has(item.pid));
  expect(oldProcesses.length === 0, "old browser processes are gone after relaunch", oldProcesses);
  return { killed, first, second, old_processes: oldProcesses.length };
}

async function disconnectPhase(base) {
  if (skipped.has("client-disconnect")) return { skipped: true };
  const started = Date.now();
  const pending = callTool(
    "browser_run",
    {
      goal: "disconnect",
      url: base + "/hang?token=disconnect",
      budget: { steps: 2, seconds: 20 },
    },
    20_000,
  ).catch(() => undefined);
  await sleep(300);
  await client.close().catch(() => {});
  const elapsed = Date.now() - started;
  await sleep(500);
  await pending;
  const remaining = (await processSnapshot()).filter(
    (item) => server && item.pid === server.serverPid,
  );
  const temps = await tempEntries();
  expect(elapsed < 10_000, "client disconnect is handled promptly", { elapsed });
  expect(remaining.length === 0, "client disconnect exits the server process", remaining);
  expect(
    temps.every((name) => baselineTemps.includes(name)),
    "client disconnect removes new jevpilot temp directories",
    { baselineTemps, temps },
  );
  return { elapsed_ms: elapsed, exited: remaining.length === 0, temps };
}

async function closeCurrent() {
  await client?.close().catch(() => {});
  if (server && server.exitCode === null) server.kill();
}

async function main() {
  if (!Number.isInteger(sessionsCount) || sessionsCount < 1)
    throw new Error("--sessions must be a positive integer");
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error("--concurrency must be a positive integer");
  if (!(await readdir(join(root, "dist"), { withFileTypes: true }).catch(() => undefined)))
    throw new Error("dist/ is missing. Run npm run build before node scripts/soak.mjs.");
  baselineTemps = await tempEntries();
  baselineBrowsers = await processSnapshot();
  const control = await startFixtures();
  const logDirectory = await mkdtemp(join(tmpdir(), "soak-log-"));
  const logPath = join(logDirectory, "decisions.jsonl");
  try {
    const started = await spawnServer(control.jevUrl, logPath);
    server = started;
    client = started.client;
    await sleep(500);
    const currentTemps = await tempEntries();
    serverProfile = currentTemps.find(
      (name) => !baselineTemps.includes(name) && name.startsWith("jevpilot-mcp-browser-"),
    );
    expect(Boolean(serverProfile), "server created an attributed temporary browser profile", {
      currentTemps,
      baselineTemps,
    });
    await addSample("warm-up");
    phases.sequential = await sequential(control.fixtureUrl);
    const sequentialSamples = samples.filter((sample) => /^sequential-/u.test(sample.label));
    const firstSequential = sequentialSamples[0];
    const lastSequential = sequentialSamples.at(-1);
    if (firstSequential && lastSequential) {
      expect(
        lastSequential.server_rss_kb - firstSequential.server_rss_kb < 50 * 1024,
        "server RSS growth stays below 50 MB",
        { first: firstSequential, last: lastSequential },
      );
      expect(
        lastSequential.browser_count - firstSequential.browser_count <= 2,
        "browser process count growth stays within two processes",
        { first: firstSequential, last: lastSequential },
      );
      expect(
        lastSequential.browser_rss_kb < firstSequential.browser_rss_kb * 1.3,
        "browser RSS growth stays below 30 percent",
        { first: firstSequential, last: lastSequential },
      );
    }
    phases.concurrency = await concurrencyPhase(control.fixtureUrl);
    phases["jev-down"] = await jevDown(control.fixtureUrl, control);
    phases["page-hang"] = await pageHang(control.fixtureUrl);
    phases["browser-crash"] = await crashPhase(control.fixtureUrl);
    phases["client-disconnect"] = await disconnectPhase(control.fixtureUrl);
  } finally {
    await closeCurrent();
    await sleep(1000);
    const after = await addSample("after-exit");
    const attributedAfter = (await processSnapshot()).filter(
      (item) => serverProfile && item.command.toLowerCase().includes(serverProfile.toLowerCase()),
    );
    const tempsAfter = await tempEntries();
    expect(
      attributedAfter.length === 0,
      "attributed browser processes return to baseline after server exit",
      attributedAfter,
    );
    expect(
      tempsAfter.every((name) => baselineTemps.includes(name)),
      "jevpilot temp directories return to baseline after server exit",
      { baselineTemps, tempsAfter },
    );
    try {
      fixture?.close();
    } catch {}
    try {
      jev?.close();
    } catch {}
    await rm(logDirectory, { recursive: true, force: true }).catch(() => {});
    const document = {
      generated_at: new Date().toISOString(),
      options: { sessions: sessionsCount, concurrency, skipped: [...skipped] },
      baseline: { temps: baselineTemps, browsers: baselineBrowsers.length },
      phases,
      samples,
      expectations,
      failures,
      after_exit: after,
      stderr_tail: server?.stderr() ?? "",
    };
    await writeFile(jsonPath, JSON.stringify(document, null, 2) + "\n", "utf8");
    console.log("soak " + (failures.length ? "FAILED" : "passed") + "; json=" + jsonPath);
    for (const [name, phase] of Object.entries(phases))
      console.log(name + ": " + (phase.skipped ? "skipped" : "completed"));
    console.log(
      "expectations: " +
        (expectations.length - failures.length) +
        "/" +
        expectations.length +
        " passed; samples=" +
        samples.length,
    );
    if (failures.length)
      console.log("failures: " + failures.map((item) => item.message).join("; "));
    process.exitCode = failures.length ? 1 : 0;
  }
}

main().catch(async (error) => {
  console.error("soak harness error: " + (error.stack || error));
  try {
    fixture?.close();
  } catch {}
  try {
    jev?.close();
  } catch {}
  process.exitCode = 1;
});
