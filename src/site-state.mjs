import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, redactPrivateResultText } from "./security.mjs";

const CONFIRMED = new Set(["signed", "already_signed", "not_available"]);
const SUCCESSFUL = new Set(["signed", "already_signed"]);

export async function loadSiteState(filePath) {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!value || typeof value !== "object" || typeof value.sites !== "object") throw new Error("invalid state");
    return value;
  } catch {
    return { version: 1, updatedAt: null, sites: {} };
  }
}

export function applyPreferredCandidates(targets, state) {
  return targets.map((target) => {
    const preferredUrl = state?.sites?.[target.origin]?.preferredUrl;
    if (!preferredUrl) return target;
    try {
      const preferred = new URL(preferredUrl);
      const allowedOrigins = new Set(target.allowedOrigins ?? [target.origin]);
      if (!/^https?:$/.test(preferred.protocol) || !allowedOrigins.has(preferred.origin)) return target;
      return {
        ...target,
        candidates: [preferred.href, ...target.candidates.filter((candidate) => candidate !== preferred.href)],
      };
    } catch {
      return target;
    }
  });
}

export function reuseRecentNotAvailable(target, state, config = {}, now = new Date()) {
  if (!(config.knownNoCheckinFeatureOrigins ?? []).includes(target.origin)) return null;
  const prior = state?.sites?.[target.origin];
  const confirmedAt = Date.parse(prior?.lastConfirmedAt ?? "");
  if (!Number.isFinite(confirmedAt)) return null;

  const confirmedStatus = prior.lastConfirmedStatus
    ?? (!prior.lastSuccessAt && Number(prior.confirmedCount ?? 0) > 0 ? "not_available" : null);
  if (confirmedStatus !== "not_available") return null;

  const configuredHours = Number(config.knownNoCheckinRecheckHours);
  const recheckHours = Math.max(24, Math.min(24 * 30,
    Number.isFinite(configuredHours) ? configuredHours : 24 * 7));
  if (now.getTime() - confirmedAt >= recheckHours * 60 * 60 * 1000) return null;

  return {
    status: "not_available",
    reason: `近期已确认未开放签到，按 ${recheckHours} 小时周期复核`,
    cached: true,
    attempt: 0,
  };
}

export async function runWithRecentNotAvailableCache(target, state, config, run, now = new Date()) {
  const cached = reuseRecentNotAvailable(target, state, config, now);
  return cached ?? run();
}

function reusablePreferredUrl(result) {
  if (!SUCCESSFUL.has(result.status) || !result.url) return null;
  try {
    const url = new URL(result.url);
    if (!/^https?:$/.test(url.protocol) || url.search || url.hash) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function updateSiteState(previous, results, finishedAt = new Date()) {
  const sites = { ...(previous?.sites ?? {}) };
  const timestamp = finishedAt.toISOString();
  for (const result of results) {
    const prior = sites[result.origin] ?? {};
    const runCount = Number(prior.runCount ?? 0) + 1;
    const durationMs = Math.max(0, Number(result.durationMs) || 0);
    const priorAverage = Math.max(0, Number(prior.averageDurationMs) || 0);
    const averageDurationMs = Math.round(((priorAverage * (runCount - 1)) + durationMs) / runCount);
    const confirmed = CONFIRMED.has(result.status);
    const successful = SUCCESSFUL.has(result.status);
    const preferredUrl = reusablePreferredUrl(result) ?? prior.preferredUrl ?? null;
    sites[result.origin] = {
      ...prior,
      lastStatus: result.status,
      lastReason: redactPrivateResultText(result.reason).slice(0, 240),
      lastRunAt: timestamp,
      lastConfirmedAt: confirmed ? timestamp : (prior.lastConfirmedAt ?? null),
      lastConfirmedStatus: confirmed ? result.status : (prior.lastConfirmedStatus ?? null),
      lastConfirmedReason: confirmed
        ? redactPrivateResultText(result.reason).slice(0, 240)
        : (prior.lastConfirmedReason ?? null),
      lastSuccessAt: successful ? timestamp : (prior.lastSuccessAt ?? null),
      failureStreak: confirmed ? 0 : Number(prior.failureStreak ?? 0) + 1,
      runCount,
      confirmedCount: Number(prior.confirmedCount ?? 0) + (confirmed ? 1 : 0),
      averageDurationMs,
      lastDurationMs: durationMs,
      preferredUrl,
    };
  }
  return { version: 1, updatedAt: timestamp, sites };
}

export async function writeSiteState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJson(filePath, state);
}
