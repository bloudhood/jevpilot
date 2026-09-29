import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, test } from "node:test";
import { BrowserConfigError } from "../../src/browser/errors.ts";
import {
  BrowserInstance,
  browserIdentity,
  buildLaunchArgs,
  launchBrowser,
  startDisplay,
} from "../../src/browser/launcher.ts";
import type { DesktopChromeProfile, ServerPlainProfile } from "../../src/browser/profiles.ts";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { CdpClient } from "../../src/browser/cdp/client.ts";
import { fakeCdp } from "./fake-cdp.ts";
import { BrowserSession } from "../../src/browser/session.ts";

const profile: DesktopChromeProfile = {
  kind: "desktop-chrome",
  display: "headed",
  userDataDir: "profile",
  windowSize: { width: 1366, height: 900 },
};
const serverProfile: ServerPlainProfile = {
  kind: "server-plain",
  userDataDir: "server-profile",
  windowSize: { width: 1280, height: 900 },
  display: "xvfb",
};

test("O1a: server-plain launch args put the window at the origin and add --headless=new only for headless", () => {
  const xvfb = buildLaunchArgs(serverProfile);
  assert.ok(xvfb.includes("--window-position=0,0"));
  assert.ok(!xvfb.includes("--headless=new"));
  assert.deepEqual(buildLaunchArgs({ ...serverProfile, display: "headless" }), [
    ...xvfb,
    "--headless=new",
  ]);
});

async function launchPreferencesFixture(
  directory: string,
  kind: "desktop-chrome" | "server-plain" = "desktop-chrome",
) {
  const fake = await fakeCdp((message, send) => {
    const method = String(message.method);
    send({
      id: message.id,
      result:
        method === "Target.getTargets"
          ? { targetInfos: [] }
          : method === "Target.createTarget"
            ? { targetId: "target" }
            : method === "Target.attachToTarget"
              ? { sessionId: "session" }
              : {},
    });
  });
  const port = new URL(fake.url).port;
  const child = fakeProcess(901);
  const browser = await launchBrowser(
    kind === "desktop-chrome"
      ? { ...profile, userDataDir: directory, executable: "/bin/chromium" }
      : {
          ...serverProfile,
          display: "headless",
          userDataDir: directory,
          executable: "/bin/chromium",
        },
    { selfCheck: false, timeoutMs: 2000 },
    {
      platform: "linux",
      env: {},
      readFile: async () => `${port}\n/devtools/browser/test\n`,
      spawn: (() => child) as never,
      kill: exitOnKill([child], []),
    },
  );
  return { fake, browser };
}

