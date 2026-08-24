import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { findBookmarkTarget } from "./bookmarks.mjs";
import { launchAutomationContext } from "./browser.mjs";
import { expandSavedPasswordLogin } from "./login-form.mjs";
import { acceptConfiguredLoginTerms, waitForLoginSubmitEnabled } from "./protected-login-flow.mjs";
import { assertBookmarkNavigation, safeLogUrl } from "./security.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const requestedOrigin = process.argv[2];
const requestedLoginUrl = process.argv[3];
if (!requestedOrigin || !requestedLoginUrl) throw new Error("用法: credential-login.mjs <origin> <login-url>");
const origin = new URL(requestedOrigin).origin;
const { target } = await findBookmarkTarget(config.bookmarksPath, origin, config);
const loginUrl = assertBookmarkNavigation(requestedLoginUrl, target.allowedOrigins ?? [origin]);
if (new URL(loginUrl).origin !== origin) throw new Error("受保护登录地址必须与凭据来源同源");

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 16 * 1024) throw new Error("凭据输入超过安全上限");
}
const credential = JSON.parse(input);
if (typeof credential.username !== "string" || credential.username.length < 1 || credential.username.length > 320
  || typeof credential.password !== "string" || credential.password.length < 1 || credential.password.length > 1024) {
  throw new Error("凭据输入格式无效");
}

function isLoginUrl(value) {
  try { return /\/(?:log[-_]?in|sign[-_]?in|auth)(?:[/?#]|$)|#\/(?:log[-_]?in|sign[-_]?in)(?:[/?#]|$)/i.test(new URL(value).href); }
  catch { return true; }
}

function pageMatchesOrigin(page) {
  try { return new URL(page.url()).origin === origin; } catch { return false; }
}

function challengeConfigured() {
  return (config.autoClickTurnstileOrigins ?? []).some((value) => {
    try {
      const candidate = new URL(value);
      return candidate.protocol === "https:"
        && !candidate.username
        && !candidate.password
        && candidate.origin === origin;
    } catch {
      return false;
    }
  });
}

const context = await launchAutomationContext(config);
let status = "failed";
let loginStage = "navigation";
let page;
let authCheckStatus = null;
try {
  page = await context.newPage();
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  if (!pageMatchesOrigin(page)) throw new Error("受保护登录页面离开目标 origin");
  loginStage = "form_expand";
  await expandSavedPasswordLogin(page, origin, config);
  await acceptConfiguredLoginTerms(page, origin, config);
  if (!pageMatchesOrigin(page)) throw new Error("受保护登录条款处理后离开目标 origin");
  loginStage = "form_fields";
  const password = page.locator('input[type="password"]:visible');
  if (await password.count() < 1) {
    if (isLoginUrl(page.url())) {
      status = "unsupported";
    } else {
      status = "logged_in";
      loginStage = "session_present";
    }
  } else {
    const usernames = page.locator('input:visible:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])');
    if (await usernames.count() < 1) status = "unsupported";
    else {
      await usernames.first().fill(credential.username);
      await password.first().fill(credential.password);
      let submit = null;
      for (const label of ["登录", "登入", "用户登录", "用戶登入", "Log in", "Sign in"]) {
        const candidate = page.getByRole("button", { name: label, exact: true });
        if (await candidate.count() === 1 && await candidate.isVisible()) { submit = candidate; break; }
      }
      if (!submit) {
        const fallback = page.locator('button[type="submit"]:visible, input[type="submit"]:visible');
        if (await fallback.count() === 1) submit = fallback.first();
      }
      if (!submit) {
        status = "unsupported";
        loginStage = "submit_control";
      }
      else {
        loginStage = "challenge_ready";
        const requireChallengeReady = challengeConfigured();
        const submitReady = await waitForLoginSubmitEnabled(page, submit, origin, config);
        if (!pageMatchesOrigin(page)) throw new Error("受保护登录验证后离开目标 origin");
        let submitAttempted = false;
        if (requireChallengeReady && !submitReady) {
          status = "needs_attention";
          loginStage = "challenge_blocked";
        }
        else {
          await submit.click({ timeout: 10000 }).catch(() => {});
          submitAttempted = true;
          loginStage = "post_submit";
        }
        if (submitAttempted) {
          const deadline = Date.now() + Math.max(30000, Math.min(90000, Number(config.cloudflareWaitMs) || 60000));
          while (Date.now() < deadline) {
            if (!pageMatchesOrigin(page)) { status = "failed"; break; }
            const stillHasPassword = await page.locator('input[type="password"]:visible').count() > 0;
            if (!stillHasPassword && !isLoginUrl(page.url())) {
              status = "logged_in";
              loginStage = "session_verification";
              break;
            }
            const cap = page.locator('cap-widget:visible, [data-cap-api-endpoint]:visible');
            if (await cap.count() === 1) await cap.click({ timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(1000);
          }
        }
        if (submitAttempted && status !== "logged_in") {
          const text = String(await page.locator("body").innerText().catch(() => ""));
          status = /(密码错误|账号或密码|invalid credentials|incorrect password)/i.test(text)
            ? "invalid_credential"
            : (await page.locator('cap-widget:visible, .cf-turnstile:visible, .h-captcha:visible').count() > 0
              ? "needs_attention"
              : "failed");
        }
      }
    }
  }
  if (status === "logged_in") {
    loginStage = "session_verification";
    await page.waitForTimeout(1200);
    await page.reload({ waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs }).catch(() => {});
    const passwordVisible = await page.locator('input[type="password"]:visible').count() > 0;
    if (!pageMatchesOrigin(page) || passwordVisible || isLoginUrl(page.url())) status = "failed";
    else {
      const verificationPath = config.protectedLoginVerificationPaths?.[origin];
      const verificationUrl = verificationPath ? new URL(verificationPath, origin) : null;
      if (verificationUrl && (verificationUrl.protocol !== "https:" || verificationUrl.origin !== origin)) {
        throw new Error("登录验证端点必须与凭据来源同源");
      }
      authCheckStatus = verificationUrl ? await page.evaluate(async (pathValue) => {
        const token = localStorage.getItem("auth_token");
        const headers = { Accept: "application/json" };
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetch(pathValue, { credentials: "include", headers }).catch(() => null);
        return response?.status ?? 0;
      }, verificationUrl.href) : 200;
      if (authCheckStatus !== 200) status = "failed";
      else loginStage = "completed";
    }
  }
  process.stdout.write(JSON.stringify({ status, loginStage, origin, finalUrl: safeLogUrl(page.url()), authCheckStatus }));
  if (status !== "logged_in") process.exitCode = 2;
} catch (error) {
  status = /Timeout|timed out/i.test(String(error?.message ?? error)) ? "timeout" : "failed";
  process.stdout.write(JSON.stringify({ status, loginStage, origin }));
  process.exitCode = 2;
} finally {
  credential.username = "";
  credential.password = "";
  await context.close();
}
