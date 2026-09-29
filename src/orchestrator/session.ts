import { randomUUID } from "node:crypto";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { createOwnedTempDir } from "../util/owned-temp.ts";
import { createDecisionPort } from "../decision/port.ts";
import { appendCalibrationRecord, calibrationRequestRecord } from "./decision-log.ts";
import { redactSecret } from "./redact.ts";
import {
  CircuitOpenError,
  ContextLimitError,
  DecisionAbortedError,
  DecisionError,
  DecisionTimeoutError,
  DecisionTransportError,
  InvalidAnswerError,
} from "../decision/errors.ts";
import { loadDecisionConfig } from "../decision/config.ts";
import type { Provider } from "../decision/config.ts";
import { validateAnswers } from "../decision/validate.ts";
import type { DecisionRequest, DecisionResult } from "../decision/types.ts";
import {
  detect,
  orderFindings,
  detectorMarkerSelectors,
  irreversibleActionMatch,
  type DetectorInput,
  type Finding,
} from "../detectors/detect.ts";
import {
  NavigationInProgressError,
  PageUnresponsiveError,
  type NavigationResult,
  type PageEvents,
  type PageHandle,
} from "../engine/types.ts";
import { executeAction, expectedDateFormat, normalizeDateLike } from "../executor/execute.ts";
import type { Action, ActionResult, Target } from "../executor/types.ts";
import { formatObservation } from "../observer/format.ts";
import { pageMatches } from "../observer/matches.ts";
import { observe } from "../observer/observe.ts";
import type { Observation, ObserveOptions } from "../observer/types.ts";
import type { SessionResult, SessionStatus, SessionTrace } from "./result.ts";
import {
  blockingHandoff,
  buildDecisionState,
  checkQuestions,
  fillableField,
  interpret,
  resolveCheck,
  POLICY_DEFAULT_THRESHOLDS,
  type HandoffReason,
  type PolicyContext,
  type PolicyInput,
  type PolicyOutcome,
} from "../policy/index.ts";

export type SecretValue = { secret_ref: string; origins: string[] };
export type SessionValue = string | SecretValue;

function checkTypedFieldsInPage(
  fields: readonly {
    epoch: number;
    ref: string;
    fingerprint: string;
    expected: string;
    secret: boolean;
  }[],
): Array<"ok" | "changed" | "missing"> {
  const normalize = (value: string): string => value.replace(/\s+/gu, " ").trim();
  const registry = (
    globalThis as typeof globalThis & {
      __jevpilotObserverRegistry?: { epoch: number; refs: Map<string, WeakRef<Element>> };
    }
  ).__jevpilotObserverRegistry;
  if (!registry || !Array.isArray(fields)) return [];
  return fields.map((field) => {
    if (registry.epoch !== field.epoch) return "missing";
    const element = registry.refs.get(field.ref)?.deref();
    if (
      !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) ||
      !element.isConnected
    )
      return "missing";
    const value = element.value;
    return (
      field.secret ? value === field.expected : normalize(value) === normalize(field.expected)
    )
      ? "ok"
      : "changed";
  });
}
export type SuccessAssertions = {
  url_matches?: string;
  text_present?: string;
  element_present?: { role: string; name: string };
};
export type { SessionResult, SessionStatus, SessionTrace } from "./result.ts";
export type SessionOptions = {
  page: PageHandle;
  openIsolatedPage?: (copyCookies: boolean) => Promise<PageHandle>;
  automaticIsolatedFallback?: boolean;
  goal: string;
  acceptanceHints?: string[];
  values?: Record<string, SessionValue>;
  success?: SuccessAssertions;
  constraints?: { allowed_domains?: string[]; allow_irreversible?: boolean };
  budget?: { steps?: number; seconds?: number; decision_tokens?: number };
  decisionProvider?: Provider;
  decisionContextLimit?: number;
  thresholds?: PolicyContext["thresholds"];
  navigation?: NavigationResult;
  initialBlockedRequest?: PageEvents["requestBlocked"];
  /** Duration of `navigation` when the caller performed it before creating the session. */
  navigationMs?: number;
  navigationTimeoutMs?: number;
  actionabilityTimeoutMs?: number;
  usageDetail?: boolean;
  decisionLogPath?: string;
  idleTimeoutMs?: number;
  autoPassWindowMs?: number;
  id?: string;
};
export type ManualOp = {
  action: Action["kind"] | "dialog" | "hover" | "drag" | "upload" | "wait_for" | "press_key";
  ref?: string;
  to_ref?: string;
  text?: string;
  submit?: boolean;
  paths?: string[];
  condition?: "appears" | "disappears";
  timeout_ms?: number;
  delay_ms?: number;
  value_key?: string;
  option_label?: string;
  direction?: "up" | "down";
  name?: string;
  key?: string;
  accept?: boolean;
};
export type SessionDeps = {
  observe: typeof observe;
  detect: typeof detect;
  buildDecisionState: typeof buildDecisionState;
  interpret: typeof interpret;
  checkQuestions: typeof checkQuestions;
  resolveCheck: typeof resolveCheck;
  decide: (request: DecisionRequest, options?: { signal?: AbortSignal }) => Promise<DecisionResult>;
  executeAction: typeof executeAction;
  pageMatches: typeof pageMatches;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  tempDir: () => Promise<string>;
};

let defaultPort: ReturnType<typeof createDecisionPort> | undefined;
const defaults: SessionDeps = {
  observe,
  detect,
  buildDecisionState,
  interpret,
  checkQuestions,
  resolveCheck,
  decide: (request, options) => {
    defaultPort ??= createDecisionPort(loadDecisionConfig(process.env));
    return defaultPort.decide(request, options);
  },
  executeAction,
  pageMatches,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  tempDir: () => createOwnedTempDir("jevpilot-"),
};
const statusByReason: Record<HandoffReason, SessionStatus> = {
  blocked_by_challenge: "BLOCKED_BY_CHALLENGE",
  needs_login: "NEEDS_LOGIN",
  needs_values: "NEEDS_VALUES",
  confirm_required: "CONFIRM_REQUIRED",
  info_not_on_page: "INFO_NOT_ON_PAGE",
  uncertain: "UNCERTAIN",
  stuck: "STUCK",
  error_page: "ERROR_PAGE",
};
const isSecret = (value: SessionValue): value is SecretValue => typeof value !== "string";
const normalizedKey = (key: string): string => key.replace(/\s+/gu, "").toLowerCase();
const targetOf = (
  action: Action,
): { epoch: number; ref: string; fingerprint: string } | undefined =>
  "target" in action ? action.target : undefined;
const withTarget = (action: Action, target: Target): Action => {
  switch (action.kind) {
    case "click":
    case "toggle":
    case "type":
    case "submit":
    case "select":
    case "key":
      return { ...action, target };
    default:
      return action;
  }
};
// The key of a chord such as "Control+Enter", split the way the input layer splits it.
const keyOf = (name: string): string =>
  Array.from(name).length === 1 ? name : (name.split("+").pop() ?? "");
const entersForm = (name: string): boolean => keyOf(name) === "Enter";
// Enter and Space activate the focused button or link, as a click would.
const activatesFocus = (name: string): boolean =>
  entersForm(name) || keyOf(name) === "Space" || keyOf(name) === " ";
const samePage = (left: string, right: string): boolean => {
  const withoutHash = (url: string): string => {
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      return parsed.href;
    } catch {
      return url;
    }
  };
  return withoutHash(left) === withoutHash(right);
};
const domainOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

function focusObservedRef(epoch: number, ref: string): boolean {
  const registry = (
    globalThis as typeof globalThis & {
      __jevpilotObserverRegistry?: { epoch: number; refs: Map<string, WeakRef<Element>> };
    }
  ).__jevpilotObserverRegistry;
  if (registry?.epoch !== epoch) return false;
  const element = registry?.refs.get(ref)?.deref();
  if (!element?.isConnected || !("focus" in element)) return false;
  (element as HTMLElement).focus();
  const root = element.getRootNode() as Document | ShadowRoot;
  return root.activeElement === element;
}

function focusedObservedRef(epoch: number): string | undefined {
  const registry = (
    globalThis as typeof globalThis & {
      __jevpilotObserverRegistry?: { epoch: number; refs: Map<string, WeakRef<Element>> };
    }
  ).__jevpilotObserverRegistry;
  if (registry?.epoch !== epoch) return undefined;
  for (const [ref, weak] of registry.refs) {
    const element = weak.deref();
    if (element && (element.getRootNode() as Document | ShadowRoot).activeElement === element)
      return ref;
  }
  return undefined;
}

function failureDetails(error: unknown): string[] {
  if (error instanceof InvalidAnswerError)
    return [
      "InvalidAnswerError: invalid decision answers",
      ...error.problems.map((problem) => {
        const match =
          /^([a-zA-Z0-9_.:-]+): (missing|unexpected|expected choice|expected score|expected noul|unknown choice|probability keys|probability range|probabilities sum|confidence|score level|noul)$/u.exec(
            problem,
          );
        return match ? `${match[1]}: ${match[2]}` : "invalid answer";
      }),
    ];
  if (error instanceof DecisionTransportError)
    return [
      "DecisionTransportError: decision transport failed",
      `HTTP status: ${error.status ?? "unavailable"}`,
      `attempts: ${error.attempts}`,
    ];
  if (error instanceof ContextLimitError)
    return [
      "ContextLimitError: decision context exceeds limit",
      `reductions tried: ${error.reductions.join(", ") || "none"}`,
    ];
  if (error instanceof Error && error.name === "CdpTimeoutError")
    return [
      `CdpTimeoutError: ${/^[A-Za-z0-9. ]+ timed out$/u.test(error.message) ? error.message : "CDP operation timed out"}`,
    ];
  if (error instanceof Error && error.name === "CdpProtocolError") {
    const protocol = error as Error & { method?: unknown; code?: unknown };
    const method =
      typeof protocol.method === "string" && /^[A-Za-z0-9.]+$/u.test(protocol.method)
        ? protocol.method
        : "CDP call";
    const code =
      typeof protocol.code === "number" && Number.isSafeInteger(protocol.code)
        ? protocol.code
        : "unknown";
    return [`CdpProtocolError: ${method} returned code ${code}`];
  }
  if (error instanceof NavigationInProgressError)
    return ["NavigationInProgressError: navigation interrupted browser operation"];
  if (error instanceof DecisionError) return [`${error.name}: decision failed`];
  if (error instanceof Error && error.name === "EvaluationError") {
    // Only code identifiers (our page function, the thrown class), never the exception text.
    const evaluation = error as Error & { functionName?: unknown; exceptionClass?: unknown };
    const identifier = (value: unknown): string | undefined =>
      typeof value === "string" && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u.test(value)
        ? value
        : undefined;
    const thrown = identifier(evaluation.exceptionClass);
    const where = identifier(evaluation.functionName);
    return [`EvaluationError${thrown ? `: ${thrown}` : ""}${where ? ` in ${where}` : ""}`];
  }
  if (error instanceof Error)
    return [/^[A-Za-z][A-Za-z0-9]*$/u.test(error.name) ? error.name : "Error"];
  return ["UnknownError"];
}

