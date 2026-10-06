import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
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
import { BrowserConfigError } from "../engine/default.ts";
import { EngineRegistryError } from "../engine/registry.ts";
import type { BrowserHandle, LaunchOptions, PageHandle } from "../engine/types.ts";
import { McpUserError } from "./errors.ts";
import {
  OrchestratorSession,
  SessionCancelledError,
  type SessionDeps,
  type SessionOptions,
} from "../orchestrator/session.ts";
import type { SessionResult } from "../orchestrator/result.ts";
import type { PolicyThresholds } from "./thresholds.ts";
import type { EngineRegistry } from "../engine/registry.ts";

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
  imageResponses?: "allow" | "omit";
  screenshotDir?: string;
  disabledTools?: string[];
  callDeadlineMs?: number;
};

export class BrowserDisconnectedError extends Error {
  readonly session: string;
  constructor(session: string) {
    super("browser disconnected");
    this.name = "BrowserDisconnectedError";
    this.session = session;
  }
}

export type ToolConfig<S extends z.ZodRawShape> = {
  description: string;
  inputSchema: S;
  annotations: ToolAnnotations;
  /** When absent: dispatch does not validate results and results carry no structuredContent. */
  outputSchema?: z.ZodRawShape;
};
export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};
export type ToolHandler<S extends z.ZodRawShape> = (
  input: z.output<z.ZodObject<S>>,
  extra: { signal: AbortSignal },
) => Promise<CallToolResult>;

export class ToolHost {
  readonly deps: Readonly<McpDeps>;
  private readonly registrations: Array<(server: McpServer) => void> = [];
  private readonly dispatch = new Map<
    string,
    {
      schema: z.ZodTypeAny;
      output?: z.ZodTypeAny;
      handler: (args: never, extra: { signal: AbortSignal }) => Promise<CallToolResult>;
    }
  >();
  private readonly sessions = new Map<string, OrchestratorSession>();
  private readonly screenshotDirs = new Map<string, string>();
  private readonly creatingScreenshotDirs = new Map<string, Promise<string>>();
  private readonly busySessions = new Map<string, number>();
  private readonly sessionChains = new Map<string, Promise<unknown>>();
  private readonly disconnectedSessions = new Set<string>();
  // Closing aborts in-flight work (the session reports session_closed); screenshot writers re-check
  // this set after every await so nothing is created for a session once its close has started.
  private readonly closingSessions = new Set<string>();
  private reclaiming: Promise<void> | undefined;
  // Runs that passed the session limit and are still opening their tab count against it: without them,
  // concurrent browser_run calls would each see room and together exceed the limit.
  private openingSessions = 0;
  private browser: BrowserHandle | undefined;
  private launching: Promise<BrowserHandle> | undefined;
  private selectedEngine: string | undefined;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private readonly idleTimer: ReturnType<typeof setInterval>;
  private server: McpServer | undefined;

  constructor(deps: McpDeps) {
    this.deps = { ...deps, clock: deps.clock ?? deps.orchestrator?.now ?? Date.now };
    this.idleTimer = setInterval(() => {
      if (!this.closing) void this.sweepIdle();
    }, deps.idleReclaimIntervalMs ?? 60_000);
    this.idleTimer.unref();
  }

  registerTool<S extends z.ZodRawShape>(
    name: string,
    config: ToolConfig<S>,
    callback: ToolHandler<S>,
  ): void {
    const output = config.outputSchema ? z.object(config.outputSchema) : undefined;
    this.registrations.push((server) =>
      server.registerTool(
        name,
        output ? { ...config, outputSchema: config.outputSchema! } : { ...config },
        callback as never,
      ),
    );
    this.dispatch.set(name, {
      schema: z.object(config.inputSchema),
      ...(output ? { output } : {}),
      handler: callback as (args: never, extra: { signal: AbortSignal }) => Promise<CallToolResult>,
    });
  }

  result(value: object): CallToolResult {
    return {
      structuredContent: value as Record<string, unknown>,
      content: [{ type: "text" as const, text: JSON.stringify(value) }],
    };
  }

  failure(message: string): CallToolResult {
    return {
      isError: true,
      content: [{ type: "text" as const, text: message }],
    };
  }

