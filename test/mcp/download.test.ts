import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MockDecider } from "../../src/decision/mock.ts";
import { EngineRegistry } from "../../src/engine/registry.ts";
import type { BrowserHandle, EngineDriver } from "../../src/engine/types.ts";
import { createServer } from "../../src/mcp/server.ts";
import { loadMcpProfile } from "../../src/mcp/profile.ts";
import { FakePageHandle } from "../support/fake-engine.ts";
import { fakeObservation } from "../support/mcp-fixture.ts";

const structured = (value: unknown): Record<string, unknown> =>
  (value as { structuredContent: Record<string, unknown> }).structuredContent;

test("initial-URL download is captured", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevpilot-mcp-download-"));
  const page = new FakePageHandle();
  const file = join(root, "initial-guid");
  const originalNavigate = page.navigate.bind(page);
  page.navigate = async (url: string) => {
    const result = await originalNavigate(url);
    await writeFile(file, "initial");
    page.emit("download", {
      id: "initial-guid",
      url: "https://signed.example/x",
      suggestedFilename: "initial.csv",
      state: "started",
    });
    page.emit("download", {
      id: "initial-guid",
      url: "https://signed.example/x",
      suggestedFilename: "initial.csv",
      state: "completed",
      path: file,
    });
    return result;
  };
  const driver: EngineDriver = {
    kind: "fake",
    async launch(): Promise<BrowserHandle> {
      return {
        engine: { name: "fake", driver: "fake", stealthLevel: "high" },
        capabilities: page.capabilities,
        selfCheck: undefined,
        connected: true,
        downloadPath: root,
        onDisconnected: () => () => {},
        newPage: async () => page,
        pages: () => [page],
        close: async () => {},
      };
    },
  };
  const deps = {
    engines: new EngineRegistry({ default: { driver: "fake", profile: {} } }),
    decisionPort: new MockDecider(() => ({ answers: {} })),
    orchestrator: {
      observe: async () => fakeObservation("initial"),
      detect: () => [],
      buildDecisionState: () => ({ state: {}, questions: {}, reductions: [] }),
      interpret: () => ({ type: "done_candidate" as const, goalMet: 0 }),
      pageMatches: async () => false,
    },
  };
  deps.engines.register(driver);
  const app = createServer(deps);
  const client = new Client({ name: "m8c-download", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await app.server.connect(right);
    await client.connect(left);
    const result = structured(
      await client.callTool({
        name: "browser_run",
        arguments: { goal: "download", url: "https://example.test" },
      }),
    );
    assert.equal((result.downloads as Array<{ id: string }>)[0]?.id, "initial-guid");
  } finally {
    await client.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("download dir option is validated at startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevpilot-profile-"));
  const profileFile = join(root, "profile.json");
  try {
    await assert.rejects(
      loadMcpProfile({ JEVPILOT_DOWNLOAD_DIR: "relative" }, "win32"),
      /absolute path/u,
    );
    await assert.rejects(
      loadMcpProfile({ JEVPILOT_DOWNLOAD_DIR: join(root, "missing") }, "win32"),
      /existing directory/u,
    );
    await writeFile(
      profileFile,
      JSON.stringify({
        kind: "desktop-chrome",
        display: "headless",
        userDataDir: join(root, "user"),
        windowSize: { width: 800, height: 600 },
        downloadPath: root,
      }),
    );
    await assert.rejects(
      loadMcpProfile({ JEVPILOT_PROFILE_FILE: profileFile, JEVPILOT_DOWNLOAD_DIR: root }, "win32"),
      /conflicts/u,
    );
    await writeFile(
      profileFile,
      JSON.stringify({ kind: "attach", cdpUrl: "http://127.0.0.1:9222", downloadPath: root }),
    );
    await assert.rejects(
      loadMcpProfile({ JEVPILOT_PROFILE_FILE: profileFile, JEVPILOT_DOWNLOAD_DIR: root }, "win32"),
      /attach/u,
    );
    const loaded = await loadMcpProfile({ JEVPILOT_DOWNLOAD_DIR: root }, "win32");
    assert.equal(loaded.profile.downloadPath, root);
    await loaded.cleanup();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
