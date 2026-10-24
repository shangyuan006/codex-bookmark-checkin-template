import { sanitizeOAuthPageObservation, sanitizeOAuthCallbackDiagnostics, sanitizeOAuthTimingDiagnostics } from './oauth-target-state.mjs';

const LOGIN_HELPER_STATUSES = new Set([
  "logged_in",
  "needs_attention",
  "no_saved_credential",
  "credential_missing",
  "invalid_credential",
  "unsupported",
  "timeout",
  "failed",
]);

export const OAUTH_DIAGNOSTIC_STAGES = new Set([
  "oauth_retry_budget_exhausted",
  "logout_verification",
  "target_login",
  "provider_button",
  "login_challenge",
  "provider_transition",
  "linuxdo_session",
  "linuxdo_session_challenge",
  "linuxdo_session_rate_limited",
  "linuxdo_login_challenge",
  "linuxdo_provider_login_required",
  "provider_session",
  "github_autofill_missing",
  "github_account_selection",
  "github_interactive_verification",
  "github_form_not_unique",
  "github_submit_not_unique",
  "github_submit_failed",
  "github_login_not_completed",
  "provider_authorization",
  "target_callback",
  "session_verification",
  "checkin_verification",
  "completed",
  "timeout",
  "helper_failed",
]);

const LOGIN_DIAGNOSTIC_STAGES = new Set([
  "navigation",
  "form_expand",
  "form_fields",
  "submit_control",
  "challenge_ready",
  "challenge_blocked",
  "post_submit",
  "session_present",
  "session_verification",
  "completed",
]);

const PROVIDER_AUTHORIZATION_CHALLENGE_OUTCOMES = new Set([
  "not_observed",
  "observed_not_clickable",
  "observed_auto_resolved",
  "clicked_once",
  "clicked_twice",
  "resolved_after_click",
  "departed_unconfirmed",
  "unresolved_after_click",
]);

const PROVIDER_AUTHORIZATION_OUTCOMES = new Set([
  'not_applicable', 'authorization_not_found', 'authorization_not_unique', 'authorization_click_failed',
  'authorization_clicked', 'authorization_completed', 'authorization_departed', 'provider_login_required',
  'provider_challenge_not_clickable', 'provider_challenge_unresolved',
]);

const LOGIN_ROUTE_PATTERN = /\/(?:log[-_]?in|sign[-_]?in|auth)(?:[/]|$)/i;
const REDACTED_VALUE_PATTERN = /\[(?:VALUE|REDACTED)[^\]]*\]/i;

const CHECKIN_AFTER_LOGIN_METHODS = new Set([
  "protected_credential",
  "oauth",
  "oauth_autodetect",
  "native_oauth_checkin",
  "saved_password",
  "native_saved_password",
]);

const CHECKIN_RECHECKABLE_STATUSES = new Set([
  "error",
  "login_required",
  "interactive_challenge",
  "managed_challenge",
  "managed_challenge_timeout",
  "needs_attention",
  "unconfirmed",
  "clicked",
  "visited",
  "no_action",
  "deferred",
]);

const MANUAL_LOGIN_OUTCOMES = new Set([
  "needs_attention", "no_saved_credential", "credential_missing", "invalid_credential", "unsupported",
]);

export function loginRecoveryRequiresManualHandoff(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0
    || attempts.some(attempt => attempt?.succeeded === true || attempt?.status === "logged_in")) return false;
  // A failed automated autofill probe alone is inconclusive. A native probe
  // that also finds no usable form or saved login confirms that this fallback
  // cannot restore the session. Other failures and timeouts remain retryable.
  const nativeFallbackUnavailable = attempts.some(attempt => attempt?.method === "native_saved_password"
    && ["unsupported", "no_saved_credential"].includes(attempt.status));
  return attempts.every(attempt => CHECKIN_AFTER_LOGIN_METHODS.has(attempt?.method)
    && (MANUAL_LOGIN_OUTCOMES.has(attempt.status)
      || (attempt.method === "saved_password" && attempt.status === "failed" && nativeFallbackUnavailable)));
}

