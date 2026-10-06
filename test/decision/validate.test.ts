import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InvalidAnswerError, tagAnswers, validateAnswers } from "../../src/index.ts";
import type { Answers, Question } from "../../src/index.ts";
import { answers, request } from "./helpers.ts";

describe("validateAnswers", () => {
  test("score answers use level indexes as Jev returns them", () => {
    const questions = {
      relevance: {
        type: "score" as const,
        instructions: "Rate",
        criteria: ["low", "high", "very high"],
      },
      object: {
        type: "score" as const,
        instructions: "Rate",
        criteria: [{ level: "low" }, { level: "high" }],
      },
    };
    validateAnswers(questions, {
      relevance: { score: 2, confidence: 0.99, probabilities: { "0": 0, "1": 0, "2": 1 } },
      object: { score: 1, confidence: 0.99, probabilities: { "0": 0, "1": 1 } },
    });
    assert.throws(
      () =>
        validateAnswers(
          { relevance: questions.relevance },
          {
            relevance: { score: 2, confidence: 1, probabilities: { low: 0, high: 0, other: 1 } },
          },
        ),
      InvalidAnswerError,
    );
  });
  const scoreQuestion: Question = {
    type: "score",
    instructions: "Rate",
    criteria: ["low", "high"],
  };
  const noulQuestion: Question = {
    type: "noul",
    instructions: "Flag",
  };

  test("accepts complete choice, score and noul answers", () => {
    validateAnswers(
      { ...request.questions, score: scoreQuestion, flag: noulQuestion },
      {
        ...answers,
        score: { score: 1, probabilities: { low: 0.4, high: 0.6 }, confidence: 0 },
        flag: { noul: 1 },
      },
    );
  });

  test("lists missing and unexpected question IDs", () => {
    assert.throws(
      () => validateAnswers({ ...request.questions, flag: noulQuestion }, { extra: { noul: 0 } }),
      (error: unknown) =>
        error instanceof InvalidAnswerError &&
        error.problems.includes("pick: missing") &&
        error.problems.includes("flag: missing") &&
        error.problems.includes("extra: unexpected"),
    );
  });

  test("rejects every answer type mismatch", () => {
    const choiceAnswer = answers.pick;
    assert.ok(choiceAnswer);
    assert.throws(
      () => validateAnswers(request.questions, { pick: { noul: 0.5 } }),
      /expected choice/,
    );
    assert.throws(
      () => validateAnswers({ score: scoreQuestion }, { score: choiceAnswer }),
      /expected score/,
    );
    assert.throws(
      () => validateAnswers({ flag: noulQuestion }, { flag: choiceAnswer }),
      /expected noul/,
    );
  });

  test("reports unknown choice, probability keys, sum and confidence together", () => {
    const invalid: Answers = {
      pick: {
        choice: "other",
        probabilities: { yes: 0.1, no: 0.1, extra: 0.1 },
        confidence: 2,
      },
    };
    assert.throws(
      () => validateAnswers(request.questions, invalid),
      (error: unknown) =>
        error instanceof InvalidAnswerError &&
        error.problems.length === 4 &&
        error.problems.some((problem) => problem.includes("unknown choice")) &&
        error.problems.some((problem) => problem.includes("probability keys")) &&
        error.problems.some((problem) => problem.includes("probabilities sum")) &&
        error.problems.some((problem) => problem.includes("confidence")),
    );
  });

  test("accepts a probability sum off by 0.005", () => {
    validateAnswers(request.questions, {
      pick: { choice: "yes", probabilities: { yes: 0.8, no: 0.205 }, confidence: 0.5 },
    });
  });

  test("rejects a probability sum off by 0.06", () => {
    assert.throws(
      () =>
        validateAnswers(request.questions, {
          pick: { choice: "yes", probabilities: { yes: 0.8, no: 0.26 }, confidence: 0.5 },
        }),
      /probabilities sum/,
    );
  });

  test("accepts rounded 120-option answers in different key orders", () => {
    const keys = Array.from({ length: 120 }, (_, index) => `e${index}`);
    const criteria = Object.fromEntries(keys.map((key) => [key, key]));
    for (const ordered of [keys, [...keys].reverse(), [...keys.slice(47), ...keys.slice(0, 47)]]) {
      const probabilities = Object.fromEntries(
        ordered.map((key) => [key, key === "e7" ? 0.99 : 0]),
      );
      const questions: Record<string, Question> = {
        click_target: { type: "choice", instructions: "click", criteria },
      };
      const raw: Answers = { click_target: { choice: "e7", probabilities, confidence: 0.99 } };
      validateAnswers(questions, raw);
      const tagged = tagAnswers(questions, raw).click_target;
      assert.equal(tagged?.type, "choice");
      if (tagged?.type === "choice")
        assert.ok(
          Math.abs(Object.values(tagged.probabilities).reduce((sum, value) => sum + value, 0) - 1) <
            1e-12,
        );
    }
  });

  test("accepts 0.96 and rejects 0.94 or mismatched keys", () => {
    const valid: Answers = {
      pick: { choice: "yes", probabilities: { yes: 0.76, no: 0.2 }, confidence: 0.8 },
    };
    validateAnswers(request.questions, valid);
    const tagged = tagAnswers(request.questions, valid).pick;
    if (tagged?.type === "choice")
      assert.equal(
        Object.values(tagged.probabilities).reduce((sum, value) => sum + value, 0),
        1,
      );
    assert.throws(
      () =>
        validateAnswers(request.questions, {
          pick: { choice: "yes", probabilities: { yes: 0.74, no: 0.2 }, confidence: 0.8 },
        }),
      /probabilities sum/u,
    );
    assert.throws(
      () =>
        validateAnswers(request.questions, {
          pick: { choice: "yes", probabilities: { yes: 0.76, other: 0.2 }, confidence: 0.8 },
        }),
      /probability keys/u,
    );
  });

  test("rejects out-of-range probabilities, score levels and noul values", () => {
    assert.throws(
      () =>
        validateAnswers(request.questions, {
          pick: { choice: "yes", probabilities: { yes: -0.1, no: 1.1 }, confidence: 1 },
        }),
      /probability range/,
    );
    assert.throws(
      () =>
        validateAnswers(
          { score: scoreQuestion },
          { score: { score: 2, probabilities: { low: 0.5, high: 0.5 }, confidence: 1 } },
        ),
      /score level/,
    );
    assert.throws(() => validateAnswers({ flag: noulQuestion }, { flag: { noul: -0.1 } }), /noul/);
  });
});

describe("tagAnswers", () => {
  test("adds the question type to each validated answer", () => {
    const questions = {
      ...request.questions,
      score: scoreQuestionForTag,
      flag: noulQuestionForTag,
    };
    const raw: Answers = {
      ...answers,
      score: { score: 1, probabilities: { low: 0.4, high: 0.6 }, confidence: 1 },
      flag: { noul: 0.5 },
    };
    validateAnswers(questions, raw);
    const tagged = tagAnswers(questions, raw);
    assert.equal(tagged.pick?.type, "choice");
    assert.equal(tagged.score?.type, "score");
    assert.equal(tagged.flag?.type, "noul");
  });
});

const scoreQuestionForTag: Question = {
  type: "score",
  instructions: "Rate",
  criteria: ["low", "high"],
};
const noulQuestionForTag: Question = { type: "noul", instructions: "Flag" };
