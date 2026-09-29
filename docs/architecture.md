# Architecture

This guide describes the source checkout. The published package contains the compiled MCP server, not a library API for importing internal modules.

## Layers

The source is organized around ownership boundaries:

| Layer                 | Owns                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| mcp                   | Tool schemas and registration, stdio/HTTP server setup, configuration parsing, session limits, browser profile selection and operator-facing errors.         |
| orchestrator          | Session lifecycle, run/resume/observe/act behavior, budgets, handoffs, safe result construction and optional calibration logging.                            |
| detectors             | Deterministic page signals such as challenges, login walls, downloads and error pages. They do not make model decisions.                                     |
| policy                | Decision state and question construction, answer interpretation, confidence gates, safe handoffs and candidate checks.                                       |
| decision port         | Jev request adaptation, timeouts, retries, response parsing, answer validation, usage and circuit breaking.                                                  |
| executor              | Revalidation and execution of selected actions through the engine interface.                                                                                 |
| observer              | Isolated page snapshot collection, element identity, compact/full observation formatting and navigation settling.                                            |
| engine and CDP driver | Browser profile resolution and engine SPI. The CDP driver owns Chrome DevTools Protocol, browser processes, page handles and protocol-specific capabilities. |

The dependency direction is enforced by test/engine/architecture.test.ts, test/orchestrator/architecture.test.ts and test/mcp/architecture.test.ts. Non-driver source modules cannot import CDP implementation or protocol types. Executors depend on engine interfaces and observer modules. Detectors and policy have restricted imports.

## One run, end to end

1. The MCP layer validates browser_run input. If no decision port exists, it returns FAILED with decision_port_not_configured before launching a browser.
2. The engine registry resolves a profile and launches or attaches to the browser. The CDP driver reports capabilities and its self-check result.
3. The orchestrator navigates to the optional initial URL, samples the page through the observer, checks deterministic blockers and evaluates completion conditions.
4. The orchestrator builds policy context from the goal, current observation, recent trace, supplied value-key names and available constraints.
5. Policy creates bounded state and typed questions. The decision port sends them to Jev and validates the response.
6. Policy interprets the answer and applies confidence, target, irreversible-action and page-state gates.
7. The executor revalidates the target against current page identity, performs one or more actions, and returns action results. The orchestrator observes again before the next decision.
8. MCP returns a structured session result with status, question, URL, title, snapshot, trace, timing and usage.

## Hand-back and resume

The orchestrator returns a handoff when it cannot safely continue, including uncertainty, missing values, login, a challenge, domain confirmation or an irreversible action needing approval. The result includes the session ID and a concrete question or next action.

browser_resume continues that session. It can add values, update the goal, extend a domain allowlist within the server policy, answer a dialog or approve a pending action. Approval is scoped to the pending action. A decision service failure can be handed back as UNCERTAIN; resuming asks Jev again. A challenge is reported and left for the agent or user; jevpilot does not solve it.

## Engine profiles and SPI

The default composition root is src/engine/default.ts. It registers the CDP driver from src/engine/cdp/driver.ts. Public engine contracts are in src/engine/types.ts and the registry is in src/engine/registry.ts. Browser-facing CDP support is in src/browser.

The engine SPI defines EngineDriver, BrowserHandle, PageHandle, capabilities, events and launch options. Upper layers use PageHandle instead of CDP commands. A driver reports capabilities honestly and performs a launch self-check.

The examples below work from a source checkout only. Internal source modules are not exported as a package library:

```ts
import { createDefaultEngine } from "./src/engine/default.ts";
import { observe } from "./src/observer/observe.ts";

const engines = createDefaultEngine({
  kind: "desktop-chrome",
  userDataDir: "./chrome-profile",
  windowSize: { width: 1280, height: 900 },
});
const browser = await engines.resolve().launch();
const page = await browser.newPage();
try {
  await page.navigate("https://example.com");
  const observation = await observe(page);
} finally {
  await page.close();
  await browser.close();
}
```

Engine profile types are defined in src/browser/profiles.ts. Supported profiles are desktop-chrome, server-plain and attach. Browsers run headless by default; desktop-chrome can run headed (off-screen on Windows) and server-plain can run under Xvfb, which the Docker runtime image does. A headless launch probes the browser once and passes `--user-agent` so that its user agent and client hints match headed Chrome; `--screen-info` makes the screen at least as large as the window. The current package registers only the CDP driver.

To add a driver, implement EngineDriver and register it with EngineRegistry. The driver must:

- Run a launch self-check and report stealth honestly.
- Declare optional capabilities honestly so callers can degrade when a feature is missing.
- Keep protocol details inside the driver. The architecture test rejects imports of protocol types outside the composition root and driver.
- Report isolated execution and trusted input as unavailable unless the implementation provides them.
- Add integration coverage for browser and observer behavior.

## Tests

- Decision adapter and port tests: test/decision.
- Browser, CDP client, observer and executor tests: test/browser, test/engine, test/observer and test/executor.
- Detector, policy, orchestrator and MCP tests: test/detectors, test/policy, test/orchestrator and test/mcp.
- Real-browser integration tests: integration subdirectories beside those unit tests.
- Architecture boundaries: test/engine/architecture.test.ts, test/orchestrator/architecture.test.ts and test/mcp/architecture.test.ts.

Run the full unit suite before proposing a change that touches shared contracts.