  private readonly errorClass = (error: unknown): string => {
    const name = error instanceof Error ? error.constructor.name : typeof error;
    return /^[A-Za-z][A-Za-z0-9]*$/u.test(name) ? name : "Error";
  };
  private readonly sanitizedErrorMessage = (error: unknown): string => {
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
  private readonly sourceFrame = (error: unknown): string => {
    const stack = error instanceof Error ? error.stack : undefined;
    const frame = stack?.split(/\r?\n/u).find((line) => /(?:^|[\\/])src[\\/][^\s)]+/u.test(line));
    const match = frame?.match(/((?:[A-Za-z]:)?[^\s()]*src[\\/][^\s():]*):(\d+)(?::\d+)?/u);
    return match?.[1] && match[2] ? `${match[1].replaceAll("\\", "/")}:${match[2]}` : "src/?";
  };

  async handle(toolName: string, operation: () => Promise<object>): Promise<CallToolResult> {
    try {
      return this.result(await operation());
    } catch (error) {
      return this.mapError(toolName, error, true);
    }
  }

  async handleContent(
    toolName: string,
    operation: () => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    try {
      return await operation();
    } catch (error) {
      return this.mapError(toolName, error, false);
    }
  }

  private mapError(toolName: string, error: unknown, structured: boolean): CallToolResult {
    if (error instanceof McpUserError) return this.failure(error.message);
    if (error instanceof SessionCancelledError) return this.failure("Request cancelled.");
    if (error instanceof BrowserDisconnectedError)
      return structured
        ? this.result(disconnectedResult(error.session))
        : this.failure(disconnectedResult(error.session).question);
    if (error instanceof EngineRegistryError)
      return this.failure("Unknown browser profile. Use the configured default profile.");
    const name = this.errorClass(error);
    process.stderr.write(
      `jevpilot-mcp tool=${toolName} error=${name} message=${JSON.stringify(this.sanitizedErrorMessage(error))} frame=${this.sourceFrame(error)}\n`,
    );
    return this.failure(`Tool failed (${name}). Check server configuration or retry.`);
  }

  requireSession(id: string): OrchestratorSession {
    if (this.disconnectedSessions.has(id)) throw new BrowserDisconnectedError(id);
    const found = this.sessions.get(id);
    if (!found) throw new McpUserError("Unknown session. Start a new session with browser_run.");
    return found;
  }

  async inSession<T>(instance: OrchestratorSession, operation: () => Promise<T>): Promise<T> {
    if (this.closing || this.closingSessions.has(instance.id) || !this.sessions.has(instance.id))
      throw new McpUserError("Session is closing.");
    const prior = this.sessionChains.get(instance.id) ?? Promise.resolve();
    const run = prior.then(async () => {
      if (this.closing || this.closingSessions.has(instance.id) || !this.sessions.has(instance.id))
        throw new McpUserError("Session is closing.");
      this.busySessions.set(instance.id, (this.busySessions.get(instance.id) ?? 0) + 1);
      try {
        return await operation();
      } finally {
        const remaining = (this.busySessions.get(instance.id) ?? 1) - 1;
        if (remaining) this.busySessions.set(instance.id, remaining);
        else this.busySessions.delete(instance.id);
      }
    });
    const tail = run.catch(() => {});
    this.sessionChains.set(instance.id, tail);
    try {
      return await run;
    } finally {
      if (this.sessionChains.get(instance.id) === tail) this.sessionChains.delete(instance.id);
    }
  }

  sessionOpen(id: string): boolean {
    return !this.closing && !this.closingSessions.has(id) && this.sessions.has(id);
  }

