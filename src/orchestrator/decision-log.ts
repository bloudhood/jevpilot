import { appendFile } from "node:fs/promises";
import type { DecisionRequest, TaggedAnswers } from "../decision/types.ts";

const knownSituations = new Set([
  "progressing",
  "goal_reached",
  "challenge",
  "login_required",
  "needs_user_values",
  "info_not_on_page",
  "error_page",
  "irreversible_next",
  "none_of_these",
]);
const safeOps = new Set([
  "CLICK",
  "TYPE",
  "SELECT",
  "TOGGLE",
  "SCROLL_DOWN",
  "SCROLL_UP",
  "BACK",
  "WAIT",
  "DONE",
  "STOP",
  "none",
]);
const families = (id: string): string => {
  if (id === "op" || id === "situation" || id === "goal_met" || id === "submit_after_type")
    return id;
  if (id === "click_target" || id === "select_target") return id;
  if (id.startsWith("value_for_")) return "value_for";
  if (id.startsWith("option_for_")) return "option_for";
  if (id.startsWith("check_")) return "check";
  return "other";
};
const classFor = (id: string, selected: string | undefined): string | undefined => {
  if (!selected) return undefined;
  const family = families(id);
  if (family === "op") return safeOps.has(selected) ? selected : "other";
  if (family === "situation") return knownSituations.has(selected) ? selected : "other";
  if (family === "submit_after_type")
    return selected === "submit" || selected === "none" ? selected : "other";
  if (family === "click_target" || family === "select_target")
    return selected === "none" ? "none" : "element";
  if (family === "value_for")
    return selected === "not_provided"
      ? "not_provided"
      : selected === "not_needed"
        ? "not_needed"
        : "provided_key";
  if (family === "option_for") return selected === "none" ? "none" : "option";
  return undefined;
};

export function calibrationRequestRecord(input: {
  session: string;
  step: number;
  request: DecisionRequest;
  answers: TaggedAnswers;
  outcome: "executed" | "handed_off";
  latencyMs?: number;
  attempts?: number;
  errorCategory?: "timeout" | "transport" | "aborted" | "other";
}): Record<string, unknown> {
  const questionFamilies = Object.entries(input.request.questions).map(([id, question]) => {
    const answer = input.answers[id];
    if (question.type === "noul")
      return {
        family: families(id),
        chosen_key_class: undefined,
        confidence: null,
        top2_probability_margin: null,
        noul_values: answer?.type === "noul" ? [answer.noul] : [],
      };
    if (answer?.type !== "choice")
      return {
        family: families(id),
        chosen_key_class: undefined,
        confidence: null,
        top2_probability_margin: null,
        noul_values: [],
      };
    const ranked = Object.values(answer.probabilities).sort((a, b) => b - a);
    const margin = ranked.length > 1 ? ranked[0]! - ranked[1]! : (ranked[0] ?? null);
    return {
      family: families(id),
      chosen_key_class: classFor(id, answer.choice),
      confidence: answer.confidence,
      top2_probability_margin: margin,
      noul_values: [],
    };
  });
  return {
    type: "decision",
    session: input.session,
    step: input.step,
    question_families: questionFamilies,
    outcome: input.outcome,
    ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
    ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
    ...(input.errorCategory ? { error_category: input.errorCategory } : {}),
  };
}

export async function appendCalibrationRecord(
  path: string | undefined,
  record: Record<string, unknown>,
): Promise<void> {
  if (!path) return;
  try {
    await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
  } catch {
    // Calibration logging must never change the browser result.
  }
}
