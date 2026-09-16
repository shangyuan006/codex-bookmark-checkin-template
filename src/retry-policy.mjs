export const RECOVERABLE_STATUSES = new Set([
  "error", "login_required", "interactive_challenge", "managed_challenge_timeout",
  "visited", "clicked", "no_action", "unconfirmed", "deferred",
]);

import { isTerminalResult } from "./result-contract.mjs";
import { compatiblePriorResult, resultIdentity } from "./result-identity.mjs";

export const TERMINAL_STATUSES = new Set(["signed", "already_signed"]);

export function recoveryEntriesForResults(results, targets, now = new Date()) {
  const byOrigin = new Map(targets.map(target => [target.origin, target]));
  return results.flatMap((result, resultIndex) => {
    if (!isRetryEligible(result, now)) return [];
    const target = byOrigin.get(result.origin);
    if (!target) throw new Error("Recovery result has no matching selected target");
    return [{ resultIndex, target }];
  });
}

function shanghaiParts(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).reduce((value, part) => {
    if (part.type !== "literal") value[part.type] = part.value;
    return value;
  }, {});
}

export function localRunDate(date = new Date()) {
  const parts = shanghaiParts(date);
  return `${parts.year}${parts.month}${parts.day}`;
}

export function isCurrentLocalRunId(runId, date = new Date()) {
  return String(runId ?? "").startsWith(`${localRunDate(date)}-`);
}

export function nextShanghaiTime(time, now = new Date()) {
  const match = String(time ?? "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  const parts = shanghaiParts(now);
  const currentMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const requestedMinutes = Number(match[1]) * 60 + Number(match[2]);
  const dayOffset = requestedMinutes <= currentMinutes ? 1 : 0;
  const utcMidnight = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + dayOffset);
  return new Date(utcMidnight - 8 * 60 * 60 * 1000 + requestedMinutes * 60 * 1000).toISOString();
}

export function nextShanghaiTimeNextDay(time, now = new Date()) {
  const match = String(time ?? "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  const parts = shanghaiParts(now);
  const requestedMinutes = Number(match[1]) * 60 + Number(match[2]);
  const utcMidnight = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1);
  return new Date(utcMidnight - 8 * 60 * 60 * 1000 + requestedMinutes * 60 * 1000).toISOString();
}

function normalizedGroupPart(value, fallback = "unknown") {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return normalized || fallback;
}

function configuredShanghaiTime(names, fallback) {
  return [...names, fallback]
    .map((value) => String(value ?? ""))
    .find((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)) || fallback;
}

function nextSameDayShanghaiTime(time, now = new Date()) {
  const match = String(time ?? "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  const parts = shanghaiParts(now);
  const currentMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const requestedMinutes = Number(match[1]) * 60 + Number(match[2]);
  return requestedMinutes > currentMinutes ? nextShanghaiTime(time, now) : null;
}

function nextUpstreamLateRetryAt(config = {}, now = new Date()) {
  return nextSameDayShanghaiTime(
    configuredShanghaiTime([config.upstreamUnavailableLateRetryTime], "21:05"),
    now,
  );
}

function oauthFailureCode(result) {
  if (String(result?.failureCode ?? "").startsWith("oauth_")) return String(result.failureCode);
  const history = Array.isArray(result?.recovery?.history) ? result.recovery.history : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const code = String(history[index]?.login?.terminalLoginFailure ?? "");
    if (code.startsWith("oauth_")) return code;
  }
  return "";
}

function configuredOAuthProvider(result, config, origin) {
  if (result?.provider) return result.provider;
  if (config.automaticOAuthProviders?.[origin]) return config.automaticOAuthProviders[origin];
  if (config.reauthCheckinRules?.[origin]?.provider) return config.reauthCheckinRules[origin].provider;
  const accountKey = String(result?.accountKey ?? result?.accountId ?? "").trim().toLowerCase();
  const matching = (config.agentrouterAccounts ?? []).filter((account) => {
    try { return new URL(account.origin).origin === origin; } catch { return false; }
  });
  const selected = accountKey
    ? matching.find((account) => String(account.accountKey ?? account.accountId ?? "").trim().toLowerCase() === accountKey)
    : (matching.length === 1 ? matching[0] : null);
  return selected?.provider;
}

