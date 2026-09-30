import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type NetworkGuard = { mode: "metadata" | "private" | "off"; extraBlocked: string[] };
export type AddressLookup = (
  hostname: string,
  options: { all: true },
) => Promise<{ address: string; family: number }[]>;

const metadata = ["169.254.0.0/16", "100.100.100.200/32", "168.63.129.16/32", "fd00:ec2::254/128"];
const privateRanges = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "::/128",
  "::1/128",
  // IPv4-compatible remnants (::a.b.c.d) with their own /96 range; :: and ::1 stay exact.
  "::/96",
  // IPv4-VPN translation (RFC 8215) alongside the well-known NAT64 prefix.
  "64:ff9b:1::/48",
  // 6to4 with an embedded IPv4 host part.
  "2002::/16",
  "fc00::/7",
  "fe80::/10",
];

function bytes(address: string): number[] | undefined {
  if (isIP(address) === 4) return address.split(".").map(Number);
  if (isIP(address) !== 6) return undefined;
  const parts = address.toLowerCase().split("::");
  if (parts.length > 2) return undefined;
  const expand = (part: string): number[] =>
    part
      ? part.split(":").flatMap((word) => {
          if (word.includes(".")) {
            const octets = word.split(".").map(Number);
            return [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!];
          }
          return [parseInt(word, 16)];
        })
      : [];
  const left = expand(parts[0]!);
  const right = parts.length === 2 ? expand(parts[1]!) : [];
  const words = [
    ...left,
    ...Array(parts.length === 2 ? 8 - left.length - right.length : 0).fill(0),
    ...right,
  ];
  if (words.length !== 8) return undefined;
  return words.flatMap((word) => [word >> 8, word & 255]);
}

function embeddedIPv4(value: number[]): number[] | undefined {
  if (value.length !== 16) return undefined;
  const prefix = value.slice(0, 12);
  if (prefix.every((byte, index) => byte === (index < 10 ? 0 : 255))) return value.slice(12);
  if (
    prefix.every(
      (byte, index) =>
        byte ===
        (index === 0 ? 0x00 : index === 1 ? 0x64 : index === 2 ? 0xff : index === 3 ? 0x9b : 0),
    )
  )
    return value.slice(12);
  return undefined;
}

export function validCidr(value: string): boolean {
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1] || !/^\d+$/u.test(parts[1])) return false;
  const address = bytes(parts[0]);
  if (!address) return false;
  const bits = Number(parts[1]);
  if (bits > address.length * 8) return false;
  // Host bits outside the prefix must be zero: "10.0.0.1/8" is rejected, use "10.0.0.0/8".
  return address.every((byte, index) => {
    const remaining = bits - index * 8;
    const mask = remaining >= 8 ? 255 : remaining <= 0 ? 0 : (255 << (8 - remaining)) & 255;
    return (byte & ~mask & 255) === 0;
  });
}

export function blockedAddress(address: string, guard: NetworkGuard): boolean {
  const raw = bytes(address.replace(/^\[|\]$/gu, ""));
  if (!raw) return false;
  const candidate = embeddedIPv4(raw) ?? raw;
  const ranges = [
    ...(guard.mode === "off" ? [] : metadata),
    ...(guard.mode === "private" ? privateRanges : []),
    ...guard.extraBlocked,
  ];
  return ranges.some((range) => {
    const [base, bitsText] = range.split("/");
    const network = bytes(base!);
    if (!network || network.length !== candidate.length) return false;
    const bits = Number(bitsText);
    return candidate.every((byte, index) => {
      const remaining = bits - index * 8;
      const mask = remaining >= 8 ? 255 : remaining <= 0 ? 0 : (255 << (8 - remaining)) & 255;
      return (byte & mask) === (network[index]! & mask);
    });
  });
}

export function urlHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/gu, "");
  } catch {
    return undefined;
  }
}

export type UrlVerdict = { blocked?: string; unverified?: true };

