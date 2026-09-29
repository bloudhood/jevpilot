import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMaxSessions, parseNetworkGuard } from "../../src/mcp/network-guard.ts";
import { blockedAddress, blockedUrl } from "../../src/security/address-guard.ts";

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
  ])
    assert.equal(blockedAddress(value, guard), true, value);
});

test("O3: JEVPILOT_NETWORK_GUARD, JEVPILOT_BLOCKED_ADDRESSES and JEVPILOT_MAX_SESSIONS are validated at startup", () => {
  assert.throws(() => parseNetworkGuard("bad"), /JEVPILOT_NETWORK_GUARD/);
  assert.throws(() => parseNetworkGuard("off", "not-a-cidr"), /JEVPILOT_BLOCKED_ADDRESSES/);
  assert.throws(() => parseMaxSessions("0"), /JEVPILOT_MAX_SESSIONS/);
  assert.equal(parseMaxSessions(undefined), 8);
});
