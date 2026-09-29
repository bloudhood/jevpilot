import { createCdpDriver, parseCdpProfile } from "./cdp/driver.ts";
import { EngineRegistry } from "./registry.ts";
import type { EngineDriver } from "./types.ts";
import type { BrowserProfile } from "../browser/profiles.ts";

export function createDefaultEngine(
  profile: BrowserProfile,
  driver: EngineDriver = createCdpDriver(),
): EngineRegistry {
  const engines = new EngineRegistry({ default: { driver: "cdp", profile } });
  engines.register(driver);
  return engines;
}

export { parseCdpProfile };
export type { BrowserProfile } from "../browser/profiles.ts";
export { BrowserConfigError } from "../browser/errors.ts";
export { buildLaunchArgs, findChrome } from "../browser/launcher.ts";
