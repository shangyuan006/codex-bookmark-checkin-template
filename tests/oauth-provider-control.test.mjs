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

test("OAuth provider fallback recognizes both LinuxDO label variants without selecting a different provider", () => {
  for (const provider of ["LinuxDO", "Linux DO"]) {
    assert.equal(selectOAuthProviderControlIndex(["使用 Linux DO 继续", "使用 GitHub 继续"], provider), 0);
    assert.equal(selectOAuthProviderControlIndex(["LinuxDO 登录"], provider), 0);
    assert.equal(selectOAuthProviderControlIndex(["Linux DO", "GitHub 登录"], provider), -1);
    assert.equal(selectOAuthProviderControlIndex(["Linux DO 登录", "LinuxDO 登录"], provider), -1);
  }
});