export function upstreamRetryGroup(result, config = {}) {
  if (result?.retryCause !== "upstream_unavailable") return null;
  let origin;
  try { origin = new URL(String(result.origin)).origin; }
  catch { return null; }
  const explicit = String(result.retryGroup ?? config.upstreamFailureGroups?.[origin] ?? "").trim();
  if (explicit) return normalizedGroupPart(explicit);
  if (["oauth_upstream_unavailable", "oauth_upstream_circuit_open"].includes(oauthFailureCode(result))) {
    const provider = configuredOAuthProvider(result, config, origin);
    const upstream = result.upstreamProvider ?? config.oauthUpstreamProviders?.[origin];
    return `oauth:${normalizedGroupPart(provider)}:${normalizedGroupPart(upstream, "shared")}`;
  }
  return `origin:${origin}`;
}

export function applyUpstreamGroupCircuitBreakers(results, config = {}, now = new Date()) {
  const configuredLimit = Number(config.upstreamFailureGroupMaxDailyAttempts);
  const limit = Math.max(1, Math.min(12, Number.isFinite(configuredLimit) ? configuredLimit : 3));
  const groups = new Map();
  const annotated = (results ?? []).map((result) => {
    const retryGroup = upstreamRetryGroup(result, config);
    if (!retryGroup) return result;
    const value = { ...result, retryGroup };
    const attempts = Math.max(1, Number(value.retrySequence) || 1);
    groups.set(retryGroup, (groups.get(retryGroup) ?? 0) + attempts);
    return value;
  });
  const nextDayTime = configuredShanghaiTime([config.rateLimitNextDayTime, config.schedule], "08:05");
  return annotated.map((result) => {
    const attempts = result.retryGroup ? groups.get(result.retryGroup) ?? 0 : 0;
    if (!result.retryGroup || attempts < limit) return result;
    if (!result.lateRetryPending) {
      const lateRetryAt = nextUpstreamLateRetryAt(config, now);
      if (lateRetryAt) {
        return {
          ...result,
          retryGroupAttempts: attempts,
          lateRetryPending: true,
          retryExhaustedForDay: false,
          nextEligibleAt: lateRetryAt,
          reason: String(result.reason || "上游服务暂时不可用")
            .replace(/；?本日自动探测已达到上限，次日再检查$/, "")
            .replace(/；?同一上游本日自动探测已达到上限，次日再检查$/, "")
            .concat("；上午探测达到上限，晚间再检查"),
        };
      }
    }
    return {
      ...result,
      retryGroupAttempts: attempts,
      upstreamCircuitOpen: true,
      retryExhaustedForDay: true,
      nextEligibleAt: nextShanghaiTimeNextDay(nextDayTime, now),
      reason: String(result.reason || "上游服务暂时不可用")
        .replace(/；?同一上游本日自动探测已达到上限，次日再检查$/, "")
        .concat("；同一上游本日自动探测已达到上限，次日再检查"),
    };
  });
}

export function withRetrySchedule(result, config = {}, now = new Date()) {
  if (result?.status !== "deferred") return result;
  const existing = Date.parse(result.nextEligibleAt ?? "");
  if (Number.isFinite(existing)) return result;
  const requestedTime = String(result.reason ?? "").match(/(?:要求|需在)\s*([0-2]\d:[0-5]\d)\s*后/)?.[1];
  const configuredDelay = Number(
    result.retryCause === "rate_limit"
      ? (config.rateLimitRetryDelayMs ?? config.deferredRetryDelayMs)
      : config.deferredRetryDelayMs,
  );
  const delayMs = Math.max(60_000, Math.min(6 * 60 * 60 * 1000,
    Number.isFinite(configuredDelay) ? configuredDelay : 30 * 60 * 1000));
  return {
    ...result,
    nextEligibleAt: (requestedTime ? nextShanghaiTime(requestedTime, now) : null)
      ?? new Date(now.getTime() + delayMs).toISOString(),
  };
}

