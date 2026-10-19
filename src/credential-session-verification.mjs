import { classifyPageText } from "./detector.mjs";

const LOGIN_ROUTE = /\/(?:log[-_]?in|sign[-_]?in|auth)(?:[/?#]|$)|#\/(?:log[-_]?in|sign[-_]?in)(?:[/?#]|$)/i;
const LOGGED_OUT_TEXT = /(?:未登录|尚未登录|请先登录|請先登入|必须登录后|必須登入後|登录后(?:才|方|可)|登入後(?:才|方|可)|not logged in|sign in to continue|login required|authentication required)/i;
const CHALLENGE_TEXT = /(?:Just a moment|正在进行安全验证|Performing security verification|当前环境正在被调试|verify you are human)/i;

export function credentialVerificationUrl(originValue, verificationPath) {
  const origin = new URL(originValue).origin;
  const raw = String(verificationPath ?? "").trim();
  if (!raw) throw new Error("受保护登录必须配置权威验证路径");
  const url = new URL(raw, `${origin}/`);
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) {
    throw new Error("登录验证端点必须是同源 HTTPS 地址");
  }
  return url;
}

export function classifyCredentialVerification({
  expectedOrigin,
  finalUrl,
  statusCode,
  passwordVisible,
  bodyText,
}) {
  let location;
  try { location = new URL(finalUrl); }
  catch { return { authenticated: false, failureCode: "invalid_final_url" }; }
  const expected = new URL(expectedOrigin).origin;
  const text = String(bodyText ?? "");
  if (location.protocol !== "https:" || location.origin !== expected) {
    return { authenticated: false, failureCode: "cross_origin" };
  }
  if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 400) {
    return { authenticated: false, failureCode: "verification_http_error" };
  }
  if (LOGIN_ROUTE.test(location.href)) return { authenticated: false, failureCode: "login_route" };
  if (passwordVisible) return { authenticated: false, failureCode: "password_form" };
  if (CHALLENGE_TEXT.test(text)) return { authenticated: false, failureCode: "challenge" };
  if (LOGGED_OUT_TEXT.test(text)) return { authenticated: false, failureCode: "logged_out_text" };
  if (text.trim().length < 20) return { authenticated: false, failureCode: "empty_page" };

  const pageState = classifyPageText({ url: location.href, bodyText: text, hasPassword: false });
  if (pageState.status === "login_required") return { authenticated: false, failureCode: "login_required" };
  if (["interactive_challenge", "managed_challenge"].includes(pageState.status)) {
    return { authenticated: false, failureCode: "challenge" };
  }
  const dailyCheckin = ["signed", "already_signed"].includes(pageState.status)
    ? { status: pageState.status, reason: pageState.reason, evidence: { source: "credential_verification" } }
    : null;
  return { authenticated: true, failureCode: null, dailyCheckin };
}

export function classifyCredentialApiVerification({ statusCode, body }) {
  if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 300) {
    return { authenticated: false, failureCode: "verification_http_error" };
  }
  const id = body?.data?.id ?? body?.data?.user?.id;
  const validId = (typeof id === "string" || (typeof id === "number" && Number.isSafeInteger(id)))
    && /^[1-9][0-9]{0,19}$/.test(String(id));
  return body?.success === true && validId
    ? { authenticated: true, failureCode: null }
    : { authenticated: false, failureCode: "api_session_unconfirmed" };
}

export async function verifyCredentialSession(page, {
  origin,
  verificationPath,
  pageUrl = null,
  navigationTimeoutMs = 20000,
}) {
  const verificationUrl = credentialVerificationUrl(origin, verificationPath);
  if (verificationUrl.pathname === "/api/user/self") {
    // Some frontends keep authentication in memory and add it to their own
    // API requests. Directly navigating to /self omits those headers. Observe
    // the frontend's actual read instead of copying or logging its secrets.
    let current;
    try { current = new URL(page.url()); } catch { /* fail closed below */ }
    if (current?.origin !== verificationUrl.origin || current?.protocol !== "https:") {
      return { authenticated: false, failureCode: "cross_origin", statusCode: 0, passwordVisible: false };
    }
    const frontendUrl = pageUrl === null ? null : credentialVerificationUrl(origin, pageUrl);
    const responsePromise = page.waitForResponse(async candidate => {
      if (candidate.url() !== verificationUrl.href || candidate.request().method() !== "GET"
        || candidate.status() < 200 || candidate.status() >= 300) return false;
      const body = await candidate.json().catch(() => null);
      return classifyCredentialApiVerification({ statusCode: candidate.status(), body }).authenticated;
    }, { timeout: Math.max(500, Math.min(Number(navigationTimeoutMs) || 20000, 8000)) })
      .catch(() => null);
    const navigationOptions = { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs };
    if (frontendUrl) await page.goto(frontendUrl.href, navigationOptions).catch(() => {});
    else await page.reload(navigationOptions).catch(() => {});
    const observed = await responsePromise;
    if (observed) {
      let location;
      try { location = new URL(page.url()); } catch { /* fail closed below */ }
      if (location?.origin !== verificationUrl.origin || location?.protocol !== "https:") {
        return { authenticated: false, failureCode: "cross_origin", statusCode: 0, passwordVisible: false };
      }
      return { authenticated: true, failureCode: null, statusCode: observed.status(), passwordVisible: false };
    }
  }
  const response = await page.goto(verificationUrl.href, {
    waitUntil: "domcontentloaded",
    timeout: navigationTimeoutMs,
  }).catch(() => null);
  if (verificationUrl.pathname === "/api/user/self") {
    let location;
    try { location = new URL(page.url()); } catch { /* fail closed below */ }
    if (location?.href !== verificationUrl.href) {
      return { authenticated: false, failureCode: "invalid_final_url", statusCode: response?.status() ?? 0,
        passwordVisible: false };
    }
    const body = await response?.json().catch(() => null);
    return { ...classifyCredentialApiVerification({ statusCode: response?.status() ?? 0, body }),
      statusCode: response?.status() ?? 0, passwordVisible: false };
  }
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  const bodyText = String(await page.locator("body").innerText().catch(() => ""));
  const passwordVisible = await page.locator('input[type="password"]:visible').count().catch(() => 0) > 0;
  const evidence = classifyCredentialVerification({
    expectedOrigin: origin,
    finalUrl: page.url(),
    statusCode: response?.status() ?? 0,
    passwordVisible,
    bodyText,
  });
  return { ...evidence, statusCode: response?.status() ?? 0, passwordVisible };
}
