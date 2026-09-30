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
  return !!address && Number(parts[1]) <= address.length * 8;
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
