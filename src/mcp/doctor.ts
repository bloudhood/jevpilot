import { tmpdir } from "node:os";
import { createDecisionPort } from "../decision/port.ts";
import {
  loadDecisionConfig,
  redactDecisionConfig,
  type DecisionConfig,
} from "../decision/config.ts";
import type { DecisionPort } from "../decision/types.ts";
import type { BrowserHandle } from "../engine/types.ts";
import { createDefaultEngine, findChrome } from "../engine/default.ts";
import { createOwnedTempDir, removeTempDir } from "../util/owned-temp.ts";
import { loadMcpProfile, parseActionabilityTimeout, parseNavigationTimeout } from "./profile.ts";
import { parseHttpConfig } from "./http.ts";
import { parseMaxSessions, parseNetworkGuard } from "./network-guard.ts";
import { parseThresholds } from "./thresholds.ts";

export type DoctorStatus = "ok" | "warn" | "fail";
export type DoctorCheck = { name: string; status: DoctorStatus; detail: string };
export type DoctorResult = { ok: boolean; checks: DoctorCheck[] };

type DoctorOptions = {
  env?: NodeJS.ProcessEnv;
  json?: boolean;
  noBrowser?: boolean;
  out?: (line: string) => void;
  engineFactory?: (profile: Awaited<ReturnType<typeof loadMcpProfile>>["profile"]) => {
    resolve(): {
      launch(options?: {
        selfCheck?: boolean;
        allowDegraded?: boolean;
        timeoutMs?: number;
      }): Promise<BrowserHandle>;
    };
  };
  decisionConfigLoader?: (env: Record<string, string | undefined>) => DecisionConfig;
  decisionPortFactory?: (config: DecisionConfig) => DecisionPort;
  tempCreate?: (prefix: string) => Promise<string>;
  tempRemove?: (directory: string) => Promise<void>;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const category = (error: unknown): string => {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  if (
    name.includes("auth") ||
    name.includes("config") ||
    /401|403|api key|unauthorized/i.test(errorMessage(error))
  )
    return "auth";
  if (name.includes("timeout") || /timeout|timed out/i.test(errorMessage(error))) return "timeout";
  if (name.includes("transport") || /network|fetch|connect|dns|http/i.test(errorMessage(error)))
    return "network";
  return "other";
};

async function effectiveProfile(
  profile: Awaited<ReturnType<typeof loadMcpProfile>>["profile"],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  // A launched profile without an explicit executable uses the discovered Chrome.
  const executable =
    profile.kind === "attach"
      ? "attach"
      : (profile.executable ?? (await findChrome({ env })) ?? "not found");
  const display = "display" in profile ? profile.display : "n/a";
  return `kind=${profile.kind}, display=${display}, executable=${executable}`;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const env = options.env ?? process.env;
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const checks: DoctorCheck[] = [];
  const secrets = Object.entries(env)
    .filter(
      ([name, value]) =>
        value &&
        (name === "JEV_API_KEY" ||
          name === "JEVPILOT_HTTP_TOKEN" ||
          name.startsWith("JEVPILOT_SECRET_") ||
          [
            "TYPESAFE_API_KEY",
            "OPENROUTER_API_KEY",
            "JEV_CLOUDFLARE_API_TOKEN",
            "CLOUDFLARE_API_TOKEN",
          ].includes(name)),
    )
    .map(([, value]) => value!)
    .sort((a, b) => b.length - a.length);
  const safe = (detail: string) =>
    secrets
      .reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), detail)
      .replace(/[\r\n]+/gu, " ");
  const add = (name: string, status: DoctorStatus, detail: string) =>
    checks.push({ name, status, detail: safe(detail) });
  add(
    "node",
    Number(process.versions.node.split(".")[0]) >= 22 ? "ok" : "fail",
    `Node ${process.versions.node} (requires >=22)`,
  );

  let loaded: Awaited<ReturnType<typeof loadMcpProfile>> | undefined;
  let parsedDecision: DecisionConfig | undefined;
  try {
    const transport = parseHttpConfig(env);
    const navigation = parseNavigationTimeout(env.JEVPILOT_NAVIGATION_TIMEOUT_MS);
    const actionability = parseActionabilityTimeout(env.JEVPILOT_ACTIONABILITY_TIMEOUT_MS);
    const thresholds = parseThresholds(env.JEVPILOT_THRESHOLDS);
    const network = parseNetworkGuard(env.JEVPILOT_NETWORK_GUARD, env.JEVPILOT_BLOCKED_ADDRESSES);
    const maxSessions = parseMaxSessions(env.JEVPILOT_MAX_SESSIONS);
    loaded = await loadMcpProfile(env);
    if (env.JEV_PROVIDER)
      parsedDecision = (options.decisionConfigLoader ?? loadDecisionConfig)(env);
    const http = transport.http;
    add(
      "config",
      "ok",
      `${await effectiveProfile(loaded.profile, env)}; timeouts=${navigation ?? "default"}/${actionability ?? "default"}; thresholds=${thresholds ? "set" : "default"}; network=${network.mode}${network.extraBlocked.length ? ` +${network.extraBlocked.length} ranges` : ""}; max-sessions=${maxSessions}; transport=${transport.transport}${http ? `, HTTP ${http.host}:${http.port}` : ""}`,
    );
  } catch (error) {
    add("config", "fail", errorMessage(error));
  }

  if (options.noBrowser) add("browser", "warn", "skipped (--no-browser)");
  else if (!loaded) add("browser", "fail", "configuration unavailable");
  else {
    let browser: BrowserHandle | undefined;
    try {
      const engine = (options.engineFactory ?? ((profile) => createDefaultEngine(profile)))(
        loaded.profile,
      );
      browser = await engine
        .resolve()
        .launch({ selfCheck: true, allowDegraded: true, timeoutMs: 30_000 });
      const report = browser.selfCheck;
      if (!report)
        add(
          "browser",
          "warn",
          `launched; stealth=${browser.engine.stealthLevel}; self-check unavailable`,
        );
      else {
        const failedRequired = report.checks
          .filter((check) => !check.ok && check.required !== false)
          .map((check) => check.name);
        const failedInfo = report.checks
          .filter((check) => !check.ok && !check.required)
          .map((check) => check.name);
        const status: DoctorStatus = failedRequired.length
          ? "fail"
          : failedInfo.length
            ? "warn"
            : "ok";
        const detail = `stealth=${report.stealth ?? browser.engine.stealthLevel};${failedRequired.length ? ` failed required: ${failedRequired.join(",")};` : ""}${failedInfo.length ? ` failed informational: ${failedInfo.join(",")}` : " self-check passed"}`;
        add("browser", status, detail);
      }
    } catch (error) {
      add("browser", "fail", errorMessage(error));
    } finally {
      await browser?.close().catch(() => {});
    }
  }

  if (!env.JEV_PROVIDER) add("decision", "warn", "browser_run needs JEV_PROVIDER");
  else if (!parsedDecision) add("decision", "fail", "decision configuration invalid");
  else {
    try {
      const port = (options.decisionPortFactory ?? createDecisionPort)(parsedDecision);
      const result = await port.decide({
        state: "doctor",
        questions: {
          ready: {
            type: "choice",
            instructions: "Choose ready",
            criteria: { yes: "ready", no: "not ready" },
          },
        },
      });
      add(
        "decision",
        "ok",
        `config valid (${String(redactDecisionConfig(parsedDecision).provider)}); latency=${result.latencyMs}ms; model=${result.model}`,
      );
    } catch (error) {
      add("decision", "fail", `decision ${category(error)} error`);
    }
  }

  const create = options.tempCreate ?? createOwnedTempDir;
  const remove = options.tempRemove ?? removeTempDir;
  try {
    const directory = await create("jevpilot-doctor-");
    await remove(directory);
    add("temp", "ok", `writable: ${tmpdir()}`);
  } catch (error) {
    add("temp", "fail", `temp directory is not writable: ${errorMessage(error)}`);
  }

  try {
    await loaded?.cleanup();
  } catch (error) {
    add("temp", "fail", `browser profile cleanup failed: ${errorMessage(error)}`);
  }

  const result = { ok: checks.every((check) => check.status !== "fail"), checks };
  if (options.json) out(JSON.stringify(result));
  else {
    for (const check of checks) out(`${check.status} ${check.name}: ${check.detail}`);
    out(
      `${result.ok ? "ok" : "fail"} summary: ${checks.filter((c) => c.status === "fail").length} failed, ${checks.filter((c) => c.status === "warn").length} warnings`,
    );
  }
  return result;
}
