import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EngineRegistry } from "../../src/engine/registry.ts";
import type { BrowserHandle, EngineDriver } from "../../src/engine/types.ts";
import { createServer } from "../../src/mcp/server.ts";
import type { SessionDeps } from "../../src/orchestrator/session.ts";
import { fakeMcpDeps } from "../support/mcp-fixture.ts";
import { FakePageHandle } from "../support/fake-engine.ts";

const structured = (value: unknown): Record<string, unknown> =>
  (value as { structuredContent: Record<string, unknown> }).structuredContent;

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function setup(orchestrator: Partial<SessionDeps> = {}) {
  const deps = fakeMcpDeps();
  deps.orchestrator = { ...deps.orchestrator, ...orchestrator };
  let launches = 0;
  let current: { handle: BrowserHandle; disconnect: () => void; closed: boolean } | undefined;
  let closedBeforeLaunch = false;
  const driver: EngineDriver = {
    kind: "disconnectable",
    async launch() {
      closedBeforeLaunch = current ? current.closed : true;
      launches++;
      let connected = true;
      const listeners = new Set<() => void>();
      const state = {
        handle: undefined as unknown as BrowserHandle,
        disconnect: () => {
          connected = false;
          for (const listener of listeners) listener();
        },
        closed: false,
      };
      const handle: BrowserHandle = {
        engine: { name: "disconnectable", driver: "disconnectable", stealthLevel: "high" },
        capabilities: new FakePageHandle().capabilities,
        selfCheck: undefined,
        get connected() {
          return connected;
        },
        onDisconnected(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        newPage: async () => new FakePageHandle(),
        pages: () => [],
        close: async () => {
          if (!connected) state.closed = true;
          else state.closed = true;
        },
      };
      state.handle = handle;
      current = state;
      return handle;
    },
  };
  deps.engines = new EngineRegistry({ default: { driver: "disconnectable", profile: {} } });
  deps.engines.register(driver);
  const app = createServer(deps);
  return {
    app,
    launches: () => launches,
    disconnect: () => current?.disconnect(),
    wasClosed: () => Boolean(current?.closed),
    closedBeforeLaunch: () => closedBeforeLaunch,
  };
}

async function connectedClient(app: ReturnType<typeof setup>["app"]) {
  const client = new Client({ name: "o9d", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await app.server.connect(right);
  await client.connect(left);
  return client;
}

test("O9d: browser_run after a browser disconnect launches a new browser", async () => {
  const setupState = setup();
  const client = await connectedClient(setupState.app);
  try {
    const first = structured(
      await client.callTool({ name: "browser_run", arguments: { goal: "Finish" } }),
    );
    setupState.disconnect();
    const second = structured(
      await client.callTool({ name: "browser_run", arguments: { goal: "Finish again" } }),
    );
    // Later runs reuse the relaunched browser instead of launching yet another one.
    const third = structured(
      await client.callTool({ name: "browser_run", arguments: { goal: "Finish a third time" } }),
    );
    assert.equal(setupState.launches(), 2);
    assert.notEqual(second.session, first.session);
    assert.notEqual(second.status, "FAILED", JSON.stringify(second));
    assert.notEqual(third.status, "FAILED", JSON.stringify(third));
  } finally {
    await client.close();
    await setupState.app.close();
  }
});

test("O9d: a session whose browser disconnected reports browser_disconnected", async () => {
  const setupState = setup();
  const client = await connectedClient(setupState.app);
  try {
    const run = structured(
      await client.callTool({ name: "browser_run", arguments: { goal: "Finish" } }),
    );
    setupState.disconnect();
    const observed = structured(
      await client.callTool({ name: "browser_observe", arguments: { session: run.session } }),
    );
    assert.equal(observed.status, "FAILED");
    assert.equal(observed.reason, "browser_disconnected");
    const closed = structured(
      await client.callTool({ name: "browser_close", arguments: { session: run.session } }),
    );
    assert.equal(closed.closed, true);
  } finally {
    await client.close();
    await setupState.app.close();
  }
});

test("O9d: the disconnected browser is closed before the relaunch", async () => {
  const setupState = setup();
  const client = await connectedClient(setupState.app);
  try {
    await client.callTool({ name: "browser_run", arguments: { goal: "Finish" } });
    setupState.disconnect();
    await client.callTool({ name: "browser_run", arguments: { goal: "Finish again" } });
    assert.equal(setupState.wasClosed(), false);
    assert.equal(setupState.closedBeforeLaunch(), true);
    assert.equal(setupState.launches(), 2);
  } finally {
    await client.close();
    await setupState.app.close();
  }
});

test("R5: a session whose browser disconnected gives up its handoff screenshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevpilot-r5-shots-"));
  const setupState = setup({ tempDir: async () => directory });
  const client = await connectedClient(setupState.app);
  try {
    const run = structured(
      await client.callTool({ name: "browser_run", arguments: { goal: "Finish" } }),
    );
    assert.equal(run.status, "NEEDS_VALUES");
    const shot = String(run.screenshot_path);
    assert.equal(existsSync(shot), true, "the handoff wrote a screenshot");
    setupState.disconnect();
    const observed = structured(
      await client.callTool({ name: "browser_observe", arguments: { session: run.session } }),
    );
    assert.equal(observed.reason, "browser_disconnected");
    await waitFor(() => !existsSync(directory));
    const closed = structured(
      await client.callTool({ name: "browser_close", arguments: { session: run.session } }),
    );
    assert.equal(closed.closed, true);
  } finally {
    await client.close();
    await setupState.app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