// `blocked` is the address that is not allowed. `unverified` means the host could not be resolved to check
// it: a name that does not exist (ENOTFOUND, ENODATA) cannot be reached either, but a timeout or any other
// resolver failure leaves the host unchecked while the browser may still resolve it.
export async function checkUrl(
  url: string,
  guard: NetworkGuard,
  lookup: AddressLookup = dnsLookup,
): Promise<UrlVerdict> {
  const host = urlHost(url);
  if (!host || (guard.mode === "off" && guard.extraBlocked.length === 0)) return {};
  if (isIP(host)) return blockedAddress(host, guard) ? { blocked: host } : {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("DNS timeout")), 2000);
      }),
    ]);
    const blocked = addresses.find((item) => blockedAddress(item.address, guard))?.address;
    return blocked ? { blocked } : {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "ENOTFOUND" || code === "ENODATA" ? {} : { unverified: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function blockedUrl(
  url: string,
  guard: NetworkGuard,
  lookup: AddressLookup = dnsLookup,
): Promise<string | undefined> {
  return (await checkUrl(url, guard, lookup)).blocked;
}

// Chrome's MatchPattern: `*` matches any run of characters (including none), `?` any single one.
function matchesPattern(text: string, pattern: string): boolean {
  let t = 0;
  let p = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
      t++;
      p++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

// A replacement is `HOST`, `HOST:PORT`, `[IPV6]` or `[IPV6]:PORT`; the port never changes what it resolves to.
function replacementHost(value: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/u.exec(value);
  if (bracketed) return bracketed[1]!;
  return /^[^:]+:\d+$/u.test(value) ? value.slice(0, value.lastIndexOf(":")) : value;
}

/**
 * Build an AddressLookup that mirrors Chrome's --host-resolver-rules so the guard resolves hosts the way
 * the browser it protects does (Chrome applies the rules instead of DNS; a deployment using them would
 * otherwise have the guard check an address the browser never connects to). Like Chrome, the last switch
 * wins, `EXCLUDE` patterns are checked first, then `MAP` rules in order with the first match applying once
 * and `*`/`?` wildcards in the pattern. A replacement that is a name is resolved normally, not mapped again,
 * and `~NOTFOUND` fails the lookup like a missing name. Hosts no rule covers use the underlying lookup.
 */
export function lookupWithResolverRules(
  extraArgs: readonly string[] | undefined,
  fallback: AddressLookup = dnsLookup,
): AddressLookup {
  const raw = (extraArgs ?? []).filter((argument) => argument.startsWith("--host-resolver-rules="));
  const value = raw.at(-1)?.slice("--host-resolver-rules=".length);
  if (value === undefined) return fallback;
  const excluded: string[] = [];
  const maps: { pattern: string; replacement: string }[] = [];
  for (const rule of value.split(",")) {
    const parts = rule.trim().split(/\s+/u);
    const keyword = parts[0]?.toLowerCase();
    if (keyword === "exclude" && parts.length === 2) excluded.push(parts[1]!.toLowerCase());
    else if (keyword === "map" && parts.length === 3)
      maps.push({ pattern: parts[1]!.toLowerCase(), replacement: parts[2]! });
  }
  if (maps.length === 0) return fallback;
  return async (hostname, options) => {
    const name = hostname.toLowerCase();
    if (excluded.some((pattern) => matchesPattern(name, pattern)))
      return fallback(hostname, options);
    const rule = maps.find((candidate) => matchesPattern(name, candidate.pattern));
    if (!rule) return fallback(hostname, options);
    if (rule.replacement.toUpperCase() === "~NOTFOUND")
      throw Object.assign(new Error("host mapped to ~NOTFOUND"), { code: "ENOTFOUND" });
    const address = replacementHost(rule.replacement);
    const family = isIP(address);
    return family ? [{ address, family }] : fallback(address, options);
  };
}
