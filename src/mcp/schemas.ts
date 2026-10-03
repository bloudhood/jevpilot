import { z } from "zod";
import type { BrowserHandle } from "../engine/types.ts";
import { thresholdSchema } from "./thresholds.ts";
import { McpUserError } from "./errors.ts";

const nonempty = z.string().trim().min(1);
const httpUrl = z.string().url();
const requireHttpUrl = (url: string): void => {
  if (!/^https?:$/u.test(new URL(url).protocol))
    throw new McpUserError("Only http: and https: URLs may be navigated.");
};
const abortableNavigation = async <T>(
  operation: Promise<T>,
  signal: AbortSignal,
  browser: BrowserHandle,
): Promise<T> => {
  let interrupt!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    interrupt = () => reject(new Error("navigation interrupted"));
  });
  const unsubscribe = browser.onDisconnected(interrupt);
  signal.addEventListener("abort", interrupt, { once: true });
  if (signal.aborted || !browser.connected) interrupt();
  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    unsubscribe();
    signal.removeEventListener("abort", interrupt);
  }
};
const values = z.record(
  z.union([
    z.string(),
    z.object({ secret_ref: nonempty, origins: z.array(z.string().url()).min(1) }),
  ]),
);
const session = { session: nonempty.describe("Session ID returned by browser_run.") };
const runInput = {
  goal: nonempty.describe("Task to complete in the browser."),
  url: httpUrl.optional().describe("Initial HTTP(S) URL. Omit to start on a blank tab."),
  navigation_timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(2_147_483_647)
    .optional()
    .describe("Navigation timeout in milliseconds; defaults to 30000."),
  values: values
    .optional()
    .describe(
      "Every piece of text the page needs typed (search terms, form fields) must be given here as { short field description: text }. Text inside the goal is never typed. Secrets use {secret_ref: 'env:NAME' or 'file:PATH', origins: [...] }.",
    ),
  success: z
    .object({
      url_matches: z.string().optional(),
      text_present: z.string().optional(),
      element_present: z.object({ role: nonempty, name: nonempty }).optional(),
    })
    .optional()
    .describe(
      "Optional checks that are false now and become true only when the goal is done, e.g. url_matches for the result page. Checks that already hold on the start page are ignored.",
    ),
  constraints: z
    .object({
      allowed_domains: z.array(nonempty).optional(),
      allow_irreversible: z.boolean().optional(),
    })
    .optional()
    .describe("Navigation allowlist and irreversible-action gate."),
  budget: z
    .object({
      steps: z.number().int().nonnegative().optional(),
      seconds: z.number().nonnegative().optional(),
      decision_tokens: z.number().int().nonnegative().optional(),
    })
    .optional()
    .describe("Per-invocation limits."),
  thresholds: thresholdSchema
    .optional()
    .describe("Per-session decision confidence thresholds (0 to 1)."),
  profile: nonempty
    .optional()
    .describe("Configured engine profile name; defaults to the server engine."),
};
const op = z.object({
  action: z.enum([
    "click",
    "type",
    "toggle",
    "select",
    "scroll",
    "back",
    "wait",
    "key",
    "dialog",
    "press_key",
    "hover",
    "drag",
    "upload",
    "wait_for",
  ]),
  ref: nonempty.optional().describe("Element ref from the latest observation for target actions."),
  value_key: nonempty.optional().describe("Key in session values for type or prompt actions."),
  text: z.string().optional(),
  submit: z.boolean().optional(),
  to_ref: nonempty.optional(),
  paths: z.array(nonempty).optional(),
  condition: z.enum(["appears", "disappears"]).optional(),
  timeout_ms: z.number().int().min(0).max(30_000).optional(),
  delay_ms: z.number().int().min(0).max(10_000).optional(),
  option_label: z.string().optional(),
  direction: z.enum(["up", "down"]).optional(),
  name: z
    .string()
    .optional()
    .describe("Key to press for key or press_key, e.g. Enter, Tab, Escape."),
  key: z.string().optional().describe("Alias of name for key or press_key."),
  accept: z.boolean().optional(),
});
const closeResultSchema = { session: z.string(), closed: z.literal(true) };
const decideResultSchema = {
  answers: z.record(z.unknown()),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
  model: z.string(),
  latency_ms: z.number(),
};
const tabsResult = z.object({
  session: z.string(),
  tabs: z
    .array(z.object({ tab_id: z.string(), url: z.string(), selected: z.boolean() }))
    .optional(),
  closed: z.boolean().optional(),
  status: z.string().optional(),
  reason: z.string().optional(),
});

export {
  nonempty,
  httpUrl,
  requireHttpUrl,
  abortableNavigation,
  values,
  session,
  runInput,
  op,
  closeResultSchema,
  decideResultSchema,
  tabsResult,
};
