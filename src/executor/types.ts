import type { PageEvents } from "../engine/types.ts";

export type Target = { epoch: number; ref: string; fingerprint: string };
export type ExecuteOptions = {
  navigationTimeoutMs?: number;
  actionabilityTimeoutMs?: number;
  waitTimeoutMs?: number;
  popupWaitMs?: number;
  strictIdentity?: boolean;
  observeMaxWaitMs?: number;
};
export type Action =
  | { kind: "click"; target: Target }
  | { kind: "type"; target: Target; valueKey?: string; text?: string; submit?: boolean }
  | { kind: "submit"; target: Target }
  | { kind: "select"; target: Target; optionLabel: string }
  | { kind: "toggle"; target: Target }
  | { kind: "scroll"; direction: "up" | "down" }
  | { kind: "back" }
  | { kind: "wait" }
  | { kind: "key"; name: string; target?: Target };

export const actionOutcomes = [
  "changed",
  "unchanged",
  "stale",
  "covered",
  "disabled",
  "invisible",
  "not-editable",
  "unstable",
  "select-failed",
  "dialog-opened",
  "value-not-set",
  "not-focusable",
] as const;
export type ActionOutcome = (typeof actionOutcomes)[number];
export type ActionResult = {
  outcome: ActionOutcome;
  drift?: boolean;
  pageHash?: string;
  url?: string;
  changes: { url: boolean; pageHash: boolean; value: boolean; checked: boolean };
  coveredBy?: { role: string; name: string };
  dialog?: PageEvents["dialog"];
  popup?: "opened" | "pending";
  timings: {
    precheckMs: number;
    waitMs?: number;
    inputMs: number;
    settleMs: number;
    resolveMs?: number;
    observeMs?: number;
    observeFramesMs?: number;
    observeChildFramesMs?: number;
    harnessMs: number;
  };
};

export class ActionValidationError extends Error {
  readonly code: "invalid-action" | "missing-value" | "unsupported-capability";
  constructor(code: ActionValidationError["code"], message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ActionValidationError";
    this.code = code;
  }
}
