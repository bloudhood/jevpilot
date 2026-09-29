import { z } from "zod";

const instructionsSchema = z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]);

export const questionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("choice"),
    instructions: instructionsSchema,
    criteria: z.record(
      z.union([z.string(), z.record(z.unknown()), z.array(z.unknown()), z.null()]),
    ),
  }),
  z.object({
    type: z.literal("score"),
    instructions: instructionsSchema,
    criteria: z.array(z.unknown()),
  }),
  z.object({
    type: z.literal("noul"),
    instructions: instructionsSchema,
    criteria: z.record(z.unknown()).optional(),
  }),
]);

export const requestSchema = z.object({
  model: z.string().optional(),
  state: z.unknown(),
  questions: z.record(questionSchema),
});

const probabilitySchema = z.record(z.number());
const choiceAnswerSchema = z.object({
  choice: z.string(),
  probabilities: probabilitySchema,
  confidence: z.number(),
});
const scoreAnswerSchema = z.object({
  score: z.number(),
  probabilities: probabilitySchema,
  confidence: z.number(),
});
const noulAnswerSchema = z.object({ noul: z.number() });

export const answerSchema = z.union([choiceAnswerSchema, scoreAnswerSchema, noulAnswerSchema]);

export const responseSchema = z.object({
  answers: z.record(answerSchema),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
  model: z.string(),
});

export type Question = z.infer<typeof questionSchema>;
export type DecisionRequest = z.infer<typeof requestSchema>;
export type ResolvedDecisionRequest = DecisionRequest & { model: string };
export type ChoiceAnswer = z.infer<typeof choiceAnswerSchema>;
export type ScoreAnswer = z.infer<typeof scoreAnswerSchema>;
export type NoulAnswer = z.infer<typeof noulAnswerSchema>;
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;
export type Answers = Record<string, Answer>;
export type TaggedChoiceAnswer = ChoiceAnswer & { type: "choice" };
export type TaggedScoreAnswer = ScoreAnswer & { type: "score" };
export type TaggedNoulAnswer = NoulAnswer & { type: "noul" };
export type TaggedAnswer = TaggedChoiceAnswer | TaggedScoreAnswer | TaggedNoulAnswer;
export type TaggedAnswers = Record<string, TaggedAnswer>;
export type ProviderResponse = z.infer<typeof responseSchema>;
export type DecisionResult = {
  answers: TaggedAnswers;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  provider: string;
  latencyMs: number;
  attempts: number;
};
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type Clock = { now(): number };
export type Sleep = (ms: number) => Promise<void>;
export type DecisionPort = {
  decide(request: DecisionRequest, options?: { signal?: AbortSignal }): Promise<DecisionResult>;
};