export function applyLoginRecoveryHandoff(result, loginOutcome) {
  if (result?.status === 'login_required' && loginOutcome?.attempts?.some(attempt => attempt.failureCode === 'two_factor_required')) {
    return {...result,status:'needs_attention',failureCode:'two_factor_required',retryableLoginRecovery:false,
      reason:'站点要求人工完成二次验证，不再重复自动登录'};
  }
  // Always recheck the page after the helpers: their failure must not override
  // a restored session, a check-in result, or a transient navigation error.
  if (result?.status !== "login_required" || loginOutcome?.succeeded
    || !loginRecoveryRequiresManualHandoff(loginOutcome?.attempts)) return result;
  const { nextEligibleAt: _nextEligibleAt, ...preserved } = result;
  return {
    ...preserved,
    status: "needs_attention",
    failureCode: "login_recovery_requires_manual",
    retryable: false,
    reason: "页面仍要求登录，现有自动恢复方法无可用登录路径；需人工登录，不再重复自动恢复",
  };
}

/**
 * A successful login helper only proves that a session was restored. A site
 * may still need one fresh navigation before its check-in page sees that
 * session, so let the caller perform one bounded same-context recheck.
 */
export function shouldRecheckCheckinAfterLogin(loginOutcome, result) {
  if (!loginOutcome?.succeeded
    || loginOutcome.authoritativeCheckinStatus
    || !result
    || !CHECKIN_RECHECKABLE_STATUSES.has(String(result.status))
    || result.retryable === false
    || result.submissionAttempted === true) {
    return false;
  }
  return Array.isArray(loginOutcome.attempts)
    && loginOutcome.attempts.some((attempt) => CHECKIN_AFTER_LOGIN_METHODS.has(String(attempt?.method)));
}

export function parseLoginHelperResult(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const value = JSON.parse(lines.slice(index).join("\n"));
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch { /* helpers may include harmless non-JSON browser startup text */ }
  }
  for (const line of [...lines].reverse()) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch { /* a compact result may appear before trailing diagnostic text */ }
  }
  return null;
}

export function loginHelperOutcome(text, fallback = "failed") {
  const value = parseLoginHelperResult(text);
  const normalizedFallback = LOGIN_HELPER_STATUSES.has(String(fallback)) ? String(fallback) : "failed";
  const status = LOGIN_HELPER_STATUSES.has(String(value?.status)) ? String(value.status) : normalizedFallback;
  const messages = {
    logged_in: "已取得登录会话",
    needs_attention: "登录需要额外验证",
    no_saved_credential: "独立配置没有可用保存凭据",
    credential_missing: "没有配置受保护站点凭据",
    invalid_credential: "站点拒绝了当前凭据",
    unsupported: "未识别可自动提交的登录表单",
    timeout: "登录恢复流程超时",
    failed: "登录恢复流程失败",
  };
  const providerAuthorizationChallengeClicks = Number(value?.providerAuthorizationChallengeClicks);
  return {
    succeeded: status === "logged_in",
    status,
    ...(status !== 'logged_in' && value?.failureCode === 'two_factor_required'
      ? {failureCode:'two_factor_required',retryableLoginRecovery:false} : {}),
    diagnostic: messages[status] ?? messages.failed,
    ...sanitizeOAuthPageObservation(value),
    ...sanitizeOAuthCallbackDiagnostics(value?.callbackDiagnostics),
    ...sanitizeOAuthTimingDiagnostics(value),
    ...(["signed", "already_signed"].includes(String(value?.checkinStatus))
      ? { checkinStatus: String(value.checkinStatus) }
      : {}),
    ...(OAUTH_DIAGNOSTIC_STAGES.has(String(value?.oauthStage))
      ? { oauthStage: String(value.oauthStage) }
      : {}),
    ...(PROVIDER_AUTHORIZATION_OUTCOMES.has(value?.authorizationOutcome)
      ? {authorizationOutcome:value.authorizationOutcome} : {}),
    ...(LOGIN_DIAGNOSTIC_STAGES.has(String(value?.loginStage))
      ? { loginStage: String(value.loginStage) }
      : {}),
    ...(PROVIDER_AUTHORIZATION_CHALLENGE_OUTCOMES.has(String(value?.providerAuthorizationChallengeOutcome))
      ? { providerAuthorizationChallengeOutcome: String(value.providerAuthorizationChallengeOutcome) }
      : {}),
    ...(Number.isInteger(providerAuthorizationChallengeClicks)
      && providerAuthorizationChallengeClicks >= 0
      && providerAuthorizationChallengeClicks <= 10
      ? { providerAuthorizationChallengeClicks }
      : {}),
  };
}

