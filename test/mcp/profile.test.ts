import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DecisionConfigError } from "../../src/decision/errors.ts";
import { BrowserConfigError, createDefaultEngine } from "../../src/engine/default.ts";
import { buildLaunchArgs } from "../../src/browser/launcher.ts";
import type { BrowserHandle, EngineDriver } from "../../src/engine/types.ts";
import { McpUserError, startupDiagnostic } from "../../src/mcp/errors.ts";
import {
  loadMcpProfile,
  parseActionabilityTimeout,
  parseNavigationTimeout,
} from "../../src/mcp/profile.ts";
import { parseThresholds } from "../../src/mcp/thresholds.ts";

test("navigation timeout environment value requires a positive integer", () => {
  assert.equal(parseNavigationTimeout(undefined), undefined);
  assert.equal(parseNavigationTimeout("30000"), 30_000);
  for (const invalid of ["0", "-1", "1.5", "abc", "2147483648", "9007199254740992"])
    assert.throws(() => parseNavigationTimeout(invalid), McpUserError);
});

test("actionability timeout environment value requires a positive integer", () => {
  assert.equal(parseActionabilityTimeout(undefined), undefined);
  assert.equal(parseActionabilityTimeout("2000"), 2000);
  for (const invalid of ["0", "-1", "1.5", "abc", "2147483648"])
    assert.throws(() => parseActionabilityTimeout(invalid), McpUserError);
});

test("decision thresholds parse and validate every supported family", () => {
  assert.deepEqual(parseThresholds('{"op":0.5,"target":1,"check":0}'), {
    op: 0.5,
    target: 1,
    check: 0,
  });
  assert.deepEqual(parseThresholds('{"check_margin":0.15}'), { check_margin: 0.15 });
  assert.throws(() => parseThresholds('{"goal_met":1.1}'));
  assert.throws(() => parseThresholds('{"unknown":0.5}'));
});
import { FakePageHandle } from "../support/fake-engine.ts";

test("O1a: the MCP default profile is server-plain on Linux and desktop-chrome on Windows", async () => {
  for (const [platform, kind, display] of [
    ["linux", "server-plain", "headless"],
    ["win32", "desktop-chrome", undefined],
  ] as const) {
    const loaded = await loadMcpProfile({ JEVPILOT_USER_DATA_DIR: "profile" }, platform);
    assert.equal(loaded.profile.kind, kind);
    if (loaded.profile.kind === "server-plain") assert.equal(loaded.profile.display, display);
  }
  const headless = await loadMcpProfile(
    { JEVPILOT_USER_DATA_DIR: "profile", JEVPILOT_DISPLAY: "headless" },
    "linux",
  );
  assert.equal(headless.profile.kind, "server-plain");
  if (headless.profile.kind === "server-plain") assert.equal(headless.profile.display, "headless");
});

test("O10: the default profile runs headless on every platform and headed on request", async () => {
  const win = await loadMcpProfile({ JEVPILOT_USER_DATA_DIR: "profile" }, "win32");
  assert.equal(win.profile.kind, "desktop-chrome");
  if (win.profile.kind === "desktop-chrome") assert.equal(win.profile.display, "headless");
  const linux = await loadMcpProfile({ JEVPILOT_USER_DATA_DIR: "profile" }, "linux");
  assert.equal(linux.profile.kind, "server-plain");
  if (linux.profile.kind === "server-plain") assert.equal(linux.profile.display, "headless");
  const headedWin = await loadMcpProfile(
    { JEVPILOT_USER_DATA_DIR: "profile", JEVPILOT_DISPLAY: "headed" },
    "win32",
  );
  if (headedWin.profile.kind === "desktop-chrome")
    assert.equal(headedWin.profile.display, "headed");
  const headedLinux = await loadMcpProfile(
    { JEVPILOT_USER_DATA_DIR: "profile", JEVPILOT_DISPLAY: "headed" },
    "linux",
  );
  if (headedLinux.profile.kind === "server-plain")
    assert.equal(headedLinux.profile.display, "xvfb");
  const xvfb = await loadMcpProfile(
    { JEVPILOT_USER_DATA_DIR: "profile", JEVPILOT_DISPLAY: "xvfb" },
    "linux",
  );
  if (xvfb.profile.kind === "server-plain") assert.equal(xvfb.profile.display, "xvfb");
  await assert.rejects(
    loadMcpProfile({ JEVPILOT_USER_DATA_DIR: "profile", JEVPILOT_DISPLAY: "invalid" }, "win32"),
    /JEVPILOT_DISPLAY/u,
  );
});

