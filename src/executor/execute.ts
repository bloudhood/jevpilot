import type { PageHandle, PageEvents, InputResult } from "../engine/types.ts";
import { NavigationInProgressError, PageUnresponsiveError } from "../engine/types.ts";
import { observe } from "../observer/observe.ts";
import { focusRef, resolveRef, waitForRef } from "../observer/page-snapshot.ts";
import type { Observation, RefResolution } from "../observer/types.ts";
import { ActionValidationError, type Action, type ActionResult } from "./types.ts";

const emptyChanges = (): ActionResult["changes"] => ({
  url: false,
  pageHash: false,
  value: false,
  checked: false,
});

const dateFormats: Record<string, string> = {
  date: "YYYY-MM-DD",
  time: "HH:MM or HH:MM:SS",
  "datetime-local": "YYYY-MM-DDTHH:MM",
  month: "YYYY-MM",
  week: "YYYY-Www",
};

export function expectedDateFormat(type: string): string | undefined {
  return dateFormats[type];
}

export function normalizeDateLike(type: string, value: string): string | undefined {
  const date = (source: string): string | undefined => {
    const match =
      /^(\d{4})[-/.](\d{2})[-/.](\d{2})$/u.exec(source) ??
      /^(\d{4})年(\d{1,2})月(\d{1,2})日$/u.exec(source);
    if (!match) return undefined;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const actual = new Date(Date.UTC(year, month - 1, day));
    if (
      year < 1 ||
      actual.getUTCFullYear() !== year ||
      actual.getUTCMonth() + 1 !== month ||
      actual.getUTCDate() !== day
    )
      return undefined;
    return `${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  };
  const time = (source: string): string | undefined => {
    const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(source);
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] ?? 0) > 59)
      return undefined;
    return source;
  };
  if (type === "date") return date(value);
  if (type === "time") return time(value);
  if (type === "month") {
    const match = /^(\d{4})-(\d{2})$/u.exec(value);
    return match && Number(match[2]) >= 1 && Number(match[2]) <= 12 ? value : undefined;
  }
  if (type === "week") {
    const match = /^(\d{4})-W(\d{2})$/u.exec(value);
    return match && Number(match[2]) >= 1 && Number(match[2]) <= 53 ? value : undefined;
  }
  if (type === "datetime-local") {
    const match = /^(.+)[T ](\d{2}:\d{2}(?::\d{2})?)$/u.exec(value);
    const day = match && date(match[1]!);
    const clock = match && time(match[2]!);
    return day && clock ? `${day}T${clock}` : undefined;
  }
  return undefined;
}

function setDateLikeInPage(epoch: number, ref: string, value: string): boolean {
  const registry = (
    globalThis as typeof globalThis & {
      __jevpilotObserverRegistry?: { epoch: number; refs: Map<string, WeakRef<Element>> };
    }
  ).__jevpilotObserverRegistry;
  const element = registry?.epoch === epoch ? registry.refs.get(ref)?.deref() : undefined;
  if (!(element instanceof HTMLInputElement) || element.disabled || element.readOnly) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) return false;
  // Focus first, as a user would, so a following Enter (submit) goes to this field.
  element.focus();
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return (
    element.value === value &&
    element.validity.rangeUnderflow === false &&
    element.validity.rangeOverflow === false
  );
}

export function selectKeySteps(current: number, target: number): ("ArrowUp" | "ArrowDown")[] {
  return Array.from({ length: Math.abs(target - current) }, () =>
    target < current ? "ArrowUp" : "ArrowDown",
  );
}

export function diffState(
  before: Observation,
  after: Observation,
  previous?: RefResolution,
  next?: RefResolution,
): ActionResult["changes"] {
  return {
    url: before.url !== after.url,
    pageHash: before.pageHash !== after.pageHash,
    value:
      previous !== undefined &&
      next !== undefined &&
      (previous.value !== next.value ||
        previous.valueLength !== next.valueLength ||
        next.valueChanged === true ||
        previous.selectedLabel !== next.selectedLabel),
    checked: previous !== undefined && next !== undefined && previous.checked !== next.checked,
  };
}

export function settleStrategy(action: Action, role?: string): "suggestions" | "normal" {
  return action.kind === "type" && (role === "combobox" || role === "searchbox")
    ? "suggestions"
    : "normal";
}

function validate(action: Action, values: Readonly<Record<string, string>>): string | undefined {
  switch (action.kind) {
    case "click":
    case "toggle":
    case "select":
    case "type":
    case "submit":
      if (
        !Number.isSafeInteger(action.target.epoch) ||
        !action.target.ref ||
        !action.target.fingerprint
      )
        throw new ActionValidationError("invalid-action", "invalid target");
      if (action.kind === "type") {
        if (action.text !== undefined) return action.text;
        if (
          !action.valueKey ||
          !Object.hasOwn(values, action.valueKey) ||
          typeof values[action.valueKey] !== "string"
        )
          throw new ActionValidationError("missing-value", "valueKey was not supplied");
        return values[action.valueKey];
      }
      if (action.kind === "select" && !action.optionLabel)
        throw new ActionValidationError("invalid-action", "missing option label");
      return undefined;
    case "scroll":
      if (action.direction !== "up" && action.direction !== "down")
        throw new ActionValidationError("invalid-action", "invalid scroll direction");
      return undefined;
    case "key":
      if (!action.name) throw new ActionValidationError("invalid-action", "missing key name");
      return undefined;
    case "back":
    case "wait":
      return undefined;
    default: {
      const neverAction: never = action;
      throw new ActionValidationError(
        "invalid-action",
        `unsupported action: ${String(neverAction)}`,
      );
    }
  }
}

function isTargeted(action: Action): action is Extract<Action, { target: unknown }> {
  return "target" in action;
}

async function settleInPage(
  suggestions: boolean,
  waitUrl?: string | null,
  waitTimeoutMs?: number | null,
): Promise<void> {
  const state = globalThis as typeof globalThis & {
    __jevpilotMutationState?: { count: number; observer: MutationObserver };
  };
  const tracker = state.__jevpilotMutationState;
  // This function is serialized into the page on its own: everything it calls must be defined inside it,
  // and an undefined argument arrives as null.
  if (typeof waitUrl === "string") {
    // WAIT: return as soon as the page changes (DOM, URL or a field value), at most waitTimeoutMs.
    await new Promise<void>((resolve) => {
      const fieldState = (): string =>
        Array.from(document.querySelectorAll("input, textarea, select"), (element) => {
          const field = element as HTMLInputElement;
          return `${field.value}:${field.checked}`;
        }).join("|");
      const initialFields = fieldState();
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      };
      const observer = new MutationObserver(finish);
      observer.observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      const poll = setInterval(() => {
        if (location.href !== waitUrl || fieldState() !== initialFields) finish();
      }, 50);
      const timer = setTimeout(finish, waitTimeoutMs ?? 3000);
    });
    tracker?.observer.disconnect();
    delete state.__jevpilotMutationState;
    return;
  }
  const initial = 0;
  const started = performance.now();
  const initialSuggestions = document.querySelectorAll(
    '[role="option"], [role="listbox"], [role="suggestion"]',
  ).length;
  await new Promise<void>((resolve) => {
    let frames = 0;
    let lastMutation = performance.now();
    let lastCount = initial;
    const check = (): void => {
      const elapsed = performance.now() - started;
      if (
        suggestions &&
        document.querySelectorAll('[role="option"], [role="listbox"], [role="suggestion"]').length >
          initialSuggestions
      ) {
        resolve();
        return;
      }
      if ((tracker?.count ?? 0) !== lastCount) {
        lastCount = tracker?.count ?? 0;
        lastMutation = performance.now();
      }
      if (!suggestions && lastCount > initial && performance.now() - lastMutation >= 100) {
        resolve();
        return;
      }
      if (suggestions && elapsed >= 200) {
        resolve();
        return;
      }
      if (!suggestions && lastCount === initial && (frames >= 2 || elapsed >= 50)) {
        resolve();
        return;
      }
      if (!suggestions && elapsed >= 1500) {
        resolve();
        return;
      }
      frames++;
      setTimeout(check, 16);
    };
    setTimeout(check, 0);
  });
  tracker?.observer.disconnect();
  delete state.__jevpilotMutationState;
}

async function settle(
  page: PageHandle,
  action: Action,
  role: string | undefined,
  navigation: Promise<void>,
  navigationStarted: () => boolean,
  currentUrl: string,
  waitTimeoutMs?: number,
): Promise<void> {
  if (navigationStarted()) {
    await navigation;
    return;
  }
  await Promise.race([
    page
      .callIsolated(
        settleInPage,
        [
          settleStrategy(action, role) === "suggestions",
          action.kind === "wait" ? currentUrl : undefined,
          waitTimeoutMs,
        ],
        {
          timeoutMs: action.kind === "wait" ? 3200 : 1600,
        },
      )
      .catch((cause: unknown) => {
        if (cause instanceof PageUnresponsiveError) throw cause;
        if (cause instanceof NavigationInProgressError) return;
        if (!navigationStarted()) throw cause;
      }),
    navigation,
  ]);
  if (navigationStarted()) await navigation;
}

export async function executeAction(
  page: PageHandle,
  before: Observation,
  action: Action,
  values: Readonly<Record<string, string>> = {},
  options: {
    navigationTimeoutMs?: number;
    actionabilityTimeoutMs?: number;
    waitTimeoutMs?: number;
    popupWaitMs?: number;
    strictIdentity?: boolean;
  } = {},
): Promise<ActionResult> {
  const started = performance.now();
  if (!page.capabilities.trustedInput && action.kind !== "wait")
    throw new ActionValidationError("unsupported-capability", "trusted input unavailable");
  const value = validate(action, values);
  let previous: RefResolution | undefined;
  const submittedFromFocus =
    action.kind === "submit" &&
    (await page.focusedSubmitTarget(
      action.target.epoch,
      action.target.ref,
      before.elements.find((item) => item.ref === action.target.ref)?.formId,
      before.elements.some(
        (item) =>
          item.ref === action.target.ref &&
          (item.role === "searchbox" || item.inputType === "search"),
      ),
    ));
  let precheckMs = 0;
  let waitMs = 0;
  let focusPath = false;
  let inputMs = 0;
  let settleMs = 0;
  let resolveMs = 0;
  let observeMs: number | undefined;
  let observeFramesMs: number | undefined;
  let observeChildFramesMs: number | undefined;
  let popup: ActionResult["popup"];
  const result = (
    outcome: ActionResult["outcome"],
    changes = emptyChanges(),
    extras: Partial<
      Pick<ActionResult, "coveredBy" | "dialog" | "pageHash" | "url" | "drift" | "popup">
    > = {},
  ): ActionResult => ({
    outcome,
    changes,
    ...extras,
    timings: {
      precheckMs,
      waitMs,
      inputMs,
      settleMs,
      resolveMs,
      ...(observeMs === undefined ? {} : { observeMs }),
      ...(observeFramesMs === undefined ? {} : { observeFramesMs }),
      ...(observeChildFramesMs === undefined ? {} : { observeChildFramesMs }),
      // Waiting for the page to become actionable is page time, not harness overhead. For WAIT the
      // wait and the settle are the same interval (waitMs = settleMs), so it is subtracted once.
      harnessMs: Math.max(
        0,
        performance.now() - started - settleMs - (action.kind === "wait" ? 0 : waitMs) - inputMs,
      ),
    },
  });
  // A SUBMIT that goes through the focused field skips the ref check (DESIGN §6 rule 18): widgets
  // like Wikipedia's search replace the input on the first keystroke, so the ref is stale by design.
  if (isTargeted(action) && (!submittedFromFocus || options.strictIdentity)) {
    const checkStart = performance.now();
    const submitControl = before.elements.find((item) => item.ref === action.target.ref);
    const fastCoveredSubmit =
      action.kind === "click" &&
      Boolean(submitControl?.formId) &&
      submitControl?.inputType === "submit" &&
      before.elements.some(
        (item) =>
          item.formId === submitControl?.formId &&
          item.value &&
          (item.tag === "input" || item.tag === "textarea"),
      );
    previous = await waitForRef(
      page,
      action.target.epoch,
      action.target.ref,
      action.target.fingerprint,
      action.kind,
      options.actionabilityTimeoutMs ?? 2000,
      options.strictIdentity ?? false,
      fastCoveredSubmit,
    );
    precheckMs = performance.now() - checkStart;
    waitMs = previous.waitMs ?? 0;
    focusPath = previous.focusPath ?? false;
    if (previous.status !== "ok") return result("stale");
    if (previous.unmet === undefined && !previous.visible) return result("invisible");
    if (previous.unmet === undefined && !previous.enabled) return result("disabled");
    if (previous.unmet === "invisible") return result("invisible");
    if (previous.unmet === "disabled") return result("disabled");
    if (previous.unmet === "not-editable") return result("not-editable");
    if (previous.unmet === "unstable") return result("unstable");
    if (
      previous.unmet === "covered" ||
      (previous.unmet === undefined && previous.coveredBy && !focusPath)
    )
      return result("covered", emptyChanges(), {
        ...(previous.coveredBy ? { coveredBy: previous.coveredBy } : {}),
      });
  }
  let navigationBegun = false;
  let navigationRequested = false;
  let completeNavigation: (() => void) | undefined;
  const navigation = new Promise<void>((resolve) => {
    completeNavigation = resolve;
  });
  let navigationTimer: ReturnType<typeof setTimeout> | undefined;
  const onLoaded = (): void => {
    if (navigationBegun) completeNavigation?.();
  };
  const onRequested = (): void => {
    navigationRequested = true;
    navigationBegun = true;
    navigationTimer ??= setTimeout(
      () => completeNavigation?.(),
      options.navigationTimeoutMs ?? 10000,
    );
  };
  const onNavigated = (event: PageEvents["navigated"]): void => {
    navigationBegun = true;
    if (event.sameDocument) completeNavigation?.();
    else
      navigationTimer ??= setTimeout(
        () => completeNavigation?.(),
        options.navigationTimeoutMs ?? 10000,
      );
  };
  page.on("navigationRequested", onRequested);
  page.on("navigated", onNavigated);
  page.on("domContentLoaded", onLoaded);
  let dialog: PageEvents["dialog"] | undefined;
  const onDialog = (opened: PageEvents["dialog"]): void => {
    dialog = opened;
  };
  page.on("dialog", onDialog);
  let popupTargetId: string | undefined;
  let openedPopupId: string | undefined;
  let popupResolve: (() => void) | undefined;
  const onPopupOpening = (event: PageEvents["popupOpening"]): void => {
    popupTargetId = event.targetId;
  };
  const onPopup = (opened: PageEvents["popup"]): void => {
    if (opened.id === popupTargetId) {
      openedPopupId = opened.id;
      popupResolve?.();
    }
  };
  page.on("popupOpening", onPopupOpening);
  page.on("popup", onPopup);
  try {
    const inputStart = performance.now();
    const send = async (operation: Promise<InputResult>): Promise<boolean> => {
      const response = await operation;
      if (response.dialog) dialog = response.dialog;
      return dialog !== undefined;
    };
    const rect = previous?.rect;
    const x =
      previous?.clickPoint?.x ?? (rect ? rect.x + rect.width / 2 : before.viewport.width / 2);
    const y =
      previous?.clickPoint?.y ?? (rect ? rect.y + rect.height / 2 : before.viewport.height / 2);
    switch (action.kind) {
      case "click":
      case "toggle":
        await send(page.click(x, y));
        break;
      case "type":
        if (
          previous &&
          expectedDateFormat(
            before.elements.find((item) => item.ref === action.target.ref)?.inputType ?? "",
          )
        ) {
          const normalized = normalizeDateLike(
            before.elements.find((item) => item.ref === action.target.ref)!.inputType!,
            value ?? "",
          );
          if (
            !normalized ||
            !(await page.callIsolated(setDateLikeInPage, [
              action.target.epoch,
              action.target.ref,
              normalized,
            ]))
          ) {
            inputMs = performance.now() - inputStart;
            return result("value-not-set");
          }
          if (action.submit) await send(page.key("Enter"));
          break;
        }
        if (focusPath) await focusRef(page, action.target.epoch, action.target.ref);
        if (
          !(focusPath ? false : await send(page.click(x, y))) &&
          !(await send(page.selectAll()))
        ) {
          // One insertText keeps the text together even when the page replaces the field on its first
          // input event; the Shift press then lets keyup-driven widgets read the full value.
          if (!(await send(page.insertText(value ?? "")))) await send(page.tapShift());
        }
        if (action.submit) await send(page.key("Enter"));
        break;
      case "submit":
        if (!submittedFromFocus) await focusRef(page, action.target.epoch, action.target.ref);
        await send(page.key("Enter"));
        break;
      case "select": {
        if (!(await send(page.click(x, y)))) {
          const index = previous?.optionLabels?.indexOf(action.optionLabel) ?? -1;
          if (index < 0 || previous?.selectedIndex === undefined) {
            inputMs = performance.now() - inputStart;
            return result("select-failed");
          }
          if (previous.selectPopup === false)
            await focusRef(page, action.target.epoch, action.target.ref);
          let dialogOpened = false;
          for (const key of selectKeySteps(previous.selectedIndex, index)) {
            if (await send(page.key(key))) {
              dialogOpened = true;
              break;
            }
          }
          if (!dialogOpened && previous.selectPopup !== false) await send(page.key("Enter"));
        }
        break;
      }
      case "scroll":
        await send(
          page.wheel(x, y, (action.direction === "down" ? 1 : -1) * before.viewport.height * 0.8),
        );
        break;
      case "back":
        await send(page.back());
        break;
      case "key":
        await send(page.key(action.name));
        break;
      case "wait":
        break;
      default: {
        const neverAction: never = action;
        throw new ActionValidationError(
          "invalid-action",
          `unsupported action: ${String(neverAction)}`,
        );
      }
    }
    inputMs = performance.now() - inputStart;
    if (dialog) return result("dialog-opened", emptyChanges(), { dialog });
    const navigationWindowEnds = performance.now() + 400;
    const targetElement = isTargeted(action)
      ? before.elements.find((element) => element.ref === action.target.ref)
      : undefined;
    const expectsNavigation =
      action.kind === "submit" ||
      (action.kind === "click" &&
        (Boolean(targetElement?.href) ||
          (targetElement?.tag === "button" &&
            (!targetElement.inputType || targetElement.inputType === "submit")) ||
          (targetElement?.tag === "input" &&
            ["submit", "image"].includes(targetElement.inputType ?? ""))));
    const settleStart = performance.now();
    const role = isTargeted(action)
      ? before.elements.find((element) => element.ref === action.target.ref)?.role
      : undefined;
    await settle(
      page,
      action,
      role,
      navigation,
      () => navigationBegun,
      before.url,
      Math.max(0, Math.min(3000, options.waitTimeoutMs ?? 3000)),
    );
    if (expectsNavigation && !navigationBegun) {
      await Promise.race([
        navigation,
        new Promise<void>((resolve) =>
          setTimeout(resolve, Math.max(0, navigationWindowEnds - performance.now())),
        ),
      ]);
      if (navigationBegun) await navigation;
    }
    settleMs = performance.now() - settleStart;
    if (action.kind === "wait") waitMs = settleMs;
    if (popupTargetId !== undefined) {
      const popupStart = performance.now();
      if (openedPopupId === undefined) {
        await new Promise<void>((resolve) => {
          popupResolve = resolve;
          const timer = setTimeout(() => {
            popupResolve = undefined;
            resolve();
          }, options.popupWaitMs ?? 3000);
          const finish = (): void => {
            clearTimeout(timer);
            popupResolve = undefined;
            resolve();
          };
          popupResolve = finish;
        });
      }
      waitMs += performance.now() - popupStart;
      popup = openedPopupId === undefined ? "pending" : "opened";
    }
    let next: RefResolution | undefined;
    if (isTargeted(action) && !navigationBegun) {
      const resolveStart = performance.now();
      next = await resolveRef(
        page,
        action.target.epoch,
        action.target.ref,
        action.target.fingerprint,
      ).catch((error: unknown) => {
        if (error instanceof PageUnresponsiveError) throw error;
        return undefined;
      });
      resolveMs = performance.now() - resolveStart;
    }
    const observeStart = performance.now();
    const after = await observe(page, { settleNavigation: navigationBegun });
    observeMs = performance.now() - observeStart;
    observeFramesMs = after.timings.framesMs;
    observeChildFramesMs = after.timings.childFramesMs;
    settleMs += after.timings.settleMs ?? 0;
    const changes = diffState(before, after, previous, next);
    if (action.kind === "type" && !changes.value) {
      const original = before.elements.find((item) => item.ref === action.target.ref);
      const current = after.elements.find((item) => item.ref === action.target.ref);
      changes.value = Boolean(
        original &&
        current &&
        original.tag === current.tag &&
        original.inputType === current.inputType &&
        original.formId === current.formId &&
        (original.fingerprint === current.fingerprint ||
          (original.placeholder !== undefined && original.placeholder === current.placeholder)) &&
        original.value !== current.value,
      );
    }
    if (action.kind === "select" && next?.selectedLabel !== action.optionLabel)
      return result("select-failed", changes, { pageHash: after.pageHash, url: after.url });
    return result(Object.values(changes).some(Boolean) ? "changed" : "unchanged", changes, {
      pageHash: after.pageHash,
      url: after.url,
      ...(popup ? { popup } : {}),
      ...(previous?.drift ? { drift: true } : {}),
    });
  } finally {
    if (navigationTimer) clearTimeout(navigationTimer);
    page.off("navigationRequested", onRequested);
    page.off("navigated", onNavigated);
    page.off("domContentLoaded", onLoaded);
    page.off("dialog", onDialog);
    page.off("popupOpening", onPopupOpening);
    page.off("popup", onPopup);
  }
}