  async sessionDir(id: string): Promise<string | undefined> {
    let directory = this.screenshotDirs.get(id);
    if (!directory) {
      let creating = this.creatingScreenshotDirs.get(id);
      if (!creating) {
        creating = this.deps.screenshotTempDir?.() ?? createOwnedTempDir("jevpilot-mcp-shot-");
        this.creatingScreenshotDirs.set(id, creating);
      }
      try {
        directory = await creating;
      } catch (error) {
        if (this.creatingScreenshotDirs.get(id) === creating)
          this.creatingScreenshotDirs.delete(id);
        throw error;
      }
      if (this.closing || this.closingSessions.has(id) || !this.sessions.has(id)) {
        this.creatingScreenshotDirs.delete(id);
        await rm(directory, { recursive: true, force: true });
        return undefined;
      }
      this.screenshotDirs.set(id, directory);
      this.creatingScreenshotDirs.delete(id);
    }
    return directory;
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  async runNewSession(options: {
    profile?: string;
    signal: AbortSignal;
    deadlineAt?: number;
    build: (page: PageHandle, browser: BrowserHandle) => Promise<OrchestratorSession>;
  }): Promise<SessionResult | "full"> {
    const { signal } = options;
    const full = (): boolean =>
      this.sessions.size + this.openingSessions >= (this.deps.maxSessions ?? 8);
    if (full()) await this.sweepIdle();
    if (full()) return "full";
    this.openingSessions++;
    let opening = true;
    const registered = (): void => {
      if (opening) this.openingSessions--;
      opening = false;
    };
    const launch = this.getBrowser(options.profile).catch((error: unknown) => {
      registered();
      throw error;
    });
    let launchTimer: ReturnType<typeof setTimeout> | undefined;
    const active = await (
      options.deadlineAt === undefined
        ? launch
        : Promise.race([
            launch,
            new Promise<BrowserHandle>((_resolve, reject) => {
              const remaining = Math.max(0, options.deadlineAt! - this.deps.clock!());
              launchTimer = setTimeout(
                () =>
                  reject(
                    new McpUserError("The browser is still starting; call browser_run again."),
                  ),
                remaining,
              );
              launchTimer.unref();
            }),
          ])
    )
      .finally(() => {
        if (launchTimer) clearTimeout(launchTimer);
      })
      .catch((error: unknown) => {
        registered();
        throw error;
      });
    if (this.deps.isolatedSessions && !active.capabilities.isolatedContexts) {
      registered();
      throw new McpUserError("Selected engine does not support isolated sessions.");
    }
    const page = await active
      .newPage(this.deps.isolatedSessions ? { isolated: { copyCookies: false } } : undefined)
      .catch((error: unknown) => {
        registered();
        throw error;
      });
    try {
      const instance = await options.build(page, active);
      const unusable = (): boolean =>
        signal.aborted || this.browser !== active || !active.connected;
      const discard = async (): Promise<never> => {
        registered();
        this.sessions.delete(instance.id);
        await instance.close().catch(() => {});
        if (this.browser !== active || !active.connected)
          throw new BrowserDisconnectedError(instance.id);
        throw new McpUserError("Request cancelled.");
      };
      if (unusable()) await discard();
      this.sessions.set(instance.id, instance);
      registered();
      try {
        return await this.inSession(instance, () =>
          instance.run({
            signal,
            ...(options.deadlineAt !== undefined ? { deadlineAt: options.deadlineAt } : {}),
          }),
        );
      } finally {
        if (unusable()) await discard();
      }
    } catch (error) {
      registered();
      if (![...this.sessions.values()].some((item) => item.page === page))
        await page.close().catch(() => {});
      throw error;
    }
  }

  async closeSession(id: string): Promise<void> {
    if (this.disconnectedSessions.delete(id)) return;
    const instance = this.sessions.get(id);
    if (!instance) throw new McpUserError("Unknown session. Start a new session with browser_run.");
    this.closingSessions.add(id);
    try {
      await instance.close();
    } finally {
      // A tab that cannot be closed (already gone, or the browser is unresponsive) must not leave the
      // session registered: it is unusable once closing began and would hold a place in the limit.
      this.sessions.delete(id);
      this.closingSessions.delete(id);
      this.disconnectedSessions.delete(id);
      const directory = this.screenshotDirs.get(id);
      this.screenshotDirs.delete(id);
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  private readonly markBrowserDisconnected = (handle: BrowserHandle): void => {
    if (this.browser !== handle) return;
    for (const [id, instance] of this.sessions) {
      this.disconnectedSessions.add(id);
      if (this.disconnectedSessions.size > 256)
        this.disconnectedSessions.delete(this.disconnectedSessions.values().next().value!);
      this.sessions.delete(id);
      // Closing the session removes its handoff screenshots; closing its tab fails, which is ignored.
      void instance.close().catch(() => {});
      const directory = this.screenshotDirs.get(id);
      this.screenshotDirs.delete(id);
      if (directory) void rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  };

  private async getBrowser(name?: string): Promise<BrowserHandle> {
    if (this.closing) throw new McpUserError("The MCP server is shutting down.");
    const selected = name ?? this.deps.engine ?? "default";
    if (this.selectedEngine && selected !== this.selectedEngine)
      throw new McpUserError(
        "Engine profile differs from the active browser. Close this server before switching profiles.",
      );
    // A lost browser is closed first (launcher cleanup: Xvfb, profile lock, managed downloads), then
    // relaunched; `browser` is cleared at once so concurrent callers share this one relaunch.
    if (this.browser && !this.browser.connected) {
      const old = this.browser;
      this.markBrowserDisconnected(old);
      this.browser = undefined;
      this.startLaunch(
        selected,
        old.close().catch(() => {}),
      );
    }
    return this.launching ?? this.startLaunch(selected);
  }

  private startLaunch(selected: string, before?: Promise<void>): Promise<BrowserHandle> {
    this.selectedEngine = selected;
    const attempt: Promise<BrowserHandle> = (async () => {
      await before;
      const handle = await this.deps.engines.resolve(selected).launch(this.deps.launchOptions);
      this.browser = handle;
      handle.onDisconnected(() => this.markBrowserDisconnected(handle));
      return handle;
    })().catch((error: unknown) => {
      this.selectedEngine = undefined;
      if (this.launching === attempt) this.launching = undefined;
      if (error instanceof BrowserConfigError)
        throw new McpUserError(
          error.message === "Chrome executable not found"
            ? "Chrome executable not found. Set JEVPILOT_BROWSER_PATH or JEVPILOT_PROFILE_FILE."
            : "Invalid browser profile configuration.",
        );
      throw error;
    });
    this.launching = attempt;
    return attempt;
  }

  private readonly noDecisionPort = (): SessionResult => ({
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
      ...(this.deps.usageDetail
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

  noDecisionPortResult(): SessionResult {
    return this.noDecisionPort();
  }

  hasDecisionPort(): boolean {
    return this.deps.decisionPort !== undefined;
  }

  private readonly sweepIdle = (): Promise<void> => {
    if (this.reclaiming) return this.reclaiming;
    this.reclaiming = (async () => {
      await Promise.allSettled(
        [...this.sessions].map(async ([id, instance]) => {
          if (this.busySessions.has(id)) return;
          if ((this.deps.clock ?? Date.now)() - instance.updatedAt < instance.idleTimeoutMs) return;
          this.closingSessions.add(id);
          let reclaimed = false;
          try {
            reclaimed = await instance.reclaimIdle();
          } catch (error) {
            // Closing has begun, so the session cannot be used again; drop it and report the failure.
            reclaimed = true;
            process.stderr.write(
              `jevpilot-mcp idle session close failed: ${this.errorClass(error)}\n`,
            );
          }
          if (!reclaimed || this.sessions.get(id) !== instance) {
            this.closingSessions.delete(id);
            return;
          }
          this.sessions.delete(id);
          this.closingSessions.delete(id);
          const directory = this.screenshotDirs.get(id);
          this.screenshotDirs.delete(id);
          if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
        }),
      );
    })().finally(() => {
      this.reclaiming = undefined;
    });
    return this.reclaiming;
  };

  createMcpServer(): McpServer {
    // The reported version must track package.json instead of a hardcoded constant that
    // drifts from the release version. Each call returns a new McpServer that replays every
    // registration; the tool-call handler shares this host's dispatch (sessions, browser state).
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
    for (const register of this.registrations) register(server);
    server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const tool = this.dispatch.get(request.params.name);
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
      if (
        tool.output &&
        !response.isError &&
        !tool.output.safeParse(response.structuredContent).success
      )
        return this.failure("Tool returned an invalid result.");
      return response;
    });
    return server;
  }

  get mcpServer(): McpServer {
    this.server ??= this.createMcpServer();
    return this.server;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      clearInterval(this.idleTimer);
      if (this.reclaiming) await this.reclaiming;
      await Promise.allSettled([...this.sessions.values()].map((item) => item.close()));
      this.sessions.clear();
      await Promise.allSettled(
        [...this.screenshotDirs.values()].map((directory) =>
          rm(directory, { recursive: true, force: true }),
        ),
      );
      this.screenshotDirs.clear();
      if (this.launching) await this.launching.catch(() => {});
      try {
        await this.browser?.close();
      } catch (error) {
        process.stderr.write(
          `jevpilot-mcp browser close failed: ${this.sanitizedErrorMessage(error)}\n`,
        );
      }
      await this.server?.close();
    })();
    return this.closePromise;
  }
}

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
