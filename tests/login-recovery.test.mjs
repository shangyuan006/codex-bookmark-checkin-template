import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  loginHelperOutcome,
  loginHelperOutcomeFromStreams,
  parseLoginHelperResult,
  resolveLoginRecoveryUrl,
} from "../src/login-recovery.mjs";

test("登录助手必须明确返回 logged_in 才算成功", () => {
  assert.deepEqual(parseLoginHelperResult('startup\n{"status":"logged_in"}\n'), { status: "logged_in" });
  assert.deepEqual(parseLoginHelperResult('browser startup\n{\n  "status": "logged_in"\n}\n'), { status: "logged_in" });
  assert.equal(loginHelperOutcome('{"status":"logged_in"}').succeeded, true);
  assert.equal(loginHelperOutcome('{"status":"needs_attention"}').succeeded, false);
  assert.equal(loginHelperOutcome("browser startup text").succeeded, false);
  assert.equal(loginHelperOutcome('{"status":"unknown"}', "needs_attention").status, "needs_attention");
  assert.equal(
    loginHelperOutcome('{"status":"needs_attention","oauthStage":"linuxdo_session"}').oauthStage,
    "linuxdo_session",
  );
  assert.equal(
    Object.hasOwn(loginHelperOutcome('{"status":"needs_attention","oauthStage":"private-page-text"}'), "oauthStage"),
    false,
  );
});

test("受保护登录只暴露固定阶段码", () => {
  assert.deepEqual(loginHelperOutcome('{"status":"failed","loginStage":"post_submit","private":"secret"}'), {
    succeeded: false,
    status: "failed",
    diagnostic: "登录恢复流程失败",
    loginStage: "post_submit",
  });
  assert.equal(loginHelperOutcome('{"status":"failed","loginStage":"private-stage"}').loginStage, undefined);
});

test("OAuth helper result can be parsed from stderr without persisting raw diagnostics", () => {
  const outcome = loginHelperOutcomeFromStreams(
    "browser startup",
    '{"status":"needs_attention","oauthStage":"provider_authorization"}',
  );
  assert.equal(outcome.status, "needs_attention");
  assert.equal(outcome.oauthStage, "provider_authorization");
  assert.equal(Object.hasOwn(outcome, "raw"), false);
});

test("stdout status remains authoritative while stderr supplies a missing fixed stage", () => {
  const outcome = loginHelperOutcomeFromStreams(
    '{"status":"logged_in"}',
    '{"oauthStage":"completed"}',
  );
  assert.equal(outcome.status, "logged_in");
  assert.equal(outcome.succeeded, true);
  assert.equal(outcome.oauthStage, "completed");
});

test("报告中的查询参数和脱敏值不会被重新用于登录导航", () => {
  assert.equal(
    resolveLoginRecoveryUrl(
      "https://example.test",
      null,
      "https://example.test/sign-in?redirect=%5BVALUE%5D",
    ),
    "https://example.test/sign-in",
  );
  assert.equal(
    resolveLoginRecoveryUrl(
      "https://example.test",
      null,
      "https://example.test/#/login?redirect=%5BREDACTED%5D",
    ),
    "https://example.test/#/login",
  );
});

test("显式登录入口优先且必须保持同源 HTTPS", () => {
  assert.equal(
    resolveLoginRecoveryUrl("https://example.test", "https://example.test/auth?mode=login", null),
    "https://example.test/auth?mode=login",
  );
  assert.throws(
    () => resolveLoginRecoveryUrl("https://example.test", "https://evil.test/login", null),
    /目标 HTTPS origin/,
  );
  assert.throws(
    () => resolveLoginRecoveryUrl("http://example.test", null, null),
    /目标 HTTPS origin/,
  );
  assert.throws(
    () => resolveLoginRecoveryUrl([
      "https://user:secret@",
      "example.test",
    ].join(""), null, null),
    /目标 HTTPS origin/,
  );
});

test("非登录诊断地址及查询参数中的伪登录路径会回退", () => {
  assert.equal(
    resolveLoginRecoveryUrl("https://example.test", null, "https://example.test/dashboard"),
    "https://example.test/login",
  );
  assert.equal(
    resolveLoginRecoveryUrl("https://example.test", null, "https://example.test/dashboard?next=/login"),
    "https://example.test/login",
  );
});

test("恢复调度只复用清理后的登录 URL 并解析助手状态", async () => {
  const source = await fs.readFile(new URL("../src/index.mjs", import.meta.url), "utf8");
  assert.match(source, /loginHelperOutcomeFromStreams/);
  assert.match(source, /const savedLoginUrl = resolveLoginRecoveryUrl\(/);
  assert.match(source, /loginHelperOutcomeFromStreams\(helperOutput\.stdout, helperOutput\.stderr\)/);
  assert.match(source, /outcome\.status === "logged_in" \? loginHelperOutcome\("", fallback\) : outcome/);
  assert.doesNotMatch(source, /"-LoginUrl", current\.url/);
  assert.doesNotMatch(source, /"saved-password-login\.mjs"\), current\.origin, current\.url/);
});

test("OAuth helper exposes only fixed diagnostic stages", async () => {
  const source = await fs.readFile(new URL("../src/oauth-login.mjs", import.meta.url), "utf8");
  assert.match(source, /setOAuthStage\("provider_transition"\)/);
  assert.match(source, /setOAuthStage\("linuxdo_session"\)/);
  assert.match(source, /setOAuthStage\("provider_authorization"\)/);
  assert.match(source, /setOAuthStage\("target_callback"\)/);
  assert.match(source, /process\.stderr\.write/);
  assert.doesNotMatch(source, /oauthStage\s*=\s*(?:page\.|error\.|finalUrl|page\.url)/);
  assert.doesNotMatch(source, /printResult\([^)]*(?:page\.url|finalUrl|error)/s);
});