test("O9f: a launched profile gets password saving and leak detection turned off", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevpilot-o9f-"));
  let launched: Awaited<ReturnType<typeof launchPreferencesFixture>> | undefined;
  try {
    launched = await launchPreferencesFixture(directory);
    const preferences = JSON.parse(
      await readFile(join(directory, "Default", "Preferences"), "utf8"),
    ) as Record<string, any>;
    assert.equal(preferences.credentials_enable_service, false);
    assert.equal(preferences.profile.password_manager_enabled, false);
    assert.equal(preferences.profile.password_manager_leak_detection, false);
  } finally {
    await launched?.browser.close();
    await launched?.fake.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("O9f: existing Preferences keep their other settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevpilot-o9f-"));
  await mkdir(join(directory, "Default"), { recursive: true });
  await writeFile(
    join(directory, "Default", "Preferences"),
    JSON.stringify({ unrelated: { keep: true }, profile: { theme: "dark" } }),
    "utf8",
  );
  let launched: Awaited<ReturnType<typeof launchPreferencesFixture>> | undefined;
  try {
    launched = await launchPreferencesFixture(directory, "server-plain");
    const preferences = JSON.parse(
      await readFile(join(directory, "Default", "Preferences"), "utf8"),
    ) as Record<string, any>;
    assert.deepEqual(preferences.unrelated, { keep: true });
    assert.equal(preferences.profile.theme, "dark");
    assert.equal(preferences.credentials_enable_service, false);
    assert.equal(preferences.profile.password_manager_enabled, false);
    assert.equal(preferences.profile.password_manager_leak_detection, false);
  } finally {
    await launched?.browser.close();
    await launched?.fake.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("O9f: an unreadable Preferences file is left untouched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevpilot-o9f-"));
  await mkdir(join(directory, "Default"), { recursive: true });
  const invalid = "{not-json";
  const preferencesPath = join(directory, "Default", "Preferences");
  await writeFile(preferencesPath, invalid, "utf8");
  let launched: Awaited<ReturnType<typeof launchPreferencesFixture>> | undefined;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: string) => warnings.push(message);
  try {
    launched = await launchPreferencesFixture(directory);
    assert.equal(await readFile(preferencesPath, "utf8"), invalid);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /could not parse Chrome Preferences/u);
  } finally {
    console.warn = originalWarn;
    await launched?.browser.close();
    await launched?.fake.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("O9f: attach profiles do not touch Preferences", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevpilot-o9f-"));
  const previousDirectory = process.cwd();
  const fake = await fakeCdp((message, send) => send({ id: message.id, result: {} }));
  let attached: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    process.chdir(directory);
    attached = await launchBrowser({ kind: "attach", cdpUrl: fake.url }, { selfCheck: false });
    assert.deepEqual(await readdir(directory), []);
  } finally {
    process.chdir(previousDirectory);
    await attached?.close();
    await fake.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("O1a: headless stays forbidden for desktop-chrome and in extraArgs", () => {
  assert.ok(!buildLaunchArgs(profile).some((arg) => arg.startsWith("--headless")));
  for (const flag of ["--headless", "--headless=new", "--disable-gpu", "--enable-automation"]) {
    assert.throws(() => buildLaunchArgs({ ...profile, extraArgs: [flag] }), BrowserConfigError);
    assert.throws(
      () => buildLaunchArgs({ ...serverProfile, extraArgs: [flag] }),
      BrowserConfigError,
    );
  }
});

test("O10: headed Chrome stays available on Windows", () => {
  const args = buildLaunchArgs({ ...profile, display: "headed" });
  assert.equal(
    args.some((arg) => arg.startsWith("--headless")),
    false,
  );
  assert.ok(args.includes("--window-position=-3000,-3000"));
  assert.ok(!args.some((arg) => arg.startsWith("--user-agent") || arg.startsWith("--screen-info")));
  const { display: _display, ...defaultProfile } = profile;
  const defaultArgs = buildLaunchArgs(defaultProfile);
  assert.ok(defaultArgs.includes("--headless=new"));
  assert.ok(defaultArgs.includes("--window-position=0,0"));
});

test("O10: a headless launch probes the browser once and adds --user-agent and --screen-info", async () => {
  const calls: { executable: string; args: string[] }[] = [];
  const methods: string[] = [];
  const fake = await fakeCdp((message, send) => {
    const method = String(message.method);
    methods.push(method);
    const result =
      method === "Browser.getVersion"
        ? { userAgent: "HeadlessChrome/153.0.0.0" }
        : method === "Target.createTarget"
          ? { targetId: "target" }
          : method === "Target.attachToTarget"
            ? { sessionId: "session" }
            : method === "Runtime.evaluate"
              ? {
                  result: {
                    value: JSON.stringify({
                      brands: [{ brand: "Chromium", version: "153" }],
                      mobile: false,
                      high: {
                        fullVersionList: [{ brand: "Chromium", version: "153.0.0.0" }],
                        platform: "Windows",
                        platformVersion: "19.0.0",
                        architecture: "x86",
                        bitness: "64",
                        model: "",
                        wow64: false,
                      },
                    }),
                  },
                }
              : method === "Target.getTargets"
                ? { targetInfos: [] }
                : {};
    send({ id: message.id, result });
    if (method === "Page.navigate")
      send({
        method: "Page.loadEventFired",
        params: { timestamp: 1 },
        sessionId: message.sessionId,
      });
  });
  const port = new URL(fake.url).port;
  const directories: string[] = [];
  const browsers: BrowserInstance[] = [];
  const children: ChildProcess[] = [];
  const deps = {
    platform: "linux",
    env: {},
    readFile: async () => `${port}\n/devtools/browser/test\n`,
    spawn: ((executable: string, args: string[]) => {
      calls.push({ executable, args });
      const child = fakeProcess(950 + calls.length);
      children.push(child);
      return child;
    }) as never,
    kill: exitOnKill(children, []),
  } as const;
  try {
    for (const size of [
      { width: 1280, height: 900 },
      { width: 2200, height: 1200 },
    ]) {
      const directory = await mkdtemp(join(tmpdir(), "jevpilot-o10-unit-"));
      directories.push(directory);
      browsers.push(
        await launchBrowser(
          {
            kind: "desktop-chrome",
            userDataDir: directory,
            windowSize: size,
            executable: "/fake/o10-probe-chrome",
            extraArgs: ["--foo=bar"],
          },
          { selfCheck: false, timeoutMs: 2000 },
          deps,
        ),
      );
    }
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.executable === "/fake/o10-probe-chrome"));
    assert.ok(calls.every((call) => call.args.includes("--foo=bar")));
    assert.ok(
      calls[0]!.args.some(
        (arg) => arg.startsWith("--user-data-dir=") && !directories.includes(arg.slice(16)),
      ),
    );
    assert.ok(calls[0]!.args.includes("--headless=new"));
    assert.ok(calls[1]!.args.includes("--user-agent=Chrome/153.0.0.0"));
    assert.ok(calls[1]!.args.includes("--screen-info={1920x1080}"));
    assert.ok(calls[2]!.args.includes("--screen-info={2200x1200}"));
    // The probe ran with the launch's extraArgs, so other flags mean another probe.
    const otherArgsDirectory = await mkdtemp(join(tmpdir(), "jevpilot-o10-unit-args-"));
    directories.push(otherArgsDirectory);
    browsers.push(
      await launchBrowser(
        {
          kind: "desktop-chrome",
          userDataDir: otherArgsDirectory,
          windowSize: { width: 1280, height: 900 },
          executable: "/fake/o10-probe-chrome",
          extraArgs: ["--foo=baz"],
        },
        { selfCheck: false, timeoutMs: 2000 },
        deps,
      ),
    );
    assert.equal(calls.length, 5);
    assert.ok(calls[3]!.args.includes("--headless=new") && calls[3]!.args.includes("--foo=baz"));
    const directory = await mkdtemp(join(tmpdir(), "jevpilot-o10-unit-fail-"));
    directories.push(directory);
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
      browsers.push(
        await launchBrowser(
          {
            kind: "desktop-chrome",
            userDataDir: directory,
            windowSize: { width: 1280, height: 900 },
            executable: "/fake/o10-failing-probe",
            extraArgs: ["--foo=bar"],
          },
          { selfCheck: false, timeoutMs: 50 },
          {
            ...deps,
            readFile: async (path: string) =>
              path.includes("jevpilot-probe-") ? "invalid" : `${port}\n/devtools/browser/test\n`,
          },
        ),
      );
    } finally {
      console.warn = warn;
    }
    assert.equal(warnings.length, 1);
    assert.ok(!calls.at(-1)!.args.some((arg) => arg.startsWith("--user-agent=")));
    // A failed probe is not cached: the next launch of the same executable probes again and succeeds.
    const retryDirectory = await mkdtemp(join(tmpdir(), "jevpilot-o10-unit-retry-"));
    directories.push(retryDirectory);
    const before = calls.length;
    browsers.push(
      await launchBrowser(
        {
          kind: "desktop-chrome",
          userDataDir: retryDirectory,
          windowSize: { width: 1280, height: 900 },
          executable: "/fake/o10-failing-probe",
          extraArgs: ["--foo=bar"],
        },
        { selfCheck: false, timeoutMs: 2000 },
        deps,
      ),
    );
    assert.equal(calls.length, before + 2);
    assert.ok(calls.at(-2)!.args.includes("--headless=new"));
    assert.ok(calls.at(-1)!.args.includes("--user-agent=Chrome/153.0.0.0"));
    assert.equal(methods.includes("Runtime.enable"), false);
  } finally {
    for (const browser of browsers) await browser.close();
    await fake.close();
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
  }
});