export function loginHelperOutcomeFromStreams(stdout, stderr = "", fallback = "failed") {
  const stdoutResult = parseLoginHelperResult(stdout);
  const primary = loginHelperOutcome(stdout, fallback);
  const diagnostic = loginHelperOutcome(stderr, fallback);
  if (stdoutResult) {
    return {
      ...primary,
      ...Object.fromEntries(Object.entries(sanitizeOAuthPageObservation(diagnostic))
        .filter(([key]) => primary[key] == null)),
      ...(!primary.callbackDiagnostics && diagnostic.callbackDiagnostics
        ? { callbackDiagnostics: diagnostic.callbackDiagnostics } : {}),
      ...Object.fromEntries(Object.entries(sanitizeOAuthTimingDiagnostics(diagnostic))
        .filter(([key]) => primary[key] == null)),
      ...(!primary.oauthStage && diagnostic.oauthStage ? { oauthStage: diagnostic.oauthStage } : {}),
      ...(!primary.loginStage && diagnostic.loginStage ? { loginStage: diagnostic.loginStage } : {}),
      ...(!primary.authorizationOutcome && diagnostic.authorizationOutcome
        ? {authorizationOutcome:diagnostic.authorizationOutcome} : {}),
      ...(!primary.providerAuthorizationChallengeOutcome && diagnostic.providerAuthorizationChallengeOutcome
        ? { providerAuthorizationChallengeOutcome: diagnostic.providerAuthorizationChallengeOutcome }
        : {}),
      ...(primary.providerAuthorizationChallengeClicks == null
        && diagnostic.providerAuthorizationChallengeClicks != null
        ? { providerAuthorizationChallengeClicks: diagnostic.providerAuthorizationChallengeClicks }
        : {}),
    };
  }
  return diagnostic;
}

function sameOriginHttpsUrl(value, expectedOrigin) {
  const url = new URL(value);
  if (url.protocol !== "https:"
    || url.origin !== expectedOrigin
    || url.username
    || url.password) {
    throw new Error("登录恢复地址必须属于目标 HTTPS origin");
  }
  return url;
}

function decodedHash(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function isLoginRoute(url) {
  if (LOGIN_ROUTE_PATTERN.test(url.pathname)) return true;
  const hashRoute = decodedHash(url.hash.slice(1)).split("?", 1)[0];
  return LOGIN_ROUTE_PATTERN.test(hashRoute.startsWith("/") ? hashRoute : `/${hashRoute}`);
}

function sanitizeObservedLoginUrl(url) {
  url.search = "";
  if (!url.hash) return url;

  const rawHash = url.hash.slice(1);
  const queryIndex = rawHash.indexOf("?");
  url.hash = queryIndex >= 0 ? `#${rawHash.slice(0, queryIndex)}` : url.hash;
  if (REDACTED_VALUE_PATTERN.test(decodedHash(url.hash))) url.hash = "";
  return url;
}

export function resolveLoginRecoveryUrl(origin, configuredUrl, observedUrl) {
  const originUrl = new URL(origin);
  const expected = sameOriginHttpsUrl(origin, originUrl.origin).origin;
  if (configuredUrl) return sameOriginHttpsUrl(configuredUrl, expected).href;

  if (observedUrl) {
    try {
      const observed = sameOriginHttpsUrl(observedUrl, expected);
      if (isLoginRoute(observed)) return sanitizeObservedLoginUrl(observed).href;
    } catch { /* invalid diagnostic URLs fall back to the conventional route */ }
  }
  return new URL("/login", expected).href;
}
