import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMaxSessions, parseNetworkGuard } from "../../src/mcp/network-guard.ts";
import {
  blockedAddress,
  blockedUrl,
  lookupWithResolverRules,
} from "../../src/security/address-guard.ts";

test("O3: the metadata guard blocks cloud metadata addresses in every notation", async () => {
  const guard = parseNetworkGuard();
  for (const value of [
    "169.254.169.254",
    "169.254.170.2",
    "100.100.100.200",
    "168.63.129.16",
    "fd00:ec2::254",
    "::ffff:169.254.169.254",
  ])
    assert.equal(blockedAddress(value, guard), true, value);
  for (const url of [
    "http://2852039166/",
    "http://0xa9fea9fe/",
    "http://0251.0376.0251.0376/",
    "http://[::ffff:a9fe:a9fe]/",
  ])
    assert.equal(Boolean(await blockedUrl(url, guard, async () => [])), true, url);
  for (const value of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "::1", "8.8.8.8"])
    assert.equal(blockedAddress(value, guard), false, value);
});

test("O3: private mode also blocks loopback, private, link-local and shared ranges", () => {
  const guard = parseNetworkGuard("private");
  for (const value of [
    "0.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    // IPv4-compatible remnants, RFC 8215 translation, and 6to4 carrying an IPv4 host part.
    "::127.0.0.1",
    "64:ff9b:1::7f00:1",
    "2002:7f00:1::",
  ])
    assert.equal(blockedAddress(value, guard), true, value);
  // Ordinary global addresses stay reachable.
  for (const value of ["8.8.8.8", "2600::", "2001:db8::1"])
    assert.equal(blockedAddress(value, guard), false, value);
});

test("O3: the guard mirrors Chrome host-resolver-rules MAP entries", async () => {
  const guard = parseNetworkGuard();
  const neverDns = async () => {
    throw new Error("mapped hosts must not reach DNS");
  };
  const lookup = lookupWithResolverRules(
    ["--host-resolver-rules=MAP outside.test 127.0.0.1,MAP unreachable.invalid 127.0.0.1:9"],
    neverDns,
  );
  // Mapped to loopback: allowed by the metadata guard, exactly like the browser resolves it.
  assert.equal(await blockedUrl("http://outside.test:9443/result", guard, lookup), undefined);
  assert.equal(await blockedUrl("http://unreachable.invalid/", guard, lookup), undefined);
  // A mapping that points at a blocked address is still caught.
  const mapping = lookupWithResolverRules(
    ["--host-resolver-rules=MAP pin.test 169.254.1.1"],
    neverDns,
  );
  assert.equal(await blockedUrl("http://pin.test/", guard, mapping), "169.254.1.1");
  // Extra args without resolver rules, or unknown rule shapes, fall through to the base lookup.
  const plain = lookupWithResolverRules(["--no-proxy-server"], async () => [
    { address: "9.9.9.9", family: 4 },
  ]);
  assert.equal(await blockedUrl("http://host.test/", guard, plain), undefined);
});

test("O3: JEVPILOT_BLOCKED_ADDRESSES rejects CIDRs with host bits set", () => {
  assert.throws(() => parseNetworkGuard("private", "10.0.0.1/8"), /JEVPILOT_BLOCKED_ADDRESSES/);
  assert.throws(() => parseNetworkGuard("private", "fe80::1/10"), /JEVPILOT_BLOCKED_ADDRESSES/);
  const guard = parseNetworkGuard("private", "203.0.113.0/24");
  assert.deepEqual(guard.extraBlocked, ["203.0.113.0/24"]);
  assert.equal(blockedAddress("203.0.113.7", guard), true);
});

test("O3: JEVPILOT_NETWORK_GUARD, JEVPILOT_BLOCKED_ADDRESSES and JEVPILOT_MAX_SESSIONS are validated at startup", () => {
  assert.throws(() => parseNetworkGuard("bad"), /JEVPILOT_NETWORK_GUARD/);
  assert.throws(() => parseNetworkGuard("off", "not-a-cidr"), /JEVPILOT_BLOCKED_ADDRESSES/);
  assert.throws(() => parseMaxSessions("0"), /JEVPILOT_MAX_SESSIONS/);
  assert.equal(parseMaxSessions(undefined), 8);
});
