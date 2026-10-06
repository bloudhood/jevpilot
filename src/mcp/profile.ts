import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createOwnedTempDir, removeTempDir } from "../util/owned-temp.ts";
import {
  BrowserConfigError,
  buildLaunchArgs,
  parseCdpProfile,
  type BrowserProfile,
} from "../engine/default.ts";
import { McpUserError } from "./errors.ts";

export const DEFAULT_CALL_DEADLINE_MS = 45_000;

export function parseCallDeadline(value: string | undefined): number {
  if (value === undefined) return DEFAULT_CALL_DEADLINE_MS;
  if (!/^\d+$/u.test(value) || Number(value) > 2_147_483_647)
    throw new McpUserError("JEVPILOT_CALL_DEADLINE_MS must be between 0 and 2147483647.");
  return Number(value);
}

export function parseNavigationTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/u.test(value) || Number(value) > 2_147_483_647)
    throw new McpUserError("JEVPILOT_NAVIGATION_TIMEOUT_MS must be between 1 and 2147483647.");
  return Number(value);
}

export function parseActionabilityTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/u.test(value) || Number(value) > 2_147_483_647)
    throw new McpUserError("JEVPILOT_ACTIONABILITY_TIMEOUT_MS must be between 1 and 2147483647.");
  return Number(value);
}

function parseExtraArgs(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const args = value.trim().split(/\s+/u);
  if (args.some((argument) => !argument.startsWith("-")))
    throw new McpUserError(
      "Invalid JEVPILOT_EXTRA_ARGS token; flags containing spaces belong in an extraArgs entry of a JEVPILOT_PROFILE_FILE profile.",
    );
  return args;
}

export async function loadMcpProfile(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<{
  profile: BrowserProfile;
  cleanup: () => Promise<void>;
}> {
  const configuredDownloadDir = env.JEVPILOT_DOWNLOAD_DIR;
  if (configuredDownloadDir !== undefined) {
    if (!isAbsolute(configuredDownloadDir))
      throw new McpUserError("JEVPILOT_DOWNLOAD_DIR must be an absolute path.");
    try {
      if (!(await stat(configuredDownloadDir)).isDirectory()) throw new Error();
    } catch {
      throw new McpUserError("JEVPILOT_DOWNLOAD_DIR must be an existing directory.");
    }
  }
  if (env.JEVPILOT_PROFILE_FILE) {
    let contents: string;
    try {
      contents = await readFile(env.JEVPILOT_PROFILE_FILE, "utf8");
    } catch {
      throw new McpUserError("Cannot read JEVPILOT_PROFILE_FILE.");
    }
    let input: unknown;
    try {
      input = JSON.parse(contents);
    } catch {
      throw new McpUserError("JEVPILOT_PROFILE_FILE must contain valid JSON.");
    }
    if (
      env.JEVPILOT_BROWSER_PATH &&
      input &&
      typeof input === "object" &&
      "kind" in input &&
      input.kind === "desktop-chrome"
    )
      input = { ...input, executable: env.JEVPILOT_BROWSER_PATH };
    try {
      const parsed = parseCdpProfile(input);
      if (configuredDownloadDir) {
        if (parsed.kind === "attach")
          throw new McpUserError("JEVPILOT_DOWNLOAD_DIR cannot be used with an attach profile.");
        if (parsed.downloadPath)
          throw new McpUserError("JEVPILOT_DOWNLOAD_DIR conflicts with profile downloadPath.");
        return {
          profile: { ...parsed, downloadPath: configuredDownloadDir },
          cleanup: async () => {},
        };
      }
      return { profile: parsed, cleanup: async () => {} };
    } catch (error) {
      if (error instanceof McpUserError) throw error;
      if (error instanceof BrowserConfigError) {
        const fields = [...new Set(error.problems.map((problem) => problem.split(":", 1)[0]))];
        throw new McpUserError(`JEVPILOT_PROFILE_FILE has invalid fields: ${fields.join(", ")}.`);
      }
      throw new McpUserError("JEVPILOT_PROFILE_FILE has an invalid browser profile.");
    }
  }

  const isLinux = platform === "linux";
  if (env.JEVPILOT_DISPLAY && !["xvfb", "headless", "headed"].includes(env.JEVPILOT_DISPLAY))
    throw new McpUserError("JEVPILOT_DISPLAY must be headless, headed, or xvfb on Linux.");
  if (!isLinux && env.JEVPILOT_DISPLAY === "xvfb")
    throw new McpUserError("JEVPILOT_DISPLAY=xvfb is only available on Linux.");
  const extraArgs = parseExtraArgs(env.JEVPILOT_EXTRA_ARGS);
  const settings = {
    kind: isLinux ? "server-plain" : "desktop-chrome",
    windowSize: { width: 1280, height: 900 },
    ...(isLinux
      ? {
          display:
            env.JEVPILOT_DISPLAY === "headed" ? "xvfb" : (env.JEVPILOT_DISPLAY ?? "headless"),
        }
      : { display: env.JEVPILOT_DISPLAY === "headed" ? "headed" : "headless" }),
    ...(extraArgs ? { extraArgs } : {}),
    ...(env.JEVPILOT_BROWSER_PATH ? { executable: env.JEVPILOT_BROWSER_PATH } : {}),
    ...(configuredDownloadDir ? { downloadPath: configuredDownloadDir } : {}),
  };
  if (extraArgs) {
    // Fail at startup, not on the first browser_run.
    const check = parseCdpProfile({ ...settings, userDataDir: "check" });
    try {
      if (check.kind !== "attach") buildLaunchArgs(check);
    } catch (error) {
      if (!(error instanceof BrowserConfigError)) throw error;
      const rejected = error.problems.filter((problem) => problem !== error.message);
      throw new McpUserError(
        `JEVPILOT_EXTRA_ARGS contains a flag jevpilot does not allow (--headless, --disable-gpu, --enable-automation)${rejected.length ? `: ${rejected.join("; ")}` : "."}`,
      );
    }
  }
  const ownedDirectory = env.JEVPILOT_USER_DATA_DIR
    ? undefined
    : await createOwnedTempDir("jevpilot-mcp-browser-");
  try {
    const profile = parseCdpProfile({
      ...settings,
      userDataDir: env.JEVPILOT_USER_DATA_DIR ?? ownedDirectory,
    });
    return {
      profile,
      cleanup: async () => {
        if (ownedDirectory) await removeTempDir(ownedDirectory);
      },
    };
  } catch (error) {
    // Do not leak the just-created profile directory when the profile is invalid.
    if (ownedDirectory) await removeTempDir(ownedDirectory).catch(() => {});
    throw error;
  }
}
