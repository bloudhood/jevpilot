import type { BrowserHandle, EngineDriver, LaunchOptions } from "./types.ts";

export type EngineConfig = { driver: string; profile: unknown };
export type EngineConfigs = Record<string, EngineConfig>;

export class EngineRegistryError extends Error {
  readonly code: "UNKNOWN_ENGINE" | "UNKNOWN_DRIVER" | "DUPLICATE_DRIVER";
  constructor(code: EngineRegistryError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EngineRegistryError";
    this.code = code;
  }
}

export type ResolvedEngine = {
  name: string;
  driver: EngineDriver;
  profile: unknown;
  launch(options?: LaunchOptions): Promise<BrowserHandle>;
};

export class EngineRegistry {
  private readonly drivers = new Map<string, EngineDriver>();
  private readonly configs: EngineConfigs;
  private readonly defaultName: string;

  constructor(configs: EngineConfigs, defaultName = "default") {
    this.configs = configs;
    this.defaultName = defaultName;
  }

  register(driver: EngineDriver): void {
    if (this.drivers.has(driver.kind)) {
      throw new EngineRegistryError(
        "DUPLICATE_DRIVER",
        `driver already registered: ${driver.kind}`,
        { cause: driver.kind },
      );
    }
    this.drivers.set(driver.kind, driver);
  }

  resolve(name = this.defaultName): ResolvedEngine {
    const config = this.configs[name];
    if (!Object.hasOwn(this.configs, name) || !config) {
      throw new EngineRegistryError("UNKNOWN_ENGINE", `unknown engine: ${name}`, { cause: name });
    }
    const driver = this.drivers.get(config.driver);
    if (!driver) {
      throw new EngineRegistryError("UNKNOWN_DRIVER", `unknown driver: ${config.driver}`, {
        cause: config.driver,
      });
    }
    return {
      name,
      driver,
      profile: config.profile,
      launch: async (options) => {
        const browser = await driver.launch(config.profile, options);
        return {
          engine: { ...browser.engine, name },
          capabilities: browser.capabilities,
          selfCheck: browser.selfCheck,
          get connected() {
            return browser.connected;
          },
          get downloadPath() {
            return browser.downloadPath;
          },
          onDisconnected: (listener) => browser.onDisconnected(listener),
          newPage: (pageOptions) => browser.newPage(pageOptions),
          pages: () => browser.pages(),
          close: () => browser.close(),
        };
      },
    };
  }
}
