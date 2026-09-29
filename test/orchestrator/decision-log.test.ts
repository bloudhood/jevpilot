import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecisionRequest, TaggedAnswers } from "../../src/decision/types.ts";
import { calibrationRequestRecord } from "../../src/orchestrator/decision-log.ts";

test("M6i: the decision log records submit_after_type", () => {
  const request: DecisionRequest = {
    state: {},
    questions: {
      submit_after_type: {
        type: "choice",
        instructions: "Submit after typing?",
        criteria: { submit: "Submit", none: "Wait" },
      },
    },
  };
  for (const selected of ["submit", "none"]) {
    const answers: TaggedAnswers = {
      submit_after_type: {
        type: "choice",
        choice: selected,
        confidence: 0.95,
        probabilities: {
          submit: selected === "submit" ? 0.95 : 0.05,
          none: selected === "none" ? 0.95 : 0.05,
        },
      },
    };
    const record = calibrationRequestRecord({
      session: "s1",
      step: 1,
      request,
      answers,
      outcome: "executed",
    });
    const family = (record.question_families as Record<string, unknown>[])[0];
    assert.equal(family?.family, "submit_after_type");
    assert.equal(family.chosen_key_class, selected);
  }
});

test("M6o: the decision log records not_needed as its own value_for class", () => {
  const request: DecisionRequest = {
    state: {},
    questions: {
      value_for_e1: {
        type: "choice",
        instructions: "Value?",
        criteria: { key: "Use key", not_provided: "Missing", not_needed: "Optional" },
      },
    },
  };
  const record = calibrationRequestRecord({
    session: "s1",
    step: 1,
    request,
    answers: {
      value_for_e1: {
        type: "choice",
        choice: "not_needed",
        confidence: 0.95,
        probabilities: { key: 0.02, not_provided: 0.03, not_needed: 0.95 },
      },
    },
    outcome: "executed",
  });
  const family = (record.question_families as Record<string, unknown>[])[0];
  assert.equal(family?.chosen_key_class, "not_needed");
});
