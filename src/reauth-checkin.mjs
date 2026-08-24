import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dismissConfiguredPreCheckinOverlay, launchAutomationContext } from "./browser.mjs";
import { loginHelperOutcomeFromStreams } from "./login-recovery.mjs";
import { localRunDate, nextShanghaiTime } from "./retry-policy.mjs";
import { normalizeAgentRouterAccountKey, normalizeReauthProvider } from "./result-identity.mjs";
import { atomicWriteJson, safeErrorMessage } from "./security.mjs";

const execFileAsync = promisify(execFile);
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const dataDirectory = path.resolve(rootDirectory, "data");
const defaultStatePath = path.join(rootDirectory, "data", "reauth-checkin-state.json");

function normalizeAuthoritativeAccountId(entry) {
  const siteAccountId = entry?.siteAccountId;
  const authoritativeAccountId = entry?.authoritativeAccountId;
  if (siteAccountId != null && authoritativeAccountId != null && siteAccountId !== authoritativeAccountId) {
    throw new Error("siteAccountId conflicts with authoritativeAccountId");
  }
  const value = authoritativeAccountId ?? siteAccountId;
  if (value == null) return null;
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || value.length > 128 || /[\s\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("authoritative reauth accountId must be a trimmed non-whitespace string of at most 128 characters");
  }
  return value;
}

function configuredAccountOrigin(value, label) {
  const raw = String(value ?? "");
  if (!raw || raw !== raw.trim()) throw new Error(`${label} must be a canonical HTTPS origin`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a canonical HTTPS origin`);
  }
  if (url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash) {
    throw new Error(`${label} must be a canonical HTTPS origin`);
  }
  return url.origin;
}

function resolveAccountPath(value, fallback, label) {
  const raw = String(value ?? "").trim();
  const resolved = path.resolve(rootDirectory, raw || fallback);
  const relative = path.relative(dataDirectory, resolved);
  if (!relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the project data directory`);
  }
  return resolved;
}

function optionalBoundedInteger(value, minimum, maximum, label) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function assertSameOriginHttps(rawUrl, origin, label) {
  const url = new URL(rawUrl, origin);
  if (url.protocol !== "https:" || url.origin !== origin) {
    throw new Error(`${label}必须是目标站点的同源 HTTPS 地址`);
  }
  return url.href;
}

function shanghaiMinutes(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  return Number(parts.hour) * 60 + Number(parts.minute);
}

export function getConfiguredReauthRule(target, config) {
  const raw = config?.reauthCheckinRules?.[target?.origin];
  if (!raw || raw.enabled === false) return null;
  const origin = new URL(target.origin).origin;
  let provider;
  try {
    provider = normalizeReauthProvider(raw.provider, "重认证规则登录提供方");
  } catch (error) {
    if (!String(raw.provider ?? "").trim()) throw new Error("重认证规则缺少登录提供方");
    throw error;
  }
  const afterMatch = raw.after == null ? null : String(raw.after).match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (raw.after != null && !afterMatch) throw new Error("重认证签到时间必须使用 HH:mm");
  const quotaField = String(raw.quotaField || "data.quota");
  if (!/^[_a-z][_a-z0-9]*(?:\.[_a-z][_a-z0-9]*)*$/i.test(quotaField)) {
    throw new Error("重认证额度字段路径无效");
  }
  const accountMenuSelector = String(raw.accountMenuSelector || "").trim();
  if (!accountMenuSelector) throw new Error("重认证规则缺少账号菜单选择器");
  const rawDomEvidence = raw.quotaDomEvidence;
  const quotaDomEvidence = rawDomEvidence ? {
    labelText: String(rawDomEvidence.labelText || "").trim(),
    valueSiblingIndex: Number(rawDomEvidence.valueSiblingIndex),
  } : null;
  if (quotaDomEvidence && (!quotaDomEvidence.labelText
    || !Number.isInteger(quotaDomEvidence.valueSiblingIndex)
    || quotaDomEvidence.valueSiblingIndex < 0
    || quotaDomEvidence.valueSiblingIndex > 10)) {
    throw new Error("重认证页面额度证据配置无效");
  }
  if (!String(raw.quotaEndpoint || "").trim() && !quotaDomEvidence) {
    throw new Error("重认证规则缺少额度接口或页面额度证据");
  }
  const rawLoginEvidence = raw.loginSuccessStorageEvidence;
  const loginSuccessStorageEvidence = rawLoginEvidence ? {
    storage: String(rawLoginEvidence.storage || "localStorage"),
    key: String(rawLoginEvidence.key || "").trim(),
    field: String(rawLoginEvidence.field || "").trim(),
    expected: rawLoginEvidence.expected ?? true,
  } : null;
  if (loginSuccessStorageEvidence
    && (!new Set(["localStorage", "sessionStorage"]).has(loginSuccessStorageEvidence.storage)
      || !loginSuccessStorageEvidence.key
      || !/^[_a-z][_a-z0-9]*(?:\.[_a-z][_a-z0-9]*)*$/i.test(loginSuccessStorageEvidence.field)
      || typeof loginSuccessStorageEvidence.expected !== "boolean")) {
    throw new Error("重认证登录成功证据配置无效");
  }
  const logoutTexts = [...new Set((raw.logoutTexts ?? []).map((value) => String(value).trim()).filter(Boolean))];
  if (logoutTexts.length === 0) throw new Error("重认证规则缺少退出动作文本");
  return {
    origin,
    pageUrl: assertSameOriginHttps(raw.pageUrl ?? target.candidates?.[0] ?? origin, origin, "重认证页面"),
    loginUrl: assertSameOriginHttps(raw.loginUrl ?? `${origin}/login`, origin, "重认证登录入口"),
    quotaEndpoint: raw.quotaEndpoint
      ? assertSameOriginHttps(raw.quotaEndpoint, origin, "重认证额度接口")
      : null,
    quotaField,
    quotaDomEvidence,
    loginSuccessStorageEvidence,
    accountMenuSelector,
    logoutTexts,
    provider,
    after: afterMatch ? `${afterMatch[1]}:${afterMatch[2]}` : null,
    evidenceWaitMs: Math.max(1_000, Math.min(30_000, Number(raw.evidenceWaitMs) || 15_000)),
  };
}

