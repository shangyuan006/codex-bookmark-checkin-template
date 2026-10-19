import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import {
  classifyCredentialApiVerification,
  classifyCredentialVerification,
  credentialVerificationUrl,
  verifyCredentialSession,
} from "../src/credential-session-verification.mjs";

const valid = {
  expectedOrigin: "https://tracker.example",
  finalUrl: "https://tracker.example/attendance.php",
  statusCode: 200,
  passwordVisible: false,
  bodyText: "欢迎回来，今日已签到，连续签到 12 天。",
};

test("受保护登录验证路径必须是同源 HTTPS", () => {
  assert.equal(
    credentialVerificationUrl("https://tracker.example", "/attendance.php").href,
    "https://tracker.example/attendance.php",
  );
  assert.throws(() => credentialVerificationUrl("https://tracker.example", ""), /权威验证路径/);
  assert.throws(() => credentialVerificationUrl("https://tracker.example", "https://other.example/profile"), /同源 HTTPS/);
});

test("账号接口必须明确认证成功并返回有效身份，200 或旧身份本身不算成功", () => {
  for (const id of [42, "42"]) {
    assert.equal(classifyCredentialApiVerification({ statusCode: 200,
      body: { success: true, data: { id } } }).authenticated, true);
  }
  for (const sample of [
    { statusCode: 401, body: { success: true, data: { id: 42 } } },
    { statusCode: 200, body: { success: false, data: { id: 42 } } },
    { statusCode: 200, body: { data: { id: 42 } } },
    { statusCode: 200, body: { success: true, data: {} } },
    { statusCode: 200, body: { success: true, data: { id: 0 } } },
    { statusCode: 200, body: { success: true, data: { id: Number.MAX_SAFE_INTEGER + 1 } } },
    { statusCode: 200, body: "Loading account details, please wait" },
  ]) assert.equal(classifyCredentialApiVerification(sample).authenticated, false);
});

test("offline Edge verifies the frontend's authenticated self response instead of bare API navigation", {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== "1", timeout: 30000,
}, async t => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  const origin = "https://credential.example.test";
  let success = true, profileLoads = 0;
  await context.route("**/*", route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    assert.equal(request.method(), "GET");
    if (path === "/api/user/self") {
      const authenticated = request.headers()["x-fixture-authenticated"] === "1";
      return route.fulfill({ status: authenticated || !success ? 200 : 401,
        contentType: "application/json", body: JSON.stringify({
          success: success && authenticated, data: { id: 42 },
        }) });
    }
    profileLoads++;
    return route.fulfill({ status: 200, contentType: "text/html", body:
      '<main>Loading account details, please wait</main>' + (path === "/profile"
        ? '<script>fetch("/api/user/self", {headers: {"X-Fixture-Authenticated": "1"}})</script>' : '') });
  });
  await page.goto(`${origin}/profile`);
  const options = { origin, verificationPath: "/api/user/self", navigationTimeoutMs: 1000 };
  const verified = await verifyCredentialSession(page, options);
  assert.equal(verified.authenticated, true);
  assert.equal(verified.statusCode, 200);
  assert.ok(profileLoads >= 2);
  assert.equal(new URL(page.url()).pathname, "/profile");
  assert.equal(Object.hasOwn(verified, "id"), false);

  await page.goto(`${origin}/dashboard`);
  const fromLanding = await verifyCredentialSession(page, { ...options, pageUrl: `${origin}/profile` });
  assert.equal(fromLanding.authenticated, true);
  assert.equal(new URL(page.url()).pathname, "/profile");
  await assert.rejects(verifyCredentialSession(page, { ...options, pageUrl: "https://outside.example.test/profile" }),
    /同源 HTTPS/);

  // An HTTP 200 containing a stale identity must not authenticate the caller.
  success = false;
  const rejected = await verifyCredentialSession(page, options);
  assert.equal(rejected.authenticated, false);
  assert.equal(rejected.failureCode, "api_session_unconfirmed");

  await page.goto("https://other.example.test/profile");
  const before = profileLoads;
  assert.equal((await verifyCredentialSession(page, options)).failureCode, "cross_origin");
  assert.equal(profileLoads, before);
});

test("只有权威页面的已登录证据才通过", () => {
  const success = classifyCredentialVerification(valid);
  assert.equal(success.authenticated, true);
  assert.equal(success.dailyCheckin.status, "already_signed");
  for (const sample of [
    { finalUrl: "https://tracker.example/login.php", bodyText: "登录", passwordVisible: true },
    { finalUrl: "https://tracker.example/takelogin.php", bodyText: "处理中", passwordVisible: false },
    { bodyText: "请先登录后访问签到页面" },
    { passwordVisible: true },
    { bodyText: "当前环境正在被调试，请稍后重试" },
    { bodyText: "异地登录安全验证，请输入二级验证代码" },
    { statusCode: 500 },
  ]) {
    assert.equal(classifyCredentialVerification({ ...valid, ...sample }).authenticated, false, JSON.stringify(sample));
  }
});
