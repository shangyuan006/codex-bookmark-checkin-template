import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicBookmarkReport } from './bookmarks.mjs';
import { readEffectiveBookmarkPlan } from './effective-bookmark-plan.mjs';
import { buildCurrentPlan } from './current-plan.mjs';
import { reconcileCheckinResult } from './checkin-evidence.mjs';
import { resultIdentity } from './result-identity.mjs';
import { configuredSequentialActionTypes } from './sequential-action-evidence.mjs';
import { validManualCompletion } from './manual-result-reconciliation.mjs';
import { atomicWriteJson } from './security.mjs';
import { acquireRunLock, releaseRunLock } from './run-lock.mjs';

const dayKey = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).replaceAll('-', '');
const sameStrings = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());

function pendingTarget(target, prior = {}) {
  const submissionAttempted = prior.submissionAttempted === true || prior.accountResults?.some(a => a.submissionAttempted === true);
  return { origin: target.origin, title: target.title, folderNames: target.folderNames,
    status: 'unconfirmed', reason: '当前书签范围需要重新核验', failureCode: 'bookmark_scope_changed',
    // Changing bookmarks must never remove an unresolved submission barrier.
    ...(submissionAttempted ? { submissionAttempted: true, retryable: false } : {}),
    ...(prior.retryable === false ? { retryable: false } : {}) };
}

function compatibleResult(prior, target, accountGroup, config, now) {
  if (!prior || prior.origin !== target.origin) return pendingTarget(target);
  if (accountGroup) {
    const source = prior.accountResults ?? [prior];
    const accountResults = accountGroup.accounts.map(account => {
      const old = source.find(value => {
        try { return resultIdentity({ ...value, origin: target.origin }) === account.identity; }
        catch { return false; }
      });
      if (!old || old.provider !== account.provider || old.actionType !== 'reauth') {
        return { ...pendingTarget(target, old), accountKey: account.identity.split('#account=')[1],
          provider: account.provider, actionType: 'reauth' };
      }
      return reconcileCheckinResult({ ...old, origin: target.origin }, old.evidence, now,
        { target: { ...target, accountKey: old.accountKey, actionType: 'reauth' }, config, requireBinding: true });
    });
    const complete = accountResults.every(value => ['signed', 'already_signed'].includes(value.status));
    return { ...prior, title: target.title, folderNames: target.folderNames, accountResults,
      status: complete ? (accountResults.some(value => value.status === 'signed') ? 'signed' : 'already_signed') : 'needs_attention' };
  }
  if (prior.accountResults?.length || (prior.actionType ?? 'checkin') !== 'checkin') return pendingTarget(target, prior);
  const result = reconcileCheckinResult(prior, prior.evidence, now, { target, config, requireBinding: true });
  return { ...result, title: target.title, folderNames: target.folderNames, allowedOrigins: target.allowedOrigins };
}

// Produce a new resume view, leaving the historical report and all evidence
// timestamps intact. New/changed targets receive pending entries, not success.
export function reconcileResumeScope(report, plan, config = {}, now = new Date()) {
  if (!String(report?.runId ?? '').startsWith(`${dayKey(now)}-`) || report.runState !== 'final'
    || report.isComplete !== true || !Array.isArray(report.results) || !plan.targets?.length
    || report.plannedTotal !== report.results.length || new Set(report.results.map(r => r.origin)).size !== report.results.length) return null;
  const metadata = buildCurrentPlan(plan, config);
  if ((report.planFingerprint ?? report.bookmarkSummary?.planFingerprint) === metadata.planFingerprint) return null;
  const previousTargets = new Map((report.bookmarkSummary?.targets ?? []).map(t => [t.origin, t]));
  const previous = new Map(report.results.map(r => [r.origin, r]));
  const results = plan.targets.map(target => {
    const oldTarget = previousTargets.get(target.origin);
    const oldFingerprint = report.bookmarkSummary?.targetPlanFingerprints?.[target.origin];
    const unchanged = oldFingerprint ? oldFingerprint === metadata.targetPlanFingerprints[target.origin]
      : oldTarget && oldTarget.candidateCount === target.candidates.length && sameStrings(oldTarget.folderNames, target.folderNames);
    return unchanged ? compatibleResult(previous.get(target.origin), target,
      metadata.accountGroups.find(group => group.origin === target.origin), config, now) : pendingTarget(target, previous.get(target.origin));
  });
  const origins = new Set(plan.targets.map(t => t.origin));
  const summary = Object.fromEntries([...new Set(results.map(r => r.status))].map(status => [status, results.filter(r => r.status === status).length]));
  return { ...report, planFingerprint: metadata.planFingerprint,
    bookmarkSummary: publicBookmarkReport({ ...plan, ...metadata }),
    plannedTotal: results.length, processedTotal: results.length, isComplete: true,
    selectedOrigins: (report.selectedOrigins ?? []).filter(origin => origins.has(origin)),
    selectedTotal: 0, selectedProcessedTotal: 0, selectedSummary: {}, scopeComplete: false,
    summary, nextRetryAt: null, results,
    scopeReconciliation: { sourcePlanFingerprint: report.planFingerprint ?? report.bookmarkSummary?.planFingerprint ?? null,
      reconciledAt: now.toISOString(), removedTargetCount: report.results.filter(r => !origins.has(r.origin)).length,
      addedTargetCount: plan.targets.filter(t => !previous.has(t.origin)).length } };
}

