import test from "node:test";
import assert from "node:assert/strict";
import { selectOAuthProviderControlIndex } from "../src/oauth-provider-control.mjs";

test("OAuth provider fallback selects one login action containing the provider", () => {
  assert.equal(selectOAuthProviderControlIndex([
    "使用 GitHub 继续",
    "使用邮箱登录",
  ], "GitHub"), 0);
  assert.equal(selectOAuthProviderControlIndex([
    "Continue with GitHub",
    "LinuxDO 登录",
  ], "GitHub"), 0);
});

test("OAuth provider fallback fails closed for ambiguous or non-action labels", () => {
  assert.equal(selectOAuthProviderControlIndex(["GitHub", "账户设置"], "GitHub"), -1);
  assert.equal(selectOAuthProviderControlIndex([
    "Continue with GitHub",
    "Sign in with GitHub",
  ], "GitHub"), -1);
  assert.equal(selectOAuthProviderControlIndex([], "GitHub"), -1);
});
