import type { IsolatedWorld } from "./isolated-world.ts";

export type SelfCheck = { name: string; ok: boolean; required: boolean; value: unknown };
export type SelfCheckReport = {
  ok: boolean;
  checks: SelfCheck[];
  stealth: "high" | "medium" | "low";
};

type BrowserValues = {
  webdriver: boolean;
  userAgent: string;
  platform: string;
  brands: unknown;
  renderer: string;
  screen: [number, number];
  outer: [number, number];
  timezone: string;
  languages: string[];
  plugins: number;
  chromeType: string;
  notificationPermission: string;
  queriedNotificationPermission: string;
};

const inspectionScript = `async () => {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("webgl");
  const extension = context?.getExtension("WEBGL_debug_renderer_info");
  const notificationPermission = Notification.permission;
  const permissionStatus = await navigator.permissions.query({ name: "notifications" });
  const queriedNotificationPermission = permissionStatus.state;
  return {
    webdriver: navigator.webdriver,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    brands: navigator.userAgentData?.brands ?? [],
    renderer: extension ? context?.getParameter(extension.UNMASKED_RENDERER_WEBGL) : "",
    screen: [screen.width, screen.height],
    outer: [outerWidth, outerHeight],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    languages: [...navigator.languages],
    plugins: navigator.plugins.length,
    chromeType: typeof window.chrome,
    notificationPermission,
    queriedNotificationPermission,
  };
}`;

export async function checkBrowser(
  world: IsolatedWorld,
  profile: "desktop-chrome" | "server-plain" = "desktop-chrome",
  display: "xvfb" | "headless" | "headed" = "xvfb",
): Promise<SelfCheckReport> {
  const values = await world.evaluate<BrowserValues>(`(${inspectionScript})()`);
  const server = profile === "server-plain";
  const checks: SelfCheck[] = [
    { name: "webdriver", ok: values.webdriver === false, required: true, value: values.webdriver },
    {
      name: "user-agent",
      ok: !values.userAgent.includes("HeadlessChrome"),
      required: !server || display !== "headless",
      value: values.userAgent,
    },
    {
      name: "renderer",
      ok: !/SwiftShader|llvmpipe/i.test(values.renderer),
      required: !server,
      value: values.renderer,
    },
    {
      name: "screen-size",
      ok: values.screen[0] >= values.outer[0] && values.screen[1] >= values.outer[1],
      required: !server || display !== "headless",
      value: { screen: values.screen, outer: values.outer },
    },
    {
      name: "outer-size",
      ok: values.outer[0] > 0 && values.outer[1] > 0,
      required: true,
      value: values.outer,
    },
    {
      name: "chrome-object",
      ok: values.chromeType === "object",
      required: true,
      value: values.chromeType,
    },
    { name: "plugins", ok: values.plugins > 0, required: !server, value: values.plugins },
    {
      name: "notifications",
      ok:
        (values.notificationPermission === "default" &&
          values.queriedNotificationPermission === "prompt") ||
        values.notificationPermission === values.queriedNotificationPermission,
      required: true,
      value: {
        notification: values.notificationPermission,
        queried: values.queriedNotificationPermission,
      },
    },
  ];
  const ok = checks.every((check) => !check.required || check.ok);
  return {
    ok,
    checks,
    stealth: server
      ? "low"
      : display === "headless"
        ? ok && checks.every((check) => check.ok)
          ? "medium"
          : "low"
        : checks.every((check) => check.ok)
          ? "high"
          : "low",
  };
}
