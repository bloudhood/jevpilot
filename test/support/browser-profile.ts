import type { DesktopChromeProfile, ServerPlainProfile } from "../../src/browser/profiles.ts";

export function testProfile(
  userDataDir: string,
  windowSize: { width: number; height: number } = { width: 1280, height: 900 },
): DesktopChromeProfile | ServerPlainProfile {
  if (process.env.JEVPILOT_TEST_PROFILE !== "server-plain")
    return {
      kind: "desktop-chrome",
      userDataDir,
      windowSize,
      display: process.env.JEVPILOT_TEST_DISPLAY === "headless" ? "headless" : "headed",
    };
  const display = process.env.JEVPILOT_TEST_DISPLAY === "headless" ? "headless" : "xvfb";
  const extraArgs = process.env.JEVPILOT_TEST_EXTRA_ARGS?.trim();
  return {
    kind: "server-plain",
    userDataDir,
    windowSize,
    display,
    ...(extraArgs ? { extraArgs: extraArgs.split(/\s+/u) } : {}),
  };
}
