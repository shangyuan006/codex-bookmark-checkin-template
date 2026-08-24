const DEFAULT_SIGN_IN_PATH = "/api/user/sign_in";
const DEFAULT_SELF_PATH = "/api/user/self";
const DEFAULT_STATUS_PATH = "/api/status";
const DEFAULT_LOG_PATH = "/api/log/self";
const DEFAULT_CHECKIN_PATH = "/api/user/checkin";
const DEFAULT_CAPTCHA_PATH = "/api/user/checkin/captcha";
const DEFAULT_USER_STORAGE_KEYS = ["user"];
const MAX_CAPTCHA_BYTES = 5 * 1024 * 1024;

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

function sameOriginHttpsUrl(origin, value, field) {
  const expectedOrigin = secureOrigin(origin, "origin");
  let resolved;
  try {
    resolved = new URL(String(value || "/"), expectedOrigin);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  if (resolved.protocol !== "https:"
    || resolved.origin !== expectedOrigin
    || resolved.username
    || resolved.password) {
    throw new Error(`${field} must be a same-origin HTTPS URL without credentials`);
  }
  return resolved.href;
}

function requiredShortText(value, field) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 120 || /[\r\n]/.test(text)) {
    throw new Error(`${field} must be 1-120 characters on one line`);
  }
  return text;
}

function boundedInteger(value, fallback, minimum, maximum, field) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function configuredUserStorageKeys(raw) {
  const keys = raw ?? DEFAULT_USER_STORAGE_KEYS;
  if (!Array.isArray(keys)
    || keys.length === 0
    || keys.length > 8
    || keys.some((key) => !String(key).trim()
      || String(key).length > 80
      || /[\r\n]/.test(String(key)))) {
    throw new Error("userStorageKeys must contain 1-8 short storage keys");
  }
  return [...new Set(keys.map((key) => String(key).trim()))];
}

function verificationOptions(raw) {
  return {
    verificationAttempts: boundedInteger(raw.verificationAttempts, 3, 1, 5, "verificationAttempts"),
    verificationDelayMs: boundedInteger(raw.verificationDelayMs, 750, 0, 5000, "verificationDelayMs"),
  };
}

