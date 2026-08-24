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

const OAUTH_DIAGNOSTIC_STAGES = new Set([
  "target_login",
  "provider_button",
  "provider_transition",
  "linuxdo_session",
  "provider_authorization",
  "target_callback",
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

const LOGIN_ROUTE_PATTERN = /\/(?:log[-_]?in|sign[-_]?in|auth)(?:[/]|$)/i;
const REDACTED_VALUE_PATTERN = /\[(?:VALUE|REDACTED)[^\]]*\]/i;

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
  return {
    succeeded: status === "logged_in",
    status,
    diagnostic: messages[status] ?? messages.failed,
    ...(OAUTH_DIAGNOSTIC_STAGES.has(String(value?.oauthStage))
      ? { oauthStage: String(value.oauthStage) }
      : {}),
    ...(LOGIN_DIAGNOSTIC_STAGES.has(String(value?.loginStage))
      ? { loginStage: String(value.loginStage) }
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
      ...(!primary.oauthStage && diagnostic.oauthStage ? { oauthStage: diagnostic.oauthStage } : {}),
      ...(!primary.loginStage && diagnostic.loginStage ? { loginStage: diagnostic.loginStage } : {}),
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
