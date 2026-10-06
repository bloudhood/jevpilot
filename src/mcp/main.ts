#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { tmpdir } from "node:os";
import { isProcessAlive, sweepStaleTempDirs } from "../util/owned-temp.ts";
import { createDecisionPort } from "../decision/port.ts";
import { loadDecisionConfig, redactDecisionConfig } from "../decision/config.ts";
import { createDefaultEngine } from "../engine/default.ts";
import { McpUserError, startupDiagnostic } from "./errors.ts";
import {
  loadMcpProfile,
  parseActionabilityTimeout,
  parseCallDeadline,
  parseNavigationTimeout,
  parseImageResponses,
  parseScreenshotDir,
  parseDisabledTools,
} from "./profile.ts";
import { installProcessSafety } from "./process-safety.ts";
import { parseThresholds } from "./thresholds.ts";
import { createServer, validateDisabledTools } from "./server.ts";
import { parseNetworkGuard, parseMaxSessions } from "./network-guard.ts";
import { parseHttpConfig, startHttpServer } from "./http.ts";
import { runDoctor } from "./doctor.ts";

async function main(): Promise<void> {
  if (process.argv[2] === "doctor") {
    const args = new Set(process.argv.slice(3));
    const result = await runDoctor({
      json: args.has("--json"),
      noBrowser: args.has("--no-browser"),
    });
    if (!result.ok) process.exitCode = 1;
    return;
  }
  void sweepStaleTempDirs(tmpdir(), isProcessAlive).then(
    (removed) => {
      if (removed) process.stderr.write(`jevpilot-mcp removed ${removed} stale temp dirs\n`);
    },
    () => {},
  );
  const env = process.env;
  const transportConfig = parseHttpConfig(env);
  if (env.JEVPILOT_ENGINE && env.JEVPILOT_ENGINE !== "cdp")
    throw new McpUserError(
      "Only the CDP driver is registered. Choose a browser profile with JEVPILOT_PROFILE_FILE.",
    );
  let decisionPort;
  let decisionProvider: ReturnType<typeof loadDecisionConfig>["provider"] | undefined;
  let decisionContextLimit: number | undefined;
  if (env.JEV_PROVIDER) {
    const config = loadDecisionConfig(env);
    decisionProvider = config.provider;
    decisionContextLimit = config.contextLimit;
    decisionPort = createDecisionPort(config);
    const redacted = redactDecisionConfig(config);
    process.stderr.write(`jevpilot-mcp decision provider: ${String(redacted.provider)}\n`);
  }
  // Validate every setting before loadMcpProfile creates the browser's temp directory, so a bad
  // value cannot leave that directory behind.
  const allowedDomains = env.JEVPILOT_ALLOWED_DOMAINS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const navigationTimeoutMs = parseNavigationTimeout(env.JEVPILOT_NAVIGATION_TIMEOUT_MS);
  const actionabilityTimeoutMs = parseActionabilityTimeout(env.JEVPILOT_ACTIONABILITY_TIMEOUT_MS);
  const callDeadlineMs = parseCallDeadline(env.JEVPILOT_CALL_DEADLINE_MS);
  const thresholds = parseThresholds(env.JEVPILOT_THRESHOLDS);
  const networkGuard = parseNetworkGuard(
    env.JEVPILOT_NETWORK_GUARD,
    env.JEVPILOT_BLOCKED_ADDRESSES,
  );
  const maxSessions = parseMaxSessions(env.JEVPILOT_MAX_SESSIONS);
  const imageResponses = parseImageResponses(env.JEVPILOT_IMAGE_RESPONSES);
  const screenshotDir = parseScreenshotDir(env.JEVPILOT_SCREENSHOT_DIR);
  const disabledTools = parseDisabledTools(env.JEVPILOT_DISABLED_TOOLS);
  validateDisabledTools(disabledTools);
  const loaded = await loadMcpProfile(env);
  let app: ReturnType<typeof createServer>;
  try {
    app = createServer({
      engines: createDefaultEngine(loaded.profile),
      launchOptions: { networkGuard },
      maxSessions,
      isolatedSessions: env.JEVPILOT_ISOLATED_SESSIONS === "1",
      usageDetail: env.JEVPILOT_USAGE_DETAIL === "1",
      ...(decisionPort ? { decisionPort } : {}),
      ...(decisionProvider ? { decisionProvider } : {}),
      ...(decisionContextLimit !== undefined ? { decisionContextLimit } : {}),
      ...(allowedDomains?.length ? { allowedDomains } : {}),
      ...(navigationTimeoutMs ? { navigationTimeoutMs } : {}),
      ...(actionabilityTimeoutMs ? { actionabilityTimeoutMs } : {}),
      callDeadlineMs,
      ...(thresholds ? { thresholds } : {}),
      ...(env.JEVPILOT_DECISION_LOG ? { decisionLogPath: env.JEVPILOT_DECISION_LOG } : {}),
      ...(imageResponses ? { imageResponses } : {}),
      ...(screenshotDir ? { screenshotDir } : {}),
      ...(disabledTools ? { disabledTools } : {}),
    });
  } catch (error) {
    await loaded.cleanup();
    throw error;
  }
  let stopping: Promise<void> | undefined;
  let httpClose: (() => Promise<void>) | undefined;
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      try {
        await httpClose?.();
        await app.close();
      } finally {
        await loaded.cleanup();
      }
    })());
  installProcessSafety(stop);
  if (transportConfig.transport === "stdio")
    process.stdin.once("end", () => {
      void stop().then(
        () => {
          process.exitCode ??= 0;
        },
        () => {
          process.exitCode = 1;
        },
      );
    });
  process.once("SIGINT", () => {
    void stop().then(
      () => {
        process.exitCode ??= 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  });
  process.once("SIGTERM", () => {
    void stop().then(
      () => {
        process.exitCode ??= 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  });
  try {
    if (transportConfig.transport === "http" && transportConfig.http) {
      const running = await startHttpServer(transportConfig.http, app.createMcpServer);
      httpClose = running.close;
      if (
        !/^127\./u.test(transportConfig.http.host) &&
        transportConfig.http.host !== "localhost" &&
        transportConfig.http.host !== "::1"
      )
        process.stderr.write(
          "jevpilot-mcp warning: HTTP endpoint is reachable from the network; use TLS via a reverse proxy.\n",
        );
    } else await app.server.connect(new StdioServerTransport());
  } catch (error) {
    await stop();
    throw error;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${startupDiagnostic(error)}\n`);
  process.exitCode = 1;
});