export class OrchestratorSession {
  readonly id: string;
  page: PageHandle;
  private readonly openIsolatedPage: ((copyCookies: boolean) => Promise<PageHandle>) | undefined;
  private readonly automaticIsolatedFallback: boolean;
  goal: string;
  readonly acceptanceHints: string[];
  readonly values: Record<string, SessionValue>;
  readonly success: SuccessAssertions | undefined;
  readonly constraints: { allowed_domains?: string[]; allow_irreversible: boolean };
  readonly budget: { steps: number; seconds: number; decision_tokens: number };
  readonly thresholds: PolicyContext["thresholds"];
  readonly trace: SessionTrace[] = [];
  epoch = 0;
  pendingGatedAction?: {
    action: Action;
    /** The page the gate was raised on; an approval does not carry over to another page. */
    url: string;
    epoch: number;
    ref: string;
    fingerprint: string;
    role: string;
    name: string;
    identityName?: string;
    formId?: string;
    containerText?: string;
    itemPosition?: number;
    reason: string;
  };
  lastObservation?: Observation;
  startPageHash?: string;
  readonly createdAt: number;
  updatedAt: number;
  readonly idleTimeoutMs: number;
  private readonly deps: SessionDeps;
  private readonly autoPassWindowMs: number;
  private readonly navigationTimeoutMs: number;
  private readonly actionabilityTimeoutMs: number;
  private readonly decisionLogPath: string | undefined;
  private readonly usageDetail: boolean;
  private readonly decisionProvider: Provider | undefined;
  private readonly decisionContextLimit: number | undefined;
  private decisionLogFinalized = false;
  private initialNavigationFailure?: { url: string; failure: string };
  private directory?: string;
  private closed = false;
  private steps = 0;
  private invocationSteps = 0;
  private invocationStarted: number;
  private decisionTokens = 0;
  private callDecisions = 0;
  private callInputTokens = 0;
  private callOutputTokens = 0;
  private sessionDecisions = 0;
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;
  private sessionDecideMs = 0;
  private sessionBrowserMs = 0;
  private sessionHarnessMs = 0;
  private sessionTotalMs = 0;
  private hasInvocation = false;
  private lastResultAt?: number;
  private lastProvider: string | undefined;
  private lastModel: string | undefined;
  private decideMs = 0;
  private browserMs = 0;
  private harnessMs = 0;
  private readonly screenshotWrites = new Set<Promise<void>>();
  private directoryCreation: Promise<string> | undefined;
  private closing: Promise<void> | undefined;
  private navigation?: DetectorInput["navigation"];
  private recentActions: ActionResult[] = [];
  private lastFilled?: { fingerprint: string; formId?: string };
  private pendingDialog?: PageEvents["dialog"];
  private popups: PageEvents["popup"][] = [];
  private pendingPopup: { page: PageEvents["popup"]; arrivedAt: number } | undefined;
  private lastExecutedActionAt: number | undefined;
  private downloads: PageEvents["download"][] = [];
  private queuedSample?: { observation: Observation; findings: Finding[] };
  private navigationVersion = 0;
  private sampleVersion = -1;
  private readonly nonEvidencePages = new WeakSet<Observation>();
  private readonly consumedKeys = new Set<string>();
  private readonly consumedFields = new Map<string, string>();
  private readonly typedTexts: { text: string; url: string }[] = [];
  private readonly typedFields: {
    text: string;
    secret: boolean;
    valueKey?: string;
    name: string;
    fingerprint: string;
    ref: string;
    url: string;
  }[] = [];
  private readonly futileSubmits: { url: string; value: string }[] = [];
  private lastCoveredTarget?: string;
  private secretLiterals = new Set<string>();
  private readonly ownedPages = new Set<PageHandle>();
  private readonly uploadDirectory = process.env.JEVPILOT_UPLOAD_DIR;
  private successAssertionsChecked = false;
  private successAssertionsIgnored = false;
  private successAssertionsIgnoredWhen = "on the start page";
  private carriedBrowserMs = 0;
  private staleRecoveryDeadline = 0;
  private pageUnresponsive = false;
  private manualOpsInProgress = false;
  private automaticReopenAttempted = false;
  private isolatedReopenNote = false;
  private blockedByPolicy?: PageEvents["requestBlocked"];

  constructor(options: SessionOptions, deps: Partial<SessionDeps> = {}) {
    this.deps = { ...defaults, ...deps };
    this.id = options.id ?? randomUUID();
    this.page = options.page;
    this.openIsolatedPage = options.openIsolatedPage;
    this.automaticIsolatedFallback = options.automaticIsolatedFallback !== false;
    this.goal = options.goal;
    this.acceptanceHints = options.acceptanceHints ?? [];
    this.values = { ...options.values };
    this.success = options.success;
    this.constraints = {
      ...options.constraints,
      allow_irreversible: options.constraints?.allow_irreversible ?? false,
    };
    this.budget = {
      steps: options.budget?.steps ?? 30,
      seconds: options.budget?.seconds ?? 180,
      decision_tokens: options.budget?.decision_tokens ?? 200_000,
    };
    this.thresholds = options.thresholds;
    this.navigation = options.navigation;
    const initialBlock = options.initialBlockedRequest ?? options.page.blockedRequest?.();
    if (initialBlock) this.blockedByPolicy = initialBlock;
    this.carriedBrowserMs = options.navigationMs ?? 0;
    if (options.navigation?.failure)
      this.initialNavigationFailure = {
        url: options.navigation.url,
        failure: options.navigation.failure,
      };
    this.createdAt = this.updatedAt = this.deps.now();
    this.invocationStarted = this.createdAt;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 600_000;
    this.autoPassWindowMs = options.autoPassWindowMs ?? 8_000;
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 30_000;
    this.actionabilityTimeoutMs = options.actionabilityTimeoutMs ?? 2_000;
    this.decisionLogPath = options.decisionLogPath;
    this.usageDetail = options.usageDetail === true;
    this.decisionProvider = options.decisionProvider;
    this.decisionContextLimit = options.decisionContextLimit;
    this.attach(this.page);
    this.ownedPages.add(this.page);
  }