export function advanceDeferredRetry(result, previous, config = {}, now = new Date()) {
  if (result?.status !== "deferred") return result;
  const sameCause = previous?.status === "deferred"
    && String(previous.retryCause || "") === String(result.retryCause || "");
  const currentDate = localRunDate(now);
  const sameDate = String(previous?.retrySequenceDate || "") === currentDate;
  const previousSequence = Math.max(0, Number(previous?.retrySequence) || (sameCause && sameDate ? 1 : 0));
  const retrySequence = sameCause && sameDate ? previousSequence + 1 : 1;
  if (result.retryCause === "upstream_unavailable") {
    const maxDailyAttempts = Math.max(1, Math.min(6,
      Number(config.upstreamUnavailableMaxDailyAttempts) || 3));
    if (retrySequence >= maxDailyAttempts) {
      const lateRetryAt = previous?.lateRetryPending ? null : nextUpstreamLateRetryAt(config, now);
      if (lateRetryAt) {
        return {
          ...result,
          retrySequence,
          retrySequenceDate: currentDate,
          lateRetryPending: true,
          retryExhaustedForDay: false,
          nextEligibleAt: lateRetryAt,
          reason: String(result.reason || "站点维护或网络不可用")
            .replace(/；?本日自动探测已达到上限，次日再检查$/, "")
            .concat("；上午探测达到上限，晚间再检查"),
        };
      }
      const nextDayTime = configuredShanghaiTime([config.rateLimitNextDayTime, config.schedule], "08:05");
      return {
        ...result,
        retrySequence,
        retrySequenceDate: currentDate,
        retryExhaustedForDay: true,
        nextEligibleAt: nextShanghaiTimeNextDay(nextDayTime, now),
        reason: String(result.reason || "站点维护或网络不可用")
          .replace(/；?本日自动探测已达到上限，次日再检查$/, "")
          .concat("；本日自动探测已达到上限，次日再检查"),
      };
    }
    return { ...result, retrySequence, retrySequenceDate: currentDate, retryExhaustedForDay: false };
  }
  if (result.retryCause === "login_required") {
    const maxDailyAttempts = Math.max(1, Math.min(4,
      Number(config.loginRetryMaxDailyAttempts) || 2));
    if (retrySequence >= maxDailyAttempts) {
      const { nextEligibleAt: _nextEligibleAt, ...preserved } = result;
      return {
        ...preserved,
        status: "needs_attention",
        reason: String(result.reason || "自动登录恢复未成功")
          .replace(/；?已安排低频重试$/, "")
          .concat("；本日自动恢复已达到上限，不再盲目重试"),
        retrySequence,
        retrySequenceDate: currentDate,
        retryExhaustedForDay: true,
      };
    }
    return { ...result, retrySequence, retrySequenceDate: currentDate, retryExhaustedForDay: false };
  }
  if (result.retryCause === "managed_challenge_timeout") {
    const maxDailyAttempts = Math.max(1, Math.min(4,
      Number(config.challengeRetryMaxDailyAttempts) || 2));
    if (retrySequence >= maxDailyAttempts) {
      const { nextEligibleAt: _nextEligibleAt, ...preserved } = result;
      return {
        ...preserved,
        status: "needs_attention",
        reason: String(result.reason || "安全验证未自动通过")
          .replace(/；?已安排低频重试$/, "")
          .concat("；本日安全验证复测已达到上限，不再重复打开站点"),
        retrySequence,
        retrySequenceDate: currentDate,
        retryExhaustedForDay: true,
      };
    }
    return { ...result, retrySequence, retrySequenceDate: currentDate, retryExhaustedForDay: false };
  }
  if (result.retryCause !== "rate_limit") return { ...result, retrySequence, retrySequenceDate: currentDate };

  const baseDelay = Math.max(60_000, Number(config.rateLimitRetryDelayMs) || 60 * 60 * 1000);
  const maxDelay = Math.max(baseDelay, Number(config.rateLimitMaxDelayMs) || 6 * 60 * 60 * 1000);
  const maxDailyAttempts = Math.max(1, Math.min(6, Number(config.rateLimitMaxDailyAttempts) || 3));
  if (retrySequence >= maxDailyAttempts) {
    const nextDayTime = [config.rateLimitNextDayTime, config.schedule, "08:05"]
      .map((value) => String(value ?? ""))
      .find((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)) || "08:05";
    return {
      ...result,
      retrySequence,
      retrySequenceDate: currentDate,
      retryExhaustedForDay: true,
      nextEligibleAt: nextShanghaiTimeNextDay(nextDayTime, now),
    };
  }
  const delayMs = Math.min(maxDelay, baseDelay * (2 ** (retrySequence - 1)));
  return {
    ...result,
    retrySequence,
    retrySequenceDate: currentDate,
    retryExhaustedForDay: false,
    nextEligibleAt: new Date(now.getTime() + delayMs).toISOString(),
  };
}

