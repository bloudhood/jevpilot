import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { createOwnedTempDir, removeTempDir } from "../util/owned-temp.ts";
import type { ChildProcess } from "node:child_process";
import { CdpClient, type CdpOptions } from "./cdp/client.ts";
import { BrowserConfigError, BrowserLaunchError, BrowserSelfCheckError } from "./errors.ts";
import { spawnBrowser, stopBrowser, type ProcessDeps } from "./process.ts";
import type { BrowserProfile, DesktopChromeProfile, ServerPlainProfile } from "./profiles.ts";
import { BrowserSession } from "./session.ts";
import { checkBrowser, type SelfCheckReport } from "./self-check.ts";

export type LaunchDeps = ProcessDeps & {
  access?: (path: string) => Promise<void>;
  readFile?: (path: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  cdpOptions?: CdpOptions;
};
const activeDirs = new Set<string>();
const activeDownloadManagers = new Set<string>();
type BrowserIdentity = {
  userAgent: string;
  userAgentMetadata: {
    brands: unknown;
    fullVersionList: unknown;
    platform: string;
    platformVersion: string;
    architecture: string;
    bitness: string;
    model: string;
    mobile: boolean;
    wow64: boolean;
  };
};
const identityCache = new Map<string, Promise<BrowserIdentity | undefined>>();
const forbidden = /^--(?:headless(?:=|$)|disable-gpu(?:=|$)|enable-automation(?:=|$))/i;

export async function preparePasswordManagerPreferences(userDataDir: string): Promise<void> {
  const defaultDir = join(userDataDir, "Default");
  const preferencesPath = join(defaultDir, "Preferences");
  await mkdir(defaultDir, { recursive: true });
  let contents: string;
  try {
    contents = await readFile(preferencesPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`jevpilot warning: could not read Chrome Preferences: ${preferencesPath}`);
      return;
    }
    contents = "{}";
  }
  let preferences: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    preferences = parsed as Record<string, unknown>;
  } catch {
    console.warn(`jevpilot warning: could not parse Chrome Preferences: ${preferencesPath}`);
    return;
  }
  const profile =
    preferences.profile &&
    typeof preferences.profile === "object" &&
    !Array.isArray(preferences.profile)
      ? (preferences.profile as Record<string, unknown>)
      : {};
  preferences.credentials_enable_service = false;
  profile.password_manager_enabled = false;
  profile.password_manager_leak_detection = false;
  preferences.profile = profile;
  await writeFile(preferencesPath, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
}

export function browserIdentity(url: string): string {
  const parsed = new URL(url);
  const browserId = /^\/devtools\/browser\/([^/]+)$/u.exec(parsed.pathname)?.[1];
  return browserId ?? url;
}

export function buildLaunchArgs(profile: DesktopChromeProfile | ServerPlainProfile): string[] {
  if (
    !profile.userDataDir ||
    !Number.isInteger(profile.windowSize.width) ||
    !Number.isInteger(profile.windowSize.height) ||
    profile.windowSize.width <= 0 ||
    profile.windowSize.height <= 0
  ) {
    throw new BrowserConfigError("invalid managed Chrome profile");
  }
  if (profile.extraArgs?.some((argument) => forbidden.test(argument))) {
    throw new BrowserConfigError("forbidden Chrome flag in extraArgs");
  }
  return [
    "--remote-debugging-port=0",
    `--user-data-dir=${profile.userDataDir}`,
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    `--window-position=${profile.kind === "server-plain" || profile.display !== "headed" ? "0,0" : "-3000,-3000"}`,
    `--window-size=${profile.windowSize.width},${profile.windowSize.height}`,
    ...((
      profile.kind === "desktop-chrome"
        ? profile.display !== "headed"
        : profile.display === "headless"
    )
      ? ["--headless=new"]
      : []),
    ...(profile.proxy ? [`--proxy-server=${profile.proxy}`] : []),
    ...(profile.extraArgs ?? []),
  ];
}

