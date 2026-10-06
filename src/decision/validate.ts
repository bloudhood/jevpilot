import { InvalidAnswerError } from "./errors.ts";
import type { Answer, Answers, Question, TaggedAnswers } from "./types.ts";

function validSubmitAfterType(question: Question, answer: Answer | undefined): boolean {
  if (question.type !== "choice" || !answer || !("choice" in answer)) return false;
  if (
    typeof answer.choice !== "string" ||
    typeof answer.confidence !== "number" ||
    typeof answer.probabilities !== "object" ||
    answer.probabilities === null ||
    Array.isArray(answer.probabilities)
  )
    return false;
  const problems: string[] = [];
  if (!Object.hasOwn(question.criteria, answer.choice)) problems.push("unknown choice");
  checkProbabilities(
    "submit_after_type",
    answer.probabilities,
    Object.keys(question.criteria),
    problems,
  );
  checkConfidence("submit_after_type", answer.confidence, problems);
  return problems.length === 0;
}

export function validateAnswers(questions: Record<string, Question>, answers: Answers): void {
  const problems: string[] = [];
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id];
    if (id === "submit_after_type" && !validSubmitAfterType(question, answer)) continue;
    if (!answer) {
      problems.push(`${id}: missing`);
      continue;
    }

    switch (question.type) {
      case "choice":
        if (!("choice" in answer)) {
          problems.push(`${id}: expected choice`);
          break;
        }
        if (!Object.hasOwn(question.criteria, answer.choice)) {
          problems.push(`${id}: unknown choice`);
        }
        checkProbabilities(id, answer.probabilities, Object.keys(question.criteria), problems);
        checkConfidence(id, answer.confidence, problems);
        break;
      case "score":
        if (!("score" in answer)) {
          problems.push(`${id}: expected score`);
          break;
        }
        if (!validScore(answer.score, question.criteria)) {
          problems.push(`${id}: score level`);
        }
        checkProbabilities(
          id,
          answer.probabilities,
          [
            question.criteria.map((_level, index) => String(index)),
            question.criteria.map((level, index) => levelKey(level, index)),
          ],
          problems,
        );
        checkConfidence(id, answer.confidence, problems);
        break;
      case "noul":
        if (!("noul" in answer)) {
          problems.push(`${id}: expected noul`);
        } else if (!Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
          problems.push(`${id}: noul`);
        }
        break;
      default: {
        const exhaustive: never = question;
        throw new Error(String(exhaustive));
      }
    }
  }

  for (const id of Object.keys(answers)) {
    if (!Object.hasOwn(questions, id)) problems.push(`${id}: unexpected`);
  }
  if (problems.length) throw new InvalidAnswerError(problems);
}

export function tagAnswers(questions: Record<string, Question>, answers: Answers): TaggedAnswers {
  const tagged: TaggedAnswers = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id];
    if (id === "submit_after_type" && !validSubmitAfterType(question, answer)) continue;
    if (!answer) throw new InvalidAnswerError([`${id}: missing`]);
    switch (question.type) {
      case "choice":
        if (!("choice" in answer)) throw new InvalidAnswerError([`${id}: expected choice`]);
        tagged[id] = { ...answer, probabilities: normalized(answer.probabilities), type: "choice" };
        break;
      case "score":
        if (!("score" in answer)) throw new InvalidAnswerError([`${id}: expected score`]);
        tagged[id] = { ...answer, probabilities: normalized(answer.probabilities), type: "score" };
        break;
      case "noul":
        if (!("noul" in answer)) throw new InvalidAnswerError([`${id}: expected noul`]);
        tagged[id] = { ...answer, type: "noul" };
        break;
      default: {
        const exhaustive: never = question;
        throw new Error(String(exhaustive));
      }
    }
  }
  return tagged;
}

function validScore(score: number, levels: unknown[]): boolean {
  if (!Number.isFinite(score)) return false;
  if (levels.some((level, index) => levelKey(level, index) === String(score))) return true;
  return Number.isInteger(score) && score >= 0 && score < levels.length;
}

function levelKey(level: unknown, index: number): string {
  if (typeof level === "string" || typeof level === "number") return String(level);
  if (typeof level === "object" && level !== null) {
    if ("level" in level && (typeof level.level === "string" || typeof level.level === "number")) {
      return String(level.level);
    }
    if ("score" in level && (typeof level.score === "string" || typeof level.score === "number")) {
      return String(level.score);
    }
  }
  return String(index);
}

function checkConfidence(id: string, value: number, problems: string[]): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    problems.push(`${id}: confidence`);
  }
}

function normalized(probabilities: Record<string, number>): Record<string, number> {
  const sum = Object.values(probabilities).reduce((total, value) => total + value, 0);
  // Guard against an all-zero table producing NaN (validateAnswers rejects it first,
  // but tagAnswers is exported and must stay total).
  const divisor = Number.isFinite(sum) && sum > 0 ? sum : 1;
  return Object.fromEntries(
    Object.entries(probabilities).map(([key, value]) => [key, value / divisor]),
  );
}

function checkProbabilities(
  id: string,
  probabilities: Record<string, number>,
  expectedKeys: string[] | string[][],
  problems: string[],
): void {
  const actualKeys = Object.keys(probabilities).sort();
  const expectedSets = Array.isArray(expectedKeys[0])
    ? (expectedKeys as string[][])
    : [expectedKeys as string[]];
  if (!expectedSets.some((keys) => actualKeys.join("\0") === [...keys].sort().join("\0"))) {
    problems.push(`${id}: probability keys`);
  }
  const values = Object.values(probabilities);
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    problems.push(`${id}: probability range`);
  }
  const sum = values.reduce((total, value) => total + value, 0);
  if (!Number.isFinite(sum) || Math.abs(sum - 1) > 0.05 + 1e-9) {
    problems.push(`${id}: probabilities sum`);
  }
}