export function getConfiguredReauthAccounts(target, config) {
  const baseRule = getConfiguredReauthRule(target, config);
  if (!baseRule) return [];
  const configured = config?.agentrouterAccounts;
  if (configured != null && !Array.isArray(configured)) {
    throw new Error("agentrouterAccounts must be an array");
  }
  const validatedAccounts = (configured ?? []).map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`agentrouterAccounts[${index}] must be an object`);
    }
    return {
      entry,
      origin: configuredAccountOrigin(entry.origin, `agentrouterAccounts[${index}].origin`),
    };
  });
  const matching = validatedAccounts
    .filter((candidate) => candidate.origin === baseRule.origin)
    .map((candidate) => candidate.entry);
  if (matching.length === 0) {
    return [{
      ...baseRule,
      accountKey: "default",
      supplementalAccount: false,
      automationUserDataDir: resolveAccountPath(
        config.automationUserDataDir,
        "data/edge-user-data",
        "automationUserDataDir",
      ),
      statePath: defaultStatePath,
    }];
  }
  const seenAccountKeys = new Set();
  const seenAccountIds = new Set();
  return matching.map((entry, index) => {
    const accountKey = normalizeAgentRouterAccountKey(entry.accountKey ?? entry.accountId ?? entry.id, "reauth accountKey");
    if (entry.accountKey != null && (entry.accountId != null || entry.id != null)) {
      const legacyAccountKey = normalizeAgentRouterAccountKey(entry.accountId ?? entry.id, "legacy reauth account key");
      if (legacyAccountKey !== accountKey) {
        throw new Error("legacy agentrouter accountId/id must match accountKey; use authoritativeAccountId for a site account id");
      }
    }
    if (seenAccountKeys.has(accountKey)) {
      throw new Error(`Duplicate reauth accountKey for ${baseRule.origin}: ${accountKey}`);
    }
    seenAccountKeys.add(accountKey);
    const provider = normalizeReauthProvider(entry.provider ?? baseRule.provider, "agentrouter provider");
    const oauthAttempts = optionalBoundedInteger(
      entry.oauthAttempts,
      1,
      3,
      `agentrouterAccounts[${index}].oauthAttempts`,
    );
    const oauthRetryDelayMs = optionalBoundedInteger(
      entry.oauthRetryDelayMs,
      500,
      20_000,
      `agentrouterAccounts[${index}].oauthRetryDelayMs`,
    );
    const oauthWaitMs = optionalBoundedInteger(
      entry.oauthWaitMs,
      30_000,
      120_000,
      `agentrouterAccounts[${index}].oauthWaitMs`,
    );
    const accountId = normalizeAuthoritativeAccountId(entry);
    if (accountId && seenAccountIds.has(accountId)) {
      throw new Error(`Duplicate authoritative reauth accountId for ${baseRule.origin}`);
    }
    if (accountId) seenAccountIds.add(accountId);
    return {
      ...baseRule,
      accountKey,
      ...(accountId ? { accountId } : {}),
      provider,
      ...(oauthAttempts == null ? {} : { oauthAttempts }),
      ...(oauthRetryDelayMs == null ? {} : { oauthRetryDelayMs }),
      ...(oauthWaitMs == null ? {} : { oauthWaitMs }),
      supplementalAccount: index > 0,
      automationUserDataDir: resolveAccountPath(
        entry.automationUserDataDir,
        path.join("data", `edge-agentrouter-${accountKey}`),
        `agentrouterAccounts[${index}].automationUserDataDir`,
      ),
      statePath: resolveAccountPath(
        entry.statePath,
        path.join("data", `agentrouter-${accountKey}-state.json`),
        `agentrouterAccounts[${index}].statePath`,
      ),
      accountIndex: index,
    };
  });
}