export function advanceAttemptedDeferredRetries(results, attemptedOrigins, previousResults, config = {}, now = new Date()) {
  const attempted = attemptedOrigins instanceof Set ? attemptedOrigins : new Set(attemptedOrigins ?? []);
  const advanced = (results ?? []).map((result) => {
    let identity;
    try { identity = resultIdentity(result); } catch { identity = null; }
    const legacyOrigin = result?.accountKey == null ? String(result?.origin ?? "") : null;
    const wasAttempted = (identity && attempted.has(identity))
      || (legacyOrigin && attempted.has(legacyOrigin));
    return wasAttempted
      ? advanceDeferredRetry(result, compatiblePriorResult(result, previousResults ?? []), config, now)
      : result;
  });
  return applyUpstreamGroupCircuitBreakers(advanced, config, now);
}

export function deferUnresolvedLogin(result, config = {}, now = new Date()) {
  if (result?.status !== "login_required") return result;
  const oauthFailure = String(result.failureCode ?? "");
  const retryCause = oauthFailure === "oauth_upstream_unavailable"
    ? "upstream_unavailable"
    : oauthFailure === "oauth_rate_limited"
      ? "rate_limit"
      : "login_required";
  return withRetrySchedule({
    ...result,
    status: "deferred",
    retryCause,
    reason: `${String(result.reason || "自动登录恢复未成功").replace(/；?已安排低频重试$/, "")}；已安排低频重试`,
  }, {
    deferredRetryDelayMs: retryCause === "login_required"
      ? config.loginRetryDelayMs ?? config.deferredRetryDelayMs
      : config.deferredRetryDelayMs,
    rateLimitRetryDelayMs: config.rateLimitRetryDelayMs,
  }, now);
}

export function isRetryEligible(result, now = new Date()) {
  if (result?.retryable === false || result?.submissionAttempted === true) return false;
  if (result?.status === "not_available" && !isTerminalResult(result)) return true;
  if (!RECOVERABLE_STATUSES.has(result?.status)) return false;
  if (result.status !== "deferred") return true;
  const next = Date.parse(result.nextEligibleAt ?? "");
  return !Number.isFinite(next) || next <= now.getTime();
}

export function isResumeRetryEligible(result, reauthOrigins, now = new Date()) {
  if (isRetryEligible(result, now)) return true;
  return result?.status === "needs_attention"
    && reauthOrigins instanceof Set
    && reauthOrigins.has(result.origin);
}

export function nextDeferredRetryAt(results, now = new Date()) {
  const values = (results ?? []).filter((result) => result?.status === "deferred")
    .map((result) => Date.parse(result.nextEligibleAt ?? ""))
    .filter((value) => Number.isFinite(value) && value > now.getTime());
  return values.length > 0 ? new Date(Math.min(...values)).toISOString() : null;
}
