import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecret } from "../../src/orchestrator/redact.ts";

const secret = "Pa$$ w0rd/9?&=+ünï long-token";

test("R4: a secret is redacted in the forms a page or the browser echoes it", () => {
  const encoded = encodeURIComponent(secret);
  const forms = [
    secret,
    encoded,
    encoded.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase()),
    new URLSearchParams({ p: secret }).toString().slice(2),
    encodeURI(secret),
    secret.replace(" ", "\n  "),
    secret.replace(" ", " \t"),
  ];
  for (const form of forms) {
    const url = `http://example.test/login?next=%2Fhome&password=${form}&x=1`;
    const clean = redactSecret(url, secret);
    assert.equal(clean, "http://example.test/login?next=%2Fhome&password=[REDACTED]&x=1", form);
    assert.equal(redactSecret(`Wrong password: ${form}.`, secret), "Wrong password: [REDACTED].");
  }
});

test("R4: a cut-off echo of a secret is redacted", () => {
  const token = `sk-${"abcdefghij".repeat(10)}`;
  const shown = `${token.slice(0, 60)}…`;
  assert.equal(redactSecret(`value ${shown}`, token), "value [REDACTED]…");
  assert.equal(redactSecret(`value ${token.slice(0, 8)}…`, token), "value [REDACTED]…");
  assert.equal(redactSecret(`${token} and ${shown}`, token), "[REDACTED] and [REDACTED]…");
  assert.equal(
    redactSecret(`?t=${encodeURIComponent(secret).slice(0, 15)}…`, secret),
    "?t=[REDACTED]…",
  );
});

test("R4: text that only resembles a secret is left alone", () => {
  assert.equal(redactSecret("Forgot your password?", "hunter2hunter2"), "Forgot your password?");
  assert.equal(redactSecret("hunter", "hunter2hunter2"), "hunter");
  assert.equal(redactSecret("Enter your Pa$$ word", "Pa$$ w0rd-long"), "Enter your Pa$$ word");
  assert.equal(redactSecret("plain text", "a.b*c"), "plain text");
  assert.equal(redactSecret("nothing here", ""), "nothing here");
  assert.equal(redactSecret("a.b*c and axb", "a.b*c"), "[REDACTED] and axb");
  assert.equal(
    redactSecret("bad %zz escape %E0%A4 here", "escape-secret"),
    "bad %zz escape %E0%A4 here",
  );
});

test("R4: a very long secret redacts without recursion limits", () => {
  const key =
    "-----BEGIN KEY-----\n" + "QUJDREVGR0hJSktMTU5PUA==\n".repeat(400) + "-----END KEY-----";
  const page = `<${key.replace(/\s+/gu, " ")}> and ${key.replace(/\s+/gu, " ").slice(0, 60)}…`;
  assert.equal(redactSecret(page, key), "<[REDACTED]> and [REDACTED]…");
});

test("R9: a secret cut short by the observer is still redacted", () => {
  const token = `common-word-${"abcdefghij".repeat(12)}`;
  for (const limit of [60, 80]) {
    const prefix = token.slice(0, limit - 1);
    assert.equal(redactSecret(`${prefix}…`, token), "[REDACTED]…");
    assert.equal(redactSecret(`Ordinary ${prefix} text`, token), `Ordinary ${prefix} text`);
  }
  assert.equal(redactSecret("common-w in ordinary text", token), "common-w in ordinary text");
  assert.equal(redactSecret("correct horse", "correct horse battery staple"), "correct horse");
  assert.equal(redactSecret("password…", "password1!", false), "password…");
  assert.equal(redactSecret("password1!", "password1!", false), "[REDACTED]");
  const encoded = token.replace("common", "%63ommon");
  assert.equal(redactSecret(`${encoded} `.repeat(1000), token), "[REDACTED] ".repeat(1000));
});