test("O1a: xvfb display reuses DISPLAY when it is set", async () => {
  const result = await startDisplay(serverProfile, {
    env: { DISPLAY: ":3" },
    access: async () => {
      throw Error("unexpected access");
    },
    spawn: (() => {
      throw Error("unexpected spawn");
    }) as never,
  });
  assert.deepEqual(result, { display: ":3" });
});

test("O1a: xvfb display starts Xvfb on a free display and stops it with the browser", async () => {
  const calls: { executable: string; args: string[] }[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    exitCode: null as number | null,
    signalCode: null,
  }) as unknown as ChildProcess;
  let socketReady = false;
  const result = await startDisplay(serverProfile, {
    env: { PATH: "/usr/bin" },
    platform: "linux",
    access: async (path) => {
      if (
        path === "/usr/bin/Xvfb" ||
        path === "/tmp/.X11-unix/X90" ||
        (path === "/tmp/.X11-unix/X91" && socketReady)
      )
        return;
      throw Object.assign(Error("missing"), { code: "ENOENT" });
    },
    spawn: ((executable: string, args: string[]) => {
      calls.push({ executable, args });
      socketReady = true;
      return child;
    }) as never,
  });
  assert.equal(result.display, ":91");
  assert.deepEqual(calls, [
    {
      executable: "/usr/bin/Xvfb",
      args: [":91", "-screen", "0", "1280x900x24", "-nolisten", "tcp"],
    },
  ]);
  const browser = new BrowserInstance(
    { close() {} } as CdpClient,
    undefined,
    undefined,
    {
      platform: "linux",
      kill: () => {
        (child as unknown as { exitCode: number | null }).exitCode = 0;
        child.emit("exit", 0);
      },
    },
    undefined,
    undefined,
    result.child,
  );
  await browser.close();
  assert.equal(child.exitCode, 0);
});

