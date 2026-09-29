import { validCidr, type NetworkGuard } from "../security/address-guard.ts";
import { McpUserError } from "./errors.ts";

export function parseNetworkGuard(mode?: string, extras?: string): NetworkGuard {
  if (mode !== undefined && mode !== "metadata" && mode !== "private" && mode !== "off")
    throw new McpUserError("JEVPILOT_NETWORK_GUARD must be metadata, private, or off.");
  const extraBlocked =
    extras === undefined || extras === "" ? [] : extras.split(",").map((entry) => entry.trim());
  if (extraBlocked.some((entry) => !validCidr(entry)))
    throw new McpUserError("JEVPILOT_BLOCKED_ADDRESSES must contain valid IPv4 or IPv6 CIDRs.");
  return { mode: mode ?? "metadata", extraBlocked };
}

export function parseMaxSessions(value?: string): number {
  if (value === undefined) return 8;
  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value)))
    throw new McpUserError("JEVPILOT_MAX_SESSIONS must be a positive integer.");
  return Number(value);
}
