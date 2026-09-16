const MAX_ORIGIN_LENGTH = 2048;
const REAUTH_PROVIDERS = new Map([
  ["github", "GitHub"],
  ["gitlab", "GitLab"],
  ["linuxdo", "LinuxDO"],
  ["google", "Google"],
  ["gitee", "Gitee"],
  ["discord", "Discord"],
  ["oauth", "OAuth"],
]);

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function normalizeOrigin(value, label = "origin") {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty trimmed string`);
  }
  if (value.length > MAX_ORIGIN_LENGTH) throw new RangeError(`${label} is too long`);

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute HTTP(S) origin`);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)
    || parsed.origin === "null"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash) {
    throw new TypeError(`${label} must be an absolute HTTP(S) origin`);
  }
  return parsed.origin;
}

export function normalizeAgentRouterAccountKey(value, label = "agentrouter accountKey") {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new TypeError(`${label} must contain 1-64 ASCII letters, digits, underscores, or hyphens`);
  }
  return normalized;
}

export function normalizeReauthProvider(value, label = "reauth provider") {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty trimmed string`);
  }
  const provider = REAUTH_PROVIDERS.get(value.toLowerCase().replace(/[\s._/-]+/gu, ""));
  if (!provider) throw new TypeError(`${label} is not an allowed OAuth provider`);
  return provider;
}

export function resultIdentity(value) {
  const record = assertRecord(value, "result identity input");
  const origin = normalizeOrigin(record.origin, "result identity input.origin");
  const accountKey = record.accountKey == null
    ? null
    : normalizeAgentRouterAccountKey(record.accountKey, "result identity input.accountKey");
  return accountKey ? `${origin}#account=${encodeURIComponent(accountKey)}` : origin;
}

function copyTargetMetadata(target, prior) {
  return {
    ...prior,
    ...(target?.title ? { title: target.title } : {}),
    ...(target?.accountKey ? { accountKey: target.accountKey } : {}),
    ...(target?.accountId ? { accountId: target.accountId } : {}),
    ...(target?.accountLabel ? { accountLabel: target.accountLabel } : {}),
    ...(target?.provider ? { provider: target.provider } : {}),
    ...(target?.upstreamProvider ? { upstreamProvider: target.upstreamProvider } : {}),
  };
}

/**
 * Find a result from an older report without allowing malformed or
 * supplemental-account entries to inherit the wrong retry state.
 */
export function compatiblePriorResult(target, previousResults = []) {
  let expectedIdentity;
  try {
    expectedIdentity = resultIdentity(target);
  } catch {
    return null;
  }

  const exact = (previousResults ?? []).find((result) => {
    try { return resultIdentity(result) === expectedIdentity; }
    catch { return false; }
  });
  if (exact) {
    const targetAccountId = String(target?.accountId ?? "").trim();
    const priorAccountId = String(exact?.accountId ?? "").trim();
    if (targetAccountId && priorAccountId && targetAccountId !== priorAccountId) return null;
    return copyTargetMetadata(target, exact);
  }

  // Reports written before account-aware identities only had an origin. They
  // can migrate to the primary account, never to a supplemental account, and
  // only when that legacy origin is unambiguous.
  if (!target?.accountKey || target?.supplementalAccount) return null;
  let targetOrigin;
  try { targetOrigin = normalizeOrigin(target.origin, "target.origin"); }
  catch { return null; }
  const legacy = (previousResults ?? []).filter((result) => {
    if (String(result?.accountKey ?? "").trim()) return false;
    try { return normalizeOrigin(result.origin, "prior.origin") === targetOrigin; }
    catch { return false; }
  });
  if (legacy.length !== 1) return null;
  return {
    ...copyTargetMetadata({ ...target, accountKey: target.accountKey }, legacy[0]),
    accountKey: target.accountKey,
    migratedLegacyIdentity: true,
  };
}

export function reauthAccountMetadataForOrigin(config, origin) {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin.startsWith("https://")) {
    throw new TypeError("reauth origin must be an HTTPS origin");
  }
  const accounts = config?.agentrouterAccounts;
  if (accounts == null) return [];
  if (!Array.isArray(accounts)) throw new TypeError("agentrouterAccounts must be an array");

  const matching = accounts.filter((entry, index) => {
    const record = assertRecord(entry, `agentrouterAccounts[${index}]`);
    const accountOrigin = normalizeOrigin(record.origin, `agentrouterAccounts[${index}].origin`);
    if (!accountOrigin.startsWith("https://")) {
      throw new TypeError(`agentrouterAccounts[${index}].origin must be an HTTPS origin`);
    }
    return accountOrigin === normalizedOrigin;
  });
  const seenAccountKeys = new Set();
  const defaultProvider = config?.reauthCheckinRules?.[normalizedOrigin]?.provider;
  const keyedAccounts = matching.map((entry) => {
    // Existing configurations use accountId as a local profile key, not as a
    // verified site account identifier. Preserve it as the legacy accountKey.
    const legacyAccountKey = entry.accountId == null && entry.id == null
      ? null
      : normalizeAgentRouterAccountKey(entry.accountId ?? entry.id, "agentrouter legacy account key");
    const accountKey = normalizeAgentRouterAccountKey(
      entry.accountKey ?? legacyAccountKey,
      "agentrouter accountKey",
    );
    if (entry.accountKey != null && legacyAccountKey && legacyAccountKey !== accountKey) {
      throw new Error("legacy agentrouter accountId/id must match accountKey");
    }
    if (seenAccountKeys.has(accountKey)) throw new Error("agentrouterAccounts contains a duplicate accountKey");
    seenAccountKeys.add(accountKey);
    return { entry, accountKey };
  });

  return keyedAccounts.map(({ entry, accountKey }, index) => {
    const provider = normalizeReauthProvider(entry.provider ?? defaultProvider, "agentrouter provider");
    return {
      origin: normalizedOrigin,
      accountKey,
      provider,
      supplementalAccount: index > 0,
    };
  });
}