function sanitizeReauthAccountResult(result) {
  const {
    accountId: _accountId,
    accountLabel: _accountLabel,
    authoritativeAccountId: _authoritativeAccountId,
    siteAccountId: _siteAccountId,
    provider,
    ...safeResult
  } = result ?? {};
  return {
    ...safeResult,
    ...(provider == null ? {} : { provider: normalizeReauthProvider(provider, "account result provider") }),
  };
}

export function withReauthAccountMetadata(result, account) {
  return {
    ...sanitizeReauthAccountResult(result),
    origin: account.origin,
    accountKey: account.accountKey,
    provider: account.provider,
    supplementalAccount: account.supplementalAccount === true,
  };
}

function matchesLegacyAccountIdOption(account, value) {
  const requestedAccountId = String(value ?? "").trim();
  let legacyAccountKey = null;
  try {
    legacyAccountKey = normalizeAgentRouterAccountKey(requestedAccountId, "legacy reauth account selector");
  } catch {
    // Authoritative site account ids are not required to be path-safe keys.
  }
  return account.accountKey === legacyAccountKey || account.accountId === requestedAccountId;
}

export function selectConfiguredReauthAccount(accounts, options = {}, origin = "configured origin") {
  if (!Array.isArray(accounts)) throw new TypeError("reauth accounts must be an array");
  if (!options.accountKey && !options.accountId) return null;

  let matches = accounts;
  if (options.accountKey) {
    const requestedAccountKey = normalizeAgentRouterAccountKey(options.accountKey, "reauth accountKey selector");
    matches = matches.filter((candidate) => candidate.accountKey === requestedAccountKey);
  }
  if (options.accountId) {
    matches = matches.filter((candidate) => matchesLegacyAccountIdOption(candidate, options.accountId));
  }
  if (matches.length !== 1) {
    const selector = options.accountKey ? "accountKey" : "accountId";
    throw new Error(`Unknown or ambiguous reauth ${selector} for ${origin}`);
  }
  return matches[0];
}

export function aggregateReauthResults(accountResults) {
  const results = Array.isArray(accountResults)
    ? accountResults.map(sanitizeReauthAccountResult)
    : [];
  if (results.length === 0) {
    return { status: "needs_attention", reason: "No reauth accounts are configured", accountResults: [] };
  }
  const statuses = results.map((result) => result.status);
  const successful = statuses.every((status) => ["signed", "already_signed"].includes(status));
  if (successful) {
    const status = statuses.some((value) => value === "signed") ? "signed" : "already_signed";
    return {
      status,
      reason: status === "signed"
        ? "All configured accounts completed or confirmed the daily reauth check-in"
        : "All configured accounts were already confirmed for today",
      accountResults: results,
    };
  }
  if (statuses.every((status) => status === "deferred")) {
    const nextEligibleAt = results
      .map((result) => Date.parse(result.nextEligibleAt ?? ""))
      .filter(Number.isFinite)
      .sort((left, right) => left - right)[0];
    return {
      status: "deferred",
      retryCause: "scheduled_window",
      ...(Number.isFinite(nextEligibleAt) ? { nextEligibleAt: new Date(nextEligibleAt).toISOString() } : {}),
      reason: "All configured accounts are waiting for their scheduled reauth window",
      accountResults: results,
    };
  }
  return {
    status: "needs_attention",
    reason: "At least one configured account did not produce authoritative check-in evidence",
    accountResults: results,
  };
}

export function mergeSelectedReauthAccountResult(accounts, previousParent, selectedAccountResult) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new TypeError("configured reauth accounts must be a non-empty array");
  }
  const selectedKey = normalizeAgentRouterAccountKey(
    selectedAccountResult?.accountKey,
    "selected reauth account result.accountKey",
  );
  if (!accounts.some((account) => account.accountKey === selectedKey)) {
    throw new Error("selected reauth account result is not part of the configured account set");
  }
  const previousByKey = new Map((previousParent?.accountResults ?? [])
    .filter((entry) => entry?.accountKey)
    .map((entry) => [entry.accountKey, sanitizeReauthAccountResult(entry)]));
  return aggregateReauthResults(accounts.map((account) => {
    if (account.accountKey === selectedKey) return selectedAccountResult;
    return previousByKey.get(account.accountKey) ?? {
      accountKey: account.accountKey,
      provider: account.provider,
      status: "needs_attention",
      reason: "The current daily report has no authoritative result for this account",
    };
  }));
}