test("O1a: xvfb display without DISPLAY or Xvfb fails with a clear error", async () => {
  await assert.rejects(
    startDisplay(serverProfile, {
      env: { PATH: "/usr/bin" },
      access: async () => {
        throw Object.assign(Error("missing"), { code: "ENOENT" });
      },
    }),
    (error: unknown) =>
      error instanceof BrowserConfigError &&
      /install Xvfb.*display: "headless"/u.test(error.message),
  );
});

test("O1a: server-plain windows stay at the origin when DISPLAY is reused", async () => {
  const calls: { method: string; params: unknown }[] = [];
  const client = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return method === "Browser.getWindowForTarget" ? { windowId: 1 } : { targetId: "target" };
    },
    attach: async () => "session",
    close() {},
  } as unknown as CdpClient;
  const server = new BrowserInstance(
    client,
    undefined,
    undefined,
    {},
    undefined,
    { width: 800, height: 600 },
    undefined,
    { left: 0, top: 0 },
  );
  await server.placeOffScreen("target");
  const desktop = new BrowserInstance(client, undefined, undefined, {}, undefined, {
    width: 800,
    height: 600,
  });
  await desktop.placeOffScreen("target");
  const fake = await fakeCdp((message, send) => {
    if (String(message.method) === "Target.createTarget")
      calls.push({ method: String(message.method), params: message.params });
    send({
      id: message.id,
      result:
        String(message.method) === "Target.createTarget"
          ? { targetId: "created" }
          : String(message.method) === "Target.attachToTarget"
            ? { sessionId: "s" }
            : {},
    });
  });
  try {
    await BrowserSession.create(
      fake.client,
      () => {},
      "ctx",
      { width: 800, height: 600 },
      { left: 0, top: 0 },
    );
    await BrowserSession.create(fake.client, () => {}, "ctx", { width: 800, height: 600 });
  } finally {
    await fake.close();
  }
  const bounds = calls
    .filter((call) => call.method === "Browser.setWindowBounds")
    .map((call) => (call.params as { bounds: { left: number; top: number } }).bounds);
  assert.deepEqual(bounds, [
    { left: 0, top: 0, width: 800, height: 600, windowState: "normal" },
    { left: -3000, top: -3000, width: 800, height: 600, windowState: "normal" },
  ]);
  assert.deepEqual(
    calls.filter((call) => call.method === "Target.createTarget").map((call) => call.params),
    [
      { url: "about:blank", browserContextId: "ctx", left: 0, top: 0, width: 800, height: 600 },
      {
        url: "about:blank",
        browserContextId: "ctx",
        left: -3000,
        top: -3000,
        width: 800,
        height: 600,
      },
    ],
  );
});

test("O1a: xvfb skips a display number whose lock file exists", async () => {
  const spawned: string[] = [];
  let ready = false;
  const child = Object.assign(new EventEmitter(), {
    pid: 5,
    exitCode: null as number | null,
    signalCode: null,
  }) as unknown as ChildProcess;
  const result = await startDisplay(serverProfile, {
    env: { PATH: "/bin" },
    access: async (path) => {
      if (path === "/bin/Xvfb" || path === "/tmp/.X90-lock") return;
      if (path === "/tmp/.X11-unix/X91" && ready) return;
      throw Object.assign(Error("missing"), { code: "ENOENT" });
    },
    spawn: ((executable: string, args: string[]) => {
      spawned.push(args[0]!);
      ready = true;
      return child;
    }) as never,
  });
  assert.deepEqual(spawned, [":91"]);
  assert.equal(result.display, ":91");
});

