import { DecisionConfigError } from "../decision/errors.ts";
import { BrowserConfigError } from "../engine/default.ts";

export class McpUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpUserError";
  }
}

export function startupDiagnostic(error: unknown): string {
  if (
    error instanceof DecisionConfigError ||
    error instanceof BrowserConfigError ||
    error instanceof McpUserError
  )
    return `${error.name}: ${error.message}`;
  return "jevpilot-mcp startup failed; check environment configuration.";
}