async function probeBrowserIdentity(
  executable: string,
  extraArgs: string[] | undefined,
  timeoutMs: number,
  deps: LaunchDeps,
): Promise<BrowserIdentity | undefined> {
  // The probe runs with the launch's extraArgs, so they are part of what it measured.
  const key = JSON.stringify([executable, extraArgs ?? []]);
  const cached = identityCache.get(key);
  if (cached) return cached;
  // Never rejects: any failure is a warning and `undefined`, and the launch goes on without the UA fix.
  const result = (async (): Promise<BrowserIdentity | undefined> => {
    let directory: string | undefined;
    let child: ChildProcess | undefined;
    let client: CdpClient | undefined;
    try {
      directory = await createOwnedTempDir("jevpilot-probe-");
      const probeFile = join(directory, "probe.html");
      await writeFile(probeFile, "<!doctype html><title>probe</title>", "utf8");
      child = spawnBrowser(
        executable,
        [
          ...(extraArgs ?? []),
          "--headless=new",
          "--remote-debugging-port=0",
          `--user-data-dir=${directory}`,
          "--no-first-run",
          "--no-default-browser-check",
        ],
        deps,
      );
      const url = await waitForDevToolsPort(directory, timeoutMs, deps);
      client = await CdpClient.connect(url, { ...(deps.cdpOptions ?? {}), timeoutMs });
      const version = await client.call("Browser.getVersion", undefined, undefined, timeoutMs);
      const target = await client.call("Target.createTarget", { url: "about:blank" });
      const sessionId = await client.attach(target.targetId);
      const loaded = client.waitForEvent("Page.loadEventFired", () => true, timeoutMs, sessionId);
      await client.call("Page.enable", {}, sessionId);
      await client.call("Page.navigate", { url: pathToFileURL(probeFile).href }, sessionId);
      await loaded;
      const evaluated = await client.call(
        "Runtime.evaluate",
        {
          expression:
            "(async()=>JSON.stringify({brands:navigator.userAgentData?.brands ?? [],mobile:navigator.userAgentData?.mobile ?? false,high:navigator.userAgentData?.getHighEntropyValues ? await navigator.userAgentData.getHighEntropyValues(['architecture','bitness','fullVersionList','model','platform','platformVersion','wow64']) : {}}))()",
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
        timeoutMs,
      );
      const value = JSON.parse(String(evaluated.result.value)) as {
        brands: unknown;
        mobile: boolean;
        high: Record<string, unknown>;
      };
      if (
        !Array.isArray(value.brands) ||
        value.brands.length === 0 ||
        !Array.isArray(value.high.fullVersionList) ||
        value.high.fullVersionList.length === 0
      )
        throw new BrowserLaunchError("browser identity metadata unavailable");
      await client.call("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
      return {
        userAgent: version.userAgent,
        userAgentMetadata: {
          brands: value.brands,
          fullVersionList: value.high.fullVersionList,
          platform: String(value.high.platform ?? ""),
          platformVersion: String(value.high.platformVersion ?? ""),
          architecture: String(value.high.architecture ?? ""),
          bitness: String(value.high.bitness ?? ""),
          model: String(value.high.model ?? ""),
          mobile: value.mobile,
          wow64: Boolean(value.high.wow64),
        },
      };
    } catch (error) {
      console.warn(
        `jevpilot warning: browser identity probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    } finally {
      client?.close();
      if (child) await stopBrowser(child, deps).catch(() => {});
      if (directory) await removeTempDir(directory).catch(() => {});
    }
  })();
  identityCache.set(
    key,
    result.then((identity) => {
      if (!identity) identityCache.delete(key);
      return identity;
    }),
  );
  return result;
}

export async function startDisplay(
  profile: ServerPlainProfile,
  deps: LaunchDeps,
): Promise<{ display: string; child?: ChildProcess }> {
  const env = deps.env ?? process.env;
  if (env.DISPLAY) return { display: env.DISPLAY };
  const exists = deps.access ?? access;
  let executable: string | undefined;
  for (const directory of (env.PATH ?? "").split(":")) {
    if (!directory) continue;
    const candidate = posix.join(directory, "Xvfb");
    try {
      await exists(candidate);
      executable = candidate;
      break;
    } catch {
      /* next PATH entry */
    }
  }
  if (!executable)
    throw new BrowserConfigError('X display unavailable: install Xvfb or use display: "headless"');
  let spawnAttempts = 0;
  for (let number = 90; number < 190 && spawnAttempts < 3; number++) {
    const socket = `/tmp/.X11-unix/X${number}`;
    const lock = `/tmp/.X${number}-lock`;
    let taken = false;
    for (const path of [socket, lock]) {
      try {
        await exists(path);
        taken = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (taken) continue;
    const display = `:${number}`;
    spawnAttempts++;
    const child = spawnBrowser(
      executable,
      [
        display,
        "-screen",
        "0",
        `${profile.windowSize.width}x${profile.windowSize.height}x24`,
        "-nolisten",
        "tcp",
      ],
      deps,
    );
    let failure: Error | undefined;
    const onError = (error: Error): void => {
      failure = error;
    };
    child.on("error", onError);
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (failure) throw new BrowserLaunchError("Xvfb launch failed", { cause: failure });
        if (child.exitCode !== null || child.signalCode !== null) break;
        try {
          await exists(socket);
          child.off("error", onError);
          return { display, child };
        } catch {
          /* wait for socket */
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } catch (cause) {
      child.off("error", onError);
      await stopBrowser(child, deps).catch(() => {});
      throw cause;
    }
    child.off("error", onError);
    await stopBrowser(child, deps).catch(() => {});
    continue;
  }
  throw new BrowserLaunchError("Xvfb did not become ready on any free display");
}

export function parseDevToolsActivePort(contents: string): { port: number; path: string } {
  const [portText, path] = contents.trim().split(/\r?\n/);
  const port = Number(portText);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !path?.startsWith("/devtools/browser/")
  ) {
    throw new BrowserLaunchError("invalid DevToolsActivePort");
  }
  return { port, path };
}

export async function waitForDevToolsPort(
  userDataDir: string,
  timeoutMs = 10000,
  deps: LaunchDeps = {},
): Promise<string> {
  const read = deps.readFile ?? ((path: string) => readFile(path, "utf8"));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { port, path } = parseDevToolsActivePort(
        await read(join(userDataDir, "DevToolsActivePort")),
      );
      return `ws://127.0.0.1:${port}${path}`;
    } catch (cause) {
      if (
        !(cause instanceof BrowserLaunchError) &&
        !["ENOENT", "EBUSY", "EPERM"].includes((cause as NodeJS.ErrnoException).code ?? "")
      ) {
        throw cause;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new BrowserLaunchError("timed out waiting for DevToolsActivePort");
}

export async function findChrome(deps: LaunchDeps = {}): Promise<string | undefined> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  const exists = deps.access ?? access;
  const candidates =
    platform === "win32"
      ? [
          ...[env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]
            .filter((directory): directory is string => Boolean(directory))
            .map((directory) =>
              path.join(directory, "Google", "Chrome", "Application", "chrome.exe"),
            ),
          ...[env.PROGRAMFILES, env["PROGRAMFILES(X86)"]]
            .filter((directory): directory is string => Boolean(directory))
            .map((directory) =>
              path.join(directory, "Microsoft", "Edge", "Application", "msedge.exe"),
            ),
        ]
      : (env.PATH ?? "")
          .split(":")
          .flatMap((directory) =>
            ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].map((name) =>
              path.join(directory, name),
            ),
          );
  for (const candidate of candidates) {
    try {
      await exists(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

export class BrowserInstance {
  readonly client: CdpClient;
  selfCheck: SelfCheckReport | undefined;
  startupTargetIds: readonly string[] = [];
  private readonly child: ChildProcess | undefined;
  private readonly displayChild: ChildProcess | undefined;
  private readonly windowPosition: { left: number; top: number };
  private readonly userDataDir: string | undefined;
  private readonly deps: LaunchDeps;
  readonly sessions = new Set<BrowserSession>();
  private keepAlive: BrowserSession | undefined;
  downloadPath: string | undefined;
  managedDownloadPath: string | undefined;
  managedBrowserKey: string | undefined;
  attached = false;
  targetDiscoveryEnabled = false;
  private closed = false;
  private readonly isolatedContexts = new Set<string>();
  private readonly windowSize: { width: number; height: number } | undefined;
  private readonly headless: boolean;
  private readonly userAgent: string | undefined;
  private readonly userAgentMetadata: BrowserIdentity["userAgentMetadata"] | undefined;
  get pid(): number | undefined {
    return this.child?.pid;
  }
  get connected(): boolean {
    return !this.closed && !this.client.isDisconnected;
  }
  onDisconnected(listener: () => void): () => void {
    return this.client.on("disconnected", listener);
  }
  constructor(
    client: CdpClient,
    child?: ChildProcess,
    userDataDir?: string,
    deps: LaunchDeps = {},
    selfCheck?: SelfCheckReport,
    windowSize?: { width: number; height: number },
    displayChild?: ChildProcess,
    windowPosition: { left: number; top: number } = { left: -3000, top: -3000 },
    headless = false,
    userAgent?: string,
    userAgentMetadata?: BrowserIdentity["userAgentMetadata"],
  ) {
    this.client = client;
    this.child = child;
    this.displayChild = displayChild;
    this.windowPosition = windowPosition;
    this.userDataDir = userDataDir;
    this.deps = deps;
    this.selfCheck = selfCheck;
    this.windowSize = windowSize;
    this.headless = headless;
    this.userAgent = userAgent;
    this.userAgentMetadata = userAgentMetadata;
  }
  async newPage(options: { isolated?: { copyCookies: boolean } } = {}): Promise<BrowserSession> {
    if (this.closed) {
      throw new BrowserLaunchError("browser is closed");
    }
    let contextId: string | undefined;
    let session: BrowserSession | undefined;
    try {
      if (options.isolated) {
        contextId = (await this.client.call("Target.createBrowserContext", {})).browserContextId;
        this.isolatedContexts.add(contextId);
        if (options.isolated.copyCookies) {
          const cookies = (await this.client.call("Storage.getCookies", {})).cookies;
          if (cookies.length)
            await this.client.call("Storage.setCookies", { cookies, browserContextId: contextId });
        }
        if (this.downloadPath)
          await this.client.call("Browser.setDownloadBehavior", {
            behavior: "allowAndName",
            downloadPath: this.downloadPath,
            eventsEnabled: true,
            browserContextId: contextId,
          });
      }
      const created = await BrowserSession.create(
        this.client,
        () => this.sessions.delete(created),
        contextId,
        this.windowSize,
        this.windowPosition,
      );
      session = created;
      this.sessions.add(session);
      await this.configureSession(session);
      if (contextId) await this.placeOffScreen(session.targetId);
      return session;
    } catch (error) {
      await session?.close().catch(() => {});
      if (contextId) await this.disposeContext(contextId).catch(() => {});
      throw error;
    }
  }
  async disposeContext(contextId: string): Promise<void> {
    if (!this.isolatedContexts.delete(contextId)) return;
    await this.client.call("Target.disposeBrowserContext", { browserContextId: contextId });
  }
  async placeOffScreen(targetId: string): Promise<void> {
    if (!this.windowSize) return;
    const { windowId } = await this.client.call("Browser.getWindowForTarget", { targetId });
    await this.client.call("Browser.setWindowBounds", {
      windowId,
      bounds: {
        left: this.windowPosition.left,
        top: this.windowPosition.top,
        width: this.windowSize.width,
        height: this.windowSize.height,
        windowState: "normal",
      },
    });
  }
  async attachPage(targetId: string, sessionId: string): Promise<BrowserSession> {
    if (this.closed) throw new BrowserLaunchError("browser is closed");
    const session = await BrowserSession.attached(this.client, targetId, sessionId, () =>
      this.sessions.delete(session),
    );
    this.sessions.add(session);
    await this.configureSession(session);
    return session;
  }
  // The --user-agent switch empties the high-entropy UA-CH values; restore the browser's own ones per page.
  // Dedicated workers inherit the override from their page, so they need no call of their own.
  private async configureSession(session: BrowserSession): Promise<void> {
    if (!this.headless || !this.userAgent || !this.userAgentMetadata) return;
    await this.client.call(
      "Emulation.setUserAgentOverride",
      {
        userAgent: this.userAgent.replace(/HeadlessChrome/gu, "Chrome"),
        userAgentMetadata: this.userAgentMetadata as never,
      },
      session.sessionId,
    );
  }
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      try {
        await Promise.all(
          [...this.sessions]
            .filter((session) => session !== this.keepAlive)
            .map((session) =>
              session.close().catch((error: unknown) => {
                if (!this.client.isDisconnected) throw error;
              }),
            ),
        );
        await this.keepAlive?.close().catch((error: unknown) => {
          if (!this.client.isDisconnected) throw error;
        });
      } finally {
        try {
          await Promise.all(
            [...this.isolatedContexts].map((id) =>
              this.disposeContext(id).catch((error: unknown) => {
                if (!this.client.isDisconnected) throw error;
              }),
            ),
          );
        } finally {
          try {
            if (this.attached && this.targetDiscoveryEnabled && !this.client.isDisconnected)
              await this.client.call("Target.setDiscoverTargets", { discover: false });
          } finally {
            if (this.attached && this.downloadPath && !this.client.isDisconnected)
              await this.client.call("Browser.setDownloadBehavior", { behavior: "default" });
          }
        }
      }
    } finally {
      this.client.close();
      try {
        if (this.child) await stopBrowser(this.child, this.deps);
      } finally {
        if (this.displayChild) await stopBrowser(this.displayChild, this.deps);
        if (this.userDataDir) activeDirs.delete(this.userDataDir);
        if (this.managedBrowserKey) activeDownloadManagers.delete(this.managedBrowserKey);
        if (this.managedDownloadPath) await removeTempDir(this.managedDownloadPath);
      }
    }
  }

  async configureDownloads(downloadPath: string, managedPath?: string): Promise<void> {
    await this.client.call("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath,
      eventsEnabled: true,
    });
    this.downloadPath = downloadPath;
    this.managedDownloadPath = managedPath;
  }

  retainPage(session: BrowserSession): void {
    this.keepAlive = session;
  }
}

export async function launchBrowser(
  profile: BrowserProfile,
  options: {
    allowDegraded?: boolean;
    selfCheck?: boolean;
    timeoutMs?: number;
    manageDownloads?: boolean;
  } = {},
  deps: LaunchDeps = {},
): Promise<BrowserInstance> {
  let child: ChildProcess | undefined;
  let displayChild: ChildProcess | undefined;
  let directory: string | undefined;
  let client: CdpClient | undefined;
  let browser: BrowserInstance | undefined;
  let probedIdentity: BrowserIdentity | undefined;
  let managedDownloadPath: string | undefined;
  let managedBrowserKey: string | undefined;
  try {
    let url: string;
    if (profile.kind !== "attach") {
      if (activeDirs.has(profile.userDataDir)) {
        // `directory` stays unset: the profile belongs to the launch that holds it, not to this one.
        throw new BrowserConfigError(`profile already active: ${profile.userDataDir}`);
      }
      directory = profile.userDataDir;
      activeDirs.add(directory);
      await rm(join(directory, "DevToolsActivePort"), { force: true }).catch(() => {});
      // Chrome's password leak check opens a tab-modal dialog that blocks all input after a login with a
      // breached password; jevpilot never uses the password manager. Failing to write it must not block launch.
      await preparePasswordManagerPreferences(directory).catch(() =>
        console.warn("jevpilot warning: could not update Chrome Preferences"),
      );
      const executable = profile.executable ?? (await findChrome(deps));
      if (!executable) {
        throw new BrowserConfigError("Chrome executable not found");
      }
      const headlessLaunch =
        (profile.kind === "desktop-chrome" && profile.display !== "headed") ||
        (profile.kind === "server-plain" && profile.display === "headless");
      if (headlessLaunch)
        probedIdentity = await probeBrowserIdentity(
          executable,
          profile.extraArgs,
          options.timeoutMs ?? 10000,
          deps,
        );
      const launchArgs = buildLaunchArgs(profile);
      if (headlessLaunch) {
        if (probedIdentity)
          launchArgs.push(
            `--user-agent=${probedIdentity.userAgent.replace(/HeadlessChrome/gu, "Chrome")}`,
          );
        launchArgs.push(
          `--screen-info={${Math.max(profile.windowSize.width, 1920)}x${Math.max(profile.windowSize.height, 1080)}}`,
        );
      }
      const display =
        profile.kind === "server-plain" && profile.display === "xvfb"
          ? await startDisplay(profile, deps)
          : undefined;
      displayChild = display?.child;
      child = spawnBrowser(
        executable,
        launchArgs,
        display
          ? { ...deps, env: { ...(deps.env ?? process.env), DISPLAY: display.display } }
          : deps,
      );
      if (displayChild) {
        const xvfb = displayChild;
        child.once("exit", () => {
          void stopBrowser(xvfb, deps).catch(() => {});
        });
      }
      const spawned = child;
      const port = waitForDevToolsPort(directory, options.timeoutMs ?? 10000, deps);
      const failed = new Promise<never>((_resolve, reject) =>
        spawned.once("error", (cause) =>
          reject(new BrowserLaunchError("Chrome launch failed", { cause })),
        ),
      );
      url = await Promise.race([port, failed]);
    } else {
      if (/^wss?:\/\//.test(profile.cdpUrl)) url = profile.cdpUrl;
      else {
        const response = await (deps.fetch ?? fetch)(new URL("/json/version", profile.cdpUrl));
        if (!response.ok) {
          throw new BrowserLaunchError(`CDP discovery HTTP ${response.status}`);
        }
        const data: unknown = await response.json();
        const wsUrl = (data as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl;
        if (typeof wsUrl !== "string") {
          throw new BrowserLaunchError("missing webSocketDebuggerUrl");
        }
        url = wsUrl;
      }
    }
    client = await CdpClient.connect(url, deps.cdpOptions);
    const version =
      profile.kind !== "attach" ? await client.call("Browser.getVersion", undefined) : undefined;
    const headless =
      profile.kind === "desktop-chrome"
        ? profile.display !== "headed"
        : profile.kind === "server-plain" && profile.display === "headless";
    browser = new BrowserInstance(
      client,
      child,
      directory,
      deps,
      undefined,
      profile.kind !== "attach" ? profile.windowSize : undefined,
      displayChild,
      profile.kind === "server-plain" ||
        (profile.kind === "desktop-chrome" && profile.display !== "headed")
        ? { left: 0, top: 0 }
        : { left: -3000, top: -3000 },
      headless,
      version?.userAgent,
      probedIdentity?.userAgentMetadata,
    );
    browser.attached = profile.kind === "attach";
    const identity = browserIdentity(url);
    if (profile.kind !== "attach") {
      managedBrowserKey = identity;
      activeDownloadManagers.add(identity);
      browser.managedBrowserKey = identity;
      const downloadPath = profile.downloadPath ?? join(profile.userDataDir, "downloads");
      await mkdir(downloadPath, { recursive: true });
      await browser.configureDownloads(downloadPath);
    } else if (options.manageDownloads) {
      if (activeDownloadManagers.has(identity)) {
        throw new BrowserConfigError(
          "attach cannot manage downloads for a browser managed by another handle",
        );
      }
      managedBrowserKey = identity;
      activeDownloadManagers.add(identity);
      browser.managedBrowserKey = identity;
      const downloadPath =
        profile.downloadPath ??
        (managedDownloadPath = await createOwnedTempDir("jevpilot-downloads-"));
      await mkdir(downloadPath, { recursive: true });
      await browser.configureDownloads(downloadPath, managedDownloadPath);
    } else if (profile.downloadPath) {
      throw new BrowserConfigError("attach downloadPath requires manageDownloads: true");
    }
    const initialTargets =
      profile.kind !== "attach"
        ? (await client.call("Target.getTargets", undefined)).targetInfos
            .filter((target) => target.type === "page")
            .map((target) => target.targetId)
        : [];
    browser.startupTargetIds = initialTargets;
    const session = profile.kind !== "attach" ? await browser.newPage() : undefined;
    if (session) browser.retainPage(session);
    for (const targetId of initialTargets) await client.call("Target.closeTarget", { targetId });
    if (options.selfCheck !== false) {
      const checkSession = session ?? (await browser.newPage());
      const loaded = client.waitForEvent(
        "Page.loadEventFired",
        () => true,
        options.timeoutMs ?? 10000,
        checkSession.sessionId,
      );
      await Promise.all([
        loaded,
        client.call(
          "Page.navigate",
          { url: "data:text/html,<title>jevpilot</title>" },
          checkSession.sessionId,
        ),
      ]);
      const report = await checkBrowser(
        checkSession.world,
        profile.kind === "attach" ? "desktop-chrome" : profile.kind,
        profile.kind === "server-plain"
          ? profile.display
          : profile.kind === "desktop-chrome" && profile.display === "headed"
            ? "headed"
            : "headless",
      );
      if (!report.ok && !options.allowDegraded) {
        throw new BrowserSelfCheckError(
          report.checks.filter((check) => check.required && !check.ok).map((check) => check.name),
        );
      }
      // A failed identity probe leaves HeadlessChrome in the UA; the required user-agent check then reports it.
      browser.selfCheck = report;
      if (profile.kind === "attach") await checkSession.close();
      return browser;
    }
    return browser;
  } catch (cause) {
    await browser?.close().catch(() => {});
    client?.close();
    if (child) await stopBrowser(child, deps).catch(() => {});
    if (displayChild) await stopBrowser(displayChild, deps).catch(() => {});
    if (directory) activeDirs.delete(directory);
    if (managedBrowserKey) activeDownloadManagers.delete(managedBrowserKey);
    if (managedDownloadPath) await removeTempDir(managedDownloadPath);
    throw cause;
  }
}