test("O1b: JEVPILOT_EXTRA_ARGS adds validated Chrome flags to the default profile", async () => {
  const loaded = await loadMcpProfile(
    {
      JEVPILOT_USER_DATA_DIR: "profile",
      JEVPILOT_EXTRA_ARGS: "--no-sandbox --disable-background-networking",
    },
    "linux",
  );
  assert.deepEqual(loaded.profile.kind === "server-plain" ? loaded.profile.extraArgs : undefined, [
    "--no-sandbox",
    "--disable-background-networking",
  ]);
  assert.ok(
    loaded.profile.kind !== "attach" && buildLaunchArgs(loaded.profile).includes("--no-sandbox"),
  );
  await assert.rejects(
    loadMcpProfile({ JEVPILOT_EXTRA_ARGS: "--no-sandbox --headless=new" }, "linux"),
    (error: unknown) => error instanceof McpUserError && /JEVPILOT_EXTRA_ARGS/u.test(error.message),
  );
  const file = await mkdtemp(join(tmpdir(), "jevpilot-profile-extra-"));
  const path = join(file, "profile.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        kind: "desktop-chrome",
        userDataDir: "p",
        windowSize: { width: 1, height: 1 },
      }),
      "utf8",
    );
    const profile = await loadMcpProfile({
      JEVPILOT_PROFILE_FILE: path,
      JEVPILOT_EXTRA_ARGS: "--no-sandbox",
    });
    assert.equal(profile.profile.kind, "desktop-chrome");
    assert.equal(profile.profile.extraArgs, undefined);
  } finally {
    await rm(file, { recursive: true, force: true });
  }
});

