import { z } from "zod";
import type { BrowserHandle, PageEvents, PageHandle } from "../../engine/types.ts";
import { McpUserError } from "../errors.ts";
import type { ToolHost } from "../host.ts";
import { OrchestratorSession } from "../../orchestrator/session.ts";
import { sessionResultSchema } from "../../orchestrator/result.ts";
import { abortableNavigation, requireHttpUrl, runInput } from "../schemas.ts";
import type { ToolModule } from "./index.ts";

const sessionResultShape = sessionResultSchema.shape;

// Build: input conversion, domain allowlist checks, requestBlocked listener, first navigation,
// new OrchestratorSession(...) — moved verbatim from the former browser_run closure in server.ts.
const buildSession = async (
  host: ToolHost,
  input: z.output<z.ZodObject<typeof runInput>>,
  signal: AbortSignal,
  page: PageHandle,
  active: BrowserHandle,
  deadlineAt?: number,
): Promise<OrchestratorSession> => {
  let initialBlockedRequest: PageEvents["requestBlocked"] | undefined;
  const initialDownloads: PageEvents["download"][] = [];
  const initialDownloadHandler = (event: PageEvents["download"]): void => {
    initialDownloads.push(event);
  };
  page.on("download", initialDownloadHandler);
  page.on("requestBlocked", (event) => {
    if (event.frame === "main") initialBlockedRequest = event;
  });
  const configuredDomains = host.deps.allowedDomains;
  const requestedDomains = input.constraints?.allowed_domains;
  if (
    configuredDomains?.length &&
    requestedDomains?.some(
      (domain) =>
        !configuredDomains.some(
          (allowed) =>
            domain.toLowerCase() === allowed.toLowerCase() ||
            domain.toLowerCase().endsWith(`.${allowed.toLowerCase()}`),
        ),
    )
  )
    throw new McpUserError("Requested domain is outside the server allowlist.");
  const allowedDomains = configuredDomains?.length
    ? requestedDomains?.length
      ? requestedDomains.filter((domain) =>
          configuredDomains.some(
            (allowed) =>
              domain.toLowerCase() === allowed.toLowerCase() ||
              domain.toLowerCase().endsWith(`.${allowed.toLowerCase()}`),
          ),
        )
      : configuredDomains
    : requestedDomains;
  if (configuredDomains?.length && requestedDomains?.length && !allowedDomains?.length)
    throw new McpUserError("Requested domains are outside the server allowlist.");
  if (input.url && allowedDomains?.length) {
    const hostname = new URL(input.url).hostname.toLowerCase();
    if (
      !allowedDomains.some(
        (domain) =>
          hostname === domain.toLowerCase() || hostname.endsWith(`.${domain.toLowerCase()}`),
      )
    )
      throw new McpUserError("Initial URL is outside allowed domains.");
  }
  const navigationTimeoutMs =
    input.navigation_timeout_ms ?? host.deps.navigationTimeoutMs ?? 30_000;
  const navigationWaitMs = (): number =>
    deadlineAt === undefined
      ? navigationTimeoutMs
      : Math.max(
          1,
          Math.min(navigationTimeoutMs, deadlineAt - (host.deps.clock?.() ?? Date.now())),
        );
  const navigationStarted = performance.now();
  const navigation = input.url
    ? await abortableNavigation(
        page.navigate(input.url, { timeoutMs: navigationWaitMs() }),
        signal,
        active,
      ).catch((error: unknown) => ({
        url: input.url!,
        headers: {},
        failure:
          deadlineAt !== undefined && (host.deps.clock?.() ?? Date.now()) >= deadlineAt
            ? "call_deadline_exceeded"
            : error instanceof Error && error.name === "CdpTimeoutError"
              ? "timeout"
              : error instanceof Error && error.name === "CdpDisconnectedError"
                ? "disconnected"
                : error instanceof Error && error.name === "CdpProtocolError"
                  ? "protocol"
                  : "navigation_error",
      }))
    : undefined;
  if (
    navigation &&
    navigation.failure === "timeout" &&
    deadlineAt !== undefined &&
    (host.deps.clock?.() ?? Date.now()) >= deadlineAt
  )
    navigation.failure = "call_deadline_exceeded";
  const navigationMs = navigation ? performance.now() - navigationStarted : undefined;
  const session = new OrchestratorSession(
    {
      page,
      initialDownloads,
      ...(active.downloadPath ? { downloadPath: active.downloadPath } : {}),
      automaticIsolatedFallback: !host.deps.isolatedSessions,
      ...(active.capabilities.isolatedContexts
        ? {
            openIsolatedPage: (copyCookies: boolean) =>
              active.newPage({
                isolated: { copyCookies: host.deps.isolatedSessions ? false : copyCookies },
              }),
          }
        : {}),
      goal: input.goal,
      ...(host.deps.decisionProvider ? { decisionProvider: host.deps.decisionProvider } : {}),
      ...(host.deps.decisionContextLimit !== undefined
        ? { decisionContextLimit: host.deps.decisionContextLimit }
        : {}),
      ...(host.deps.usageDetail ? { usageDetail: true } : {}),
      ...host.deps.sessionOptions,
      navigationTimeoutMs,
      ...(navigationMs !== undefined ? { navigationMs } : {}),
      ...(host.deps.actionabilityTimeoutMs
        ? { actionabilityTimeoutMs: host.deps.actionabilityTimeoutMs }
        : {}),
      ...(host.deps.decisionLogPath ? { decisionLogPath: host.deps.decisionLogPath } : {}),
      thresholds: Object.fromEntries(
        Object.entries({ ...host.deps.thresholds, ...input.thresholds }).filter(
          ([, value]) => value !== undefined,
        ),
      ),
      ...(navigation ? { navigation } : {}),
      ...(initialBlockedRequest ? { initialBlockedRequest } : {}),
      ...(input.values ? { values: input.values } : {}),
      ...(input.success
        ? {
            success: {
              ...(input.success.url_matches !== undefined
                ? { url_matches: input.success.url_matches }
                : {}),
              ...(input.success.text_present !== undefined
                ? { text_present: input.success.text_present }
                : {}),
              ...(input.success.element_present
                ? { element_present: input.success.element_present }
                : {}),
              ...(input.success.download_completed ? { download_completed: true as const } : {}),
            },
          }
        : {}),
      ...(input.budget
        ? {
            budget: {
              ...(input.budget.steps !== undefined ? { steps: input.budget.steps } : {}),
              ...(input.budget.seconds !== undefined ? { seconds: input.budget.seconds } : {}),
              ...(input.budget.decision_tokens !== undefined
                ? { decision_tokens: input.budget.decision_tokens }
                : {}),
            },
          }
        : {}),
      constraints: {
        ...(input.constraints?.allow_irreversible !== undefined
          ? { allow_irreversible: input.constraints.allow_irreversible }
          : {}),
        ...(allowedDomains ? { allowed_domains: allowedDomains } : {}),
      },
    },
    {
      ...host.deps.orchestrator,
      ...(host.deps.clock ? { now: host.deps.clock } : {}),
      ...(host.deps.decisionPort
        ? { decide: (request, options) => host.deps.decisionPort!.decide(request, options) }
        : {}),
    },
  );
  page.off("download", initialDownloadHandler);
  return session;
};

