import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createOwnedTempDir } from "../util/owned-temp.ts";
import {
  CallToolRequestSchema,
  ErrorCode,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { DecisionPort } from "../decision/types.ts";
import { requestSchema } from "../decision/types.ts";
import { BrowserConfigError } from "../engine/default.ts";
import { EngineRegistryError } from "../engine/registry.ts";
import type { EngineRegistry } from "../engine/registry.ts";
import type { BrowserHandle, LaunchOptions, PageEvents } from "../engine/types.ts";
import { McpUserError } from "./errors.ts";
import {
  OrchestratorSession,
  type ManualOp,
  type SessionDeps,
  type SessionOptions,
} from "../orchestrator/session.ts";
import { sessionResultSchema, type SessionResult } from "../orchestrator/result.ts";
import { thresholdSchema, type PolicyThresholds } from "./thresholds.ts";

const nonempty = z.string().trim().min(1);
const httpUrl = z.string().url();
const requireHttpUrl = (url: string): void => {
  if (!/^https?:$/u.test(new URL(url).protocol))
    throw new McpUserError("Only http: and https: URLs may be navigated.");
};
const abortableNavigation = async <T>(
  operation: Promise<T>,
  signal: AbortSignal,
  browser: BrowserHandle,
): Promise<T> => {
  let interrupt!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    interrupt = () => reject(new Error("navigation interrupted"));
  });
  const unsubscribe = browser.onDisconnected(interrupt);
  signal.addEventListener("abort", interrupt, { once: true });
  if (signal.aborted || !browser.connected) interrupt();
  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    unsubscribe();
    signal.removeEventListener("abort", interrupt);
  }
};
const values = z.record(
  z.union([
    z.string(),
    z.object({ secret_ref: nonempty, origins: z.array(z.string().url()).min(1) }),
  ]),
);
const session = { session: nonempty.describe("Session ID returned by browser_run.") };
const runInput = {
  goal: nonempty.describe("Task to complete in the browser."),
  url: httpUrl.optional().describe("Initial HTTP(S) URL. Omit to start on a blank tab."),
  navigation_timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(2_147_483_647)
    .optional()
    .describe("Navigation timeout in milliseconds; defaults to 30000."),
  values: values
    .optional()
    .describe(
      "Every piece of text the page needs typed (search terms, form fields) must be given here as { short field description: text }. Text inside the goal is never typed. Secrets use {secret_ref: 'env:NAME' or 'file:PATH', origins: [...] }.",
    ),
  success: z
    .object({
      url_matches: z.string().optional(),
      text_present: z.string().optional(),
      element_present: z.object({ role: nonempty, name: nonempty }).optional(),
    })
    .optional()
    .describe(
      "Optional checks that are false now and become true only when the goal is done, e.g. url_matches for the result page. Checks that already hold on the start page are ignored.",
    ),
  constraints: z
    .object({
      allowed_domains: z.array(nonempty).optional(),
      allow_irreversible: z.boolean().optional(),
    })
    .optional()
    .describe("Navigation allowlist and irreversible-action gate."),
  budget: z
    .object({
      steps: z.number().int().nonnegative().optional(),
      seconds: z.number().nonnegative().optional(),
      decision_tokens: z.number().int().nonnegative().optional(),
    })
    .optional()
    .describe("Per-invocation limits."),
  thresholds: thresholdSchema
    .optional()
    .describe("Per-session decision confidence thresholds (0 to 1)."),
  profile: nonempty
    .optional()
    .describe("Configured engine profile name; defaults to the server engine."),
};
const op = z.object({
  action: z.enum([
    "click",
    "type",
    "toggle",
    "select",
    "scroll",
    "back",
    "wait",
    "key",
    "dialog",
    "press_key",
    "hover",
    "drag",
    "upload",
    "wait_for",
  ]),
  ref: nonempty.optional().describe("Element ref from the latest observation for target actions."),
  value_key: nonempty.optional().describe("Key in session values for type or prompt actions."),
  text: z.string().optional(),
  submit: z.boolean().optional(),
  to_ref: nonempty.optional(),
  paths: z.array(nonempty).optional(),
  condition: z.enum(["appears", "disappears"]).optional(),
  timeout_ms: z.number().int().min(0).max(30_000).optional(),
  delay_ms: z.number().int().min(0).max(10_000).optional(),
  option_label: z.string().optional(),
  direction: z.enum(["up", "down"]).optional(),
  name: z
    .string()
    .optional()
    .describe("Key to press for key or press_key, e.g. Enter, Tab, Escape."),
  key: z.string().optional().describe("Alias of name for key or press_key."),
  accept: z.boolean().optional(),
});
const closeResultSchema = { session: z.string(), closed: z.literal(true) };
const decideResultSchema = {
  answers: z.record(z.unknown()),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
  model: z.string(),
  latency_ms: z.number(),
};

