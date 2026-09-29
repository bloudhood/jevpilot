import assert from "node:assert/strict";
import { test } from "node:test";
import { EngineRegistry, EngineRegistryError } from "../../src/engine/registry.ts";
import type { BrowserHandle, EngineDriver } from "../../src/engine/types.ts";

test("registry resolves default and named engines through a registered driver", async () => {
  const profiles: unknown[] = [];
  const driver: EngineDriver = {
    kind: "fixture",
    async launch(profile) {
      profiles.push(profile);
      return {
        engine: { name: "fixture", driver: "fixture", stealthLevel: "low" },
        capabilities: {
          isolatedExecution: false,
          isolatedContexts: false,
          trustedInput: false,
          responseHeaders: false,
          crossOriginFrames: false,
          dialogs: false,
          popups: false,
          downloads: false,
          fileUpload: false,
          screenshots: false,
        },
        connected: true,
        onDisconnected: () => () => {},
        selfCheck: undefined,
        async newPage() {
          throw new Error("not used");
        },
        pages() {
          return [];
        },
        async close() {},
      } satisfies BrowserHandle;
    },
  };
  const registry = new EngineRegistry({
    default: { driver: "fixture", profile: { seed: 1 } },
    stealth: { driver: "fixture", profile: { seed: 2 } },
  });
  registry.register(driver);
  assert.equal((await registry.resolve().launch()).engine.name, "default");
  assert.equal((await registry.resolve("stealth").launch()).engine.name, "stealth");
  assert.deepEqual(profiles, [{ seed: 1 }, { seed: 2 }]);
  assert.throws(
    () => registry.resolve("missing"),
    (error) => error instanceof EngineRegistryError && error.code === "UNKNOWN_ENGINE",
  );
  assert.throws(
    () => registry.register(driver),
    (error) => error instanceof EngineRegistryError && error.code === "DUPLICATE_DRIVER",
  );
});

test("registry reports unregistered driver with cause", () => {
  const registry = new EngineRegistry({ default: { driver: "bidi", profile: {} } });
  assert.throws(
    () => registry.resolve(),
    (error) =>
      error instanceof EngineRegistryError &&
      error.code === "UNKNOWN_DRIVER" &&
      error.cause === "bidi",
  );
});