test("O1b: the test profile helper selects server-plain from the environment", async () => {
  const previous = {
    profile: process.env.JEVPILOT_TEST_PROFILE,
    display: process.env.JEVPILOT_TEST_DISPLAY,
    args: process.env.JEVPILOT_TEST_EXTRA_ARGS,
  };
  process.env.JEVPILOT_TEST_PROFILE = "server-plain";
  process.env.JEVPILOT_TEST_DISPLAY = "headless";
  process.env.JEVPILOT_TEST_EXTRA_ARGS = "--no-sandbox --foo=bar";
  try {
    const { testProfile } = await import("../support/browser-profile.ts");
    assert.deepEqual(testProfile("profile", { width: 10, height: 20 }), {
      kind: "server-plain",
      userDataDir: "profile",
      windowSize: { width: 10, height: 20 },
      display: "headless",
      extraArgs: ["--no-sandbox", "--foo=bar"],
    });
  } finally {
    for (const [key, value] of [
      ["JEVPILOT_TEST_PROFILE", previous.profile],
      ["JEVPILOT_TEST_DISPLAY", previous.display],
      ["JEVPILOT_TEST_EXTRA_ARGS", previous.args],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("attach and desktop profile files reach the CDP driver with their options", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevpilot-profile-test-"));
  const path = join(directory, "profile.json");
  const page = new FakePageHandle();
  let received: unknown;
  const driver: EngineDriver = {
    kind: "cdp",
    launch: async (profile): Promise<BrowserHandle> => {
      received = profile;
      return {
        engine: { name: "cdp", driver: "cdp", stealthLevel: "medium" },
        capabilities: page.capabilities,
        selfCheck: undefined,
        connected: true,
        onDisconnected: () => () => {},
        newPage: async () => page,
        pages: () => [page],
        close: async () => {},
      };
    },
  };
  try {
    for (const profile of [
      { kind: "attach", cdpUrl: "http://127.0.0.1:9222" },
      {
        kind: "desktop-chrome",
        executable: "C:/Edge/msedge.exe",
        userDataDir: "C:/profile",
        windowSize: { width: 1100, height: 750 },
        extraArgs: ["--fingerprint=1234"],
      },
    ]) {
      await writeFile(path, JSON.stringify(profile), "utf8");
      const loaded = await loadMcpProfile({ JEVPILOT_PROFILE_FILE: path });
      await createDefaultEngine(loaded.profile, driver).resolve().launch();
      assert.deepEqual(received, profile);
      await loaded.cleanup();
    }
    const desktop = {
      kind: "desktop-chrome",
      userDataDir: "C:/profile",
      windowSize: { width: 1100, height: 750 },
      extraArgs: ["--fingerprint=1234"],
    };
    await writeFile(path, JSON.stringify(desktop), "utf8");
    const overridden = await loadMcpProfile({
      JEVPILOT_PROFILE_FILE: path,
      JEVPILOT_BROWSER_PATH: "C:/Edge/msedge.exe",
    });
    await createDefaultEngine(overridden.profile, driver).resolve().launch();
    assert.deepEqual(received, { ...desktop, executable: "C:/Edge/msedge.exe" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid profile files produce safe user-facing errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevpilot-profile-test-"));
  const path = join(directory, "profile.json");
  try {
    await writeFile(
      path,
      JSON.stringify({ kind: "desktop-chrome", executable: "SECRET_MARKER" }),
      "utf8",
    );
    await assert.rejects(
      loadMcpProfile({ JEVPILOT_PROFILE_FILE: path }),
      (error: unknown) =>
        error instanceof McpUserError &&
        /invalid fields: userDataDir, windowSize/u.test(error.message) &&
        !/SECRET_MARKER|profile\.json/u.test(error.message),
    );
    await writeFile(path, "not json", "utf8");
    await assert.rejects(loadMcpProfile({ JEVPILOT_PROFILE_FILE: path }), McpUserError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function startup(
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../../src/mcp/main.ts", import.meta.url))],
    { env: { ...process.env, ...env, JEVPILOT_SKIP_BROWSER: "1" }, stdio: "pipe", shell: false },
  );
  child.stdin.end();
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (text: string) => (stderr += text));
  child.stdout.on("data", (text: string) => (stdout += text));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  return { code, stderr, stdout };
}

test("startup diagnostics name safe configuration errors without printing secrets", async () => {
  assert.equal(
    startupDiagnostic(new DecisionConfigError("API key required")),
    "DecisionConfigError: API key required",
  );
  assert.equal(
    startupDiagnostic(new BrowserConfigError("invalid Chrome profile")),
    "BrowserConfigError: invalid Chrome profile",
  );
  assert.equal(
    startupDiagnostic(new McpUserError("Invalid profile file")),
    "McpUserError: Invalid profile file",
  );
  assert.doesNotMatch(startupDiagnostic(new Error("SECRET_MARKER")), /SECRET_MARKER/u);
  const decision = await startup({ JEV_PROVIDER: "invalid", JEV_API_KEY: "SECRET_MARKER" });
  assert.equal(decision.code, 1);
  assert.match(decision.stderr, /DecisionConfigError: JEV_PROVIDER required/u);
  assert.doesNotMatch(decision.stderr + decision.stdout, /SECRET_MARKER/u);

  const profile = await startup({
    JEV_PROVIDER: "",
    JEVPILOT_PROFILE_FILE: "C:/missing-profile.json",
  });
  assert.equal(profile.code, 1);
  assert.match(profile.stderr, /McpUserError: Cannot read JEVPILOT_PROFILE_FILE/u);
  assert.doesNotMatch(profile.stdout, /./u);
});