export function reauthLoginFailureReason(provider, oauthStage = null) {
  const normalized = String(provider ?? "").trim() || "配置的登录提供方";
  const stageReasons = {
    target_login: "目标站登录页未就绪",
    provider_button: "未找到登录提供方按钮",
    provider_transition: "登录提供方跳转未完成",
    linuxdo_session: "LinuxDO 会话恢复未完成",
    provider_authorization: "LinuxDO 授权未完成",
    target_callback: "登录回调未返回目标站",
    timeout: "登录流程超时",
    helper_failed: "登录助手执行失败",
  };
  const detail = stageReasons[oauthStage];
  return detail
    ? `${normalized} 重新登录未完成（${detail}），需要人工处理`
    : `${normalized} 重新登录未完成，需要人工处理`;
}

function normalizeProviderLabel(value) {
  return String(value ?? "").toLowerCase().replace(/[\s\-_./]+/g, "");
}

export function configuredProviderIsExplicitlyUnavailable(provider, controlLabels) {
  const expected = normalizeProviderLabel(provider);
  if (!expected) return true;
  const labels = [...new Set((controlLabels ?? [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean))];
  if (labels.some((label) => normalizeProviderLabel(label).includes(expected))) return false;
  return labels.some((label) => /github|gitlab|linux\s*do|google|gitee|discord|oauth/i.test(label));
}

export function valueAtFieldPath(value, fieldPath) {
  return String(fieldPath).split(".").reduce((current, key) => (
    current && typeof current === "object" ? current[key] : undefined
  ), value);
}

export function classifyQuotaIncrease(before, after) {
  const previous = Number(before);
  const current = Number(after);
  if (!Number.isFinite(previous) || !Number.isFinite(current)) {
    return { status: "needs_attention", reason: "重新登录后未获得可验证的额度字段" };
  }
  if (current > previous) {
    return { status: "signed", reason: "重新登录后确认额度已到账" };
  }
  return { status: "needs_attention", reason: "重新登录成功，但额度没有可验证的增加" };
}

export function parseQuotaDisplayText(value) {
  const normalized = String(value ?? "").replace(/[\s,]/g, "");
  const matches = normalized.match(/-?\d+(?:\.\d+)?/g) ?? [];
  if (matches.length !== 1) return null;
  const numeric = Number(matches[0]);
  return Number.isFinite(numeric) ? numeric : null;
}

export function buildReauthStateEntry(date, status, now = new Date()) {
  if (!/^\d{8}$/.test(String(date)) || !["started", "logged_out", "completed"].includes(status)) {
    throw new Error("重认证状态无效");
  }
  return { date: String(date), status, updatedAt: now.toISOString() };
}

async function readState(statePath) {
  return fs.readFile(statePath, "utf8").then(JSON.parse).catch((error) => {
    if (error.code === "ENOENT") return { version: 1, entries: {} };
    throw error;
  });
}

async function writeState(statePath, state, key, entry) {
  await atomicWriteJson(statePath, {
    version: 2,
    entries: { ...(state.entries ?? {}), [key]: entry },
  });
}

async function openRulePage(config, rule) {
  const context = await launchAutomationContext({ ...config, backgroundWindowMode: "offscreen" });
  const page = await context.newPage();
  const quotaDiagnostics = { matchedResponses: 0, unreadableResponses: 0, invalidFields: 0 };
  const quotaObservation = rule.quotaDomEvidence ? Promise.resolve(undefined) : new Promise((resolve) => {
    const evidenceUrl = new URL(rule.quotaEndpoint);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      page.off("response", inspectResponse);
      resolve(value);
    };
    const inspectResponse = async (response) => {
      try {
        const responseUrl = new URL(response.url());
        if (!response.ok()
          || responseUrl.origin !== evidenceUrl.origin
          || responseUrl.pathname.replace(/\/+$/, "") !== evidenceUrl.pathname.replace(/\/+$/, "")) return;
        quotaDiagnostics.matchedResponses += 1;
        await response.finished();
        const body = await response.json();
        const numeric = Number(valueAtFieldPath(body, rule.quotaField));
        if (Number.isFinite(numeric)) finish(numeric);
        else quotaDiagnostics.invalidFields += 1;
      } catch {
        // Some SPA requests expose headers before a readable body; keep listening.
        quotaDiagnostics.unreadableResponses += 1;
      }
    };
    const timer = setTimeout(() => finish(undefined), rule.evidenceWaitMs + 5_000);
    page.on("response", inspectResponse);
  });
  try {
    await page.goto(rule.pageUrl, { waitUntil: "commit", timeout: config.navigationTimeoutMs });
    await page.waitForTimeout(500);
    return { context, page, quotaObservation, quotaDiagnostics };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

async function verifyConfiguredProviderBeforeLogout(session, rule, config) {
  let probe = null;
  try {
    probe = await session.context.newPage();
    await probe.goto(rule.loginUrl, { waitUntil: "commit", timeout: config.navigationTimeoutMs });
    await probe.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    if (new URL(probe.url()).origin !== rule.origin) return false;
    const controlLabels = await probe.locator("button, a, [role=button], img[alt]").evaluateAll((elements) => elements
      .map((element) => String(
        element.innerText || element.getAttribute("aria-label") || element.getAttribute("alt") || "",
      ).replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 100));
    return configuredProviderIsExplicitlyUnavailable(rule.provider, controlLabels);
  } catch {
    // A login page may redirect an already authenticated session.  Only an
    // explicit conflicting provider is a reason to prevent the daily logout.
    return false;
  } finally {
    await probe?.close().catch(() => {});
  }
}

async function readDomQuota(page, rule) {
  const evidence = rule.quotaDomEvidence;
  if (!evidence) return null;
  const deadline = Date.now() + rule.evidenceWaitMs;
  while (Date.now() < deadline) {
    const label = await uniqueVisibleLocator(page.getByText(evidence.labelText, { exact: true }));
    if (label) {
      const displayText = await label.evaluate((element, siblingIndex) => (
        element.parentElement?.children?.[siblingIndex]?.textContent ?? ""
      ), evidence.valueSiblingIndex).catch(() => "");
      const numeric = parseQuotaDisplayText(displayText);
      if (Number.isFinite(numeric)) return numeric;
    }
    await page.waitForTimeout(300);
  }
  return null;
}

async function readDomQuotaOnce(page, rule) {
  const evidence = rule.quotaDomEvidence;
  if (!evidence) return null;
  const label = await uniqueVisibleLocator(page.getByText(evidence.labelText, { exact: true }));
  if (!label) return null;
  const displayText = await label.evaluate((element, siblingIndex) => (
    element.parentElement?.children?.[siblingIndex]?.textContent ?? ""
  ), evidence.valueSiblingIndex).catch(() => "");
  return parseQuotaDisplayText(displayText);
}

async function readLoginSuccessEvidence(page, rule) {
  const evidence = rule.loginSuccessStorageEvidence;
  if (!evidence) return false;
  return page.evaluate(({ storageName, key, field, expected }) => {
    try {
      const storage = storageName === "sessionStorage" ? sessionStorage : localStorage;
      const parsed = JSON.parse(storage.getItem(key) || "null");
      const value = field.split(".").reduce((current, item) => (
        current && typeof current === "object" ? current[item] : undefined
      ), parsed);
      return typeof value === "boolean" && value === expected;
    } catch {
      return false;
    }
  }, {
    storageName: evidence.storage,
    key: evidence.key,
    field: evidence.field,
    expected: evidence.expected,
  }).catch(() => false);
}

async function readQuota(session, rule) {
  const { page, quotaObservation, quotaDiagnostics } = session;
  if (rule.quotaDomEvidence) {
    const domQuota = await readDomQuota(page, rule);
    if (Number.isFinite(domQuota)) return domQuota;
    throw new Error("页面在有限等待内未显示唯一可验证的当前额度");
  }
  const naturallyObserved = await quotaObservation;
  if (Number.isFinite(naturallyObserved)) return naturallyObserved;
  const deadline = Date.now() + rule.evidenceWaitMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    const result = await page.evaluate(async ({ endpoint, fieldPath }) => {
      try {
        const response = await fetch(endpoint, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) return { ok: false, status: response.status };
        const body = await response.json();
        const value = fieldPath.split(".").reduce((current, key) => (
          current && typeof current === "object" ? current[key] : undefined
        ), body);
        const numeric = Number(value);
        return Number.isFinite(numeric) ? { ok: true, value: numeric } : { ok: false, status: response.status };
      } catch {
        return { ok: false, status: 0 };
      }
    }, { endpoint: rule.quotaEndpoint, fieldPath: rule.quotaField });
    if (result.ok) return result.value;
    lastStatus = result.status;
    await page.waitForTimeout(500);
  }
  throw new Error(lastStatus === 401 || lastStatus === 403
    ? "站点登录状态无效"
    : `额度接口在有限等待内未返回可验证字段（匹配响应 ${quotaDiagnostics.matchedResponses}，正文不可读 ${quotaDiagnostics.unreadableResponses}，字段无效 ${quotaDiagnostics.invalidFields}，主动请求状态 ${lastStatus ?? "无"}）`);
}

async function readQuotaSnapshot(session, rule) {
  if (rule.quotaDomEvidence) return readDomQuotaOnce(session.page, rule);
  const result = await session.page.evaluate(async ({ endpoint, fieldPath }) => {
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return null;
      const body = await response.json();
      const value = fieldPath.split(".").reduce((current, key) => (
        current && typeof current === "object" ? current[key] : undefined
      ), body);
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    } catch {
      return null;
    }
  }, { endpoint: rule.quotaEndpoint, fieldPath: rule.quotaField }).catch(() => null);
  return Number.isFinite(result) ? result : null;
}