export type McpDeps = {
  engines: EngineRegistry;
  engine?: string;
  decisionPort?: DecisionPort;
  decisionProvider?: SessionOptions["decisionProvider"];
  decisionContextLimit?: number;
  orchestrator?: Partial<SessionDeps>;
  clock?: () => number;
  launchOptions?: LaunchOptions;
  maxSessions?: number;
  allowedDomains?: string[];
  navigationTimeoutMs?: number;
  actionabilityTimeoutMs?: number;
  thresholds?: PolicyThresholds;
  decisionLogPath?: string;
  isolatedSessions?: boolean;
  usageDetail?: boolean;
  sessionOptions?: Pick<SessionOptions, "idleTimeoutMs" | "autoPassWindowMs">;
  idleReclaimIntervalMs?: number;
  screenshotTempDir?: () => Promise<string>;
};

class BrowserDisconnectedError extends Error {
  readonly session: string;
  constructor(session: string) {
    super("browser disconnected");
    this.name = "BrowserDisconnectedError";
    this.session = session;
  }
}

export function createServer(deps: McpDeps): {
  server: McpServer;
  createMcpServer: () => McpServer;
  close: () => Promise<void>;
} {
  const registrations: Array<(server: McpServer) => void> = [];
  const dispatch = new Map<
    string,
    {
      schema: z.ZodTypeAny;
      output: z.ZodTypeAny;
      handler: (args: never, extra: { signal: AbortSignal }) => Promise<CallToolResult>;
    }
  >();
  function registerTool<S extends z.ZodRawShape>(
    name: string,
    config: { description: string; inputSchema: S; outputSchema: z.ZodRawShape },
    callback: (
      input: z.output<z.ZodObject<S>>,
      extra: { signal: AbortSignal },
    ) => Promise<CallToolResult>,
  ): void {
    registrations.push((server) => server.registerTool(name, config, callback as never));
    dispatch.set(name, {
      schema: z.object(config.inputSchema),
      output: z.object(config.outputSchema),
      handler: callback as (args: never, extra: { signal: AbortSignal }) => Promise<CallToolResult>,
    });
  }
  const sessions = new Map<string, OrchestratorSession>();
  const screenshotDirs = new Map<string, string>();
  const creatingScreenshotDirs = new Map<string, Promise<string>>();
  const busySessions = new Map<string, number>();
  const sessionChains = new Map<string, Promise<unknown>>();
  const disconnectedSessions = new Set<string>();
  // Closing aborts in-flight work (the session reports session_closed); screenshot writers re-check
  // this set after every await so nothing is created for a session once its close has started.
  const closingSessions = new Set<string>();
  let reclaiming: Promise<void> | undefined;
  // Runs that passed the session limit and are still opening their tab count against it: without them,
  // concurrent browser_run calls would each see room and together exceed the limit.
  let openingSessions = 0;
  let browser: BrowserHandle | undefined;
  let launching: Promise<BrowserHandle> | undefined;
  let selectedEngine: string | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;

  const disconnectedResult = (session: string): SessionResult => ({
    status: "FAILED",
    reason: "browser_disconnected",
    question:
      "The browser disconnected. Start a new browser_run; browser_close can release this session.",
    details: ["The browser process or CDP connection closed."],
    session,
    url: "",
    title: "",
    snapshot: "",
    trace: [],
    timing: { total: 0, decide: 0, browser: 0, harness: 0 },
    usage: { decision_tokens: 0 },
  });

  const markBrowserDisconnected = (handle: BrowserHandle): void => {
    if (browser !== handle) return;
    for (const [id, instance] of sessions) {
      disconnectedSessions.add(id);
      if (disconnectedSessions.size > 256)
        disconnectedSessions.delete(disconnectedSessions.values().next().value!);
      sessions.delete(id);
      // Closing the session removes its handoff screenshots; closing its tab fails, which is ignored.
      void instance.close().catch(() => {});
      const directory = screenshotDirs.get(id);
      screenshotDirs.delete(id);
      if (directory) void rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  };

  async function getBrowser(name?: string): Promise<BrowserHandle> {
    if (closing) throw new McpUserError("The MCP server is shutting down.");
    const selected = name ?? deps.engine ?? "default";
    if (selectedEngine && selected !== selectedEngine)
      throw new McpUserError(
        "Engine profile differs from the active browser. Close this server before switching profiles.",
      );
    // A lost browser is closed first (launcher cleanup: Xvfb, profile lock, managed downloads), then
    // relaunched; `browser` is cleared at once so concurrent callers share this one relaunch.
    if (browser && !browser.connected) {
      const old = browser;
      markBrowserDisconnected(old);
      browser = undefined;
      startLaunch(
        selected,
        old.close().catch(() => {}),
      );
    }
    return launching ?? startLaunch(selected);
  }

  function startLaunch(selected: string, before?: Promise<void>): Promise<BrowserHandle> {
    selectedEngine = selected;
    const attempt: Promise<BrowserHandle> = (async () => {
      await before;
      const handle = await deps.engines.resolve(selected).launch(deps.launchOptions);
      browser = handle;
      handle.onDisconnected(() => markBrowserDisconnected(handle));
      return handle;
    })().catch((error: unknown) => {
      selectedEngine = undefined;
      if (launching === attempt) launching = undefined;
      if (error instanceof BrowserConfigError)
        throw new McpUserError(
          error.message === "Chrome executable not found"
            ? "Chrome executable not found. Set JEVPILOT_BROWSER_PATH or JEVPILOT_PROFILE_FILE."
            : "Invalid browser profile configuration.",
        );
      throw error;
    });
    launching = attempt;
    return attempt;
  }

  const result = (value: object) => ({
    structuredContent: value as Record<string, unknown>,
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  });
  const failure = (message: string) => ({
    isError: true,
    content: [{ type: "text" as const, text: message }],
  });
  const errorClass = (error: unknown): string => {
    const name = error instanceof Error ? error.constructor.name : typeof error;
    return /^[A-Za-z][A-Za-z0-9]*$/u.test(name) ? name : "Error";
  };
  const sanitizedErrorMessage = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    return message
      .replace(/\b(?:env|file):[^\s,;]+/giu, "[REDACTED]")
      .replace(/\bsecret_ref\s*[:=]\s*[^\s,;]+/giu, "secret_ref=[REDACTED]")
      .replace(
        /\b(api[_-]?key|secret|password|token|value|values)(\s*[:=]\s*)[^\s,;]+/giu,
        "$1$2[REDACTED]",
      )
      .replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/gu, "[REDACTED]")
      .slice(0, 300);
  };
  const sourceFrame = (error: unknown): string => {
    const stack = error instanceof Error ? error.stack : undefined;
    const frame = stack?.split(/\r?\n/u).find((line) => /(?:^|[\\/])src[\\/][^\s)]+/u.test(line));
    const match = frame?.match(/((?:[A-Za-z]:)?[^\s()]*src[\\/][^\s():]*):(\d+)(?::\d+)?/u);
    return match?.[1] && match[2] ? `${match[1].replaceAll("\\", "/")}:${match[2]}` : "src/?";
  };
  const handle = async (toolName: string, operation: () => Promise<object>) => {
    try {
      return result(await operation());
    } catch (error) {
      if (error instanceof McpUserError) return failure(error.message);
      if (error instanceof BrowserDisconnectedError)
        return result(disconnectedResult(error.session));
      if (error instanceof EngineRegistryError)
        return failure("Unknown browser profile. Use the configured default profile.");
      const name = errorClass(error);
      process.stderr.write(
        `jevpilot-mcp tool=${toolName} error=${name} message=${JSON.stringify(sanitizedErrorMessage(error))} frame=${sourceFrame(error)}\n`,
      );
      return failure(`Tool failed (${name}). Check server configuration or retry.`);
    }
  };
  const requireSession = (id: string): OrchestratorSession => {
    if (disconnectedSessions.has(id)) throw new BrowserDisconnectedError(id);
    const found = sessions.get(id);
    if (!found) throw new McpUserError("Unknown session. Start a new session with browser_run.");
    return found;
  };
  const inSession = async <T>(
    instance: OrchestratorSession,
    operation: () => Promise<T>,
  ): Promise<T> => {
    if (closing || closingSessions.has(instance.id) || !sessions.has(instance.id))
      throw new McpUserError("Session is closing.");
    const prior = sessionChains.get(instance.id) ?? Promise.resolve();
    const run = prior.then(async () => {
      if (closing || closingSessions.has(instance.id) || !sessions.has(instance.id))
        throw new McpUserError("Session is closing.");
      busySessions.set(instance.id, (busySessions.get(instance.id) ?? 0) + 1);
      try {
        return await operation();
      } finally {
        const remaining = (busySessions.get(instance.id) ?? 1) - 1;
        if (remaining) busySessions.set(instance.id, remaining);
        else busySessions.delete(instance.id);
      }
    });
    const tail = run.catch(() => {});
    sessionChains.set(instance.id, tail);
    try {
      return await run;
    } finally {
      if (sessionChains.get(instance.id) === tail) sessionChains.delete(instance.id);
    }
  };
  const noDecisionPort = (): SessionResult => ({
    status: "FAILED",
    reason: "decision_port_not_configured",
    question:
      "Set JEV_PROVIDER and JEV_API_KEY (or the selected provider's key variable) in the MCP server environment.",
    details: ["DecisionConfigError: decision port not configured"],
    session: "",
    url: "",
    title: "",
    snapshot: "",
    trace: [],
    timing: { total: 0, decide: 0, browser: 0, harness: 0 },
    usage: {
      decision_tokens: 0,
      ...(deps.usageDetail
        ? {
            detail: {
              call: {
                decisions: 0,
                input_tokens: 0,
                output_tokens: 0,
                decide_ms: 0,
                browser_ms: 0,
                harness_ms: 0,
                total_ms: 0,
              },
              session: {
                decisions: 0,
                input_tokens: 0,
                output_tokens: 0,
                decide_ms: 0,
                browser_ms: 0,
                harness_ms: 0,
                total_ms: 0,
              },
            },
          }
        : {}),
    },
  });

  const sweepIdle = (): Promise<void> => {
    if (reclaiming) return reclaiming;
    reclaiming = (async () => {
      await Promise.allSettled(
        [...sessions].map(async ([id, instance]) => {
          if (busySessions.has(id)) return;
          if ((deps.clock ?? Date.now)() - instance.updatedAt < instance.idleTimeoutMs) return;
          closingSessions.add(id);
          let reclaimed = false;
          try {
            reclaimed = await instance.reclaimIdle();
          } catch (error) {
            // Closing has begun, so the session cannot be used again; drop it and report the failure.
            reclaimed = true;
            process.stderr.write(`jevpilot-mcp idle session close failed: ${errorClass(error)}\n`);
          }
          if (!reclaimed || sessions.get(id) !== instance) {
            closingSessions.delete(id);
            return;
          }
          sessions.delete(id);
          closingSessions.delete(id);
          const directory = screenshotDirs.get(id);
          screenshotDirs.delete(id);
          if (directory) await rm(directory, { recursive: true, force: true });
        }),
      );
    })().finally(() => {
      reclaiming = undefined;
    });
    return reclaiming;
  };
  const idleTimer = setInterval(() => {
    if (!closing) void sweepIdle();
  }, deps.idleReclaimIntervalMs ?? 60_000);
  idleTimer.unref();

  registerTool(
    "browser_run",
    {
      description:
        "Open a new browser session and work toward a goal. Jev acts fast on its own and hands back early with a question when unsure; continue with browser_act / browser_resume from the returned snapshot. Returns a session ID and a status; handoff statuses include a concrete question for the agent or user. Reuse the session with browser_resume, browser_observe, browser_act, and browser_close.",
      inputSchema: runInput,
      outputSchema: sessionResultSchema.shape,
    },
    (input, extra) =>
      !deps.decisionPort
        ? Promise.resolve(result(noDecisionPort()))
        : handle("browser_run", async () => {
            if (input.url) requireHttpUrl(input.url);
            const full = (): boolean => sessions.size + openingSessions >= (deps.maxSessions ?? 8);
            if (full()) await sweepIdle();
            if (full())
              return {
                status: "FAILED" as const,
                reason: "too_many_sessions",
                question: `The server allows at most ${deps.maxSessions ?? 8} sessions. Use browser_close to free a session.`,
                session: "",
                url: "",
                title: "",
                snapshot: "",
                trace: [],
                timing: { total: 0, decide: 0, browser: 0, harness: 0 },
                usage: { decision_tokens: 0 },
              };
            openingSessions++;
            let opening = true;
            const registered = (): void => {
              if (opening) openingSessions--;
              opening = false;
            };
            const active = await getBrowser(input.profile).catch((error: unknown) => {
              registered();
              throw error;
            });
            if (deps.isolatedSessions && !active.capabilities.isolatedContexts) {
              registered();
              throw new McpUserError("Selected engine does not support isolated sessions.");
            }
            const page = await active
              .newPage(deps.isolatedSessions ? { isolated: { copyCookies: false } } : undefined)
              .catch((error: unknown) => {
                registered();
                throw error;
              });
            try {
              let initialBlockedRequest: PageEvents["requestBlocked"] | undefined;
              page.on("requestBlocked", (event) => {
                if (event.frame === "main") initialBlockedRequest = event;
              });
              const configuredDomains = deps.allowedDomains;
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
                      hostname === domain.toLowerCase() ||
                      hostname.endsWith(`.${domain.toLowerCase()}`),
                  )
                )
                  throw new McpUserError("Initial URL is outside allowed domains.");
              }
              const navigationTimeoutMs =
                input.navigation_timeout_ms ?? deps.navigationTimeoutMs ?? 30_000;
              const navigationStarted = performance.now();
              const navigation = input.url
                ? await abortableNavigation(
                    page.navigate(input.url, { timeoutMs: navigationTimeoutMs }),
                    extra.signal,
                    active,
                  ).catch((error: unknown) => ({
                    url: input.url!,
                    headers: {},
                    failure:
                      error instanceof Error && error.name === "CdpTimeoutError"
                        ? "timeout"
                        : error instanceof Error && error.name === "CdpDisconnectedError"
                          ? "disconnected"
                          : error instanceof Error && error.name === "CdpProtocolError"
                            ? "protocol"
                            : "navigation_error",
                  }))
                : undefined;
              const navigationMs = navigation ? performance.now() - navigationStarted : undefined;
              const instance = new OrchestratorSession(
                {
                  page,
                  automaticIsolatedFallback: !deps.isolatedSessions,
                  ...(active.capabilities.isolatedContexts
                    ? {
                        openIsolatedPage: (copyCookies: boolean) =>
                          active.newPage({
                            isolated: { copyCookies: deps.isolatedSessions ? false : copyCookies },
                          }),
                      }
                    : {}),
                  goal: input.goal,
                  ...(deps.decisionProvider ? { decisionProvider: deps.decisionProvider } : {}),
                  ...(deps.decisionContextLimit !== undefined
                    ? { decisionContextLimit: deps.decisionContextLimit }
                    : {}),
                  ...(deps.usageDetail ? { usageDetail: true } : {}),
                  ...deps.sessionOptions,
                  navigationTimeoutMs,
                  ...(navigationMs !== undefined ? { navigationMs } : {}),
                  ...(deps.actionabilityTimeoutMs
                    ? { actionabilityTimeoutMs: deps.actionabilityTimeoutMs }
                    : {}),
                  ...(deps.decisionLogPath ? { decisionLogPath: deps.decisionLogPath } : {}),
                  thresholds: Object.fromEntries(
                    Object.entries({ ...deps.thresholds, ...input.thresholds }).filter(
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
                        },
                      }
                    : {}),
                  ...(input.budget
                    ? {
                        budget: {
                          ...(input.budget.steps !== undefined
                            ? { steps: input.budget.steps }
                            : {}),
                          ...(input.budget.seconds !== undefined
                            ? { seconds: input.budget.seconds }
                            : {}),
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
                  ...deps.orchestrator,
                  ...(deps.clock ? { now: deps.clock } : {}),
                  ...(deps.decisionPort
                    ? { decide: (request, options) => deps.decisionPort!.decide(request, options) }
                    : {}),
                },
              );
              const unusable = (): boolean =>
                extra.signal.aborted || browser !== active || !active.connected;
              const discard = async (): Promise<never> => {
                registered();
                sessions.delete(instance.id);
                await instance.close().catch(() => {});
                if (browser !== active || !active.connected)
                  throw new BrowserDisconnectedError(instance.id);
                throw new McpUserError("Request cancelled.");
              };
              if (unusable()) await discard();
              sessions.set(instance.id, instance);
              registered();
              try {
                return await inSession(instance, () => instance.run());
              } finally {
                if (unusable()) await discard();
              }
            } catch (error) {
              registered();
              if (![...sessions.values()].some((item) => item.page === page))
                await page.close().catch(() => {});
              throw error;
            }
          }),
  );

  registerTool(
    "browser_resume",
    {
      description:
        "Continue an existing session after a handoff. Supply missing values, refine the goal, or approve one pending irreversible action; approval is scoped to that action.",
      inputSchema: {
        ...session,
        values: values.optional(),
        goal_update: nonempty.optional(),
        allow_irreversible: z.boolean().optional(),
        allowed_domains: z.array(nonempty).optional(),
        dialog: z.object({ accept: z.boolean(), value_key: nonempty.optional() }).optional(),
      },
      outputSchema: sessionResultSchema.shape,
    },
    (input) =>
      handle("browser_resume", () => {
        if (
          deps.allowedDomains?.length &&
          input.allowed_domains?.some(
            (domain) =>
              !deps.allowedDomains!.some(
                (allowed) =>
                  domain.toLowerCase() === allowed.toLowerCase() ||
                  domain.toLowerCase().endsWith(`.${allowed.toLowerCase()}`),
              ),
          )
        )
          throw new McpUserError("Requested domain is outside the server allowlist.");
        const instance = requireSession(input.session);
        return inSession(instance, () =>
          instance.resume({
            ...(input.values ? { values: input.values } : {}),
            ...(input.goal_update ? { goal_update: input.goal_update } : {}),
            ...(input.allow_irreversible !== undefined
              ? { allow_irreversible: input.allow_irreversible }
              : {}),
            ...(input.allowed_domains ? { allowed_domains: input.allowed_domains } : {}),
            ...(input.dialog
              ? {
                  dialog: {
                    accept: input.dialog.accept,
                    ...(input.dialog.value_key ? { value_key: input.dialog.value_key } : {}),
                  },
                }
              : {}),
          }),
        );
      }),
  );

  registerTool(
    "browser_observe",
    {
      description:
        "Read the current page in an existing session without taking action. Use full detail when the compact snapshot omits needed content. A screenshot path may be returned for handoffs when safe.",
      inputSchema: {
        ...session,
        detail: z.enum(["compact", "full"]).optional(),
        screenshot: z.boolean().optional(),
      },
      outputSchema: sessionResultSchema.shape,
    },
    (input) =>
      handle("browser_observe", async () => {
        const instance = requireSession(input.session);
        return inSession(instance, async () => {
          const observed = await instance.observe(input.detail);
          if (
            input.screenshot &&
            instance.page.capabilities.screenshots &&
            !Object.values(instance.values).some((value) => typeof value !== "string")
          ) {
            try {
              let directory = screenshotDirs.get(input.session);
              if (!directory) {
                let creating = creatingScreenshotDirs.get(input.session);
                if (!creating) {
                  creating = deps.screenshotTempDir?.() ?? createOwnedTempDir("jevpilot-mcp-shot-");
                  creatingScreenshotDirs.set(input.session, creating);
                }
                directory = await creating;
                if (closing || closingSessions.has(input.session) || !sessions.has(input.session)) {
                  creatingScreenshotDirs.delete(input.session);
                  await rm(directory, { recursive: true, force: true });
                  return observed;
                }
                screenshotDirs.set(input.session, directory);
                creatingScreenshotDirs.delete(input.session);
              }
              const path = join(directory, `observation-${randomUUID()}.png`);
              await writeFile(path, await instance.page.screenshot());
              if (!closing && !closingSessions.has(input.session) && sessions.has(input.session))
                observed.screenshot_path = path;
            } catch {
              creatingScreenshotDirs.delete(input.session);
              // Screenshots are optional; the observation remains useful.
            }
          }
          return observed;
        });
      }),
  );

  registerTool(
    "browser_act",
    {
      description:
        "Perform manual browser operations against current element refs in an existing session. Returns a fresh snapshot, so a separate browser_observe is not needed after it. The orchestrator rechecks targets and applies the same domain and irreversible-action gates.",
      inputSchema: {
        ...session,
        ops: z.array(op).min(1),
        allow_irreversible: z.boolean().optional(),
      },
      outputSchema: sessionResultSchema.shape,
    },
    (input) =>
      handle("browser_act", () => {
        const instance = requireSession(input.session);
        const operations: ManualOp[] = input.ops.map((item) => ({
          action: item.action as ManualOp["action"],
          ...(item.ref ? { ref: item.ref } : {}),
          ...(item.value_key ? { value_key: item.value_key } : {}),
          ...(item.text !== undefined ? { text: item.text } : {}),
          ...(item.submit !== undefined ? { submit: item.submit } : {}),
          ...(item.to_ref ? { to_ref: item.to_ref } : {}),
          ...(item.paths ? { paths: item.paths } : {}),
          ...(item.condition ? { condition: item.condition } : {}),
          ...(item.timeout_ms !== undefined ? { timeout_ms: item.timeout_ms } : {}),
          ...(item.delay_ms !== undefined ? { delay_ms: item.delay_ms } : {}),
          ...(item.option_label !== undefined ? { option_label: item.option_label } : {}),
          ...(item.direction ? { direction: item.direction } : {}),
          ...(item.name !== undefined ? { name: item.name } : {}),
          ...(item.key !== undefined ? { key: item.key } : {}),
          ...(item.accept !== undefined ? { accept: item.accept } : {}),
        }));
        return inSession(instance, () =>
          instance.act(operations, {
            ...(input.allow_irreversible !== undefined
              ? { allow_irreversible: input.allow_irreversible }
              : {}),
          }),
        );
      }),
  );

  registerTool(
    "browser_navigate",
    {
      description: "Navigate the selected session tab within its domain allowlist.",
      inputSchema: { ...session, url: httpUrl },
      outputSchema: sessionResultSchema.shape,
    },
    (input) =>
      handle("browser_navigate", () => {
        requireHttpUrl(input.url);
        const instance = requireSession(input.session);
        return inSession(instance, () => instance.navigate(input.url));
      }),
  );

  const tabsResult = z.object({
    session: z.string(),
    tabs: z
      .array(z.object({ tab_id: z.string(), url: z.string(), selected: z.boolean() }))
      .optional(),
    closed: z.boolean().optional(),
    status: z.string().optional(),
    reason: z.string().optional(),
  });
  registerTool(
    "browser_tabs",
    {
      description: "List, select, or close tabs owned by a browser session.",
      inputSchema: {
        ...session,
        action: z.enum(["list", "select", "close"]),
        tab_id: nonempty.optional(),
      },
      outputSchema: tabsResult.shape,
    },
    (input) =>
      handle("browser_tabs", async () => {
        const instance = requireSession(input.session);
        return inSession(instance, async () => {
          if (input.action === "list")
            return { session: input.session, tabs: await instance.listTabs() };
          if (!input.tab_id) throw new McpUserError("tab_id is required for select or close.");
          if (input.action === "select") {
            const result = await instance.selectTab(input.tab_id);
            return { session: input.session, status: result.status, reason: result.reason };
          }
          const result = await instance.closeTab(input.tab_id);
          return {
            session: input.session,
            closed: result.status === "RUNNING",
            status: result.status,
            reason: result.reason,
          };
        });
      }),
  );

  registerTool(
    "browser_close",
    {
      description:
        "Close a browser session and its tab, and delete its temporary handoff files. The shared browser remains available for other sessions.",
      inputSchema: session,
      outputSchema: closeResultSchema,
    },
    (input) =>
      handle("browser_close", async () => {
        if (disconnectedSessions.delete(input.session))
          return { session: input.session, closed: true as const };
        const instance = sessions.get(input.session);
        if (!instance)
          throw new McpUserError("Unknown session. Start a new session with browser_run.");
        closingSessions.add(input.session);
        try {
          await instance.close();
        } finally {
          // A tab that cannot be closed (already gone, or the browser is unresponsive) must not leave the
          // session registered: it is unusable once closing began and would hold a place in the limit.
          sessions.delete(input.session);
          closingSessions.delete(input.session);
          disconnectedSessions.delete(input.session);
          const directory = screenshotDirs.get(input.session);
          screenshotDirs.delete(input.session);
          if (directory) await rm(directory, { recursive: true, force: true });
        }
        return { session: input.session, closed: true as const };
      }),
  );

  if (deps.decisionPort)
    registerTool(
      "jev_decide",
      {
        description:
          "Pass a state and typed questions directly to the configured decision port. This does not create or change a browser session.",
        inputSchema: { state: requestSchema.shape.state, questions: requestSchema.shape.questions },
        outputSchema: decideResultSchema,
      },
      (input) =>
        handle("jev_decide", async () => {
          const decision = await deps.decisionPort!.decide(input);
          return {
            answers: decision.answers,
            usage: decision.usage,
            model: decision.model,
            latency_ms: decision.latencyMs,
          };
        }),
    );

  const createMcpServer = (): McpServer => {
    // The reported version must track package.json instead of a hardcoded constant that
    // drifts from the release version.
    let version = "0.0.0";
    try {
      version =
        (
          JSON.parse(
            readFileSync(
              join(fileURLToPath(new URL(".", import.meta.url)), "../../package.json"),
              "utf8",
            ),
          ) as { version?: string }
        ).version ?? version;
    } catch {
      // Keep the fallback version when package.json is not readable next to the build output.
    }
    const server = new McpServer({ name: "jevpilot", version });
    for (const register of registrations) register(server);
    server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const tool = dispatch.get(request.params.name);
      if (!tool) throw new McpError(ErrorCode.InvalidParams, "Unknown tool");
      const parsed = tool.schema.safeParse(request.params.arguments);
      if (!parsed.success) {
        const paths = [
          ...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "arguments")),
        ];
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid tool arguments: ${paths.slice(0, 10).join(", ")}`,
        );
      }
      const response = await tool.handler(parsed.data as never, extra);
      if (!response.isError && !tool.output.safeParse(response.structuredContent).success)
        return failure("Tool returned an invalid result.");
      return response;
    });
    return server;
  };
  const server = createMcpServer();

  return {
    server,
    createMcpServer,
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        clearInterval(idleTimer);
        if (reclaiming) await reclaiming;
        await Promise.allSettled([...sessions.values()].map((item) => item.close()));
        sessions.clear();
        await Promise.allSettled(
          [...screenshotDirs.values()].map((directory) =>
            rm(directory, { recursive: true, force: true }),
          ),
        );
        screenshotDirs.clear();
        if (launching) await launching.catch(() => {});
        try {
          await browser?.close();
        } catch (error) {
          process.stderr.write(
            `jevpilot-mcp browser close failed: ${sanitizedErrorMessage(error)}\n`,
          );
        }
        await server.close();
      })();
      return closePromise;
    },
  };
}
