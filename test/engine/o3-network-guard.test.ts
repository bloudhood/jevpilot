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

test("R8: the guard applies wildcard, EXCLUDE and ordering of host-resolver-rules like Chrome", async () => {
  const guard = parseNetworkGuard();
  const dns = async (hostname: string) => {
    if (hostname === "real.example") return [{ address: "8.8.8.8", family: 4 }];
    const missing = new Error(`getaddrinfo ENOTFOUND ${hostname}`) as NodeJS.ErrnoException;
    missing.code = "ENOTFOUND";
    throw missing;
  };
  const lookup = (rules: string, ...more: string[]) =>
    lookupWithResolverRules([`--host-resolver-rules=${rules}`, ...more], dns);
  // A wildcard pattern covers every matching name; before, only exact names were mapped and the
  // rest went to DNS (a missing name counts as unreachable), so the guard let them through.
  const wild = lookup("MAP *.internal.test 169.254.169.254");
  assert.equal(await blockedUrl("http://a.b.internal.test/", guard, wild), "169.254.169.254");
  assert.equal(await blockedUrl("http://x.internal.test/", guard, wild), "169.254.169.254");
  assert.equal(
    await blockedUrl("http://internal.test/", guard, wild),
    undefined,
    "no label, no match",
  );
  assert.equal(
    await blockedUrl("http://cache1.test/", guard, lookup("MAP cache? 169.254.169.254")),
    undefined,
  );
  assert.equal(
    await blockedUrl("http://cache1/", guard, lookup("MAP cache? 169.254.169.254")),
    "169.254.169.254",
  );
  const everything = lookup("MAP * 169.254.169.254");
  assert.equal(await blockedUrl("http://real.example/", guard, everything), "169.254.169.254");
  // EXCLUDE wins over MAP wherever it is written; the excluded host goes to DNS.
  const excluded = lookup("MAP * 169.254.169.254,EXCLUDE real.example");
  assert.equal(await blockedUrl("http://real.example/", guard, excluded), undefined);
  assert.equal(await blockedUrl("http://other.example/", guard, excluded), "169.254.169.254");
  // The first matching MAP applies, and only once: its replacement is not mapped again.
  const first = lookup("MAP a.test 127.0.0.1,MAP a.* 169.254.169.254");
  assert.equal(await blockedUrl("http://a.test/", guard, first), undefined);
  assert.equal(await blockedUrl("http://a.other/", guard, first), "169.254.169.254");
  const once = lookup("MAP a.test b.test,MAP b.test 169.254.169.254");
  assert.equal(await blockedUrl("http://a.test/", guard, once), undefined, "b.test goes to DNS");
  // A replacement name is resolved normally; an IPv6 replacement keeps its address.
  const named = lookup("MAP a.test real.example:8080");
  assert.deepEqual(await named("a.test", { all: true }), [{ address: "8.8.8.8", family: 4 }]);
  const v6 = lookup("MAP a.test [fd00:ec2::254]:80");
  assert.equal(await blockedUrl("http://a.test/", guard, v6), "fd00:ec2::254");
  assert.equal(
    await blockedUrl("http://a.test/", guard, lookup("MAP a.test fd00:ec2::254")),
    "fd00:ec2::254",
  );
  // ~NOTFOUND fails like a missing name; the case of keyword and host does not matter.
  await assert.rejects(lookup("map A.test ~NOTFOUND")("a.test", { all: true }), {
    code: "ENOTFOUND",
  });
  assert.equal(
    await blockedUrl("http://A.TEST/", guard, lookup("map A.test 169.254.169.254")),
    "169.254.169.254",
  );
  // Chrome uses the last --host-resolver-rules switch.
  const repeated = lookup(
    "MAP a.test 127.0.0.1",
    "--host-resolver-rules=MAP a.test 169.254.169.254",
  );
  assert.equal(await blockedUrl("http://a.test/", guard, repeated), "169.254.169.254");
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