export async function readQuotaUntilIncrease(session, rule, before) {
  const baseline = Number(before);
  if (!Number.isFinite(baseline)) throw new Error("登录前未获得可比较的额度");
  const deadline = Date.now() + rule.evidenceWaitMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await readQuotaSnapshot(session, rule);
    if (Number.isFinite(latest) && latest > baseline) return latest;
    await session.page.waitForTimeout(500);
  }
  return latest;
}

async function uniqueVisibleLocator(locator) {
  const visible = [];
  for (let index = 0; index < await locator.count(); index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
  }
  return visible.length === 1 ? visible[0] : null;
}

async function waitForUniqueVisibleLocator(locator, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const candidate = await uniqueVisibleLocator(locator);
    if (candidate) return candidate;
    await locator.page().waitForTimeout(300);
  }
  return null;
}

async function runOAuthHelper(rule, config, account, phaseArgs = []) {
  try {
    const result = await execFileAsync(process.execPath, [
      path.join(sourceDirectory, "oauth-login.mjs"),
      rule.origin,
      rule.provider,
      "--login-url",
      rule.loginUrl,
      "--automation-user-data-dir",
      account.automationUserDataDir,
      "--account-id",
      account.accountKey,
      ...(Number.isInteger(account.oauthWaitMs) ? ["--wait-ms", String(account.oauthWaitMs)] : []),
      ...phaseArgs,
      "--private-result",
    ], {
      cwd: rootDirectory,
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });
    const outcome = loginHelperOutcomeFromStreams(result.stdout, result.stderr);
    return { succeeded: outcome.succeeded, oauthStage: outcome.oauthStage ?? null };
  } catch (error) {
    const fallback = error?.code === "ETIMEDOUT" ? "timeout" : "failed";
    const outcome = loginHelperOutcomeFromStreams(error?.stdout, error?.stderr, fallback);
    return {
      succeeded: false,
      oauthStage: outcome.oauthStage ?? (fallback === "timeout" ? "timeout" : "helper_failed"),
    };
  }
}

