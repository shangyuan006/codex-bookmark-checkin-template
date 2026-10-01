import {
  configuredBearerCheckinRule,
  verifyConfiguredBearerSession,
} from "./bearer-checkin.mjs";

const DEFAULT_USER_STORAGE_KEYS = ["user"];

function secureOrigin(value, field = "origin") {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${field} must be an HTTPS URL without credentials`);
  }
  return url.origin;
}

function sameOriginUrl(origin, value, field) {
  let url;
  try {
    url = new URL(String(value || "/"), origin);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  if (url.protocol !== "https:"
    || url.origin !== origin
    || url.username
    || url.password) {
    throw new Error(`${field} must be a same-origin HTTPS URL without credentials`);
  }
  return url.href;
}

function storageKeys(value) {
  const keys = value ?? DEFAULT_USER_STORAGE_KEYS;
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

export function configuredSavedLoginSessionRule(origin, config = {}) {
  const expectedOrigin = secureOrigin(origin);
  const rules = config.savedLoginSessionRules;
  if (rules == null) return null;
  if (typeof rules !== "object" || Array.isArray(rules)) {
    throw new Error("savedLoginSessionRules must be an object keyed by canonical origin");
  }
  if (!Object.hasOwn(rules, expectedOrigin)) return null;
  const raw = rules[expectedOrigin];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("savedLoginSessionRules rule must be an object");
  }
  if (!["new_api", "bearer_refresh"].includes(raw.type)) {
    throw new Error("savedLoginSessionRules type must be new_api or bearer_refresh");
  }
  if (raw.type === "bearer_refresh") {
    if (raw.refreshPath !== undefined || raw.selfPath !== undefined) {
      if (!raw.refreshPath || !raw.selfPath) {
        throw new Error("standalone bearer_refresh requires refreshPath and selfPath");
      }
      return {
        type: "bearer_refresh",
        sessionAdapter: {
          refreshPath: sameOriginUrl(expectedOrigin, raw.refreshPath, "refreshPath"),
          selfPath: sameOriginUrl(expectedOrigin, raw.selfPath, "selfPath"),
        },
      };
    }
    if (!configuredBearerCheckinRule(expectedOrigin, config)) {
      throw new Error("bearer_refresh session verification requires a bearerCheckinRules entry");
    }
    return { type: "bearer_refresh" };
  }
  return {
    type: "new_api",
    selfUrl: sameOriginUrl(expectedOrigin, raw.selfPath || "/api/user/self", "selfPath"),
    userStorageKeys: storageKeys(raw.userStorageKeys),
  };
}

export async function verifyConfiguredSavedLoginSession(page, origin, config = {}) {
  const expectedOrigin = secureOrigin(origin);
  const rule = configuredSavedLoginSessionRule(expectedOrigin, config);
  if (!rule) return null;
  if (rule.type === "bearer_refresh") {
    // An explicit session-only adapter is deliberately ephemeral. Enabling
    // login verification must not enable a direct check-in POST for this site.
    const sessionConfig = rule.sessionAdapter ? {
      ...config,
      bearerCheckinRules: { ...config.bearerCheckinRules, [expectedOrigin]: rule.sessionAdapter },
    } : config;
    return verifyConfiguredBearerSession(page, expectedOrigin, sessionConfig);
  }
  return page.evaluate(async (activeRule) => {
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
        } catch { /* Invalid site storage is not authoritative. */ }
      }
    }
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return { status: "invalid" };
    if (uniqueIds.length !== 1) return { status: "unknown" };

    const userId = uniqueIds[0];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let response;
    try {
      response = await fetch(activeRule.selfUrl, {
        credentials: "include",
        signal: controller.signal,
        headers: { Accept: "application/json", "New-Api-User": userId },
      });
      if ([401, 403].includes(response.status)) return { status: "invalid" };
      if (!response.ok) return { status: "unknown" };
      const body = await response.json();
      if (!body || body.success === false) return { status: "invalid" };
      const returnedId = normalizeId(extractUserId(body));
      if (!returnedId || returnedId !== userId) return { status: "invalid" };
      return { status: "valid" };
    } catch {
      return { status: "unknown" };
    } finally {
      clearTimeout(timeout);
    }
  }, rule).catch(() => ({ status: "unknown" }));
}