test("O1a: xvfb tries the next display when Xvfb exits before it is ready", async () => {
  const spawned: string[] = [];
  let attempt = 0;
  const children = [0, 1].map(
    (pid) =>
      Object.assign(new EventEmitter(), {
        pid: pid + 5,
        exitCode: pid === 0 ? 1 : null,
        signalCode: null,
      }) as unknown as ChildProcess,
  );
  const result = await startDisplay(serverProfile, {
    env: { PATH: "/bin" },
    access: async (path) => {
      if (path === "/bin/Xvfb") return;
      if (path === "/tmp/.X11-unix/X91" && attempt > 1) return;
      throw Object.assign(Error("missing"), { code: "ENOENT" });
    },
    spawn: ((executable: string, args: string[]) => {
      spawned.push(args[0]!);
      attempt++;
      return children[attempt - 1]!;
    }) as never,
  });
  assert.deepEqual(spawned, [":90", ":91"]);
  assert.equal(result.display, ":91");
});

const fakeProcess = (pid: number): ChildProcess =>
  Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null,
  }) as unknown as ChildProcess;
const exitOnKill =
  (children: ChildProcess[], kills: [number, string][]) => (pid: number, signal: string) => {
    kills.push([pid, signal]);
    const child = children.find((item) => item.pid === Math.abs(pid));
    if (!child || child.exitCode !== null) return;
    (child as unknown as { exitCode: number }).exitCode = 0;
    child.emit("exit", 0);
  };

test("O1a: a server-plain launch that cannot spawn Chrome stops the Xvfb it started", async () => {
  const xvfb = fakeProcess(700);
  const kills: [number, string][] = [];
  let spawned = 0;
  const directory = await mkdtemp(join(tmpdir(), "jevpilot-o1a-spawn-failure-"));
  await assert.rejects(
    launchBrowser(
      { ...serverProfile, userDataDir: directory, executable: "/bin/chromium" },
      { selfCheck: false, timeoutMs: 500 },
      {
        platform: "linux",
        env: { PATH: "/bin" },
        graceMs: 10,
        access: async (path) => {
          if (path === "/bin/Xvfb" || (path === "/tmp/.X11-unix/X90" && spawned > 0)) return;
          throw Object.assign(Error("missing"), { code: "ENOENT" });
        },
        spawn: (() => {
          spawned++;
          if (spawned === 1) return xvfb;
          throw new Error("spawn EACCES");
        }) as never,
        kill: exitOnKill([xvfb], kills),
      },
    ),
    /spawn EACCES/u,
  );
  assert.deepEqual(kills, [[-700, "SIGTERM"]]);
  assert.equal(xvfb.exitCode, 0);
  await rm(directory, { recursive: true, force: true });
});

test("O1a: a launched server-plain browser keeps isolated-context windows at the origin", async () => {
  const calls: { method: string; params: unknown }[] = [];
  let targets = 0;
  const fake = await fakeCdp((message, send) => {
    const method = String(message.method);
    calls.push({ method, params: message.params });
    const result =
      method === "Target.getTargets"
        ? { targetInfos: [] }
        : method === "Target.createTarget"
          ? { targetId: `target-${++targets}` }
          : method === "Target.attachToTarget"
            ? { sessionId: `session-${targets}` }
            : method === "Target.createBrowserContext"
              ? { browserContextId: "context" }
              : method === "Browser.getWindowForTarget"
                ? { windowId: 1 }
                : {};
    send({ id: message.id, result });
  });
  const port = new URL(fake.url).port;
  const directory = await mkdtemp(join(tmpdir(), "jevpilot-o1a-origin-"));
  const chrome = fakeProcess(710);
  const kills: [number, string][] = [];
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    browser = await launchBrowser(
      {
        ...serverProfile,
        display: "headless",
        userDataDir: directory,
        executable: "/bin/chromium",
      },
      { selfCheck: false, timeoutMs: 2000 },
      {
        platform: "linux",
        env: {},
        graceMs: 10,
        readFile: async () => `${port}\n/devtools/browser/${port}\n`,
        spawn: (() => chrome) as never,
        kill: exitOnKill([chrome], kills),
      },
    );
    await browser.newPage({ isolated: { copyCookies: false } });
    const isolated = calls.find(
      (call) =>
        call.method === "Target.createTarget" &&
        (call.params as { browserContextId?: string }).browserContextId === "context",
    );
    assert.deepEqual(
      [(isolated?.params as { left?: number }).left, (isolated?.params as { top?: number }).top],
      [0, 0],
    );
    const bounds = calls
      .filter((call) => call.method === "Browser.setWindowBounds")
      .map((call) => (call.params as { bounds: { left: number; top: number } }).bounds);
    assert.ok(bounds.length > 0);
    assert.ok(bounds.every((item) => item.left === 0 && item.top === 0));
  } finally {
    await browser?.close();
    await fake.close();
    await rm(directory, { recursive: true, force: true });
  }
});

