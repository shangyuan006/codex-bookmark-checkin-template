import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localRunDate, nextDeferredRetryAt } from './retry-policy.mjs';
import { isTerminalResult } from './result-contract.mjs';
import { atomicWriteJson } from './security.mjs';

function canonicalOrigin(value) {
  if (typeof value !== 'string' || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

export async function readTodayAbandonment(root, now = new Date()) {
  const document = await fs.readFile(path.join(root, 'tmp', 'manual-abandon.json'), 'utf8')
    .then(JSON.parse).catch(() => null);
  if (document?.schemaVersion !== 1 || document.date !== localRunDate(now)
    || !Array.isArray(document.origins) || document.origins.some(origin => !canonicalOrigin(origin))) return null;
  return { ...document, origins: document.origins.map(canonicalOrigin) };
}

export function applyTodayAbandonment(report, document, now = new Date()) {
  if (!Array.isArray(report?.results) || !String(report.runId).startsWith(`${localRunDate(now)}-`)
    || document?.schemaVersion !== 1 || document.date !== localRunDate(now)
    || !Array.isArray(document.origins) || document.origins.some(origin => !canonicalOrigin(origin))) return report;
  const abandoned = new Set(document.origins.map(canonicalOrigin));
  let changed = false;
  const results = report.results.map(result => {
    const reasonCode = document.reasons?.[result.origin] === 'network_unavailable' ? 'network_unavailable' : 'user_requested';
    if (!abandoned.has(result.origin) || (result.status === 'abandoned' && (result.abandonment?.reasonCode ?? 'user_requested') === reasonCode)
      || isTerminalResult(result, now)) return result;
    changed = true;
    const updated = {
      ...result, status: 'abandoned', reason: reasonCode === 'network_unavailable'
        ? '人工确认今日网络不可用，今日跳过，次日再检查' : '今日按用户要求放弃，不再重试', retryable: false,
      abandonment: { previousStatus: result.abandonment?.previousStatus ?? result.status,
        previousFailureCode: result.abandonment?.previousFailureCode ?? result.failureCode ?? null,
        previousReason: result.abandonment?.previousReason ?? result.reason ?? null,
        recordedAt: document.createdAt ?? now.toISOString(), reasonCode },
    };
    for (const key of ['failureCode', 'retryCause', 'nextEligibleAt']) delete updated[key];
    return updated;
  });
  if (!changed) return report;
  const summarize = values => values.reduce((summary, result) => {
    summary[result.status] = (summary[result.status] ?? 0) + 1;
    return summary;
  }, {});
  const selected = Array.isArray(report.selectedOrigins) ? new Set(report.selectedOrigins) : null;
  return { ...report, results, summary: summarize(results),
    ...(report.selectedSummary ? { selectedSummary: summarize(selected ? results.filter(result => selected.has(result.origin)) : results) } : {}),
    nextRetryAt: nextDeferredRetryAt(results, now), abandonmentReconciledAt: now.toISOString() };
}

export async function reconcileLatestAbandonment(root, now = new Date()) {
  const latestPath = path.join(root, 'logs', 'latest.json');
  const report = await fs.readFile(latestPath, 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const updated = applyTodayAbandonment(report, await readTodayAbandonment(root, now), now);
  if (updated === report) return { updated: false };
  // latest.json is the current view; retain the original per-run failure history.
  await atomicWriteJson(latestPath, updated);
  return { updated: true, abandonedCount: updated.summary.abandoned ?? 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await reconcileLatestAbandonment(path.resolve(process.argv[2] ?? '.'))));
}
