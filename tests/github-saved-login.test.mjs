import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  isGitHubInteractiveVerificationUrl,
  isGitHubLoginUrl,
} from "../src/github-saved-login.mjs";

test("GitHub 保存登录只接受官方 HTTPS 登录页", () => {
  assert.equal(isGitHubLoginUrl("https://github.com/login?return_to=%2Flogin%2Foauth%2Fauthorize"), true);
  assert.equal(isGitHubLoginUrl("http://github.com/login"), false);
  assert.equal(isGitHubLoginUrl("https://github.example/login"), false);
});

test("GitHub 二次验证和 Passkey 页面必须人工处理", () => {
  for (const url of [
    "https://github.com/sessions/two-factor/app",
    "https://github.com/sessions/verified-device",
    "https://github.com/login/device",
    "https://github.com/passkeys/1",
  ]) {
    assert.equal(isGitHubInteractiveVerificationUrl(url), true, url);
  }
  assert.equal(isGitHubInteractiveVerificationUrl("https://github.com/login/oauth/authorize"), false);
});

test("GitHub 恢复器只读取字段是否填充且拒绝账号选择界面", async () => {
  const source = await fs.readFile(new URL("../src/github-saved-login.mjs", import.meta.url), "utf8");
  assert.match(source, /Boolean\(element\.value\)/);
  assert.doesNotMatch(source, /inputValue\(|console\.(?:log|error)|process\.(?:stdout|stderr)/);
  assert.match(source, /accountChooser/);
  assert.match(source, /one-time-code/);
  assert.match(source, /data-webauthn/);
});
