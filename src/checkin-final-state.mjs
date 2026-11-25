import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validManualCompletion } from './manual-result-reconciliation.mjs';
import { expireCycleResult } from './checkin-cycle.mjs';
import { readEffectiveBookmarkPlan } from './effective-bookmark-plan.mjs';
import { buildCurrentPlan } from './current-plan.mjs';

function originOf(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}
const dateKey = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).replaceAll('-', '');

// This command only reads existing state. It does not request user input,
// reconcile queues, launch browsers, acquire locks or write reports.
export async function readCheckinFinalState(root, { now = new Date() } = {}) {
  const readErrors = [];
  async function read(relative, label) {
    try {
      const value = JSON.parse(await fs.readFile(path.join(root, relative), 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) { readErrors.push(label); return null; }
      return value;
    }
    catch (error) {
      if (error.code !== 'ENOENT') readErrors.push(label);
      return null;
    }
  }
  const [report, savedPlan, config, handoff, verification, abandonment, session, accountSession, launch, lock] = await Promise.all([
    ['logs/latest.json', 'report'], ['data/last-valid-bookmark-plan.json', 'plan'], ['config/config.json', 'config'],
    ['tmp/manual-handoff.json', 'handoff'], ['tmp/manual-verification.json', 'verification'],
    ['tmp/manual-abandon.json', 'abandonment'], ['tmp/manual-session.json', 'session'],
    ['tmp/agentrouter-manual-state.json', 'account_session'], ['tmp/manual-handoff-launch.json', 'launch'],
    ['tmp/run.lock', 'run_lock'],
  ].map(([file, label]) => read(file, label)));
  let plan = savedPlan;
  if (config?.bookmarksPath) {
    try {
      const freshPlan = await readEffectiveBookmarkPlan(config.bookmarksPath, config,
        path.join(root, 'data/last-valid-bookmark-plan.json'));
      plan = { ...freshPlan, planFingerprint: buildCurrentPlan(freshPlan, config).planFingerprint };
    } catch { readErrors.push('bookmark_plan'); }
  }
  const day = dateKey(now), current = String(report?.runId ?? '').startsWith(`${day}-`);
  const currentDocument = document => String(document?.sourceRunId ?? '').startsWith(`${day}-`);
  const targets = (plan?.targets ?? []).map(target => originOf(target.origin)).filter(Boolean);
  const expected = [...new Set(targets)];
  const results = new Map((current ? report.results ?? [] : []).map(result => [originOf(result.origin),
    expireCycleResult(result, config ?? {}, now, report.finishedAt)]));
  const completed = result => !!result && validManualCompletion(result, now, config ?? {});
  const abandoned = new Set(abandonment?.date === day ? (abandonment.origins ?? []).map(originOf).filter(Boolean) : []);
  function targetComplete(target) {
    const result = results.get(originOf(target.origin));
    if (!result) return false;
    const keys = target.accountKeys ?? (target.accountKey ? [target.accountKey] : null);
    if (keys?.length) return keys.every(key => {
      const account = (result.accountResults ?? [result]).find(item => item.accountKey === key);
      return completed(account && { ...account, origin: result.origin });
    });
    if ((target.actionType ?? 'checkin') !== (result.actionType ?? 'checkin')) return false;
    return completed(result);
  }
  const pendingTargets = document => (document?.targets ?? []).filter(target =>
    !targetComplete(target) && !abandoned.has(originOf(target.origin)));
  const pendingHandoffCount = currentDocument(handoff) && handoff.state === 'awaiting_manual_handoff'
    ? pendingTargets(handoff).length : 0;
  const pendingVerificationCount = currentDocument(verification) && verification.state === 'pending_verification'
    ? pendingTargets(verification).length : 0;
  const files = await fs.readdir(path.join(root, 'tmp')).catch(error => {
    if (error.code !== 'ENOENT') readErrors.push('account_queue');
    return [];
  });
  let pendingRewardCount = 0;
  for (const file of files.filter(file => /^agentrouter-verification-[a-z0-9_-]+\.json$/.test(file))) {
    const request = await read(`tmp/${file}`, 'reward_request');
    if (request?.date !== day || !['pending', 'needs_attention'].includes(request.state)) continue;
    const account = config?.agentrouterAccounts?.find(item => item.accountKey === request.accountKey);
    if (!account || !targetComplete({ origin: account.origin, accountKey: request.accountKey })) pendingRewardCount++;
  }
  const remainingTargets = expected.filter(origin => !completed(results.get(origin)) && !abandoned.has(origin))
    .map(origin => ({ origin, status: results.get(origin)?.status ?? 'missing' }));
  const activeSessionCount = [session, accountSession].filter(Boolean).length;
  const launchPending = !!launch && !['complete', 'completed', 'failed', 'closed', 'expired'].includes(launch.state);
  const reportFinal = current && report.runState === 'final' && report.isComplete === true
    && Number.isFinite(Date.parse(report.finishedAt)) && Date.parse(report.finishedAt) <= now.getTime();
  const planMatches = !plan?.planFingerprint || !report?.planFingerprint || plan.planFingerprint === report.planFingerprint;
  const readyToFinish = !!(reportFinal && expected.length && planMatches && config && !readErrors.length
    && !activeSessionCount && !launchPending && !lock && !pendingHandoffCount && !pendingVerificationCount
    && !pendingRewardCount && !remainingTargets.length);
  return { checkedAt: now.toISOString(), runId: current ? report.runId : null, reportFinal,
    planMatches, expectedCount: expected.length, completedCount: expected.filter(origin => completed(results.get(origin))).length,
    abandonedCount: expected.filter(origin => !completed(results.get(origin)) && abandoned.has(origin)).length,
    remainingTargets, activeSessionCount, launchPending, runInProgress: !!lock,
    pendingHandoffCount, pendingVerificationCount, pendingRewardCount, readErrors,
    readyToFinish, allCheckinsComplete: readyToFinish && expected.every(origin => completed(results.get(origin))) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await readCheckinFinalState(path.dirname(path.dirname(fileURLToPath(import.meta.url)))), null, 2));
}
