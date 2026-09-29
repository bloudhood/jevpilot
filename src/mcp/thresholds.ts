import { z } from "zod";

export const thresholdSchema = z
  .object({
    op: z.number().min(0).max(1).optional(),
    target: z.number().min(0).max(1).optional(),
    value_for: z.number().min(0).max(1).optional(),
    option_for: z.number().min(0).max(1).optional(),
    situation: z.number().min(0).max(1).optional(),
    goal_met: z.number().min(0).max(1).optional(),
    goal_met_unchanged: z.number().min(0).max(1).optional(),
    check: z.number().min(0).max(1).optional(),
    check_margin: z.number().min(0).max(1).optional(),
  })
  .strict();

export type PolicyThresholds = z.infer<typeof thresholdSchema>;

export function parseThresholds(value: string | undefined): PolicyThresholds | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("JEVPILOT_THRESHOLDS must be valid JSON.");
  }
  const result = thresholdSchema.safeParse(parsed);
  if (!result.success) throw new Error("JEVPILOT_THRESHOLDS contains invalid threshold values.");
  return result.data;
}
