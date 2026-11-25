import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadAttentionHandoff } from './attention-urls.mjs';
import { readBookmarkPlan } from './bookmarks.mjs';
import { normalizeNativeCheckinActionRule } from './native-checkin-action.mjs';
import { getConfiguredPreCheckinNavigationRule } from './pre-checkin-navigation.mjs';
import { createRunLog, writeRunResult, summarizeResults, sanitizeForPersistence } from './logger.mjs';
import { syncManualCompletion, validManualCompletion } from './manual-result-reconciliation.mjs';
import { acquireRunLock, releaseRunLock } from './run-lock.mjs';
import { samePageManualTargetEligible, getSamePageManualRule } from './same-page-checkin.mjs';
import { samePageSequentialStep } from './same-page-sequential.mjs';
import { readTodayAbandonment, applyTodayAbandonment } from './manual-abandonment.mjs';
import { localRunDate } from './retry-policy.mjs';
import { configuredNativeVisitRule } from './native-visit-checkin.mjs';
import { sanitizeSequentialClickDiagnostics } from './sequential-click-diagnostics.mjs';
import { checkinCycle } from './checkin-cycle.mjs';
import { nativeInspectionFailure, parseNativeInspectionOutput } from './native-inspection-diagnostics.mjs';
import { readSubmissionJournal, partitionSubmissions } from './submission-guard.mjs';

const execute = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sameProfile = (a, b) => typeof a === 'string' && typeof b === 'string'
  && path.resolve(root, a).toLowerCase() === path.resolve(root, b).toLowerCase();
const observationKey = results => JSON.stringify(results.map(result => Object.fromEntries(
  ['origin', 'status', 'reason', 'failureCode', 'actionAttempted', 'submissionAttempted', 'evidence',
    'cycle', 'actionResults', 'requiredActionTypes', 'firstSubmissionFailure', 'submissionDiagnostics',
    'verificationRecoveryDiagnostics', 'continuationDiagnostics'].map(key => [key, result[key]]))));

export function controlledManualRule(target, config) {
  const samePage = getSamePageManualRule(target, config);
  if (samePage?.browserMode === 'native') {
    if (!samePageSequentialStep(target, config, samePage)) return null;
    return { mode: 'execute-same-page' };
  }
  if (configuredNativeVisitRule(target, config)) return { mode: 'verify-visit' };
  const entries = (config.nativeChallengePreflight ?? []).filter(entry => {
    try { return new URL(entry.url).origin === target.origin; } catch { return false; }
  });
  if (entries.length !== 1) return null;
  const entry = entries[0];
  if (entry.passiveOnly || entry.automationUserDataDir
    && !sameProfile(entry.automationUserDataDir, config.automationUserDataDir)) return null;
  if ([!!entry.action, !!entry.dailyFormCheckin, !!entry.calendarDayCheckin, !!entry.newApiCheckin].filter(Boolean).length !== 1) return null;
  if (entry.action) return { mode: 'execute-checkin', action: normalizeNativeCheckinActionRule(entry.action) };
  if (entry.dailyFormCheckin && getConfiguredPreCheckinNavigationRule(target, target.origin, config)?.dailyUnsignedForm) {
    return { mode: 'execute-daily-form' };
  }
  if (entry.calendarDayCheckin && config.calendarDayCheckinOrigins?.includes(target.origin)) return { mode: 'execute-calendar' };
  if (entry.newApiCheckin && config.newApiCheckinOrigins?.includes(target.origin)) return { mode: 'execute-new-api' };
  return null;
}

export function controlledManualTargets(handoff, config) {
  return (handoff.targets ?? []).filter(target => !samePageManualTargetEligible(target, config) && controlledManualRule(target, config));
}

