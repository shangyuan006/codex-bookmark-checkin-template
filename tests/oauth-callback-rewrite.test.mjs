import test from "node:test";
import assert from "node:assert/strict";
import { rewriteConfiguredOAuthCallbackUrl } from "../src/oauth-callback-rewrite.mjs";

test("configured OAuth callback alias replaces only the origin", () => {
  const rewritten = rewriteConfiguredOAuthCallbackUrl(
    "https://legacy.example/oauth/linuxdo?code=opaque%2Bvalue&state=a%2Fb#done",
    "https://current.example",
    { "https://current.example": ["https://legacy.example"] },
  );

  assert.equal(
    rewritten,
    "https://current.example/oauth/linuxdo?code=opaque%2Bvalue&state=a%2Fb#done",
  );
});

test("OAuth callback alias refuses unconfigured and non-HTTPS origins", () => {
  const aliases = { "https://current.example": ["https://legacy.example"] };

  assert.equal(
    rewriteConfiguredOAuthCallbackUrl(
      "https://other.example/oauth/linuxdo?code=opaque",
      "https://current.example",
      aliases,
    ),
    null,
  );
  assert.equal(
    rewriteConfiguredOAuthCallbackUrl(
      "http://legacy.example/oauth/linuxdo?code=opaque",
      "https://current.example",
      aliases,
    ),
    null,
  );
});