async function runPrivateOAuth(rule, config, account) {
  if (normalizeReauthProvider(rule.provider, "agentrouter provider") !== "LinuxDO") {
    return runOAuthHelper(rule, config, account);
  }

  // LinuxDO recovery is deliberately split into two isolated contexts. The
  // provider session is established and closed first; only then is the
  // Agent Router OAuth page opened with the same encrypted browser profile.
  const providerResult = await runOAuthHelper(rule, config, account, ["--provider-only"]);
  if (!providerResult.succeeded) return providerResult;
  return runOAuthHelper(rule, config, account, ["--agent-router-only"]);
}

async function retryOAuthOperation(rule, config, account, operation) {
  const attempts = Math.max(1, Math.min(3, Number(account.oauthAttempts) || Number(config.reauthLoginAttempts) || 2));
  const retryDelayMs = Math.max(
    500,
    Math.min(20_000, Number(account.oauthRetryDelayMs) || Number(config.reauthLoginRetryDelayMs) || 3000),
  );
  let latest = { succeeded: false, oauthStage: "helper_failed" };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await operation();
    if (current.succeeded) return current;
    latest = {
      succeeded: false,
      oauthStage: preferOAuthFailureStage(latest.oauthStage, current.oauthStage),
    };
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  return latest;
}

async function runProviderOnlyWithRetry(rule, config, account) {
  const providerResult = await retryOAuthOperation(
    rule,
    config,
    account,
    () => runOAuthHelper(rule, config, account, ["--provider-only"]),
  );
  if (providerResult.succeeded) return providerResult;
  if (!await runNativeProviderSessionRefresh(config, account)) return providerResult;
  const refreshedResult = await runOAuthHelper(rule, config, account, ["--provider-only"]);
  return refreshedResult.succeeded ? refreshedResult : {
    succeeded: false,
    oauthStage: preferOAuthFailureStage(providerResult.oauthStage, refreshedResult.oauthStage),
  };
}

async function runNativeProviderSessionRefresh(config, account) {
  const configuredPowerShell = String(config.powershellExecutable ?? "").trim();
  const systemRoot = String(process.env.SystemRoot ?? "C:\\Windows");
  const executable = configuredPowerShell || path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (!path.isAbsolute(executable) || !["powershell.exe", "pwsh.exe"].includes(path.basename(executable).toLowerCase())) {
    return false;
  }
  try {
    const result = await execFileAsync(executable, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(rootDirectory, "scripts", "Refresh-AgentRouterProviderSession.ps1"),
      "-AccountKey",
      account.accountKey,
    ], {
      cwd: rootDirectory,
      windowsHide: true,
      timeout: 70_000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });
    const lines = String(result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.some((line) => {
      try { return JSON.parse(line)?.status === "prepared"; } catch { return false; }
    });
  } catch {
    return false;
  }
}