export function continuationInspectionRule(rule, previous, readyOnly) {
  if (!readyOnly) return rule;
  const attempted = previous?.currentCycleSubmissionAttempted !== false
    && (previous?.actionAttempted === true || previous?.submissionAttempted === true);
  if (rule.mode === 'execute-same-page') return { ...rule, mode: attempted ? 'verify-same-page' : rule.mode };
  if (rule.mode === 'execute-checkin') return { ...rule,
    mode: attempted ? 'verify-checkin' : rule.mode,
    action: { ...rule.action, clickChallenge: false } };
  if (attempted && rule.mode === 'execute-daily-form') return { ...rule, mode: 'verify-daily-form' };
  if (attempted && rule.mode === 'execute-calendar') return { ...rule, mode: 'verify-calendar' };
  return rule;
}

export async function continueControlledManualSession(projectRoot, config, state, { inspect, readyOnly = false, now: referenceNow } = {}) {
  if (state.mode !== 'native' || state.controlledCheckin !== true || state.windowReady !== true
    || !sameProfile(state.profile, config.automationUserDataDir)
    || !Number.isInteger(state.nativeDebugPort) || state.nativeDebugPort < 1024 || state.nativeDebugPort > 65535
    || !/^[a-f0-9]{32}$/.test(state.launchMarker ?? '')
    || !Array.isArray(state.targets) || !state.targets.length || state.targetCount !== state.targets.length) {
    throw new Error('Controlled manual session identity is invalid');
  }
  const startedAt = new Date().toISOString();
  const plan = await readBookmarkPlan(config.bookmarksPath, config);
  const targets = state.targets.map(item => plan.targets.find(target => target.origin === item.origin));
  if (targets.some(target => !target || !controlledManualRule(target, config))
    || new Set(targets.map(target => target.origin)).size !== targets.length) {
    throw new Error('Controlled targets no longer match current bookmark rules');
  }
  const progressPath = path.join(projectRoot, 'tmp/manual-continuation-progress.json');
  const saved = await fs.readFile(progressPath, 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const previousResults = saved?.identity === state.launchMarker ? saved.results ?? [] : [];
  const now = referenceNow ?? new Date();
  const abandonment = await readTodayAbandonment(projectRoot, now);
  const abandonedOrigins = new Set(abandonment?.origins ?? []);
  const results = [];
  for (const target of targets) {
    const recorded = previousResults.find(result => result.origin === target.origin);
    const cycle = checkinCycle(target.origin, config, now);
    // Old attempts remain in their reports and journal. Only this cycle's
    // progress can select a read-only continuation or carry attempt flags.
    const previous = recorded && (!recorded.cycle?.id || recorded.cycle.id === cycle.id) ? recorded : null;
    if (abandonedOrigins.has(target.origin)) {
      const completed = previous && validManualCompletion(previous, now, config);
      results.push(completed ? previous : applyTodayAbandonment({ runId: `${localRunDate(now)}-manual`,
        results: [{ origin: target.origin, title: target.title, folderNames: target.folderNames,
          status: 'needs_attention', ...(previous ? { actionAttempted: previous.actionAttempted,
            submissionAttempted: previous.submissionAttempted } : {}) }] }, abandonment, now).results[0]);
      continue;
    }
    if (readyOnly && previous && validManualCompletion(previous, now, config)) {
      results.push(previous); continue;
    }
    const rule = continuationInspectionRule(controlledManualRule(target, config), previous, readyOnly);
    let result;
    try {
      result = await (inspect ?? (async (target, rule) => {
        const { stdout } = await execute(process.execPath, [path.join(projectRoot, 'src/native-browser-inspect.mjs'),
          String(state.nativeDebugPort), target.origin, readyOnly ? '1' : '45', rule.mode,
          rule.action ? Buffer.from(JSON.stringify(rule.action)).toString('base64') : '',
          ...(readyOnly ? ['--continuation-only'] : []),
          ...(previous?.browserErrorRecovery?.attempted ? ['--no-error-recovery'] : [])],
        { cwd: projectRoot, windowsHide: true, timeout: 240000, maxBuffer: 1024 * 1024 });
        return parseNativeInspectionOutput(stdout);
      }))(target, rule);
    } catch (error) {
      result = nativeInspectionFailure(error);
      // A helper can fail after reserving an intent. Keep that fact even if
      // no JSON result reached the parent; it never authorizes another click.
      const journal = await readSubmissionJournal(config.submissionJournalPath
        ?? path.join(projectRoot, 'data/submission-journal.json')).catch(() => null);
      const pending = (journal?.entries ?? []).filter(entry => entry.identity?.siteOrigin === target.origin
        && ['intent', 'uncertain'].includes(entry.state));
      if (partitionSubmissions(pending, target, config, now).current.length) {
        result.actionAttempted = true; result.submissionAttempted = true;
      }
    }
    const first = previous?.firstSubmissionFailure ?? result.firstSubmissionFailure;
    const firstAction = sanitizeSequentialClickDiagnostics(first?.action);
    const firstSubmissionFailure = /^same_page_[a-z_]{1,80}$/.test(first?.failureCode ?? '')
      ? { failureCode: first.failureCode, ...(firstAction ? { action: firstAction } : {}) } : null;
    results.push({ ...result, origin: target.origin, title: target.title, folderNames: target.folderNames, cycle,
      ...(firstSubmissionFailure ? { firstSubmissionFailure } : {}),
      ...(result.browserErrorRecovery || previous?.browserErrorRecovery
        ? { browserErrorRecovery: result.browserErrorRecovery ?? previous.browserErrorRecovery } : {}),
      actionAttempted: result.currentCycleSubmissionAttempted === false ? false : result.actionAttempted === true || previous?.actionAttempted === true,
      submissionAttempted: result.currentCycleSubmissionAttempted === false ? false : result.submissionAttempted === true || previous?.submissionAttempted === true });
  }
  await fs.mkdir(path.dirname(progressPath), { recursive: true });
  // A pass never forgets an ambiguous click. Later passes can observe its
  // completion, but cannot turn the retained page into a second submission.
  const { atomicWriteJson } = await import('./security.mjs');
  await atomicWriteJson(progressPath, sanitizeForPersistence({ identity: state.launchMarker, results }));
  const finishedAt = new Date().toISOString();
  const changed = !readyOnly || saved?.identity !== state.launchMarker
    || observationKey(results) !== observationKey(previousResults);
  if (changed) {
    const log = await createRunLog(path.join(projectRoot, 'logs'));
    const report = { runId: log.runId, startedAt, finishedAt, runState: 'final', isComplete: true, scopeComplete: false,
      plannedTotal: targets.length, processedTotal: targets.length, selectedTotal: targets.length,
      selectedProcessedTotal: targets.length, selectedOrigins: targets.map(target => target.origin),
      summary: summarizeResults(results), results };
    await writeRunResult(path.join(projectRoot, 'logs'), log, report, { updateLatest: false, reconcileLatest: true });
    await syncManualCompletion(projectRoot, report);
  }
  const completedCount = results.filter(result => validManualCompletion(result, referenceNow ?? new Date(), config)).length;
  const stillAbandoned = new Set((await readTodayAbandonment(projectRoot))?.origins ?? []);
  const abandonedCount = results.filter(result => result.status === 'abandoned' && stillAbandoned.has(result.origin)).length;
  return { processedCount: results.length, completedCount,
    ...(abandonedCount ? { abandonedCount, handledCount: completedCount + abandonedCount } : {}),
    unresolvedCount: results.length - completedCount - abandonedCount };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(await fs.readFile(path.join(root, 'config/config.json'), 'utf8'));
  const args = process.argv.slice(2);
  if (args.includes('--plan')) {
    const handoff = await loadAttentionHandoff(root, args.filter(arg => arg !== '--plan'));
    process.stdout.write(JSON.stringify({ origins: controlledManualTargets(handoff, config).map(target => target.origin) }));
  } else if (args[0] === '--continue' && args.every(arg => ['--continue', '--ready-only'].includes(arg))) {
    const lease = await acquireRunLock(path.join(root, 'tmp/manual-native-continuation.lock'));
    try {
      const state = JSON.parse(await fs.readFile(path.join(root, 'tmp/manual-session.json'), 'utf8'));
      process.stdout.write(JSON.stringify(await continueControlledManualSession(root, config, state, { readyOnly: args.includes('--ready-only') })));
    } finally { await releaseRunLock(lease); }
  } else throw new Error('Invalid controlled manual continuation request');
}
