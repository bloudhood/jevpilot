const MAX_HEADERS = 64;
const MAX_VALUE_LENGTH = 2048;

export function sanitizeResponseHeaders(headers: Record<string, unknown>): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (
      key === "set-cookie" ||
      key === "set-cookie2" ||
      key === "cookie" ||
      key.includes("authorization") ||
      key === "proxy-authenticate" ||
      key === "www-authenticate" ||
      key.includes("token") ||
      key.includes("secret") ||
      key.includes("password") ||
      key.includes("credential") ||
      key.includes("session") ||
      key.includes("cookie") ||
      key.includes("auth") ||
      /(?:^|[-_])(api|access)[-_]?key(?:$|[-_])/u.test(key)
    )
      continue;
    if (Object.keys(selected).length >= MAX_HEADERS) break;
    if (typeof value === "string" || typeof value === "number") {
      selected[key] = String(value).slice(0, MAX_VALUE_LENGTH);
    }
  }
  return selected;
}
