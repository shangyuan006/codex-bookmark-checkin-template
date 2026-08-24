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
  if (raw.type !== "new_api") {
    throw new Error("savedLoginSessionRules type must be new_api");
  }
  return {
    type: "new_api",
    selfUrl: sameOriginUrl(expectedOrigin, raw.selfPath || "/api/user/self", "selfPath"),
    userStorageKeys: storageKeys(raw.userStorageKeys),
  };
}

export async function verifyConfiguredSavedLoginSession(page, origin, config = {}) {
  const rule = configuredSavedLoginSessionRule(origin, config);
  if (!rule) return null;
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
    let response;
    try {
      response = await fetch(activeRule.selfUrl, {
        credentials: "include",
        headers: { Accept: "application/json", "New-Api-User": userId },
      });
    } catch {
      return { status: "unknown" };
    }
    if ([401, 403].includes(response.status)) return { status: "invalid" };
    if (!response.ok) return { status: "unknown" };
    const body = await response.json().catch(() => null);
    if (!body || body.success === false) return { status: "invalid" };
    const returnedId = normalizeId(extractUserId(body));
    if (!returnedId || returnedId !== userId) return { status: "invalid" };
    return { status: "valid" };
  }, rule).catch(() => ({ status: "unknown" }));
}