async function runAgentRouterOnlyWithRetry(rule, config, account) {
  return retryOAuthOperation(
    rule,
    config,
    account,
    () => runOAuthHelper(rule, config, account, ["--agent-router-only"]),
  );
}

export function parseProviderSessionProbe(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of [...lines].reverse()) {
    try {
      const value = JSON.parse(line);
      if (["valid", "invalid", "unknown", "not_supported"].includes(value?.status)) {
        return { status: value.status };
      }
    } catch { /* ignore browser startup diagnostics */ }
  }
  return { status: "unknown" };
}

export function preferOAuthFailureStage(previous, current) {
  const generic = new Set([null, undefined, "helper_failed"]);
  if (generic.has(current) && !generic.has(previous)) return previous;
  return current ?? previous ?? "helper_failed";
}

async function runPrivateOAuthWithRetry(rule, config, account) {
  return retryOAuthOperation(rule, config, account, () => runPrivateOAuth(rule, config, account));
}

async function inspectCurrentLogin(config, rule) {
  let session;
  try {
    session = await openRulePage(config, rule);
    await readQuota(session, rule);
    return {
      valid: true,
      explicitLoginSuccess: await readLoginSuccessEvidence(session.page, rule),
    };
  } catch {
    return { valid: false, explicitLoginSuccess: false };
  } finally {
    await session?.context.close().catch(() => {});
  }
}