  private attach(page: PageHandle): void {
    page.on("dialog", this.onDialog);
    page.on("popup", this.onPopup);
    page.on("download", this.onDownload);
    page.on("navigated", this.onNavigated);
    page.on("requestBlocked", this.onRequestBlocked);
  }
  private detach(page: PageHandle): void {
    page.off("dialog", this.onDialog);
    page.off("popup", this.onPopup);
    page.off("download", this.onDownload);
    page.off("navigated", this.onNavigated);
    page.off("requestBlocked", this.onRequestBlocked);
  }
  private onDialog = (dialog: PageEvents["dialog"]): void => {
    this.pendingDialog = dialog;
  };
  private onPopup = (page: PageHandle): void => {
    this.popups.push(page);
    this.ownedPages.add(page);
    this.attach(page);
    if (this.lastExecutedActionAt !== undefined)
      this.pendingPopup = { page, arrivedAt: this.deps.now() };
  };
  private switchPendingPopup(): boolean {
    const pending = this.pendingPopup;
    if (
      !pending ||
      this.lastExecutedActionAt === undefined ||
      pending.arrivedAt < this.lastExecutedActionAt ||
      pending.arrivedAt - this.lastExecutedActionAt > 10_000
    )
      return false;
    this.pendingPopup = undefined;
    this.popups = this.popups.filter((popup) => popup !== pending.page);
    this.detach(this.page);
    this.page = pending.page;
    this.attach(pending.page);
    return true;
  }
  private onDownload = (download: PageEvents["download"]): void => {
    this.downloads.push(download);
  };
  private onNavigated = (event: PageEvents["navigated"]): void => {
    this.navigationVersion++;
    this.navigation = {
      url: event.url,
      ...(event.status !== undefined ? { status: event.status } : {}),
      headers: event.headers ?? {},
    };
  };
  private onRequestBlocked = (event: PageEvents["requestBlocked"]): void => {
    if (event.frame === "main") this.blockedByPolicy = event;
  };
  private touch(): void {
    this.updatedAt = this.deps.now();
  }
  private beginInvocation(): void {
    if (this.usageDetail && this.hasInvocation) {
      this.sessionDecideMs += this.decideMs;
      this.sessionBrowserMs += this.browserMs;
      this.sessionHarnessMs += this.harnessMs;
      // The finished call ended at its last result, not now: idle time between calls is not session time.
      this.sessionTotalMs += Math.max(
        0,
        (this.lastResultAt ?? this.invocationStarted) - this.invocationStarted,
      );
    }
    delete this.lastResultAt;
    this.touch();
    this.invocationStarted = this.deps.now();
    this.hasInvocation = true;
    this.invocationSteps = 0;
    this.callDecisions = 0;
    this.callInputTokens = 0;
    this.callOutputTokens = 0;
    this.decideMs = 0;
    this.browserMs = 0;
    this.harnessMs = 0;
    this.staleRecoveryDeadline = 0;
    // The isolated-reopen note belongs to the tool call in which the reopen happened.
    this.isolatedReopenNote = false;
    // Browser time spent before this invocation started (the server's initial navigation, or a
    // navigate() that hands over to observe()) belongs to it.
    this.browserMs += this.carriedBrowserMs;
    this.carriedBrowserMs = 0;
  }
  private recordDecisionUsage(decision: DecisionResult): void {
    this.callInputTokens += decision.usage.inputTokens;
    this.callOutputTokens += decision.usage.outputTokens;
    this.sessionInputTokens += decision.usage.inputTokens;
    this.sessionOutputTokens += decision.usage.outputTokens;
    this.lastProvider = decision.provider;
    this.lastModel = decision.model;
  }
  private scrub(value: string): string {
    let clean = value;
    for (const secret of this.secretLiterals) clean = redactSecret(clean, secret);
    for (const item of Object.values(this.values))
      if (isSecret(item)) clean = clean.replaceAll(item.secret_ref, "[REDACTED]");
    return clean;
  }
  private scrubDeep<T>(value: T): T {
    if (typeof value === "string") return this.scrub(value) as T;
    if (Array.isArray(value)) return value.map((item) => this.scrubDeep(item)) as T;
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.scrubDeep(item)]),
      ) as T;
    return value;
  }
  private sanitizedObservation(observation: Observation): Observation {
    const clean = this.scrubDeep(observation);
    return {
      ...clean,
      elements: clean.elements.map((item) =>
        item.inputType === "password" ? { ...item, value: item.value ? "[filled]" : "" } : item,
      ),
    };
  }
  private question(reason: string, details: Record<string, unknown>): string {
    if (details.decisionHandoff === true) {
      const problem =
        details.decisionHandoffKind === "timeout"
          ? "the decision service timed out"
          : details.decisionHandoffKind === "context"
            ? "the page is too large for the decision model"
            : details.decisionHandoffKind === "invalid"
              ? "the decision model returned an invalid answer"
              : "the decision service was unavailable";
      return `Jev could not decide (${problem}). The page is ready: continue with browser_act / browser_observe, or call browser_resume to let Jev try again.`;
    }
    const fields =
      this.lastObservation?.elements
        .filter((item) => item.inViewport && item.required && !item.value)
        .map((item) => `${item.role} ${JSON.stringify(this.scrub(item.name))}`) ?? [];
    switch (reason) {
      case "needs_values":
        if (details.secretSource)
          return "Use a JEVPILOT_SECRET_ environment variable or a file inside JEVPILOT_SECRETS_DIR for this secret.";
        if (details.dialogKind === "prompt" && !Array.isArray(details.fields))
          return `Provide a value key for the pending prompt. No field was identified. Provided keys: ${Object.keys(this.values).join(", ") || "none"}.`;
        const namedFields = Array.isArray(details.fields)
          ? details.fields.map((field) => String((field as { label?: string }).label ?? "field"))
          : fields;
        return namedFields.length
          ? `Provide values for ${namedFields.join(", ")}. Provided keys: ${Object.keys(this.values).join(", ") || "none"}.`
          : `No field was identified as missing a value. Provided keys: ${Object.keys(this.values).join(", ") || "none"}.`;
      case "needs_login":
        return `Provide login values for ${
          this.lastObservation?.elements
            .filter(
              (item) =>
                item.inViewport &&
                (item.inputType === "password" ||
                  item.inputType === "email" ||
                  /user|login/i.test(item.name)),
            )
            .map((item) => `${item.role} ${JSON.stringify(this.scrub(item.name))}`)
            .join(", ") || "the login fields"
        }.`;
      case "confirm_required":
        const target =
          details.target && typeof details.target === "object"
            ? (details.target as { page_name?: string })
            : undefined;
        return details.domain
          ? `Approve navigation to domain ${details.domain}?`
          : `Approve ${JSON.stringify(this.scrub(String(details.targetName ?? target?.page_name ?? details.message ?? "this action")))}${details.matched ? ` (matched ${details.matched})` : ""}?`;
      case "blocked_by_challenge":
        return `Complete the ${String(details.vendor ?? "site")} challenge.`;
      case "blocked_address":
        return `The address for ${String(details.host ?? "this host")} is blocked by the server's network guard (JEVPILOT_NETWORK_GUARD). Only the server operator can change it.`;
      case "uncertain":
        if (
          details.question === "op" &&
          Array.isArray(details.candidates) &&
          details.candidates.length
        )
          return `Next step unclear: ${details.candidates
            .map((candidate) => {
              const item = candidate as {
                key: string;
                probability: number;
                target?: { ref: string; role: string; name: string; covered?: boolean };
              };
              return `${item.key}${item.target ? ` via ${item.target.ref} ${item.target.role} ${JSON.stringify(this.scrub(item.target.name))}` : ""} (${item.probability.toFixed(2)}${item.target?.covered ? ", covered" : ""})`;
            })
            .join("; ")}.`;
        if (details.missing === "page appears empty")
          return `Page appears empty at ${this.scrub(String(details.url ?? ""))} (${this.scrub(String(details.title ?? ""))}).`;
        return details.completionMissing
          ? `Cannot confirm completion: ${details.completionMissing}.`
          : details.missing
            ? `Cannot proceed: ${details.missing}.`
            : typeof details.goalMet === "number" && typeof details.threshold === "number"
              ? `Could not confirm the goal is met: goal_met ${details.goalMet.toFixed(2)} < ${details.threshold.toFixed(2)}.`
              : Array.isArray(details.candidates) && details.candidates.length
                ? details.question === "value_for"
                  ? `Choose a provided value for ${details.candidates
                      .map((candidate) => {
                        const field = (
                          candidate as { field?: { role?: string; name?: string; ref?: string } }
                        ).field;
                        const probabilities = (candidate as { probabilities?: [string, number][] })
                          .probabilities;
                        return `${field?.role ?? "field"} ${field?.name ?? ""} (${field?.ref ?? ""}): ${probabilities?.map(([key, probability]) => `${key} ${probability.toFixed(2)}`).join(", ") ?? ""}`;
                      })
                      .join("; ")}.`
                  : `Choose among ${JSON.stringify(details.candidates)}.`
                : details.question === "value_for" &&
                    Array.isArray(details.remaining_keys) &&
                    Array.isArray(details.fields)
                  ? `Jev chose to type, but no empty field fits the remaining keys (${details.remaining_keys.map((key) => this.scrub(String(key))).join(", ") || "none"}). Empty fields: ${
                      details.fields
                        .map((field) => {
                          const item = field as { type?: string; label?: string; ref?: string };
                          return `${item.type ?? "field"} ${JSON.stringify(this.scrub(String(item.label ?? "")))} (${this.scrub(String(item.ref ?? ""))})`;
                        })
                        .join(", ") || "none"
                    }. Type into the intended control with browser_act, or call browser_resume with a goal_update.`
                  : `Could not choose a confident ${String(details.question ?? "next action")}.`;
      case "error_page":
        return `The page failed${details.status ? ` with status ${details.status}` : ""}${details.failure ? ` during navigation (${details.failure})` : ""}.`;
      case "stuck":
        if (details.coveredBy && typeof details.coveredBy === "object") {
          const cover = details.coveredBy as { role: string; name: string };
          return `${this.scrub(String(details.targetName ?? "Target"))} is repeatedly covered by ${cover.role} ${JSON.stringify(this.scrub(cover.name))}.`;
        }
        return `The last actions made no progress. ${this.trace.at(-1)?.op ?? ""}`;
      case "info_not_on_page":
        return "Provide the missing information or a different page.";
      default:
        return reason;
    }
  }
  private async result(
    status: SessionStatus,
    reason: string,
    details: Record<string, unknown> = {},
  ): Promise<SessionResult> {
    if (this.blockedByPolicy) {
      status = "BLOCKED_BY_POLICY";
      reason = "blocked_address";
      details = {
        host: domainOf(this.blockedByPolicy.url) || this.blockedByPolicy.address,
        url: this.blockedByPolicy.url,
      };
    }
    const observation = this.blockedByPolicy
      ? undefined
      : this.lastObservation && this.sanitizedObservation(this.lastObservation);
    const resultAt = this.deps.now();
    const totalMs = Math.max(0, resultAt - this.invocationStarted);
    // The latest result of a call marks its end; a discarded earlier result is simply superseded.
    this.lastResultAt = resultAt;
    const usage = { decision_tokens: this.decisionTokens } as SessionResult["usage"];
    if (this.usageDetail) {
      const call = {
        decisions: this.callDecisions,
        input_tokens: this.callInputTokens,
        output_tokens: this.callOutputTokens,
        decide_ms: Math.round(this.decideMs),
        browser_ms: Math.round(this.browserMs),
        harness_ms: Math.round(this.harnessMs),
        total_ms: Math.round(totalMs),
      };
      usage.detail = {
        call,
        session: {
          decisions: this.sessionDecisions,
          input_tokens: this.sessionInputTokens,
          output_tokens: this.sessionOutputTokens,
          decide_ms: Math.round(this.sessionDecideMs + this.decideMs),
          browser_ms: Math.round(this.sessionBrowserMs + this.browserMs),
          harness_ms: Math.round(this.sessionHarnessMs + this.harnessMs),
          total_ms: Math.round(this.sessionTotalMs + totalMs),
        },
        ...(this.lastProvider === undefined ? {} : { provider: this.lastProvider }),
        ...(this.lastModel === undefined ? {} : { model: this.lastModel }),
      };
    }
    const result: SessionResult = {
      status,
      reason,
      question: this.scrub(this.question(reason, details)),
      ...this.resultDetails(status, reason, details),
      session: this.id,
      url:
        (typeof details.url === "string" ? details.url : undefined) ??
        observation?.url ??
        this.initialNavigationFailure?.url ??
        this.navigation?.url ??
        "",
      title: observation?.title ?? "",
      snapshot: observation ? this.scrub(formatObservation(observation)).slice(0, 12_000) : "",
      trace: this.trace.map((entry) => ({
        ...entry,
        ...(entry.target
          ? { target: { role: entry.target.role, name: this.scrub(entry.target.name) } }
          : {}),
      })),
      timing: {
        total: totalMs,
        decide: this.decideMs,
        browser: this.browserMs,
        harness: this.harnessMs,
      },
      usage,
    };
    if (status !== "RUNNING" && !this.decisionLogFinalized) {
      this.decisionLogFinalized = true;
      const assertionsHeld = status === "DONE_VERIFIED";
      await appendCalibrationRecord(this.decisionLogPath, {
        type: "session_end",
        session: this.id,
        final_status: status,
        success_assertions_held: assertionsHeld,
      });
    }
    if (
      status !== "BLOCKED_BY_POLICY" &&
      !(["RUNNING", "DONE_VERIFIED", "DONE_UNVERIFIED"] as SessionStatus[]).includes(status) &&
      !this.pageUnresponsive &&
      this.page.capabilities.screenshots &&
      !this.closed &&
      this.secretLiterals.size === 0
    ) {
      const write = (async () => {
        try {
          this.directoryCreation ??= this.deps.tempDir();
          this.directory ??= await this.directoryCreation;
          if (this.closed) return;
          const path = join(this.directory, `handoff-${this.steps}.png`);
          await writeFile(path, await this.page.screenshot());
          if (!this.closed) result.screenshot_path = path;
        } catch {
          /* Screenshot support is optional. */
        }
      })();
      this.screenshotWrites.add(write);
      try {
        await write;
      } finally {
        this.screenshotWrites.delete(write);
      }
    }
    return this.scrubDeep(result);
  }
  private async handoff(
    reason: HandoffReason,
    details: Record<string, unknown> = {},
  ): Promise<SessionResult> {
    return this.result(statusByReason[reason], reason, details);
  }
  private async decisionFailure(
    error: unknown,
    reductions: string[] = [],
    check = false,
  ): Promise<SessionResult> {
    const name = error instanceof Error ? error.name : "Error";
    const reason =
      error instanceof ContextLimitError || (!check && /ContextLimit/u.test(name))
        ? "decision_context_limit"
        : error instanceof CircuitOpenError || (!check && /Circuit/u.test(name))
          ? "decision_circuit_open"
          : /InvalidAnswer/u.test(name)
            ? "decision_invalid_answer"
            : "decision_transport_error";
    const failure =
      error instanceof ContextLimitError
        ? [...reductions, ...failureDetails(error)]
        : failureDetails(error);
    const kind =
      error instanceof DecisionTimeoutError
        ? "timeout"
        : error instanceof ContextLimitError
          ? "context"
          : error instanceof InvalidAnswerError
            ? "invalid"
            : "unavailable";
    const recoverable =
      error instanceof DecisionTimeoutError ||
      (error instanceof DecisionTransportError && error.retryable) ||
      error instanceof CircuitOpenError ||
      error instanceof ContextLimitError ||
      error instanceof InvalidAnswerError;
    if (!recoverable) return this.result("FAILED", reason, { failure });
    if (this.sampleVersion !== this.navigationVersion && !this.pageUnresponsive) await this.fresh();
    return this.result("UNCERTAIN", reason, {
      failure,
      decisionHandoff: true,
      decisionHandoffKind: kind,
    });
  }
  private async logDecisionFailure(
    request: DecisionRequest,
    error: unknown,
    startedAt: number,
  ): Promise<void> {
    const category =
      error instanceof DecisionTimeoutError
        ? "timeout"
        : error instanceof DecisionTransportError
          ? "transport"
          : error instanceof DecisionAbortedError
            ? "aborted"
            : "other";
    const attempts =
      error instanceof DecisionTimeoutError || error instanceof DecisionTransportError
        ? error.attempts
        : undefined;
    await appendCalibrationRecord(
      this.decisionLogPath,
      calibrationRequestRecord({
        session: this.id,
        step: this.steps + 1,
        request,
        answers: {},
        outcome: "handed_off",
        latencyMs: Math.max(0, this.deps.now() - startedAt),
        ...(attempts ? { attempts } : {}),
        errorCategory: category,
      }),
    );
  }
  private allowed(url: string): string | undefined {
    if (!this.constraints.allowed_domains?.length) return undefined;
    // A blank tab (a fresh popup, or a run without url) has no content from any origin.
    if (url === "about:blank") return undefined;
    const domain = domainOf(url);
    return !domain ||
      !this.constraints.allowed_domains.some(
        (allowed) =>
          domain === allowed.toLowerCase() || domain.endsWith(`.${allowed.toLowerCase()}`),
      )
      ? domain || "URL without a hostname"
      : undefined;
  }
  private exceeded(): boolean {
    return (
      this.invocationSteps >= this.budget.steps ||
      this.deps.now() - this.invocationStarted >= this.budget.seconds * 1000 ||
      this.decisionTokens >= this.budget.decision_tokens
    );
  }
  private async decideWithinBudget(request: DecisionRequest): Promise<DecisionResult> {
    const remaining = this.budget.seconds * 1000 - (this.deps.now() - this.invocationStarted);
    if (remaining <= 0) throw new DecisionAbortedError("session budget exhausted");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remaining);
    try {
      return await this.deps.decide(request, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new DecisionAbortedError("session budget exhausted");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  private async sample(
    options: ObserveOptions = {},
  ): Promise<{ observation: Observation; findings: Finding[] }> {
    if (this.blockedByPolicy) throw new Error("blocked_address");
    const started = this.deps.now();
    const version = this.navigationVersion;
    let observation: Observation;
    try {
      observation = await this.deps.observe(this.page, {
        goal: this.goal,
        markerSelectors: detectorMarkerSelectors(),
        settleNavigation: this.sampleVersion !== version,
        ...options,
      });
    } catch (error) {
      if (!this.staleFrame(error)) throw error;
      await this.waitForDocumentCommit(version);
      observation = await this.deps.observe(this.page, {
        goal: this.goal,
        markerSelectors: detectorMarkerSelectors(),
        settleNavigation: true,
        ...options,
      });
    }
    this.browserMs += Math.max(0, this.deps.now() - started);
    this.sampleVersion = version;
    this.lastObservation = observation;
    if (
      this.navigation?.failure === "timeout" &&
      (observation.elements.length || observation.text.trim())
    ) {
      const { failure: _failure, ...navigation } = this.navigation;
      this.navigation = navigation;
    }
    this.epoch = observation.epoch;
    this.startPageHash ??= observation.pageHash;
    const findings = orderFindings(
      this.deps.detect({
        observation,
        ...(this.navigation ? { navigation: this.navigation } : {}),
        recentActions: this.recentActions,
        ...(this.pendingDialog ? { pendingDialog: this.pendingDialog } : {}),
        events: { popups: this.popups, downloads: this.downloads },
      }),
    );
    this.popups = [];
    this.downloads = [];
    // A challenge, a login wall or an error page is never evidence of completion, even when its URL matches:
    // SSO redirects carry the target URL in their query and some challenges are served at the target URL.
    // A login page of an origin the agent supplied credentials for is part of the task, as in topBlocker().
    if (
      findings.some(
        (finding) =>
          finding.level === "blocking" &&
          (finding.kind === "challenge" ||
            (finding.kind === "login_wall" && !this.hasOriginSecret(observation.url)) ||
            finding.kind === "error_page"),
      )
    )
      this.nonEvidencePages.add(observation);
    if (
      !this.successAssertionsChecked &&
      !this.nonEvidencePages.has(observation) &&
      (this.navigation?.status ?? 0) < 400
    ) {
      this.successAssertionsChecked = true;
      if (this.success && Object.keys(this.success).length) {
        try {
          this.successAssertionsIgnored =
            (!this.success.url_matches ||
              new RegExp(this.success.url_matches).test(observation.url)) &&
            ((!this.success.text_present && !this.success.element_present) ||
              (await this.deps.pageMatches(this.page, this.success)));
        } catch (error) {
          if (error instanceof PageUnresponsiveError) throw error;
          this.successAssertionsIgnored = false;
        }
      }
    }
    return { observation, findings };
  }
  private resultDetails(
    status: SessionStatus,
    reason: string,
    details: Record<string, unknown>,
  ): { details?: string[] } {
    const base =
      status === "FAILED" || (status === "UNCERTAIN" && details.decisionHandoff === true)
        ? (Array.isArray(details.failure) && details.failure.length
            ? details.failure
            : [`SessionError: ${reason}`]
          ).map((item) => this.scrub(String(item)))
        : status === "UNCERTAIN" &&
            Array.isArray(details.candidates) &&
            details.candidates.some(
              (candidate) => typeof (candidate as { noul?: unknown }).noul === "number",
            )
          ? details.candidates.map((candidate) => {
              const item = candidate as { key?: string; noul?: number };
              return `${this.scrub(String(item.key ?? "candidate"))}: ${typeof item.noul === "number" ? item.noul.toFixed(2) : "unavailable"}`;
            })
          : [];
    // M6e: say once per result that the caller's assertions were not usable, without hiding other details.
    const all = this.successAssertionsIgnored
      ? [
          ...base,
          `success assertions already held ${this.successAssertionsIgnoredWhen} and were ignored`,
        ]
      : base;
    if (this.isolatedReopenNote)
      all.push(
        "the page stopped responding in the shared browser context; reopened in an isolated context (cookies copied, site storage not)",
      );
    if (reason === "isolated_reopen" && details.remainingOps === true)
      all.push("remaining ops were not run");
    return all.length ? { details: all } : {};
  }
  private staleFrame(error: unknown): boolean {
    if (error instanceof NavigationInProgressError)
      return (
        /navigation interrupted isolated/iu.test(error.message) || this.staleFrame(error.cause)
      );
    if (!(error instanceof Error)) return false;
    const protocol = error as Error & { code?: unknown; method?: unknown };
    return (
      (protocol.code === -32602 && protocol.method === "Page.createIsolatedWorld") ||
      (protocol.code === -32000 &&
        typeof protocol.method === "string" &&
        /^(?:DOM\.(?:getFrameOwner|resolveNode)|Page\.createIsolatedWorld|Runtime\.callFunctionOn)$/u.test(
          protocol.method,
        ) &&
        /node|context|frame|object|target|navigat/iu.test(error.message)) ||
      /frame with given id was not found|Page\.createIsolatedWorld returned code -32602/iu.test(
        error.message,
      )
    );
  }
  private async waitForDocumentCommit(version: number): Promise<void> {
    // A replaced document normally commits within a second or two; without a navigation event (for
    // example a swapped iframe) waiting longer only delays the handoff.
    this.staleRecoveryDeadline ||= this.deps.now() + Math.min(this.navigationTimeoutMs, 5000);
    const deadline = this.staleRecoveryDeadline;
    while (this.navigationVersion === version && this.deps.now() < deadline)
      await this.deps.sleep(Math.min(50, deadline - this.deps.now()));
  }
  private async staleHandoff(): Promise<SessionResult> {
    const url = await (
      this.page.targetUrl?.() ?? Promise.resolve(this.navigation?.url ?? "")
    ).catch(() => this.navigation?.url ?? "");
    return this.handoff("uncertain", { missing: `page kept changing; current URL: ${url}`, url });
  }
  private async recoverStale(version: number): Promise<SessionResult> {
    await this.waitForDocumentCommit(version);
    if (this.navigationVersion === version) return this.staleHandoff();
    try {
      await this.sample({ settleNavigation: true });
      return this.result("RUNNING", "observation");
    } catch (error) {
      if (error instanceof PageUnresponsiveError) return this.unresponsiveHandoff();
      if (this.staleFrame(error)) return this.staleHandoff();
      throw error;
    }
  }
  private async replaceUnresponsivePage(url: string): Promise<NavigationResult> {
    if (!this.openIsolatedPage) throw new Error("isolated contexts are unavailable");
    const started = this.deps.now();
    const replacement = await this.openIsolatedPage(true);
    try {
      const navigation = await replacement.navigate(url, { timeoutMs: this.navigationTimeoutMs });
      if (navigation.failure && navigation.failure !== "timeout")
        throw new Error(`isolated navigation failed: ${navigation.failure}`);
      await replacement.callIsolated(() => true, [], { timeoutMs: 2000 });
      const outside = this.allowed(navigation.url);
      if (outside) throw new Error(`isolated navigation left allowed domains: ${outside}`);
      const previous = this.page;
      this.detach(previous);
      this.page = replacement;
      this.attach(replacement);
      this.ownedPages.add(replacement);
      this.ownedPages.delete(previous);
      await previous.close().catch(() => {});
      this.pageUnresponsive = false;
      this.navigation = navigation;
      delete this.lastObservation;
      delete this.queuedSample;
      this.sampleVersion = -1;
      return navigation;
    } catch (error) {
      await replacement.close().catch(() => {});
      throw error;
    } finally {
      this.browserMs += Math.max(0, this.deps.now() - started);
    }
  }
  private async unresponsiveHandoff(): Promise<SessionResult> {
    const remainingOps = this.manualOpsInProgress;
    this.pageUnresponsive = true;
    const url = await (
      this.page.targetUrl?.() ?? Promise.resolve(this.navigation?.url ?? "")
    ).catch(() => this.navigation?.url ?? this.lastObservation?.url ?? "");
    if (
      !this.automaticReopenAttempted &&
      this.automaticIsolatedFallback &&
      this.page.capabilities.isolatedContexts &&
      this.openIsolatedPage &&
      /^https?:$/u.test(new URL(url, "about:blank").protocol) &&
      !this.allowed(url) &&
      !this.exceeded()
    ) {
      this.automaticReopenAttempted = true;
      this.invocationSteps++;
      try {
        await this.replaceUnresponsivePage(url);
        this.isolatedReopenNote = true;
        await this.sample();
        return this.result("RUNNING", "isolated_reopen", { remainingOps });
      } catch {
        // Preserve the M6h handoff if the isolated renderer also stops responding.
        this.pageUnresponsive = true;
      }
    }
    return this.handoff("uncertain", {
      missing: `page is not responding (its main thread is busy) at ${url}; use browser_navigate to reload or open another URL, or browser_close`,
      url,
    });
  }
  private async checkPageLiveness(): Promise<SessionResult | undefined> {
    if (!this.pageUnresponsive) return undefined;
    try {
      await this.page.callIsolated(() => true, [], { timeoutMs: 2000 });
      this.pageUnresponsive = false;
      return undefined;
    } catch {
      return this.unresponsiveHandoff();
    }
  }
  private async fresh(sampled?: { observation: Observation; findings: Finding[] }): Promise<{
    observation: Observation;
    findings: Finding[];
  }> {
    let current = sampled ?? (await this.sample());
    if (this.switchPendingPopup()) current = await this.sample();
    for (
      let retry = 0;
      retry < 3 && !this.exceeded() && this.sampleVersion !== this.navigationVersion;
      retry++
    )
      current = await this.sample();
    return current;
  }
  private async waitForContent(sampled: {
    observation: Observation;
    findings: Finding[];
  }): Promise<{
    observation: Observation;
    findings: Finding[];
  }> {
    let current = sampled;
    for (
      let elapsed = 0;
      elapsed < 3000 && !current.observation.elements.length && !current.observation.text.trim();
      elapsed += 500
    ) {
      await this.deps.sleep(500);
      current = await this.fresh();
    }
    return current;
  }
  private hasOriginSecret(url: string): boolean {
    try {
      const origin = new URL(url).origin;
      return Object.values(this.values).some(
        (value) => isSecret(value) && value.origins.includes(origin),
      );
    } catch {
      return false;
    }
  }
  private topBlocker(findings: Finding[]): Finding | undefined {
    return findings.find(
      (finding) =>
        finding.level === "blocking" &&
        !(finding.kind === "login_wall" && this.hasOriginSecret(this.lastObservation?.url ?? "")),
    );
  }
  private async blocking(sampled: { observation: Observation; findings: Finding[] }): Promise<{
    sampled: { observation: Observation; findings: Finding[] };
    handoff?: SessionResult;
  }> {
    let current = sampled;
    let blocker = this.topBlocker(current.findings);
    if (blocker?.kind === "challenge" && blocker.autoPassPlausible) {
      const until = this.deps.now() + this.autoPassWindowMs;
      while (this.deps.now() < until) {
        await this.deps.sleep(Math.min(1000, until - this.deps.now()));
        current = await this.sample();
        blocker = this.topBlocker(current.findings);
        if (blocker?.kind !== "challenge") break;
      }
    }
    if (!blocker) return { sampled: current };
    const mapped = blockingHandoff(blocker);
    return mapped.type === "handoff"
      ? { sampled: current, handoff: await this.handoff(mapped.reason, mapped.details) }
      : { sampled: current };
  }
  private async verified(observation: Observation): Promise<boolean> {
    if (this.successAssertionsIgnored || !this.success || !Object.keys(this.success).length)
      return false;
    // An HTTP error document (a 429 rate limit, a 404) is never evidence of completion, even when
    // its URL matches the assertion.
    if ((this.navigation?.status ?? 0) >= 400) return false;
    for (let retry = 0; retry < 3; retry++) {
      const current =
        this.sampleVersion === this.navigationVersion
          ? observation
          : (await this.fresh()).observation;
      const version = this.navigationVersion;
      let matched = false;
      try {
        matched =
          !this.nonEvidencePages.has(current) &&
          (!this.success.url_matches || new RegExp(this.success.url_matches).test(current.url)) &&
          ((!this.success.text_present && !this.success.element_present) ||
            (await this.deps.pageMatches(
              this.page,
              this.success,
              this.typedTexts
                .filter((entry) => entry.url === current.url)
                .map((entry) => entry.text),
            )));
      } catch (error) {
        if (error instanceof PageUnresponsiveError) throw error;
        matched = false;
      }
      if (version === this.navigationVersion) return matched;
    }
    return false;
  }
  private async completion(goalMet: number): Promise<SessionResult> {
    if (this.lastObservation && (await this.verified(this.lastObservation)))
      return this.result("DONE_VERIFIED", "success_assertions_met");
    const observation =
      this.sampleVersion === this.navigationVersion
        ? this.lastObservation
        : (await this.fresh()).observation;
    const threshold = this.thresholds?.goal_met ?? POLICY_DEFAULT_THRESHOLDS.goal_met;
    const unchangedThreshold =
      this.thresholds?.goal_met_unchanged ?? POLICY_DEFAULT_THRESHOLDS.goal_met_unchanged;
    const unchanged =
      observation?.pageHash === this.startPageHash &&
      !this.trace.some((entry) => entry.outcome === "changed");
    const safePage = !this.navigation?.failure && (this.navigation?.status ?? 0) < 400;
    const missing =
      this.success && Object.keys(this.success).length && !this.successAssertionsIgnored
        ? "success assertions are not satisfied"
        : goalMet < threshold
          ? "goal_met is below threshold"
          : unchanged && goalMet < unchangedThreshold
            ? `unchanged page requires goal_met >= ${unchangedThreshold.toFixed(2)}`
            : "page is an error page";
    if (
      (!this.success || this.successAssertionsIgnored) &&
      goalMet >= threshold &&
      (!unchanged || goalMet >= unchangedThreshold) &&
      safePage
    )
      return this.result(
        "DONE_UNVERIFIED",
        unchanged ? "goal_met_without_action" : "goal_met_without_assertions",
      );
    return this.handoff("uncertain", { completionMissing: missing });
  }
  private async resolveValue(key: string, targetUrl?: string): Promise<string | SessionResult> {
    const item = this.values[key];
    if (item === undefined) return this.handoff("needs_values");
    if (!isSecret(item)) return item;
    try {
      const origin = new URL(targetUrl ?? "").origin;
      if (!item.origins.includes(origin)) return this.handoff("needs_values");
      let value: string;
      if (item.secret_ref.startsWith("env:")) {
        const name = item.secret_ref.slice(4);
        if (!/^JEVPILOT_SECRET_[A-Za-z0-9_]+$/u.test(name))
          return this.handoff("needs_values", { secretSource: true });
        value = process.env[name] ?? "";
      } else if (item.secret_ref.startsWith("file:")) {
        const directory = process.env.JEVPILOT_SECRETS_DIR;
        if (!directory) return this.handoff("needs_values", { secretSource: true });
        const root = await realpath(directory);
        const file = await realpath(item.secret_ref.slice(5));
        const path = relative(root, file);
        if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
          return this.handoff("needs_values", { secretSource: true });
        value = (await readFile(file, "utf8")).replace(/\r?\n$/u, "");
      } else return this.handoff("needs_values", { secretSource: true });
      if (!value) return this.handoff("needs_values");
      this.secretLiterals.add(value);
      return value;
    } catch {
      return this.handoff("needs_values", { secretSource: true });
    }
  }
  private async valueFor(action: Action): Promise<Record<string, string> | SessionResult> {
    if (action.kind !== "type" || action.text !== undefined) return {};
    if (!action.valueKey) return this.handoff("needs_values");
    const key = Object.hasOwn(this.values, action.valueKey)
      ? action.valueKey
      : Object.keys(this.values).find(
          (item) => normalizedKey(item) === normalizedKey(action.valueKey!),
        );
    if (!key)
      return this.handoff("uncertain", {
        missing: `unknown value key ${JSON.stringify(action.valueKey)}. Provided keys: ${Object.keys(this.values).join(", ") || "none"}`,
      });
    const target = this.lastObservation?.elements.find((item) => item.ref === action.target.ref);
    const targetUrl = target
      ? (target.origin ?? (target.framePath ? undefined : this.lastObservation?.url))
      : undefined;
    const value = await this.resolveValue(key, targetUrl);
    return typeof value === "string" ? { [action.valueKey]: value } : value;
  }
  private async answerDialog(
    accept: boolean,
    valueKey?: string,
  ): Promise<SessionResult | undefined> {
    const dialog = this.pendingDialog;
    if (!dialog) return this.handoff("uncertain", { missing: "no pending dialog" });
    let promptText: string | undefined;
    if (dialog.kind === "prompt" && accept) {
      if (!valueKey)
        return this.handoff("needs_values", { fields: [{ label: "dialog response" }] });
      const resolved = await this.resolveValue(
        valueKey,
        dialog.url ?? (dialog.frame === "child" ? undefined : this.lastObservation?.url),
      );
      if (typeof resolved !== "string") return resolved;
      promptText = resolved;
    }
    const started = this.deps.now();
    await this.page.handleDialog(accept, promptText);
    delete this.pendingDialog;
    this.steps++;
    this.invocationSteps++;
    this.trace.push({
      step: this.steps,
      op: "dialog",
      outcome: accept ? "accepted" : "dismissed",
      ms: Math.max(0, this.deps.now() - started),
    });
    return undefined;
  }
  private retargetAction(
    action: Action,
    identity: {
      fingerprint: string;
      role: string;
      name: string;
      identityName?: string;
      formId?: string;
      containerText?: string;
      itemPosition?: number;
    },
    observation: Observation,
    typedValues?: readonly string[],
  ): Action | undefined {
    let matches = observation.elements.filter(
      (item) =>
        item.role === identity.role &&
        (item.identityName ?? item.name) === (identity.identityName ?? identity.name) &&
        (item.formId ?? "") === (identity.formId ?? "") &&
        (typedValues === undefined || fillableField(item, typedValues)),
    );
    if (matches.length > 1 && identity.containerText) {
      const narrowed = matches.filter((item) => item.containerText === identity.containerText);
      if (narrowed.length) matches = narrowed;
    }
    if (matches.length > 1 && identity.itemPosition !== undefined) {
      const narrowed = matches.filter((item) => item.itemPosition === identity.itemPosition);
      if (narrowed.length) matches = narrowed;
    }
    if (matches.length !== 1) return undefined;
    const item = matches[0]!;
    return withTarget(action, {
      epoch: observation.epoch,
      ref: item.ref,
      fingerprint: item.fingerprint,
    });
  }
  private async execute(
    action: Action,
    confidence?: number,
    approved = false,
    batchStep?: number,
    retriedStale = false,
    manual = false,
  ): Promise<SessionResult | undefined> {
    if (this.switchPendingPopup()) {
      this.queuedSample = await this.fresh();
      return undefined;
    }
    const observation = this.lastObservation;
    if (!observation) return this.handoff("uncertain", { missing: "page observation" });
    const target = targetOf(action);
    const element = target && observation.elements.find((item) => item.ref === target.ref);
    if (target && (!element || target.epoch !== observation.epoch))
      return this.handoff("uncertain", { missing: "stored target changed" });
    if (action.kind === "type") {
      if (action.valueKey && !manual && this.consumedKeys.has(action.valueKey))
        return this.handoff("uncertain", {
          missing: `value key ${JSON.stringify(action.valueKey)} was already typed into ${JSON.stringify(this.consumedFields.get(action.valueKey) ?? element?.name ?? "a field")}`,
        });
      if (!element) return this.handoff("needs_values");
      if (action.text === undefined) {
        if (!action.valueKey) return this.handoff("needs_values");
        const suppliedKey = Object.hasOwn(this.values, action.valueKey)
          ? action.valueKey
          : Object.keys(this.values).find(
              (key) => normalizedKey(key) === normalizedKey(action.valueKey!),
            );
        const supplied = suppliedKey ? this.values[suppliedKey] : undefined;
        if (supplied === undefined)
          return this.handoff("uncertain", {
            missing: `unknown value key ${JSON.stringify(action.valueKey)}. Provided keys: ${Object.keys(this.values).join(", ") || "none"}`,
          });
        if (isSecret(supplied) !== (element.inputType === "password"))
          return this.handoff("uncertain", { missing: "field and value type disagree" });
      } else if (element.inputType === "password") {
        return this.handoff("needs_values", { literalText: false });
      }
    }
    const submits =
      action.kind === "submit" ||
      (action.kind === "type" && action.submit === true) ||
      (action.kind === "click" &&
        (element?.inputType === "submit" ||
          (element?.tag === "button" && element.inputType !== "button")));
    if (submits && !manual) {
      const current = { observation };
      const fields = this.typedFields.filter((item) => item.url === current.observation.url);
      const statuses: unknown = fields.length
        ? await this.page
            .callIsolated(checkTypedFieldsInPage, [
              fields.map((field) => ({
                epoch: current.observation.epoch,
                ref: field.ref,
                fingerprint: field.fingerprint,
                expected: field.text,
                secret: field.secret,
              })),
            ])
            .catch(() => undefined)
        : undefined;
      for (const [index, field] of fields.entries()) {
        const present = current.observation.elements.find(
          (item) => item.fingerprint === field.fingerprint,
        );
        if (!Array.isArray(statuses) || statuses[index] !== "changed") continue;
        const retryAction: Action = {
          kind: "type",
          target: {
            epoch: current.observation.epoch,
            ref: present?.ref ?? field.ref,
            fingerprint: field.fingerprint,
          },
          text: field.secret ? undefined : field.text,
          ...(field.secret && field.valueKey ? { valueKey: field.valueKey } : {}),
        } as Action;
        const retryValues = await this.valueFor(retryAction);
        if (!("status" in retryValues)) {
          const retryResult = await this.deps.executeAction(
            this.page,
            current.observation,
            retryAction,
            retryValues,
            {
              navigationTimeoutMs: this.navigationTimeoutMs,
              waitTimeoutMs: 1000,
              actionabilityTimeoutMs: this.actionabilityTimeoutMs,
              strictIdentity: true,
            },
          );
          this.trace.push({
            step: this.steps,
            op: "type",
            target: { role: "textbox", name: this.scrub(field.name) },
            outcome: retryResult.outcome,
            ms: retryResult.timings.inputMs,
            waitMs: retryResult.timings.waitMs ?? 0,
          });
        }
        const checked: unknown = await this.page
          .callIsolated(checkTypedFieldsInPage, [
            [
              {
                epoch: current.observation.epoch,
                ref: present?.ref ?? field.ref,
                fingerprint: field.fingerprint,
                expected: field.text,
                secret: field.secret,
              },
            ],
          ])
          .catch(() => undefined);
        if (Array.isArray(checked) && checked[0] === "changed")
          return this.handoff("uncertain", {
            missing: `${this.scrub(field.name || "field")} was rewritten by the page`,
          });
      }
    }
    if (action.kind === "click" && element?.href) {
      const domain = this.allowed(new URL(element.href, observation.url).href);
      if (domain) {
        this.pendingGatedAction = {
          action,
          url: observation.url,
          epoch: target!.epoch,
          ref: target!.ref,
          fingerprint: target!.fingerprint,
          role: element.role,
          name: element.name,
          ...(element.identityName ? { identityName: element.identityName } : {}),
          ...(element.formId ? { formId: element.formId } : {}),
          ...(element.containerText ? { containerText: element.containerText } : {}),
          ...(element.itemPosition !== undefined ? { itemPosition: element.itemPosition } : {}),
          reason: `domain:${domain}`,
        };
        return this.handoff("confirm_required", { domain, targetName: element.name });
      }
    }
    const submitButton =
      (action.kind === "submit" ||
        (action.kind === "type" && action.submit === true) ||
        (action.kind === "key" && entersForm(action.name))) &&
      element?.formId
        ? observation.elements.find(
            (item) =>
              item.formId === element.formId &&
              ((item.tag === "button" &&
                (item.inputType === undefined || item.inputType === "submit")) ||
                (item.tag === "input" && ["submit", "image"].includes(item.inputType ?? ""))) &&
              irreversibleActionMatch(item),
          )
        : undefined;
    const matched = submitButton
      ? irreversibleActionMatch(submitButton)
      : action.kind === "key"
        ? element && activatesFocus(action.name)
          ? irreversibleActionMatch(element)
          : undefined
        : element && irreversibleActionMatch(element);
    if (matched && !this.constraints.allow_irreversible && !approved) {
      this.pendingGatedAction = {
        action,
        url: observation.url,
        epoch: target!.epoch,
        ref: target!.ref,
        fingerprint: target!.fingerprint,
        role: element!.role,
        name: element!.name,
        ...(element!.identityName ? { identityName: element!.identityName } : {}),
        ...(element!.formId ? { formId: element!.formId } : {}),
        ...(element!.containerText ? { containerText: element!.containerText } : {}),
        ...(element!.itemPosition !== undefined ? { itemPosition: element!.itemPosition } : {}),
        reason: matched,
      };
      return this.handoff("confirm_required", {
        targetName: submitButton?.name ?? element?.name,
        matched,
      });
    }
    const values = await this.valueFor(action);
    if ("status" in values) return values as SessionResult;
    if (action.kind === "type" && element && expectedDateFormat(element.inputType ?? "")) {
      const supplied = action.text ?? (action.valueKey ? values[action.valueKey] : undefined);
      if (!normalizeDateLike(element.inputType!, supplied ?? ""))
        return this.handoff("uncertain", {
          missing: `${element.name || "field"} expects ${expectedDateFormat(element.inputType!)}`,
        });
    }
    const started = this.deps.now();
    const actionVersion = this.navigationVersion;
    // An action-triggered navigation may wait on a slow server, so allow more than the observe path.
    this.staleRecoveryDeadline = started + Math.min(this.navigationTimeoutMs, 10_000);
    let result: ActionResult;
    try {
      result = await this.deps.executeAction(this.page, observation, action, values, {
        navigationTimeoutMs: this.navigationTimeoutMs,
        waitTimeoutMs: Math.max(
          0,
          Math.min(3000, this.budget.seconds * 1000 - (this.deps.now() - this.invocationStarted)),
        ),
        actionabilityTimeoutMs: Math.max(
          1,
          Math.min(
            this.actionabilityTimeoutMs,
            this.budget.seconds * 1000 - (this.deps.now() - this.invocationStarted),
          ),
        ),
        strictIdentity: approved || Boolean(matched) || Boolean(this.pendingGatedAction),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "UnknownKeyError")
        return this.handoff("uncertain", { missing: error.message });
      if (!this.staleFrame(error)) throw error;
      await this.waitForDocumentCommit(actionVersion);
      const refreshed = await this.fresh();
      this.queuedSample = refreshed;
      return undefined;
    }
    const ms = Math.max(0, this.deps.now() - started);
    this.lastExecutedActionAt = this.deps.now();
    if (
      action.kind === "type" &&
      element &&
      expectedDateFormat(element.inputType ?? "") &&
      ["disabled", "not-editable", "value-not-set"].includes(result.outcome)
    )
      return this.handoff("uncertain", {
        missing: `${element.name || "field"} could not retain the value; expected ${expectedDateFormat(element.inputType!)}`,
      });
    const waitMs = result.timings.waitMs ?? 0;
    // For WAIT the executor reports the same interval as both waitMs and settleMs; count it once.
    this.browserMs +=
      result.timings.inputMs + result.timings.settleMs + (action.kind === "wait" ? 0 : waitMs);
    this.harnessMs += result.timings.harnessMs;
    if (batchStep === undefined) {
      this.steps++;
      this.invocationSteps++;
    }
    this.trace.push({
      step: batchStep ?? this.steps,
      op: action.kind,
      ...(element ? { target: { role: element.role, name: this.scrub(element.name) } } : {}),
      ...(confidence === undefined ? {} : { confidence }),
      ...(result.coveredBy
        ? { coveredBy: { role: result.coveredBy.role, name: this.scrub(result.coveredBy.name) } }
        : {}),
      outcome: result.outcome,
      ...(result.drift ? { drift: true } : {}),
      ms,
      waitMs: result.timings.waitMs ?? 0,
      ...(this.usageDetail
        ? {
            phases: {
              precheck: Math.round(result.timings.precheckMs),
              input: Math.round(result.timings.inputMs),
              settle: Math.round(result.timings.settleMs),
              ...(result.timings.waitMs === undefined
                ? {}
                : { wait: Math.round(result.timings.waitMs) }),
              ...(result.timings.resolveMs === undefined
                ? {}
                : { resolve: Math.round(result.timings.resolveMs) }),
              ...(result.timings.observeMs === undefined
                ? {}
                : { observe: Math.round(result.timings.observeMs) }),
              ...(result.timings.observeFramesMs === undefined
                ? {}
                : { frames: Math.round(result.timings.observeFramesMs) }),
              ...(result.timings.observeChildFramesMs === undefined
                ? {}
                : { children: Math.round(result.timings.observeChildFramesMs) }),
              harness: Math.round(result.timings.harnessMs),
            },
          }
        : {}),
    });
    this.recentActions.push(result);
    if (action.kind === "type" && ["changed", "unchanged"].includes(result.outcome)) {
      const typed = action.text ?? (action.valueKey ? values[action.valueKey] : undefined);
      const valueKey =
        action.valueKey &&
        Object.keys(this.values).find(
          (key) => normalizedKey(key) === normalizedKey(action.valueKey!),
        );
      if (
        typed !== undefined &&
        !this.secretLiterals.has(typed) &&
        (action.text !== undefined ||
          (valueKey !== undefined && typeof this.values[valueKey] === "string"))
      )
        this.typedTexts.push({ text: typed, url: observation.url });
      if (
        typed !== undefined &&
        element &&
        (action.text !== undefined || action.valueKey !== undefined)
      ) {
        const secret =
          element.inputType === "password" ||
          (valueKey !== undefined && isSecret(this.values[valueKey]!));
        this.typedFields.push({
          text: typed,
          secret,
          name: element.name,
          fingerprint: element.fingerprint,
          ref: element.ref,
          url: observation.url,
          ...(action.valueKey ? { valueKey: action.valueKey } : {}),
        });
      }
    }
    if (action.kind === "type" && result.changes.value && action.valueKey) {
      this.consumedKeys.add(action.valueKey);
      this.consumedFields.set(action.valueKey, element?.name ?? "a field");
      const canonical = Object.keys(this.values).find(
        (key) => normalizedKey(key) === normalizedKey(action.valueKey!),
      );
      if (canonical) {
        this.consumedKeys.add(canonical);
        this.consumedFields.set(canonical, element?.name ?? "a field");
      }
    }
    if (action.kind === "type" && !action.submit && result.changes.value && element)
      this.lastFilled = {
        fingerprint: element.fingerprint,
        ...(element.formId ? { formId: element.formId } : {}),
      };
    else if (action.kind === "submit" || (action.kind === "type" && action.submit))
      delete this.lastFilled;
    if (
      result.popup === undefined &&
      result.changes.url === false &&
      (action.kind === "submit" || (action.kind === "type" && action.submit)) &&
      element &&
      element.inputType !== "password"
    ) {
      const value =
        action.kind === "type"
          ? (action.text ?? (action.valueKey ? values[action.valueKey] : undefined))
          : element.value;
      if (typeof value === "string" && !this.secretLiterals.has(value))
        this.futileSubmits.push({ url: observation.url, value });
    }
    this.recentActions = this.recentActions.slice(-2);
    if (result.dialog) this.pendingDialog = result.dialog;
    if (this.pendingDialog) {
      const mapped = blockingHandoff({
        kind: "dialog",
        level: "blocking",
        evidence: [],
        dialog: this.pendingDialog,
      });
      if (mapped.type === "handoff") return this.handoff(mapped.reason, mapped.details);
    }
    if (this.popups.length) {
      const popup = this.popups.at(-1)!;
      this.detach(this.page);
      this.page = popup;
      this.attach(popup);
      if (this.pendingPopup?.page === popup) this.pendingPopup = undefined;
    }
    if (result.outcome === "covered" && element) {
      if (
        action.kind === "click" &&
        result.coveredBy &&
        ["div", "span", "p", "section", "ul", "li"].includes(result.coveredBy.role) &&
        // Only a real submit control (input type=submit, or a <button> whose type is submit by default):
        // pressing Enter in the filled field does the same thing. A type="button" control must not submit.
        element.inputType === "submit" &&
        element.formId &&
        observation.elements.some(
          (item) =>
            item.formId === element.formId &&
            item.value &&
            !this.futileSubmits.some(
              (entry) => entry.url === observation.url && entry.value === item.value,
            ) &&
            (item.tag === "input" || item.tag === "textarea"),
        )
      ) {
        const field = observation.elements.find(
          (item) =>
            item.formId === element.formId &&
            item.value &&
            !this.futileSubmits.some(
              (entry) => entry.url === observation.url && entry.value === item.value,
            ) &&
            (item.tag === "input" || item.tag === "textarea"),
        );
        if (field)
          return this.execute(
            {
              kind: "submit",
              target: { epoch: observation.epoch, ref: field.ref, fingerprint: field.fingerprint },
            },
            confidence,
            approved,
            batchStep ?? this.steps,
            true,
          );
      }
      if (this.lastCoveredTarget === element.fingerprint)
        return this.handoff("stuck", { targetName: element.name, coveredBy: result.coveredBy });
      this.lastCoveredTarget = element.fingerprint;
      if (
        !retriedStale &&
        result.coveredBy &&
        ["listbox", "menu", "tooltip", "combobox"].includes(result.coveredBy.role)
      ) {
        await this.page.key("Escape");
        const refreshed = await this.fresh();
        const retry = this.retargetAction(action, element, refreshed.observation);
        if (retry) return this.execute(retry, confidence, approved, batchStep ?? this.steps, true);
      }
    } else delete this.lastCoveredTarget;
    const next = await this.fresh();
    const outside = this.allowed(next.observation.url);
    if (outside) return this.handoff("confirm_required", { domain: outside });
    if (await this.verified(next.observation))
      return this.result("DONE_VERIFIED", "success_assertions_met");
    if (result.outcome === "stale" && !retriedStale && element) {
      const refreshed = this.retargetAction(action, element, next.observation);
      if (refreshed)
        return this.execute(refreshed, confidence, approved, batchStep ?? this.steps, true);
    }
    if (batchStep === undefined && this.exceeded())
      return this.result("BUDGET_EXHAUSTED", "budget_exhausted");
    this.queuedSample = next;
    return undefined;
  }
  async run(): Promise<SessionResult> {
    this.beginInvocation();
    if (this.blockedByPolicy) return this.result("BLOCKED_BY_POLICY", "blocked_address");
    const unresponsive = await this.checkPageLiveness();
    if (unresponsive && unresponsive.reason !== "isolated_reopen") return unresponsive;
    return this.runLoop();
  }
  private async runLoop(): Promise<SessionResult> {
    if (this.closed) return this.result("FAILED", "session_closed");
    this.touch();
    const version = this.navigationVersion;
    try {
      if (this.initialNavigationFailure) {
        const failure = this.initialNavigationFailure.failure;
        const handoff = await this.handoff("error_page", { failure });
        delete this.initialNavigationFailure;
        return handoff;
      }
      if (this.exceeded()) return this.result("BUDGET_EXHAUSTED", "budget_exhausted");
      for (;;) {
        let sampled = await this.fresh(this.queuedSample);
        delete this.queuedSample;
        sampled = await this.waitForContent(sampled);
        if (!sampled.observation.elements.length && !sampled.observation.text.trim())
          return this.handoff("uncertain", {
            missing: "page appears empty",
            url: sampled.observation.url,
            title: sampled.observation.title,
          });
        const outside = this.allowed(sampled.observation.url);
        if (outside) return this.handoff("confirm_required", { domain: outside });
        if (await this.verified(sampled.observation))
          return this.result("DONE_VERIFIED", "success_assertions_met");
        sampled = await this.fresh(sampled);
        const blocked = await this.blocking(sampled);
        if (blocked.handoff) return blocked.handoff;
        sampled = blocked.sampled;
        sampled = await this.fresh(sampled);
        const afterWindowDomain = this.allowed(sampled.observation.url);
        if (afterWindowDomain)
          return this.handoff("confirm_required", { domain: afterWindowDomain });
        if (await this.verified(sampled.observation))
          return this.result("DONE_VERIFIED", "success_assertions_met");
        sampled = await this.fresh(sampled);
        if (this.exceeded()) return this.result("BUDGET_EXHAUSTED", "budget_exhausted");
        const observation = sampled.observation;
        const findings = sampled.findings.filter(
          (finding) => !(finding.kind === "login_wall" && this.hasOriginSecret(observation.url)),
        );
        const context: PolicyInput = {
          observation: this.sanitizedObservation(observation),
          findings,
          goal: this.goal,
          acceptanceHints: this.acceptanceHints,
          trace: this.trace.map((entry) => ({
            op: entry.op,
            targetName: entry.target?.name ?? "",
            outcome: entry.outcome,
            ...(entry.coveredBy ? { coveredBy: entry.coveredBy } : {}),
          })),
          valueKeys: Object.entries(this.values)
            .filter(([name]) => !this.consumedKeys.has(name))
            .map(([name, value]) => ({
              name,
              secret: isSecret(value),
            })),
          // Every value this session typed, on any URL: an SPA may change the URL while a field keeps our value.
          typedValues: this.typedTexts.map((entry) => entry.text),
          futileSubmits: this.futileSubmits,
          step: this.steps + 1,
          allowIrreversible: this.constraints.allow_irreversible,
          credentialsAvailable: this.hasOriginSecret(observation.url),
          ...(this.lastFilled ? { lastFilled: this.lastFilled } : {}),
          ...(this.thresholds ? { thresholds: this.thresholds } : {}),
          ...(this.decisionProvider ? { provider: this.decisionProvider } : {}),
          ...(this.decisionContextLimit !== undefined
            ? { contextLimit: this.decisionContextLimit }
            : {}),
        };
        const { state, questions, reductions } = this.deps.buildDecisionState(context);
        const decisionRequest: DecisionRequest = { state, questions };
        const decisionStarted = this.deps.now();
        let decision: DecisionResult;
        this.callDecisions++;
        this.sessionDecisions++;
        try {
          decision = await this.decideWithinBudget(decisionRequest);
        } catch (error) {
          await this.logDecisionFailure(decisionRequest, error, decisionStarted);
          if (
            this.exceeded() ||
            (error instanceof DecisionAbortedError && error.message === "session budget exhausted")
          )
            return this.result("BUDGET_EXHAUSTED", "budget_exhausted");
          return this.decisionFailure(error, reductions);
        }
        this.decideMs += Math.max(decision.latencyMs, this.deps.now() - decisionStarted);
        this.decisionTokens += decision.usage.inputTokens + decision.usage.outputTokens;
        this.recordDecisionUsage(decision);
        if (this.sampleVersion !== this.navigationVersion) continue;
        try {
          validateAnswers(questions, decision.answers);
        } catch (error) {
          return error instanceof InvalidAnswerError
            ? this.decisionFailure(error)
            : this.result("FAILED", "decision_invalid_answer", { failure: failureDetails(error) });
        }
        if (this.exceeded()) return this.result("BUDGET_EXHAUSTED", "budget_exhausted");
        let outcome: PolicyOutcome = this.deps.interpret(questions, decision.answers, context);
        let checkRequest: DecisionRequest | undefined;
        let checkedDecision: DecisionResult | undefined;
        if (outcome.type === "check") {
          const checkQuestions = this.deps.checkQuestions(outcome);
          checkRequest = { state, questions: checkQuestions };
          let checked: DecisionResult;
          const checkStarted = this.deps.now();
          this.callDecisions++;
          this.sessionDecisions++;
          try {
            checked = await this.decideWithinBudget(checkRequest);
          } catch (error) {
            await this.logDecisionFailure(checkRequest, error, checkStarted);
            if (
              this.exceeded() ||
              (error instanceof DecisionAbortedError &&
                error.message === "session budget exhausted")
            )
              return this.result("BUDGET_EXHAUSTED", "budget_exhausted");
            return this.decisionFailure(error, [], true);
          }
          checkedDecision = checked;
          this.decideMs += Math.max(checked.latencyMs, this.deps.now() - checkStarted);
          this.decisionTokens += checked.usage.inputTokens + checked.usage.outputTokens;
          this.recordDecisionUsage(checked);
          try {
            validateAnswers(checkQuestions, checked.answers);
          } catch (error) {
            return error instanceof InvalidAnswerError
              ? this.decisionFailure(error, [], true)
              : this.result("FAILED", "decision_invalid_answer", {
                  failure: failureDetails(error),
                });
          }
          if (this.sampleVersion !== this.navigationVersion) continue;
          if (this.exceeded()) return this.result("BUDGET_EXHAUSTED", "budget_exhausted");
          outcome = this.deps.resolveCheck(
            outcome,
            checked.answers,
            questions,
            decision.answers,
            context,
          );
          if (outcome.type === "check") {
            await appendCalibrationRecord(
              this.decisionLogPath,
              calibrationRequestRecord({
                session: this.id,
                step: this.steps + 1,
                request: checkRequest,
                answers: checkedDecision!.answers,
                outcome: "handed_off",
                latencyMs: checkedDecision!.latencyMs,
                attempts: checkedDecision!.attempts,
              }),
            );
            return this.handoff("uncertain", { missing: "candidate check did not resolve" });
          }
        }
        const logOutcome = outcome.type === "handoff" ? "handed_off" : "executed";
        await appendCalibrationRecord(
          this.decisionLogPath,
          calibrationRequestRecord({
            session: this.id,
            step: this.steps + 1,
            request: decisionRequest,
            answers: decision.answers,
            outcome: logOutcome,
            latencyMs: decision.latencyMs,
            attempts: decision.attempts,
          }),
        );
        if (checkRequest && checkedDecision)
          await appendCalibrationRecord(
            this.decisionLogPath,
            calibrationRequestRecord({
              session: this.id,
              step: this.steps + 1,
              request: checkRequest,
              answers: checkedDecision.answers,
              outcome: logOutcome,
              latencyMs: checkedDecision.latencyMs,
              attempts: checkedDecision.attempts,
            }),
          );
        if (outcome.type === "handoff") {
          if (outcome.pendingAction && targetOf(outcome.pendingAction)) {
            const target = targetOf(outcome.pendingAction)!;
            const element = observation.elements.find((item) => item.ref === target.ref);
            if (element)
              this.pendingGatedAction = {
                action: outcome.pendingAction,
                url: observation.url,
                ...target,
                role: element.role,
                name: element.name,
                ...(element.identityName ? { identityName: element.identityName } : {}),
                ...(element.formId ? { formId: element.formId } : {}),
                ...(element.containerText ? { containerText: element.containerText } : {}),
                ...(element.itemPosition !== undefined
                  ? { itemPosition: element.itemPosition }
                  : {}),
                reason: String(outcome.details.matched ?? "irreversible"),
              };
          }
          return this.handoff(outcome.reason, outcome.details);
        }
        if (outcome.type === "done_candidate") return this.completion(outcome.goalMet);
        if (outcome.type === "batch") {
          const batchStep = this.steps + 1;
          const batchKeys = new Set<string>();
          let ranAction = false;
          this.steps++;
          this.invocationSteps++;
          for (const planned of outcome.actions) {
            if (!planned.valueKey || batchKeys.has(planned.valueKey)) continue;
            batchKeys.add(planned.valueKey);
            const current = this.lastObservation;
            const original = observation.elements.find((item) => item.ref === planned.target.ref);
            const refreshed =
              !ranAction && current?.epoch === planned.target.epoch
                ? planned
                : original && current
                  ? this.retargetAction(
                      planned,
                      original,
                      current,
                      this.typedTexts.map((entry) => entry.text),
                    )
                  : undefined;
            if (!refreshed) {
              if (!ranAction)
                return this.handoff("uncertain", { missing: "stored target changed" });
              break;
            }
            ranAction = true;
            const gate = await this.execute(
              refreshed,
              decision.answers.op?.type === "choice" ? decision.answers.op.confidence : undefined,
              false,
              batchStep,
            );
            if (gate) return gate;
            if (this.recentActions.at(-1)?.outcome !== "changed") break;
          }
          continue;
        }
        const gate = await this.execute(
          outcome.action,
          decision.answers.op?.type === "choice" ? decision.answers.op.confidence : undefined,
        );
        if (gate) return gate;
      }
    } catch (error) {
      if (error instanceof PageUnresponsiveError) {
        const recovery = await this.unresponsiveHandoff();
        return recovery.reason === "isolated_reopen" ? this.runLoop() : recovery;
      }
      if (this.staleFrame(error)) return this.recoverStale(version);
      const name = error instanceof Error ? error.name : "Error";
      const reason = /ContextLimit/u.test(name)
        ? "decision_context_limit"
        : /Circuit/u.test(name)
          ? "decision_circuit_open"
          : /InvalidAnswer/u.test(name)
            ? "decision_invalid_answer"
            : "operation_failed";
      return this.result("FAILED", reason, { failure: failureDetails(error) });
    } finally {
      this.touch();
    }
  }
  async resume(
    update: {
      values?: Record<string, SessionValue>;
      goal_update?: string;
      allow_irreversible?: boolean;
      allowed_domains?: string[];
      dialog?: { accept: boolean; value_key?: string };
    } = {},
  ): Promise<SessionResult> {
    this.beginInvocation();
    if (this.blockedByPolicy) return this.result("BLOCKED_BY_POLICY", "blocked_address");
    const unresponsive = await this.checkPageLiveness();
    if (unresponsive && unresponsive.reason !== "isolated_reopen") return unresponsive;
    Object.assign(this.values, update.values);
    for (const key of Object.keys(update.values ?? {})) this.consumedKeys.delete(key);
    if (update.goal_update !== undefined) {
      if (this.success && !this.successAssertionsIgnored && this.lastObservation) {
        this.successAssertionsIgnored = await this.verified(this.lastObservation);
        if (this.successAssertionsIgnored)
          this.successAssertionsIgnoredWhen = "when the goal was updated";
      }
      this.goal = update.goal_update;
    }
    if (update.allowed_domains?.length)
      this.constraints.allowed_domains = [
        ...new Set([...(this.constraints.allowed_domains ?? []), ...update.allowed_domains]),
      ];
    if (this.exceeded()) return this.result("BUDGET_EXHAUSTED", "budget_exhausted");
    if (update.dialog) {
      try {
        const answered = await this.answerDialog(update.dialog.accept, update.dialog.value_key);
        if (answered) return answered;
      } catch (error) {
        if (error instanceof PageUnresponsiveError) {
          const recovery = await this.unresponsiveHandoff();
          return recovery.reason === "isolated_reopen" ? this.runLoop() : recovery;
        }
        if (this.staleFrame(error)) return this.recoverStale(this.sampleVersion);
        return this.result("FAILED", "operation_failed", { failure: failureDetails(error) });
      }
    }
    const pendingAction = this.pendingGatedAction;
    const pendingAllowed =
      pendingAction &&
      (pendingAction.reason.startsWith("domain:")
        ? !this.allowed(`https://${pendingAction.reason.slice(7)}/`)
        : update.allow_irreversible === true);
    if (pendingAction && pendingAllowed) {
      const pending = pendingAction;
      delete this.pendingGatedAction;
      try {
        const current = await this.sample();
        const refreshed = samePage(pending.url, current.observation.url)
          ? this.retargetAction(pending.action, pending, current.observation)
          : undefined;
        if (!refreshed) return this.handoff("uncertain", { missing: "stored target changed" });
        const result = await this.execute(
          refreshed,
          undefined,
          pending.reason.startsWith("domain:") ? false : true,
        );
        if (result) return result;
      } catch (error) {
        if (error instanceof PageUnresponsiveError) {
          const recovery = await this.unresponsiveHandoff();
          return recovery.reason === "isolated_reopen" ? this.runLoop() : recovery;
        }
        if (this.staleFrame(error)) return this.recoverStale(this.sampleVersion);
        return this.result("FAILED", "operation_failed", { failure: failureDetails(error) });
      }
    }
    return this.runLoop();
  }
  async act(
    ops: ManualOp[],
    options: { allow_irreversible?: boolean } = {},
  ): Promise<SessionResult> {
    this.beginInvocation();
    if (this.blockedByPolicy) return this.result("BLOCKED_BY_POLICY", "blocked_address");
    this.manualOpsInProgress = true;
    const unresponsive = await this.checkPageLiveness();
    if (unresponsive) {
      this.manualOpsInProgress = false;
      return unresponsive;
    }
    const version = this.navigationVersion;
    try {
      for (const op of ops) {
        if (this.exceeded()) return this.result("BUDGET_EXHAUSTED", "budget_exhausted");
        if (op.action === "dialog") {
          if (op.accept === undefined)
            return this.handoff("uncertain", { missing: "dialog choice" });
          const answered = await this.answerDialog(op.accept, op.value_key);
          if (answered) return answered;
          const verified = await this.manualVerified();
          if (verified) return verified;
          continue;
        }
        const sampled = this.queuedSample ?? (await this.sample());
        delete this.queuedSample;
        const outside = this.allowed(sampled.observation.url);
        if (outside) return this.handoff("confirm_required", { domain: outside });
        const item = sampled.observation.elements.find((element) => element.ref === op.ref);
        if (op.ref && !item) return this.handoff("uncertain", { missing: "target missing" });
        const target = item && {
          epoch: sampled.observation.epoch,
          ref: item.ref,
          fingerprint: item.fingerprint,
        };
        if (op.action === "wait_for") {
          const timeout = Math.min(op.timeout_ms ?? 10_000, 30_000);
          if (op.delay_ms !== undefined) {
            if (op.delay_ms < 0 || op.delay_ms > 10_000)
              return this.handoff("uncertain", { missing: "delay must be <= 10s" });
            await this.deps.sleep(op.delay_ms);
          } else if (op.text !== undefined) {
            const until = this.deps.now() + timeout;
            let found = false;
            while (this.deps.now() <= until) {
              const current = await this.sample();
              found = current.observation.text.includes(op.text);
              if (found === (op.condition !== "disappears")) break;
              await this.deps.sleep(100);
            }
            if (found !== (op.condition !== "disappears"))
              return this.handoff("uncertain", { missing: "wait_for timed out" });
          } else return this.handoff("uncertain", { missing: "wait_for text or delay" });
          const verified = await this.manualVerified();
          if (verified) return verified;
          continue;
        }
        if ((op.action === "hover" || op.action === "upload" || op.action === "drag") && !item)
          return this.handoff("uncertain", { missing: "target missing" });
        if (op.action === "drag") {
          const destination = sampled.observation.elements.find(
            (element) => element.ref === op.to_ref,
          );
          if (!destination)
            return this.handoff("uncertain", { missing: "drag destination missing" });
          const from = item!.clickRect ?? item!.rect;
          const to = destination.clickRect ?? destination.rect;
          await this.page.drag(
            { x: from.x + from.width / 2, y: from.y + from.height / 2 },
            { x: to.x + to.width / 2, y: to.y + to.height / 2 },
          );
          const verified = await this.manualVerified();
          if (verified) return verified;
          continue;
        }
        if (op.action === "hover") {
          const rect = item!.clickRect ?? item!.rect;
          await this.page.hover(rect.x + rect.width / 2, rect.y + rect.height / 2);
          const verified = await this.manualVerified();
          if (verified) return verified;
          continue;
        }
        if (op.action === "upload") {
          if (!this.page.capabilities.fileUpload)
            return this.handoff("uncertain", { missing: "file upload is unavailable" });
          if (!this.uploadDirectory || !op.paths?.length || item!.inputType !== "file")
            return this.handoff("uncertain", {
              missing: "upload requires file input and JEVPILOT_UPLOAD_DIR",
            });
          const root = await realpath(this.uploadDirectory).catch(() => undefined);
          if (!root)
            return this.handoff("uncertain", {
              missing: "JEVPILOT_UPLOAD_DIR is unavailable",
            });
          const files: string[] = [];
          for (const candidate of op.paths) {
            const file = await realpath(candidate).catch(() => "");
            const relativePath = file ? relative(root, file) : "";
            if (
              !file ||
              !relativePath ||
              relativePath === ".." ||
              relativePath.startsWith(`..${sep}`) ||
              isAbsolute(relativePath)
            )
              return this.handoff("uncertain", {
                missing: "upload path is outside JEVPILOT_UPLOAD_DIR",
              });
            files.push(file);
          }
          await this.page.setInputFiles(
            (ref: string) => {
              const registry = (
                globalThis as typeof globalThis & {
                  __jevpilotObserverRegistry?: { refs: Map<string, WeakRef<Element>> };
                }
              ).__jevpilotObserverRegistry;
              return registry?.refs.get(ref)?.deref() ?? null;
            },
            [op.ref!],
            files,
          );
          const verified = await this.manualVerified();
          if (verified) return verified;
          continue;
        }
        let action: Action;
        if (op.action === "click" && target) action = { kind: "click", target };
        else if (op.action === "type" && target && (op.value_key || op.text !== undefined)) {
          if (op.text !== undefined && item?.inputType === "password")
            return this.handoff("needs_values", { literalText: false });
          action = {
            kind: "type",
            target,
            ...(op.value_key ? { valueKey: op.value_key } : { text: op.text! }),
            ...(op.submit ? { submit: true } : {}),
          };
        } else if (op.action === "toggle" && target) action = { kind: "toggle", target };
        else if (op.action === "select" && target && op.option_label)
          action = { kind: "select", target, optionLabel: op.option_label };
        else if (op.action === "scroll" && op.direction)
          action = { kind: "scroll", direction: op.direction };
        else if (op.action === "back") action = { kind: "back" };
        else if (op.action === "wait") action = { kind: "wait" };
        else if ((op.action === "key" || op.action === "press_key") && (op.name ?? op.key))
          action = { kind: "key", name: (op.name ?? op.key)! };
        else {
          const missing: Record<string, string> = {
            click: "click needs ref",
            type: "type needs ref and text or value_key",
            toggle: "toggle needs ref",
            select: "select needs ref and option_label",
            scroll: "scroll needs direction (up or down)",
            key: 'key needs name (e.g. {"action":"key","name":"Enter"})',
            press_key: 'press_key needs name (e.g. {"action":"press_key","name":"Enter"})',
          };
          return this.handoff("uncertain", {
            missing: missing[op.action] ?? `${op.action} needs valid fields`,
          });
        }
        if (action.kind === "key" && op.ref) {
          const focused = await this.page.callIsolated(focusObservedRef, [
            sampled.observation.epoch,
            op.ref,
          ]);
          if (!focused) return this.handoff("uncertain", { missing: "target cannot be focused" });
        }
        if (action.kind === "key" && activatesFocus(action.name)) {
          const focusedRef =
            op.ref ??
            (await this.page
              .callIsolated(focusedObservedRef, [sampled.observation.epoch])
              .catch(() => undefined));
          const focused = sampled.observation.elements.find(
            (element) => element.ref === focusedRef,
          );
          // Enter submits the focused field's form; Enter or Space on a focused control clicks it.
          // Either is gated like the click or submit it stands for.
          if (
            focused &&
            ((entersForm(action.name) && focused.formId) || irreversibleActionMatch(focused))
          )
            action = {
              ...action,
              target: {
                epoch: sampled.observation.epoch,
                ref: focused.ref,
                fingerprint: focused.fingerprint,
              },
            };
        }
        const beforeStep = this.steps;
        const outcome = await this.execute(
          action,
          undefined,
          options.allow_irreversible === true,
          undefined,
          false,
          true,
        );
        if (
          this.steps > beforeStep &&
          this.pendingGatedAction &&
          targetOf(action)?.ref === this.pendingGatedAction.ref
        )
          delete this.pendingGatedAction;
        if (outcome) return outcome;
      }
      return this.result("RUNNING", "manual_actions_complete");
    } catch (error) {
      if (error instanceof PageUnresponsiveError) return this.unresponsiveHandoff();
      if (this.staleFrame(error)) return this.recoverStale(version);
      return this.result("FAILED", "operation_failed", { failure: failureDetails(error) });
    } finally {
      this.manualOpsInProgress = false;
    }
  }
  private async manualVerified(): Promise<SessionResult | undefined> {
    const sampled = await this.sample();
    return (await this.verified(sampled.observation))
      ? this.result("DONE_VERIFIED", "success_assertions_met")
      : undefined;
  }
  async observe(detail: "compact" | "full" = "compact"): Promise<SessionResult> {
    this.beginInvocation();
    if (this.blockedByPolicy) return this.result("BLOCKED_BY_POLICY", "blocked_address");
    this.switchPendingPopup();
    const unresponsive = await this.checkPageLiveness();
    if (unresponsive && unresponsive.reason !== "isolated_reopen") return unresponsive;
    const version = this.navigationVersion;
    try {
      delete this.queuedSample;
      const sampled = await this.sample(
        detail === "full" ? { maxTextChars: 20_000, maxElements: 255 } : {},
      );
      if (await this.verified(sampled.observation))
        return this.result("DONE_VERIFIED", "success_assertions_met");
      const blocker = this.topBlocker(sampled.findings);
      if (blocker) {
        const mapped = blockingHandoff(blocker);
        if (mapped.type === "handoff") return this.handoff(mapped.reason, mapped.details);
      }
      const result = await this.result("RUNNING", "observation");
      if (detail === "full")
        result.snapshot = this.scrub(
          formatObservation(this.sanitizedObservation(this.lastObservation!), {
            maxTokens: Infinity,
          }),
        );
      return result;
    } catch (error) {
      if (error instanceof PageUnresponsiveError) return this.unresponsiveHandoff();
      if (this.staleFrame(error)) return this.recoverStale(version);
      return this.result("FAILED", "operation_failed", { failure: failureDetails(error) });
    }
  }
  async navigate(url: string): Promise<SessionResult> {
    this.beginInvocation();
    if (!/^https?:$/u.test(new URL(url).protocol))
      return this.handoff("uncertain", { missing: "Only http: and https: URLs may be navigated." });
    const requestedDomain = this.allowed(url);
    if (requestedDomain) return this.handoff("confirm_required", { domain: requestedDomain });
    const navigationStarted = this.deps.now();
    const version = this.navigationVersion;
    let navigation: NavigationResult;
    const replace =
      this.pageUnresponsive && this.page.capabilities.isolatedContexts && this.openIsolatedPage;
    try {
      navigation = replace
        ? await this.replaceUnresponsivePage(url)
        : await this.page.navigate(url, { timeoutMs: this.navigationTimeoutMs });
    } catch (error) {
      // The hung tab is still the session page when opening a replacement fails.
      if (replace) return this.unresponsiveHandoff();
      if (error instanceof PageUnresponsiveError) return this.unresponsiveHandoff();
      if (this.staleFrame(error)) return this.recoverStale(version);
      throw error;
    }
    // A load timeout alone is not "not responding": slow sites commit late but stay interactive (M6d).
    // Only a page that also fails a quick liveness call is handed off as unresponsive.
    if (navigation.failure === "timeout") {
      const alive = await this.page
        .callIsolated(() => true, [], { timeoutMs: 2000 })
        .then(
          () => true,
          (error: unknown) => !(error instanceof PageUnresponsiveError),
        );
      if (!alive) return this.unresponsiveHandoff();
    }
    this.pageUnresponsive = false;
    this.browserMs += Math.max(0, this.deps.now() - navigationStarted);
    this.navigation = navigation;
    // Report where the navigation landed (for example a redirect to a login page), not the old page:
    // the previous snapshot and title belong to a page that is gone.
    if (
      (navigation.status ?? 0) >= 400 ||
      (navigation.failure && navigation.failure !== "timeout")
    ) {
      delete this.lastObservation;
      delete this.queuedSample;
    }
    if ((navigation.status ?? 0) >= 400)
      return this.handoff("error_page", { status: navigation.status, url: navigation.url });
    if (navigation.failure && navigation.failure !== "timeout")
      return this.handoff("error_page", { failure: navigation.failure, url: navigation.url });
    if (navigation.failure === "timeout") {
      let sampled;
      try {
        sampled = await this.sample();
      } catch (error) {
        if (error instanceof PageUnresponsiveError) return this.unresponsiveHandoff();
        if (this.staleFrame(error)) return this.recoverStale(version);
        throw error;
      }
      if (!sampled.observation.elements.length && !sampled.observation.text.trim())
        return this.handoff("error_page", { failure: navigation.failure, url: navigation.url });
    }
    const outside = this.allowed(navigation.url);
    if (outside) return this.handoff("confirm_required", { domain: outside });
    // observe() starts a new invocation; carry the browser time spent so far into it.
    this.carriedBrowserMs += this.browserMs;
    return this.observe("compact");
  }
  async listTabs(): Promise<{ tab_id: string; url: string; selected: boolean }[]> {
    return Promise.all(
      [...this.ownedPages].map(async (page) => ({
        tab_id: page.id,
        url: this.scrub(
          await (page.targetUrl?.() ?? page.callIsolated(() => location.href, [])).catch(() => ""),
        ),
        selected: page === this.page,
      })),
    );
  }
  async selectTab(tabId: string): Promise<SessionResult> {
    const page = [...this.ownedPages].find((candidate) => candidate.id === tabId);
    if (!page) return this.handoff("uncertain", { missing: "tab not found" });
    if (page !== this.page) {
      this.detach(this.page);
      this.page = page;
      this.attach(page);
      delete this.queuedSample;
      delete this.lastObservation;
    }
    return this.observe("compact");
  }
  async closeTab(tabId: string): Promise<SessionResult> {
    const page = [...this.ownedPages].find((candidate) => candidate.id === tabId);
    if (!page) return this.handoff("uncertain", { missing: "tab not found" });
    if (this.ownedPages.size === 1)
      return this.handoff("uncertain", { missing: "cannot close the only tab" });
    this.detach(page);
    await page.close();
    this.ownedPages.delete(page);
    if (this.page === page) {
      this.page = [...this.ownedPages][0]!;
      this.attach(this.page);
      delete this.queuedSample;
      delete this.lastObservation;
    }
    return this.observe("compact");
  }
  async reclaimIdle(): Promise<boolean> {
    if (this.closed || this.deps.now() - this.updatedAt < this.idleTimeoutMs) return false;
    await this.close();
    return true;
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.detach(this.page);
    this.closing = (async () => {
      try {
        await Promise.all([...this.ownedPages].map((page) => page.close()));
      } finally {
        await Promise.allSettled([...this.screenshotWrites]);
        if (this.directory) await rm(this.directory, { recursive: true, force: true });
      }
    })();
    return this.closing;
  }
}
