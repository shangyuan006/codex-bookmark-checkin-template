import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAgentRouterAccountKey,
  normalizeReauthProvider,
  reauthAccountMetadataForOrigin,
  resultIdentity,
} from "../src/result-identity.mjs";

test("result identity normalizes origins and Agent Router account keys", () => {
  assert.equal(resultIdentity({ origin: "https://EXAMPLE.test:443/" }), "https://example.test");
  assert.equal(
    resultIdentity({ origin: "https://example.test", accountKey: " Linux.DO " }),
    "https://example.test#account=linux-do",
  );
});

test("Agent Router keys use the same path-safe normalization as the runner", () => {
  assert.equal(normalizeAgentRouterAccountKey(" Linux.DO "), "linux-do");
  assert.equal(normalizeAgentRouterAccountKey("GitHub Primary"), "github-primary");
  assert.throws(() => normalizeAgentRouterAccountKey("..."), /agentrouter accountKey/);
});

test("reauth provider metadata is restricted to canonical public labels", () => {
  assert.equal(normalizeReauthProvider("Linux DO"), "LinuxDO");
  assert.equal(normalizeReauthProvider("github"), "GitHub");
  assert.throws(() => normalizeReauthProvider("Private account label"), /allowed OAuth provider/);
});

test("result identity rejects malformed identity fields", () => {
  assert.throws(() => resultIdentity({ origin: "https://example.test/path" }), /HTTP\(S\) origin/);
  assert.throws(() => resultIdentity({ origin: "https://user@example.com" }), /HTTP\(S\) origin/);
  assert.throws(() => resultIdentity({ origin: "https://example.test", accountKey: " " }), /accountKey/);
});

test("Agent Router metadata gives legacy ownership only to the first configured account", () => {
  const metadata = reauthAccountMetadataForOrigin({
    agentrouterAccounts: [
      { origin: "https://router.example", accountId: "github", provider: "GitHub" },
      { origin: "https://router.example/", accountId: "Linux.DO", provider: "LinuxDO" },
      { origin: "https://other.example", accountId: "other", provider: "Other" },
    ],
  }, "https://router.example");
  assert.deepEqual(metadata, [
    {
      origin: "https://router.example",
      accountKey: "github",
      provider: "GitHub",
      supplementalAccount: false,
    },
    {
      origin: "https://router.example",
      accountKey: "linux-do",
      provider: "LinuxDO",
      supplementalAccount: true,
    },
  ]);
});

test("Agent Router treats legacy accountId as a key and validates key uniqueness", () => {
  assert.throws(() => reauthAccountMetadataForOrigin({
    agentrouterAccounts: [
      { origin: "https://router.example", accountId: "same" },
      { origin: "https://router.example", accountId: "same" },
    ],
  }, "https://router.example"), /duplicate accountKey/);
  assert.throws(() => reauthAccountMetadataForOrigin({
    agentrouterAccounts: [{ origin: "https://router.example/path", accountId: "one" }],
  }, "https://router.example"), /HTTP\(S\) origin/);
  assert.throws(() => reauthAccountMetadataForOrigin({
    agentrouterAccounts: [{ origin: "http://router.example", accountId: "one" }],
  }, "https://router.example"), /HTTPS origin/);
});
