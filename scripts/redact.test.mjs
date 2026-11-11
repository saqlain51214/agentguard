// Redaction tests. Run with: npm run test:redact
// Uses only node:test and node:assert, and esbuild (already installed with vite).
import test from "node:test";
import assert from "node:assert/strict";
import { redact, looksClean, hasCredentials } from "../.tmp/redact.mjs";

/** Each of these must NOT survive redaction. */
const MUST_REMOVE = {
  email: ["maria.santos@example.com", "maria.santos@example.com"],
  "unicode email": ["józef@exämple.com", "józef@exämple.com"],
  "card, spaces": ["4111 1111 1111 1111", "4111 1111 1111 1111"],
  "card, dots": ["4111.1111.1111.1111", "4111.1111.1111.1111"],
  "api key sk-": ["sk-live-8fJ2xQp91mZvNrT4wLcB7yHs", "8fJ2xQp91mZvNrT4wLcB7yHs"],
  "aws key": ["AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
  "google key": ["AIzaSyD8dRPYaXQ07EBaE34J8BdWLdJ6uNTQQIs", "AIzaSyD8dRPY"],
  "gitlab token": ["glpat-abcdefghijklmnopqrstu", "abcdefghijklmnopqrstu"],
  "jwt": ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r", "eyJhbGci"],
  "bearer, short": ["Authorization: Bearer abc123", "abc123"],
  "plain password": ["login with password: hunter2 now", "hunter2"],
  "secret key=": ["secret_key=abcd1234efgh5678", "abcd1234efgh5678"],
  "private key": ["-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----", "MIIE"],
  "ipv4": ["host 10.20.30.40 down", "10.20.30.40"],
  "ipv6": ["2001:0db8:85a3:0000:0000:8a2e:0370:7334", "8a2e:0370"],
  "phone intl": ["call +44 20 7946 0958", "7946 0958"],
  "phone short": ["call 555-2671", "555-2671"],
  "ssn": ["SSN 123-45-6789", "123-45-6789"],
  "iban": ["IBAN GB82 WEST 1234 5698 7654 32", "1234 5698"],
  "hex id": ["id 5f2b8c1a9d3e4f6071a2b3c4", "5f2b8c1a9d3e4f6071a2b3c4"],
  "base64 blob": ["token dGhpcyBpcyBhIHNlY3JldA==", "dGhpcyBpcyBhIHNlY3JldA"],
  "labelled name": ["Customer James Whitfield disputed", "Whitfield"],
  "street address": ["lives at 12 Baker Street", "Baker Street"],
  "internal host": ["db.internal.example.corp is down", "internal.example.corp"],
  "url path/query": ["https://api.example.com/v1/users/42?token=SECRET123", "SECRET123"],
  "exact amount": ["refund $7,400.00 today", "7,400"],
};

for (const [name, [input, secret]] of Object.entries(MUST_REMOVE)) {
  test(`removes ${name}`, () => {
    const { text } = redact(input);
    assert.ok(!text.includes(secret), `"${secret}" survived: ${text}`);
  });
}

test("credential material is flagged so it is never escalated", () => {
  for (const s of ["Bearer abc123def456", "password: hunter2", "AKIAIOSFODNN7EXAMPLE", "sk-live-8fJ2xQp91mZvNrT4wLcB7yHs"]) {
    assert.ok(hasCredentials(redact(s).removed), s);
  }
  assert.ok(!hasCredentials(redact("Reply to a shipping question").removed));
});

test("redaction is idempotent, so looksClean accepts its own output", () => {
  for (const [input] of Object.values(MUST_REMOVE)) {
    const { text } = redact(input);
    assert.ok(looksClean(text), `not clean after redaction: ${text}`);
  }
});

test("looksClean rejects raw identifiers it was handed directly", () => {
  for (const s of ["write to maria@example.com", "card 4111 1111 1111 1111", "password: hunter2", "AKIAIOSFODNN7EXAMPLE", "10.1.2.3"]) {
    assert.ok(!looksClean(s), s);
  }
});

test("amounts become buckets, not exact figures", () => {
  assert.match(redact("$45.00").text, /AMOUNT<50/);
  assert.match(redact("$480.00").text, /AMOUNT_200_1K/);
  assert.match(redact("$7,400.00").text, /AMOUNT_1K_10K/);
});

test("ordinary text passes through unchanged", () => {
  const t = "Reply to a shipping question about an order that arrives Thursday";
  assert.equal(redact(t).text, t);
});

test("output is capped in length", () => {
  assert.ok(redact("word ".repeat(400)).text.length < 700);
});

/** Known limits. These document what redaction does NOT do, so nobody assumes otherwise. */
test("KNOWN LIMIT: an unlabelled name is not recognised", () => {
  assert.ok(redact("Maria Santos asked about her order").text.includes("Maria Santos"));
});
