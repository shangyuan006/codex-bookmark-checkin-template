import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "./security.mjs";

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
      lastReason: String(result.reason ?? "").slice(0, 240),
      lastRunAt: timestamp,
      lastConfirmedAt: confirmed ? timestamp : (prior.lastConfirmedAt ?? null),
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
