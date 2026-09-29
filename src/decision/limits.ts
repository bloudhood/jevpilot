import type { Provider } from "./config.ts";
import { ContextLimitError } from "./errors.ts";
import type { DecisionRequest } from "./types.ts";

export type Limits = { total: number; stateQuestion: number };

export const defaultLimits: Record<Provider, Limits> = {
  typesafe: { total: 65536, stateQuestion: 32768 },
  openrouter: { total: 32768, stateQuestion: 32768 },
  cloudflare: { total: 32768, stateQuestion: 32768 },
  custom: { total: 32768, stateQuestion: 32768 },
  vercel: { total: 32768, stateQuestion: 32768 },
};

export function estimateTokens(value: unknown): number {
  const serialized = JSON.stringify(value) ?? "";
  let nonAscii = 0;
  let ascii = 0;
  for (const character of serialized) {
    if (character.charCodeAt(0) > 127) nonAscii++;
    else ascii++;
  }
  return nonAscii + Math.ceil(ascii / 4);
}

export function enforceLimits(
  request: DecisionRequest,
  provider: Provider,
  override?: number,
): void {
  for (const question of Object.values(request.questions)) {
    if (question.type === "choice" && Object.keys(question.criteria).length > 255) {
      throw new ContextLimitError("choice options exceed 255");
    }
  }

  const limits = defaultLimits[provider];
  const totalLimit = Math.min(override ?? limits.total, limits.total);
  if (estimateTokens(request) > totalLimit) {
    throw new ContextLimitError(`context exceeds ${totalLimit} tokens`);
  }

  const longestQuestion = Math.max(
    0,
    ...Object.entries(request.questions).map(([id, question]) =>
      estimateTokens({ [id]: question }),
    ),
  );
  const stateQuestionLimit = Math.min(override ?? limits.stateQuestion, limits.stateQuestion);
  if (estimateTokens(request.state) + longestQuestion > stateQuestionLimit) {
    throw new ContextLimitError(`state and longest question exceed ${stateQuestionLimit} tokens`);
  }
}