function configuredRule(config, field, origin) {
  const rules = config?.[field];
  if (rules == null) return null;
  if (typeof rules !== "object" || Array.isArray(rules)) {
    throw new Error(`${field} must be an object keyed by canonical origin`);
  }
  if (!Object.hasOwn(rules, origin)) return null;
  const raw = rules[origin];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${field} rule must be an object`);
  }
  return raw;
}

export function configuredNewApiSignInRule(origin, config = {}) {
  const expectedOrigin = secureOrigin(origin);
  const raw = configuredRule(config, "newApiSignInRules", expectedOrigin);
  if (raw == null) return null;

  const rewardAmount = Number(raw.rewardAmount);
  const logType = Number(raw.logType);
  if (!Number.isFinite(rewardAmount) || rewardAmount <= 0) {
    throw new Error("rewardAmount must be a positive number");
  }
  if (!Number.isInteger(logType) || logType < 0 || logType > 100) {
    throw new Error("logType must be an integer from 0 to 100");
  }

  return {
    origin: expectedOrigin,
    signInUrl: sameOriginHttpsUrl(expectedOrigin, raw.signInPath || DEFAULT_SIGN_IN_PATH, "signInPath"),
    selfUrl: sameOriginHttpsUrl(expectedOrigin, raw.selfPath || DEFAULT_SELF_PATH, "selfPath"),
    statusUrl: sameOriginHttpsUrl(expectedOrigin, raw.statusPath || DEFAULT_STATUS_PATH, "statusPath"),
    logUrl: sameOriginHttpsUrl(expectedOrigin, raw.logPath || DEFAULT_LOG_PATH, "logPath"),
    logSuccessText: requiredShortText(raw.logSuccessText, "logSuccessText"),
    rewardAmount,
    logType,
    userStorageKeys: configuredUserStorageKeys(raw.userStorageKeys),
    ...verificationOptions(raw),
  };
}

export function configuredNewApiCaptchaRule(origin, config = {}) {
  const expectedOrigin = secureOrigin(origin);
  const raw = configuredRule(config, "newApiCaptchaRules", expectedOrigin);
  if (raw == null) return null;

  return {
    origin: expectedOrigin,
    checkinUrl: sameOriginHttpsUrl(expectedOrigin, raw.checkinPath || DEFAULT_CHECKIN_PATH, "checkinPath"),
    captchaUrl: sameOriginHttpsUrl(expectedOrigin, raw.captchaPath || DEFAULT_CAPTCHA_PATH, "captchaPath"),
    maxAttempts: boundedInteger(raw.maxAttempts, 6, 1, 8, "maxAttempts"),
    userStorageKeys: configuredUserStorageKeys(raw.userStorageKeys),
    ...verificationOptions(raw),
  };
}

function candidateText(candidate) {
  if (typeof candidate === "string") return candidate;
  if (candidate && typeof candidate === "object") return candidate.code ?? candidate.text ?? "";
  return "";
}

export function normalizeNewApiCaptchaCandidates(candidates) {
  if (!Array.isArray(candidates)) return [];
  const normalized = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const code = String(candidateText(candidate)).trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code) || seen.has(code)) continue;
    seen.add(code);
    normalized.push(code);
  }
  return normalized;
}

function decodeCaptchaImage(value) {
  const text = String(value ?? "").trim();
  const dataMatch = text.match(/^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/]+={0,2})$/i);
  const encoded = dataMatch?.[1] ?? (/^[A-Za-z0-9+/]+={0,2}$/.test(text) ? text : "");
  if (!encoded || encoded.length > Math.ceil(MAX_CAPTCHA_BYTES / 3) * 4 + 4) return null;

  const image = Buffer.from(encoded, "base64");
  if (image.length === 0 || image.length > MAX_CAPTCHA_BYTES) return null;
  return image;
}

function amountMatches(value, expected) {
  const amount = Number(value);
  return Number.isFinite(amount) && Math.abs(amount - expected) < 0.000001;
}

export function classifyNewApiSignInObservation(observed, rule) {
  if (!observed) {
    return { status: "unconfirmed", reason: "New API sign-in returned no verifiable result" };
  }
  if (observed.state === "user_id_missing") {
    return { status: "login_required", reason: "No explicit signed-in user ID was available" };
  }
  if (observed.state === "user_id_ambiguous") {
    return { status: "unconfirmed", reason: "Multiple user IDs were present; no sign-in request was sent" };
  }
  if (observed.state === "unauthorized") {
    return { status: "login_required", reason: "The authoritative API rejected the current session" };
  }
  if (observed.state === "already_confirmed") {
    return {
      status: "already_signed",
      reason: "Today's reward was confirmed by the usage log",
      evidence: { source: "usage_log" },
    };
  }
  if (observed.state !== "called") {
    return { status: "unconfirmed", reason: "New API sign-in or verification was unavailable" };
  }

  const sources = [];
  if (observed.rewardLogAfter === true && observed.rewardLogBefore !== true) sources.push("usage_log");
  if (amountMatches(observed.quotaDelta, rule.rewardAmount)) sources.push("self_quota_delta");
  if (sources.length > 0) {
    return {
      status: "signed",
      reason: "Sign-in was confirmed by authoritative account state",
      evidence: { sources },
    };
  }

  const message = String(observed.responseMessage ?? "");
  if (/not logged|login required|unauthori[sz]ed|forbidden|\u672a\u767b\u5f55|\u672a\u767b\u9304|\u672a\u6388\u6743|\u7121\u6b0a/i.test(message)) {
    return { status: "login_required", reason: "The sign-in API reported an expired session" };
  }
  if (/turnstile|hcaptcha|recaptcha|captcha|\u9a8c\u8bc1\u7801|\u9a57\u8b49\u78bc|\u4eba\u673a|\u4eba\u6a5f/i.test(message)) {
    return { status: "interactive_challenge", reason: "The sign-in API requires an interactive challenge" };
  }
  if (/(?:error\s*1290|lock_write_growth|mysql server|database.{0,30}(?:locked|read[ -]?only)|internal server error|bad gateway|service unavailable)/i.test(message)) {
    return {
      status: "deferred",
      retryCause: "upstream_unavailable",
      reason: "The upstream sign-in service is temporarily unavailable",
    };
  }
  return {
    status: "unconfirmed",
    reason: "The request returned without a matching usage log or authoritative account-state change",
  };
}

export function classifyNewApiCaptchaObservation(observed) {
  if (!observed) return { status: "unconfirmed", reason: "Captcha check-in returned no verifiable result" };
  if (observed.state === "user_id_missing") {
    return { status: "login_required", reason: "No explicit signed-in user ID was available" };
  }
  if (observed.state === "user_id_ambiguous") {
    return { status: "unconfirmed", reason: "Multiple user IDs were present; no check-in request was sent" };
  }
  if (observed.state === "unauthorized") {
    return { status: "login_required", reason: "The authoritative API rejected the current session" };
  }
  if (observed.state === "already_signed") {
    return { status: "already_signed", reason: "The authoritative status API confirms today's check-in" };
  }
  if (observed.state === "signed") {
    return {
      status: "signed",
      reason: "The authoritative status API confirms today's check-in",
      evidence: { source: "new_api_checkin_status", attempts: observed.attempts },
    };
  }
  if (observed.state === "captcha_unresolved") {
    return { status: "interactive_challenge", reason: "Local OCR produced no unused, valid five-character candidate" };
  }
  return { status: "unconfirmed", reason: "New API captcha check-in could not be authoritatively verified" };
}

export async function tryNewApiSignIn(page, origin, config = {}) {
  const rule = configuredNewApiSignInRule(origin, config);
  if (!rule) return null;

  const observed = await page.evaluate(async (activeRule) => {
    const extractUserId = (value) => value?.id
      ?? value?.user?.id
      ?? value?.state?.user?.id
      ?? value?.data?.id
      ?? value?.data?.user?.id
      ?? null;
    const normalizeId = (value) => {
      const id = String(value ?? "").trim();
      return /^\d{1,20}$/.test(id) ? id : null;
    };
    const ids = [];
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of activeRule.userStorageKeys) {
        try {
          const id = normalizeId(extractUserId(JSON.parse(storage.getItem(key) || "null")));
          if (id) ids.push(id);
        } catch { /* Ignore malformed configured storage values. */ }
      }
    }
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return { state: "user_id_missing" };
    if (uniqueIds.length !== 1) return { state: "user_id_ambiguous" };

    const userId = uniqueIds[0];
    const headers = { Accept: "application/json", "New-Api-User": userId };
    const fetchJson = async (url, options = {}) => {
      try {
        const response = await fetch(url, { credentials: "include", ...options });
        const text = await response.text();
        let body = null;
        try { body = JSON.parse(text); } catch { /* Invalid JSON remains unverified. */ }
        return { ok: response.ok, status: response.status, body };
      } catch {
        return { ok: false, status: 0, body: null };
      }
    };
    const unauthorizedMessage = (message) => /not logged|login required|unauthori[sz]ed|forbidden|\u672a\u767b\u5f55|\u672a\u767b\u9304|\u672a\u6388\u6743|\u7121\u6b0a/i.test(String(message || ""));
    const readSelf = async () => {
      const result = await fetchJson(activeRule.selfUrl, { headers });
      const message = result.body?.message;
      if ([401, 403].includes(result.status) || unauthorizedMessage(message)) {
        return { unauthorized: true, authenticated: false, quota: null };
      }
      if (!result.ok || result.body?.success === false) {
        return { unauthorized: false, authenticated: false, quota: null };
      }
      const returnedId = normalizeId(extractUserId(result.body));
      if (returnedId && returnedId !== userId) return { ambiguous: true, authenticated: false, quota: null };
      const quota = Number(result.body?.data?.quota ?? result.body?.data?.user?.quota);
      return { unauthorized: false, authenticated: true, quota: Number.isFinite(quota) ? quota : null };
    };
    const readQuotaPerUnit = async () => {
      const result = await fetchJson(activeRule.statusUrl, { headers: { Accept: "application/json" } });
      const value = Number(result.body?.data?.quota_per_unit ?? result.body?.data?.quotaPerUnit);
      return Number.isFinite(value) && value > 0 ? value : null;
    };
    const findRewardLog = async () => {
      const now = new Date();
      const startSeconds = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
      const endSeconds = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() / 1000);
      const amountPattern = /(?:increase(?:d)? quota|reward(?:ed)?|\u589e\u52a0\u989d\u5ea6|\u65b0\u589e\u989d\u5ea6|\u83b7\u5f97\u989d\u5ea6|\u7372\u5f97\u984d\u5ea6)\s*[\uff04$]\s*([0-9]+(?:\.[0-9]+)?)/i;
      for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
        const endpoint = new URL(activeRule.logUrl);
        endpoint.searchParams.set("p", String(pageIndex));
        endpoint.searchParams.set("page_size", "100");
        endpoint.searchParams.set("type", String(activeRule.logType));
        endpoint.searchParams.set("token_name", "");
        endpoint.searchParams.set("model_name", "");
        endpoint.searchParams.set("start_timestamp", String(startSeconds));
        endpoint.searchParams.set("end_timestamp", String(endSeconds));
        endpoint.searchParams.set("group", "");
        const result = await fetchJson(endpoint.href, { headers });
        if ([401, 403].includes(result.status) || unauthorizedMessage(result.body?.message)) {
          return { unauthorized: true, found: false };
        }
        const items = result.body?.data?.items;
        if (!result.ok || !Array.isArray(items)) return { unauthorized: false, found: false };
        const match = items.find((item) => {
          const createdAt = Number(item?.created_at);
          const content = String(item?.content || "");
          const amount = Number(content.match(amountPattern)?.[1]);
          return Number(item?.type) === activeRule.logType
            && createdAt >= startSeconds
            && createdAt < endSeconds
            && content.includes(activeRule.logSuccessText)
            && Number.isFinite(amount)
            && Math.abs(amount - activeRule.rewardAmount) < 0.000001;
        });
        if (match) return { unauthorized: false, found: true };
        if (items.length < 100) break;
      }
      return { unauthorized: false, found: false };
    };

    const before = await readSelf();
    if (before.unauthorized) return { state: "unauthorized" };
    if (before.ambiguous) return { state: "user_id_ambiguous" };
    if (!before.authenticated) return { state: "verification_failed" };
    const rewardLogBefore = await findRewardLog();
    if (rewardLogBefore.unauthorized) return { state: "unauthorized" };
    if (rewardLogBefore.found) return { state: "already_confirmed" };
    const quotaPerUnit = await readQuotaPerUnit();

    const signIn = await fetchJson(activeRule.signInUrl, { method: "POST", headers });
    if ([401, 403].includes(signIn.status)) return { state: "unauthorized" };

    let after = null;
    let rewardLogAfter = { found: false };
    for (let attempt = 1; attempt <= activeRule.verificationAttempts; attempt += 1) {
      [after, rewardLogAfter] = await Promise.all([readSelf(), findRewardLog()]);
      if (after.unauthorized) return { state: "unauthorized" };
      if (after.ambiguous) return { state: "user_id_ambiguous" };
      if (rewardLogAfter.unauthorized) return { state: "unauthorized" };
      const rawDelta = before.quota != null && after.quota != null ? after.quota - before.quota : null;
      const quotaDelta = rawDelta == null ? null : (quotaPerUnit ? rawDelta / quotaPerUnit : rawDelta);
      if (rewardLogAfter.found || (Number.isFinite(quotaDelta)
        && Math.abs(quotaDelta - activeRule.rewardAmount) < 0.000001)) break;
      if (attempt < activeRule.verificationAttempts && activeRule.verificationDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, activeRule.verificationDelayMs));
      }
    }

    const rawDelta = before.quota != null && after?.quota != null ? after.quota - before.quota : null;
    const quotaDelta = rawDelta == null ? null : (quotaPerUnit ? rawDelta / quotaPerUnit : rawDelta);
    return {
      state: "called",
      signInStatus: signIn.status,
      responseSuccess: signIn.body?.success === true,
      responseMessage: String(signIn.body?.message || "").slice(0, 200),
      quotaDelta,
      rewardLogBefore: false,
      rewardLogAfter: rewardLogAfter.found === true,
    };
  }, rule);

  return classifyNewApiSignInObservation(observed, rule);
}

export async function tryNewApiCaptchaCheckin(page, origin, config = {}, solveCaptcha) {
  const rule = configuredNewApiCaptchaRule(origin, config);
  if (!rule) return null;
  if (typeof solveCaptcha !== "function") throw new Error("solveCaptcha must be a function");

  const session = await page.evaluate(async (activeRule) => {
    const extractUserId = (value) => value?.id
      ?? value?.user?.id
      ?? value?.state?.user?.id
      ?? value?.data?.id
      ?? value?.data?.user?.id
      ?? null;
    const ids = [];
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of activeRule.userStorageKeys) {
        try {
          const id = String(extractUserId(JSON.parse(storage.getItem(key) || "null")) ?? "").trim();
          if (/^\d{1,20}$/.test(id)) ids.push(id);
        } catch { /* Ignore malformed configured storage values. */ }
      }
    }
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return { state: "user_id_missing" };
    if (uniqueIds.length !== 1) return { state: "user_id_ambiguous" };

    const userId = uniqueIds[0];
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const endpoint = new URL(activeRule.checkinUrl);
    endpoint.searchParams.set("month", month);
    let response;
    try {
      response = await fetch(endpoint.href, {
        credentials: "include",
        headers: { Accept: "application/json", "New-Api-User": userId },
      });
    } catch {
      return { state: "verification_failed" };
    }
    if ([401, 403].includes(response.status)) return { state: "unauthorized" };
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.success !== true) return { state: "verification_failed" };
    const checked = body?.success === true
      && Boolean(body?.data?.stats?.checked_in_today
        ?? body?.data?.checked_in_today
        ?? body?.data?.checkedInToday);
    return checked ? { state: "already_signed" } : { state: "ready", userId };
  }, rule);
  if (session.state !== "ready") return classifyNewApiCaptchaObservation(session);

  const tried = new Set();
  for (let attempt = 1; attempt <= rule.maxAttempts; attempt += 1) {
    const challenge = await page.evaluate(async ({ activeRule, userId }) => {
      let response;
      try {
        response = await fetch(activeRule.captchaUrl, {
          method: "POST",
          credentials: "include",
          headers: { Accept: "application/json", "New-Api-User": userId },
        });
      } catch {
        return { state: "failed" };
      }
      if ([401, 403].includes(response.status)) return { state: "unauthorized" };
      const body = await response.json().catch(() => null);
      const id = body?.data?.captcha_id;
      const image = body?.data?.captcha_image;
      if (!response.ok || body?.success !== true || !id || !image) return { state: "failed" };
      return { state: "ready", id: String(id), image: String(image) };
    }, { activeRule: rule, userId: session.userId });
    if (challenge.state !== "ready") return classifyNewApiCaptchaObservation(challenge);

    const image = decodeCaptchaImage(challenge.image);
    if (!image) return classifyNewApiCaptchaObservation({ state: "failed" });
    let rawCandidates;
    try {
      rawCandidates = await solveCaptcha(image, { attempt });
    } catch {
      rawCandidates = [];
    }
    const code = normalizeNewApiCaptchaCandidates(rawCandidates)
      .find((candidate) => !tried.has(candidate));
    if (!code) continue;
    tried.add(code);

    const submitted = await page.evaluate(async ({ activeRule, userId, captchaId, captchaAnswer }) => {
      let response;
      try {
        response = await fetch(activeRule.checkinUrl, {
          method: "POST",
          credentials: "include",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "New-Api-User": userId,
          },
          body: JSON.stringify({ captcha_id: captchaId, captcha_answer: captchaAnswer }),
        });
      } catch {
        return { state: "failed" };
      }
      if ([401, 403].includes(response.status)) return { state: "unauthorized" };
      const body = await response.json().catch(() => null);
      const message = String(body?.message || "");
      if (/captcha|\u9a8c\u8bc1\u7801|\u9a57\u8b49\u78bc/i.test(message) && body?.success !== true) {
        return { state: "retry" };
      }
      if (body?.success === true || /already.+(?:signed|checked)|\u5df2\u7b7e\u5230|\u5df2\u7c3d\u5230/i.test(message)) {
        return { state: "submitted" };
      }
      return { state: "failed" };
    }, {
      activeRule: rule,
      userId: session.userId,
      captchaId: challenge.id,
      captchaAnswer: code,
    });
    if (submitted.state === "retry") continue;
    if (submitted.state !== "submitted") return classifyNewApiCaptchaObservation(submitted);

    const verified = await page.evaluate(async ({ activeRule, userId }) => {
      for (let attemptIndex = 1; attemptIndex <= activeRule.verificationAttempts; attemptIndex += 1) {
        const now = new Date();
        const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        const endpoint = new URL(activeRule.checkinUrl);
        endpoint.searchParams.set("month", month);
        let response;
        try {
          response = await fetch(endpoint.href, {
            credentials: "include",
            headers: { Accept: "application/json", "New-Api-User": userId },
          });
        } catch {
          response = null;
        }
        if (response && [401, 403].includes(response.status)) return { state: "unauthorized" };
        const body = response ? await response.json().catch(() => null) : null;
        const checked = response?.ok
          && body?.success === true
          && Boolean(body?.data?.stats?.checked_in_today
            ?? body?.data?.checked_in_today
            ?? body?.data?.checkedInToday);
        if (checked) return { state: "signed" };
        if (attemptIndex < activeRule.verificationAttempts && activeRule.verificationDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, activeRule.verificationDelayMs));
        }
      }
      return { state: "verification_failed" };
    }, { activeRule: rule, userId: session.userId });
    if (verified.state === "signed") {
      return classifyNewApiCaptchaObservation({ state: "signed", attempts: attempt });
    }
    return classifyNewApiCaptchaObservation(verified);
  }

  return classifyNewApiCaptchaObservation({ state: "captcha_unresolved" });
}
