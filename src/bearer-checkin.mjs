const DEFAULT_REFRESH_PATH = "/api/user/auth/refresh";
const DEFAULT_SELF_PATH = "/api/data/self";
const DEFAULT_CHECKIN_PATH = "/api/user/checkin";

function secureOrigin(value, field = "origin") {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${field} must be an HTTPS URL without credentials`);
  }
  return parsed.origin;
}

function sameOriginUrl(origin, value, field) {
  let parsed;
  try {
    parsed = new URL(String(value || "/"), origin);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  if (parsed.protocol !== "https:"
    || parsed.origin !== origin
    || parsed.username
    || parsed.password) {
    throw new Error(`${field} must be a same-origin HTTPS URL without credentials`);
  }
  return parsed.href;
}

function boundedInteger(value, fallback, minimum, maximum, field) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

export function configuredBearerCheckinRule(origin, config = {}) {
  const expectedOrigin = secureOrigin(origin);
  const rules = config.bearerCheckinRules;
  if (rules == null) return null;
  if (typeof rules !== "object" || Array.isArray(rules)) {
    throw new Error("bearerCheckinRules must be an object keyed by canonical origin");
  }
  if (!Object.hasOwn(rules, expectedOrigin)) return null;
  const raw = rules[expectedOrigin];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("bearerCheckinRules rule must be an object");
  }
  return {
    origin: expectedOrigin,
    refreshUrl: sameOriginUrl(expectedOrigin, raw.refreshPath || DEFAULT_REFRESH_PATH, "refreshPath"),
    selfUrl: sameOriginUrl(expectedOrigin, raw.selfPath || DEFAULT_SELF_PATH, "selfPath"),
    checkinUrl: sameOriginUrl(expectedOrigin, raw.checkinPath || DEFAULT_CHECKIN_PATH, "checkinPath"),
    verificationAttempts: boundedInteger(raw.verificationAttempts, 3, 1, 5, "verificationAttempts"),
    verificationDelayMs: boundedInteger(raw.verificationDelayMs, 750, 0, 5000, "verificationDelayMs"),
  };
}

export function classifyBearerCheckinObservation(observed) {
  if (!observed) return { status: "unconfirmed", reason: "Bearer check-in returned no verifiable result" };
  if (observed.state === "unauthorized" || observed.state === "token_missing") {
    return { status: "login_required", reason: "The authoritative Bearer session is not valid" };
  }
  if (observed.state === "already_signed") {
    return { status: "already_signed", reason: "The authoritative check-in API confirms today's check-in" };
  }
  if (observed.state === "signed") {
    return {
      status: "signed",
      reason: "The authoritative check-in API confirms today's check-in",
      evidence: { source: "bearer_checkin_status", attempts: observed.attempts },
    };
  }
  if (observed.state === "not_available") {
    return { status: "not_available", reason: "The authoritative API reports that check-in is unavailable" };
  }
  if (observed.state === "interactive_challenge") {
    return { status: "interactive_challenge", reason: "The check-in API requires interactive verification" };
  }
  if (observed.state === "upstream_unavailable") {
    return {
      status: "deferred",
      retryCause: "upstream_unavailable",
      reason: "The Bearer authentication or check-in service is temporarily unavailable",
    };
  }
  return { status: "unconfirmed", reason: "Bearer check-in could not be authoritatively verified" };
}

export async function runBearerCheckinInBrowser({ activeRule, sessionOnly = false }) {
  const maxAccessTokenLength = 16 * 1024;
  const fetchJson = async (url, options = {}) => {
    try {
      const response = await fetch(url, { credentials: "include", ...options });
      const body = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, body };
    } catch {
      return { ok: false, status: 0, body: null };
    }
  };
  const unauthorizedMessage = (message) => /not logged|login required|unauthori[sz]ed|forbidden|\u672a\u767b\u5f55|\u672a\u767b\u9304|\u672a\u6388\u6743|\u7121\u6b0a/i.test(String(message || ""));
  const unavailable = (result) => result.status === 0 || result.status >= 500;
  const unauthorized = (result) => [401, 403].includes(result.status)
    || unauthorizedMessage(result.body?.message);

  const refresh = await fetchJson(activeRule.refreshUrl, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (unauthorized(refresh)) return { state: "unauthorized" };
  if (unavailable(refresh)) return { state: "upstream_unavailable" };
  const accessToken = refresh.body?.data?.access_token;
  const tokenType = String(refresh.body?.data?.token_type || "Bearer").trim();
  const refreshUserId = refresh.body?.data?.user?.id ?? refresh.body?.data?.id;
  if (!refresh.ok
    || refresh.body?.success === false
    || typeof accessToken !== "string"
    || !accessToken
    || accessToken.length > maxAccessTokenLength
    || /[\r\n]/.test(accessToken)
    || !/^Bearer$/i.test(tokenType)) {
    return { state: "token_missing" };
  }

  const headers = { Accept: "application/json", Authorization: `Bearer ${accessToken}` };
  const self = await fetchJson(activeRule.selfUrl, { headers });
  if (unauthorized(self)) return { state: "unauthorized" };
  if (unavailable(self)) return { state: "upstream_unavailable" };
  const userId = self.body?.data?.user?.id ?? self.body?.data?.id ?? refreshUserId;
  const validUserId = (typeof userId === "string"
    && userId.trim().length > 0
    && userId.length <= 256)
    || (typeof userId === "number" && Number.isSafeInteger(userId) && userId >= 0);
  if (!self.ok
    || self.body?.success === false
    || !validUserId) {
    return { state: "verification_failed" };
  }
  if (sessionOnly) return { state: "session_valid" };

  const readStatus = async () => {
    const result = await fetchJson(activeRule.checkinUrl, { headers });
    if (unauthorized(result)) return { state: "unauthorized" };
    if (result.status === 404) return { state: "not_available" };
    if (unavailable(result)) return { state: "upstream_unavailable" };
    if (!result.ok || result.body?.success === false) return { state: "verification_failed" };
    if (result.body?.data?.enabled === false) return { state: "not_available" };
    const checked = result.body?.data?.stats?.checked_in_today
      ?? result.body?.data?.checked_in_today
      ?? result.body?.data?.checkedInToday;
    if (typeof checked !== "boolean") return { state: "verification_failed" };
    return { state: checked ? "already_signed" : "ready" };
  };

  const before = await readStatus();
  if (before.state !== "ready") return before;

  const submitted = await fetchJson(activeRule.checkinUrl, { method: "POST", headers });
  if (unauthorized(submitted)) return { state: "unauthorized" };
  if (submitted.status === 404) return { state: "not_available" };
  if (unavailable(submitted)) return { state: "upstream_unavailable" };
  const submitMessage = String(submitted.body?.message || "");
  if (/captcha|turnstile|challenge|\u9a8c\u8bc1|\u9a57\u8b49|\u4eba\u673a|\u4eba\u6a5f/i.test(submitMessage)
    && submitted.body?.success !== true) {
    return { state: "interactive_challenge" };
  }

  for (let attempt = 1; attempt <= activeRule.verificationAttempts; attempt += 1) {
    const verified = await readStatus();
    if (verified.state === "already_signed") return { state: "signed", attempts: attempt };
    if (verified.state !== "ready" && verified.state !== "verification_failed") return verified;
    if (attempt < activeRule.verificationAttempts && activeRule.verificationDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, activeRule.verificationDelayMs));
    }
  }
  return { state: "verification_failed" };
}

export async function tryBearerCheckin(page, origin, config = {}) {
  const rule = configuredBearerCheckinRule(origin, config);
  if (!rule) return null;
  const observed = await page.evaluate(runBearerCheckinInBrowser, { activeRule: rule, sessionOnly: false });
  return classifyBearerCheckinObservation(observed);
}

export async function verifyConfiguredBearerSession(page, origin, config = {}) {
  const rule = configuredBearerCheckinRule(origin, config);
  if (!rule) return null;
  const observed = await page.evaluate(runBearerCheckinInBrowser, { activeRule: rule, sessionOnly: true })
    .catch(() => ({ state: "verification_failed" }));
  if (observed.state === "session_valid") return { status: "valid" };
  if (["unauthorized", "token_missing"].includes(observed.state)) return { status: "invalid" };
  return { status: "unknown" };
}