export function reconcileManualScope(document, plan, config = {}, now = new Date()) {
  if (!String(document?.sourceRunId ?? '').startsWith(`${dayKey(now)}-`)
    || !['pending_verification', 'awaiting_manual_handoff'].includes(document.state)) return { document, changed: false };
  const updated = structuredClone(document);
  const metadata = buildCurrentPlan(plan, config);
  const origins = new Set(plan.targets.map(t => t.origin));
  const removed = [];
  updated.targets = (updated.targets ?? []).filter(target => {
    const group = metadata.accountGroups.find(g => g.origin === target.origin);
    const keys = group?.identities.map(identity => identity.split('#account=')[1]) ?? [];
    const priorKeys = target.accountKeys ?? (target.accountKey ? [target.accountKey] : []);
    const allowedActions = group ? ['reauth'] : ['checkin', ...(configuredSequentialActionTypes(target.origin, config) ?? [])];
    if (!origins.has(target.origin) || priorKeys.length && !priorKeys.some(key => keys.includes(key))
      || target.actionType && !allowedActions.includes(target.actionType)) {
      removed.push({ ...target, removalReason: 'removed_from_current_plan' });
      return false;
    }
    if (target.accountKeys) target.accountKeys = target.accountKeys.filter(key => keys.includes(key));
    const providerMatches = !group || (target.accountResults ?? [target]).every(account =>
      group.accounts.some(planned => {
        try { return resultIdentity({ ...account, origin: target.origin }) === planned.identity && account.provider === planned.provider; }
        catch { return false; }
      }));
    if (['signed', 'already_signed'].includes(target.verificationStatus)
      && (!providerMatches || !validManualCompletion({ ...target, status: target.verificationStatus }, now, config))) {
      target.verificationStatus = 'pending';
    }
    return true;
  });
  if (removed.length) updated.removedTargets = [...(updated.removedTargets ?? []), ...removed];
  if (updated.state === 'pending_verification') {
    const complete = updated.targets.every(t => validManualCompletion({ ...t, status: t.verificationStatus }, now, config));
    updated.state = complete ? 'verification_complete' : 'pending_verification';
    updated.authoritativeEvidenceRequired = !complete;
  } else if (!updated.targets.length) updated.state = 'handoff_complete';
  const changed = JSON.stringify(updated) !== JSON.stringify(document);
  if (changed) updated.scopeReconciledAt = now.toISOString();
  return { document: updated, changed };
}

export async function prepareScopedResume(root, { now = new Date() } = {}) {
  const lease = await acquireRunLock(path.join(root, 'tmp', 'run.lock'));
  try {
    const config = JSON.parse(await fs.readFile(path.join(root, 'config', 'config.json'), 'utf8'));
    const plan = await readEffectiveBookmarkPlan(config.bookmarksPath, config, path.join(root, 'data', 'last-valid-bookmark-plan.json'));
    const latest = await fs.readFile(path.join(root, 'logs', 'latest.json'), 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const reconciled = reconcileResumeScope(latest, plan, config, now);
    if (!reconciled) return null;
    const resumePath = path.join(root, 'logs', 'scope-resume.json');
    await atomicWriteJson(resumePath, reconciled);
    for (const name of ['manual-verification.json', 'manual-handoff.json']) {
      const file = path.join(root, 'tmp', name);
      try { await fs.access(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const documentLease = await acquireRunLock(`${file}.lock`);
      try {
        const existing = JSON.parse(await fs.readFile(file, 'utf8'));
        const update = reconcileManualScope(existing, plan, config, now);
        if (update.changed) await atomicWriteJson(file, update.document);
      } finally { await releaseRunLock(documentLease); }
    }
    return { path: resumePath, removedTargetCount: reconciled.scopeReconciliation.removedTargetCount,
      addedTargetCount: reconciled.scopeReconciliation.addedTargetCount };
  } finally { await releaseRunLock(lease); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await prepareScopedResume(path.resolve(process.argv[2] ?? '.')))); }
  catch { console.error('无法安全整理当天续跑与人工复核范围；未启动浏览器。'); process.exitCode = 1; }
}
