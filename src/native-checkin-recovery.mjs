import { configuredBearerCheckinRule, runBearerCheckinInBrowser } from './bearer-checkin.mjs';
import { bindSuccessEvidence, dailyReadinessEvidence, successEvidence } from './checkin-evidence.mjs';
import { assertBookmarkNavigation } from './security.mjs';
import { createHash } from 'node:crypto';
import { partitionSubmissions } from './submission-guard.mjs';

export function normalizeNativeVerificationRecovery(raw) {
  if (raw == null) return null;
  const origin = 'https://checkin.example';
  for (const key of ['refreshPath', 'selfPath', 'checkinPath']) {
    if (typeof raw[key] !== 'string' || !/^\/(?!\/)/.test(raw[key]) || raw[key].length > 300
      || /[%?#\s\\]/.test(raw[key]) || new URL(raw[key], origin).origin !== origin
      || new URL(raw[key], origin).pathname !== raw[key]
      || /\/(?:logout|signout|delete|remove|submit|claim|destroy)(?:[/. _-]|$)/i.test(raw[key])) {
      throw new Error('Native verification recovery requires exact same-origin paths');
    }
  }
  const includes = raw.rejectionMessageIncludes;
  if (typeof includes !== 'string' || !includes.trim() || includes.length > 80 || /[\r\n]/.test(includes)) {
    throw new Error('Native verification recovery requires a bounded explicit rejection message');
  }
  return { refreshPath: raw.refreshPath, selfPath: raw.selfPath, checkinPath: raw.checkinPath,
    rejectionMessageIncludes: includes };
}

export function nativeVerificationRuleKey(raw) {
  return createHash('sha256').update(JSON.stringify(normalizeNativeVerificationRecovery(raw))).digest('hex');
}

export function nativeSubmissionHandoff(result) {
  if (['signed', 'already_signed'].includes(result.status) || result.failureCode === 'submission_quarantined') return result;
  const verification = ['interactive_challenge', 'managed_challenge'].includes(result.status)
    || result.verificationRecoveryDiagnostics?.outcome === 'rejected_intent_released';
  if (!verification && result.actionAttempted !== true && result.submissionAttempted !== true) return result;
  return { ...result, status: verification ? 'interactive_challenge' : 'needs_attention',
    submissionAttempted: result.submissionAttempted === true || result.actionAttempted === true,
    failureCode: result.failureCode || (verification ? 'cloudflare_verification_unresolved' : 'native_submission_unconfirmed'),
    retryable: false, manualBrowserMode: 'native' };
}

// A previous day's ambiguity remains in history. Only a fresh authoritative
// negative status may admit this day's action; current-cycle intents never do.
export async function resumeNativeCycleFromStatus({ page, origin, rule, config, scope,
  readStatus = readNativeVerificationStatus, now = () => new Date() }) {
  const pending = await scope.pending();
  if (!pending.length || partitionSubmissions(pending, { origin }, config, now()).current.length) return false;
  const status = await readStatus(page, origin, rule, config).catch(() => null);
  if (status?.status !== 'not_signed') return false;
  try { await scope.prepareNewCycleAfterVerifiedReadiness(status); return true; }
  catch { return false; }
}

// Reopened sessions may recover a recorded explicit rejection, never an
// unobserved/ambiguous request. Endpoint readiness must be read again now.
export async function recoverRecordedNativeVerification({ page, origin, rule, config, scope,
  readStatus = readNativeVerificationStatus }) {
  const ruleKey = nativeVerificationRuleKey(rule);
  const pending = await scope.pending();
  if (!pending.some(entry => entry.verificationRejection?.ruleKey === ruleKey)) return false;
  // A retained old document may still replay its verification asynchronously.
  // Recovery requires a newer document, already covered by the caller's guard.
  const documentStartedAt = await page.evaluate(() => performance.timeOrigin).catch(() => null);
  const status = await readStatus(page, origin, rule, config).catch(() => null);
  if (status?.status !== 'not_signed') return false;
  if (!await scope.releaseRecordedVerificationRejections(status, ruleKey, { documentStartedAt })) return false;
  if ((await scope.pending()).length) await scope.prepareNewCycleAfterVerifiedReadiness(status);
  return true;
}

// Authentication and status responses remain inside the page. This helper
// never POSTs to the action endpoint, even when the server says it is unsigned.
export async function readNativeVerificationStatus(page, origin, raw, config = {}) {
  const rule = normalizeNativeVerificationRecovery(raw);
  if (!rule) return null;
  assertBookmarkNavigation(page.url(), [origin]);
  const activeRule = configuredBearerCheckinRule(origin, { bearerCheckinRules: { [origin]: rule } });
  const observed = await page.evaluate(runBearerCheckinInBrowser, { activeRule, readOnly: true })
    .catch(() => ({ state: 'verification_failed' }));
  assertBookmarkNavigation(page.url(), [origin]);
  if (observed.state === 'ready') return dailyReadinessEvidence({ origin }, config, { source: 'status_endpoint' });
  if (observed.state === 'already_signed') return bindSuccessEvidence({ status: 'already_signed',
    reason: '原生签到状态接口确认今日已签到', evidence: successEvidence('status_endpoint', 'native_confirmed_completion') }, { origin }, config);
  return null;
}

export function watchNativeCheckinSubmissions(page, origin, raw) {
  const rule = normalizeNativeVerificationRecovery(raw);
  if (!rule) return null;
  const requests = new Set(), rejected = new Set(), verificationRejected = new Set(), pending = new Set(), pages = new Set();
  let failed = false, stopped = false;
  const matches = request => {
    try { const url = new URL(request.url());
      return url.origin === origin && url.pathname === rule.checkinPath && request.method() === 'POST';
    } catch { return false; }
  };
  const requestHandler = request => { if (!stopped && matches(request)) requests.add(request); };
  const failureHandler = request => { if (matches(request)) failed = true; };
  const responseHandler = response => {
    const request = response.request();
    if (stopped || !requests.has(request)) return;
    const task = (async () => {
      const status = response.status();
      // An authentication retry did not apply the check-in. Unknown errors,
      // HTTP 429/5xx and successful submissions must keep the intent blocked.
      if (status === 401) { rejected.add(request); return; }
      if (status !== 200) return;
      const body = await response.json().catch(() => null);
      if (body?.success === false && typeof body.message === 'string'
        && body.message.includes(rule.rejectionMessageIncludes)) {
        rejected.add(request); verificationRejected.add(request);
      }
    })().catch(() => {});
    pending.add(task); void task.finally(() => pending.delete(task));
  };
  const attach = activePage => {
    const source = typeof activePage.context === 'function' ? activePage.context() : activePage;
    if (stopped || pages.has(source)) return;
    pages.add(source);
    source.on('request', requestHandler); source.on('requestfailed', failureHandler); source.on('response', responseHandler);
  };
  attach(page);
  return {
    attach,
    diagnostics: () => ({ requestCount: requests.size, rejectionCount: rejected.size,
      verificationRejectionCount: verificationRejected.size, requestFailed: failed, pendingResponseCount: pending.size }),
    allRejected: () => verificationRejected.size > 0 && !failed && requests.size === rejected.size && pending.size === 0,
    async stop() {
      stopped = true;
      for (const activePage of pages) {
        activePage.off('request', requestHandler); activePage.off('requestfailed', failureHandler); activePage.off('response', responseHandler);
      }
      await Promise.allSettled([...pending]);
    },
  };
}

// Freeze the site's asynchronous verification replay before taking a final
// status snapshot. Unknown submissions remain isolated; only this live intent
// can be rejected, never an older record from the journal.
export async function settleNativeVerificationRecovery({ page, origin, rule, config, scope, watcher,
  result, freeze, readStatus = readNativeVerificationStatus }) {
  if (!watcher) return result;
  await freeze();
  await watcher.stop();
  const diagnostics = watcher.diagnostics();
  if (['signed', 'already_signed'].includes(result.status)) {
    return { ...result, verificationRecoveryDiagnostics: { ...diagnostics, outcome: 'completed' } };
  }
  if (watcher.allRejected()) await scope.recordVerificationRejection(nativeVerificationRuleKey(rule),
    { ...diagnostics, allRejected: true, submissionsFrozen: true });
  const status = await readStatus(page, origin, rule, config).catch(() => null);
  if (['signed', 'already_signed'].includes(status?.status)) {
    return { ...result, ...status, failureCode: null, retryable: false,
      verificationRecoveryDiagnostics: { ...diagnostics, outcome: 'completed' } };
  }
  let outcome = 'protected';
  if (status?.status === 'not_signed' && watcher.allRejected()) {
    await scope.rejectAfterVerifiedReadiness(status, { ...diagnostics, allRejected: true, submissionsFrozen: true });
    outcome = 'rejected_intent_released';
  }
  return { ...result, verificationRecoveryDiagnostics: { ...diagnostics, outcome } };
}