export async function runConfiguredReauthCheckinForAccount(target, config, account, options = {}) {
  const rule = account;
  if (!rule) return null;
  const now = options.now ?? new Date();
  const date = localRunDate(now);
  if (rule.after) {
    const [hour, minute] = rule.after.split(":").map(Number);
    if (shanghaiMinutes(now) < hour * 60 + minute) {
      return {
        status: "deferred",
        retryCause: "scheduled_window",
        nextEligibleAt: nextShanghaiTime(rule.after, now),
        reason: `站点要求 ${rule.after} 后执行每日重新认证`,
      };
    }
  }

  const statePath = options.statePath ?? rule.statePath ?? defaultStatePath;
  const stateKey = `${rule.origin}::${rule.accountKey}`;
  const accountConfig = { ...config, automationUserDataDir: rule.automationUserDataDir };
  const state = await readState(statePath);
  const previous = state.entries?.[stateKey] ?? state.entries?.[rule.origin];
  if (previous?.date === date && previous.status === "completed") {
    return { status: "already_signed", reason: "今日已通过重新登录确认额度到账" };
  }
  if (previous?.date === date && previous.status === "logged_out") {
    let currentLogin = await inspectCurrentLogin(accountConfig, rule);
    if (!currentLogin.valid) {
      const oauthResult = await runPrivateOAuthWithRetry(rule, accountConfig, rule);
      if (!oauthResult.succeeded) {
        return { status: "needs_attention", reason: reauthLoginFailureReason(rule.provider, oauthResult.oauthStage) };
      }
      currentLogin = await inspectCurrentLogin(accountConfig, rule);
    }
    if (previous.status === "logged_out" && currentLogin.valid && currentLogin.explicitLoginSuccess) {
      const refreshed = await readState(statePath);
      await writeState(statePath, refreshed, stateKey, buildReauthStateEntry(date, "completed", new Date()));
      return { status: "signed", reason: "重新登录后站点确认额度已到账" };
    }
    return {
      status: "needs_attention",
      reason: "今日重新认证曾中断；登录已尽力恢复，但缺少登录前后额度证据",
    };
  }
  if (previous?.date === date && previous.status === "started") {
    const currentLogin = await inspectCurrentLogin(accountConfig, rule);
    if (currentLogin.valid && currentLogin.explicitLoginSuccess) {
      const refreshed = await readState(statePath);
      await writeState(statePath, refreshed, stateKey, buildReauthStateEntry(date, "completed", new Date()));
      return { status: "signed", reason: "重新登录后站点确认额度已到账" };
    }
    // A started run may have been interrupted before OAuth login. Continue
    // with a fresh before/after cycle instead of leaving the account stuck.
  }

  let beforeSession;
  let before;
  try {
    const isLinuxDoProvider = normalizeReauthProvider(rule.provider, "agentrouter provider") === "LinuxDO";
    if (isLinuxDoProvider) {
      // The provider-only helper is the single authoritative LinuxDO stage.
      // It opens one provider context, confirms the session endpoint, and
      // closes that context before this function can open Agent Router.
      const providerRecovery = await runProviderOnlyWithRetry(rule, accountConfig, rule);
      if (!providerRecovery.succeeded) {
        throw new Error(`${rule.provider} 会话恢复未完成，未退出 Agent Router；请先完成提供方登录`);
      }
    }
    beforeSession = await openRulePage(accountConfig, rule);
    before = await readQuota(beforeSession, rule);
    if (await verifyConfiguredProviderBeforeLogout(beforeSession, rule, accountConfig)) {
      throw new Error(`${rule.provider} 登录入口未出现在当前站点登录页，已取消退出`);
    }
    await dismissConfiguredPreCheckinOverlay(
      beforeSession.page,
      target,
      new URL(beforeSession.page.url()).origin,
      accountConfig,
    );
    const accountMenu = await waitForUniqueVisibleLocator(
      beforeSession.page.locator(rule.accountMenuSelector),
      rule.evidenceWaitMs,
    );
    if (!accountMenu) throw new Error("没有找到唯一可见的账号菜单");
    await accountMenu.click();
    await beforeSession.page.waitForTimeout(300);
    const logoutMatches = [];
    for (const text of rule.logoutTexts) {
      const candidate = await waitForUniqueVisibleLocator(
        beforeSession.page.getByText(text, { exact: true }),
        Math.min(rule.evidenceWaitMs, 5_000),
      );
      if (candidate) logoutMatches.push(candidate);
    }
    if (logoutMatches.length !== 1) throw new Error("没有找到唯一可见的退出动作");
    await writeState(statePath, state, stateKey, buildReauthStateEntry(date, "started", now));
    await logoutMatches[0].click();
    await beforeSession.page.waitForTimeout(1_000);
    const refreshed = await readState(statePath);
    await writeState(statePath, refreshed, stateKey, buildReauthStateEntry(date, "logged_out", new Date()));
  } catch (error) {
    return { status: "needs_attention", reason: safeErrorMessage(error) };
  } finally {
    await beforeSession?.context.close().catch(() => {});
  }

  const oauthResult = normalizeReauthProvider(rule.provider, "agentrouter provider") === "LinuxDO"
    ? await runAgentRouterOnlyWithRetry(rule, accountConfig, rule)
    : await runPrivateOAuthWithRetry(rule, accountConfig, rule);
  if (!oauthResult.succeeded) {
    return { status: "needs_attention", reason: reauthLoginFailureReason(rule.provider, oauthResult.oauthStage) };
  }

  let afterSession;
  try {
    afterSession = await openRulePage(accountConfig, rule);
    const explicitLoginSuccess = await readLoginSuccessEvidence(afterSession.page, rule);
    const after = explicitLoginSuccess
      ? await readQuotaSnapshot(afterSession, rule)
      : await readQuotaUntilIncrease(afterSession, rule, before);
    const result = explicitLoginSuccess
      ? { status: "signed", reason: "重新登录后站点确认额度已到账" }
      : classifyQuotaIncrease(before, after);
    if (result.status === "signed") {
      const refreshed = await readState(statePath);
      await writeState(statePath, refreshed, stateKey, buildReauthStateEntry(date, "completed", new Date()));
    }
    return result;
  } catch (error) {
    return { status: "needs_attention", reason: safeErrorMessage(error) };
  } finally {
    await afterSession?.context.close().catch(() => {});
  }
}

export async function runConfiguredReauthCheckin(target, config, options = {}) {
  const accounts = getConfiguredReauthAccounts(target, config);
  if (accounts.length === 0) return null;
  if (options.onAccountResult != null && typeof options.onAccountResult !== "function") {
    throw new TypeError("onAccountResult must be a function");
  }
  const callbackAccounts = accounts.map((account) => withReauthAccountMetadata({}, account));
  if (options.accountKey || options.accountId) {
    const account = selectConfiguredReauthAccount(accounts, options, target.origin);
    const result = await runConfiguredReauthCheckinForAccount(target, config, account, options);
    const accountResult = withReauthAccountMetadata(result, account);
    if (options.onAccountResult) {
      await options.onAccountResult(
        { ...accountResult },
        [{ ...accountResult }],
        callbackAccounts.map((candidate) => ({ ...candidate })),
      );
    }
    return accountResult;
  }
  const accountResults = [];
  for (const account of accounts) {
    let accountResult;
    try {
      const result = await runConfiguredReauthCheckinForAccount(target, config, account, options);
      accountResult = withReauthAccountMetadata(result, account);
    } catch (error) {
      accountResult = withReauthAccountMetadata({
        status: "needs_attention",
        reason: safeErrorMessage(error),
      }, account);
    }
    accountResults.push(accountResult);
    if (options.onAccountResult) {
      await options.onAccountResult(
        { ...accountResult },
        accountResults.map((completed) => ({ ...completed })),
        callbackAccounts.map((candidate) => ({ ...candidate })),
      );
    }
  }
  return aggregateReauthResults(accountResults);
}