const tool: ToolModule = {
  name: "browser_run",
  apply(host: ToolHost): void {
    host.registerTool(
      "browser_run",
      {
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        description:
          "Open a new browser session and work toward a goal. Jev acts fast on its own and hands back early with a question when unsure; continue with browser_act / browser_resume from the returned snapshot. Returns a session ID and a status; handoff statuses include a concrete question for the agent or user. Reuse the session with browser_resume, browser_observe, browser_act, and browser_close.",
        inputSchema: runInput,
        outputSchema: sessionResultShape,
      },
      (input, extra) =>
        !host.hasDecisionPort()
          ? Promise.resolve(host.result(host.noDecisionPortResult()))
          : host.handle("browser_run", async () => {
              const startedAt = host.deps.clock?.() ?? Date.now();
              const deadlineAt =
                host.deps.callDeadlineMs && host.deps.callDeadlineMs > 0
                  ? startedAt + host.deps.callDeadlineMs
                  : undefined;
              if (input.url) requireHttpUrl(input.url);
              const outcome = await host.runNewSession({
                ...(input.profile !== undefined ? { profile: input.profile } : {}),
                signal: extra.signal,
                ...(deadlineAt !== undefined ? { deadlineAt } : {}),
                build: (page, active) =>
                  buildSession(host, input, extra.signal, page, active, deadlineAt),
              });
              if (outcome === "full")
                return {
                  status: "FAILED" as const,
                  reason: "too_many_sessions",
                  question: `The server allows at most ${host.deps.maxSessions ?? 8} sessions. Use browser_close to free a session.`,
                  session: "",
                  url: "",
                  title: "",
                  snapshot: "",
                  trace: [],
                  timing: { total: 0, decide: 0, browser: 0, harness: 0 },
                  usage: { decision_tokens: 0 },
                };
              return outcome;
            }),
    );
  },
};

export default tool;
