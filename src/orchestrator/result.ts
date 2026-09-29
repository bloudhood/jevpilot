import { z } from "zod";
import { actionOutcomes } from "../executor/types.ts";

export const sessionResultSchema = z.object({
  status: z.enum([
    "RUNNING",
    "DONE_VERIFIED",
    "DONE_UNVERIFIED",
    "NEEDS_VALUES",
    "NEEDS_LOGIN",
    "BLOCKED_BY_CHALLENGE",
    "BLOCKED_BY_POLICY",
    "CONFIRM_REQUIRED",
    "INFO_NOT_ON_PAGE",
    "UNCERTAIN",
    "STUCK",
    "ERROR_PAGE",
    "BUDGET_EXHAUSTED",
    "FAILED",
  ]),
  reason: z.string(),
  question: z.string(),
  details: z.array(z.string()).optional(),
  session: z.string(),
  url: z.string(),
  title: z.string(),
  snapshot: z.string(),
  screenshot_path: z.string().optional(),
  trace: z.array(
    z.object({
      step: z.number(),
      op: z.string(),
      target: z.object({ role: z.string(), name: z.string() }).optional(),
      coveredBy: z.object({ role: z.string(), name: z.string() }).optional(),
      confidence: z.number().optional(),
      outcome: z.enum([...actionOutcomes, "accepted", "dismissed"]),
      drift: z.boolean().optional(),
      ms: z.number(),
      waitMs: z.number().optional(),
      phases: z
        .object({
          precheck: z.number().int().optional(),
          input: z.number().int().optional(),
          settle: z.number().int().optional(),
          wait: z.number().int().optional(),
          resolve: z.number().int().optional(),
          observe: z.number().int().optional(),
          frames: z.number().int().optional(),
          children: z.number().int().optional(),
          harness: z.number().int().optional(),
        })
        .optional(),
    }),
  ),
  timing: z.object({
    total: z.number(),
    decide: z.number(),
    browser: z.number(),
    harness: z.number(),
  }),
  usage: z.object({
    decision_tokens: z.number(),
    detail: z
      .object({
        call: z.object({
          decisions: z.number().int(),
          input_tokens: z.number(),
          output_tokens: z.number(),
          decide_ms: z.number().int(),
          browser_ms: z.number().int(),
          harness_ms: z.number().int(),
          total_ms: z.number().int(),
        }),
        session: z.object({
          decisions: z.number().int(),
          input_tokens: z.number(),
          output_tokens: z.number(),
          decide_ms: z.number().int(),
          browser_ms: z.number().int(),
          harness_ms: z.number().int(),
          total_ms: z.number().int(),
        }),
        provider: z.string().optional(),
        model: z.string().optional(),
      })
      .optional(),
  }),
});

export type SessionResult = z.infer<typeof sessionResultSchema>;
export type SessionStatus = SessionResult["status"];
export type SessionTrace = SessionResult["trace"][number];