describe("desktop launcher", () => {
  test("browser identity is stable across localhost aliases", () => {
    assert.equal(
      browserIdentity("ws://127.0.0.1:9222/devtools/browser/abc"),
      browserIdentity("ws://localhost:9222/devtools/browser/abc"),
    );
    assert.notEqual(
      browserIdentity("ws://127.0.0.1:9222/devtools/browser/abc"),
      browserIdentity("ws://127.0.0.1:9222/devtools/browser/def"),
    );
  });
  test("builds the exact desktop flags", () => {
    assert.deepEqual(buildLaunchArgs(profile), [
      "--remote-debugging-port=0",
      "--user-data-dir=profile",
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--window-position=-3000,-3000",
      "--window-size=1366,900",
    ]);
  });

  test("rejects forbidden extra flags", () => {
    for (const flag of ["--headless", "--headless=new", "--disable-gpu", "--enable-automation"]) {
      assert.throws(() => buildLaunchArgs({ ...profile, extraArgs: [flag] }), BrowserConfigError);
    }
  });
});

test("attach without opt-in never changes browser-wide download behavior", async () => {
  const calls: { method: string; params: unknown }[] = [];
  const fake = await fakeCdp((message, send) => {
    calls.push({ method: String(message.method), params: message.params });
    send({ id: message.id, result: {} });
  });
  let attached: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    attached = await launchBrowser({ kind: "attach", cdpUrl: fake.url }, { selfCheck: false });
    assert.equal(attached.downloadPath, undefined);
    assert.equal(attached.managedDownloadPath, undefined);
    await attached.close();
    assert.equal(
      calls.some((call) => call.method === "Browser.setDownloadBehavior"),
      false,
    );
  } finally {
    await attached?.close();
    await fake.close();
  }
});

test("opt-in attach removes only its managed temp directory and never resets behavior", async () => {
  const calls: { method: string; params: unknown }[] = [];
  const fake = await fakeCdp((message, send) => {
    calls.push({ method: String(message.method), params: message.params });
    send({ id: message.id, result: {} });
  });
  const configured = await mkdtemp(join(tmpdir(), "jevpilot-configured-downloads-"));
  let attached: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    attached = await launchBrowser(
      { kind: "attach", cdpUrl: fake.url },
      { selfCheck: false, manageDownloads: true },
    );
    const managed = attached.managedDownloadPath;
    if (!managed) throw new Error("managed download path missing");
    assert.equal(attached.downloadPath, managed);
    assert.ok((await readdir(tmpdir())).includes(basename(managed)));
    await assert.rejects(
      launchBrowser(
        { kind: "attach", cdpUrl: fake.url },
        { selfCheck: false, manageDownloads: true },
      ),
      BrowserConfigError,
    );
    await attached.close();
    attached = undefined;
    assert.equal((await readdir(tmpdir())).includes(basename(managed)), false);
    attached = await launchBrowser(
      { kind: "attach", cdpUrl: fake.url, downloadPath: configured },
      { selfCheck: false, manageDownloads: true },
    );
    await attached.close();
    attached = undefined;
    assert.ok((await readdir(tmpdir())).includes(basename(configured)));
    const behaviors = calls
      .filter((call) => call.method === "Browser.setDownloadBehavior")
      .map((call) => call.params as { behavior: string; downloadPath?: string });
    assert.deepEqual(
      behaviors.map((item) => item.behavior),
      ["allowAndName", "allowAndName"],
    );
    assert.equal(behaviors[0]?.downloadPath, managed);
    assert.equal(behaviors[1]?.downloadPath, configured);
    await assert.rejects(
      launchBrowser(
        { kind: "attach", cdpUrl: fake.url, downloadPath: configured },
        { selfCheck: false },
      ),
      BrowserConfigError,
    );
    assert.equal(calls.filter((call) => call.method === "Browser.setDownloadBehavior").length, 2);
  } finally {
    await attached?.close();
    await fake.close();
    await rm(configured, { recursive: true, force: true });
  }
});
