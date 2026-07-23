export const RECOVERABLE_STATUSES = new Set([
  "error", "login_required", "interactive_challenge", "managed_challenge_timeout",
  "visited", "clicked", "no_action", "unconfirmed", "deferred",
]);

export const TERMINAL_STATUSES = new Set(["signed", "already_signed", "not_available"]);

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

export function withRetrySchedule(result, config = {}, now = new Date()) {
  if (result?.status !== "deferred") return result;
  const existing = Date.parse(result.nextEligibleAt ?? "");
  if (Number.isFinite(existing)) return result;
  const requestedTime = String(result.reason ?? "").match(/(?:要求|需在)\s*([0-2]\d:[0-5]\d)\s*后/)?.[1];
  const configuredDelay = Number(config.deferredRetryDelayMs);
  const delayMs = Math.max(60_000, Math.min(6 * 60 * 60 * 1000,
    Number.isFinite(configuredDelay) ? configuredDelay : 30 * 60 * 1000));
  return {
    ...result,
    nextEligibleAt: (requestedTime ? nextShanghaiTime(requestedTime, now) : null)
      ?? new Date(now.getTime() + delayMs).toISOString(),
  };
}

export function isRetryEligible(result, now = new Date()) {
  if (!RECOVERABLE_STATUSES.has(result?.status)) return false;
  if (result.status !== "deferred") return true;
  const next = Date.parse(result.nextEligibleAt ?? "");
  return !Number.isFinite(next) || next <= now.getTime();
}

export function nextDeferredRetryAt(results, now = new Date()) {
  const values = (results ?? []).filter((result) => result?.status === "deferred")
    .map((result) => Date.parse(result.nextEligibleAt ?? ""))
    .filter((value) => Number.isFinite(value) && value > now.getTime());
  return values.length > 0 ? new Date(Math.min(...values)).toISOString() : null;
}
