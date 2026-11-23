const phases = new Set(['scan_control', 'trial_click', 'recheck_control', 'reserve_intent', 'dispatch_click', 'completed']);
const outcomes = new Set(['in_progress', 'failed', 'not_dispatched', 'click_returned']);
const errors = new Set(['timeout', 'context_unavailable', 'failed']);

// Persist fixed categories and relative timing, never browser error text,
// control labels, page URLs, or values from the document.
export function sanitizeSequentialClickDiagnostics(value) {
  if (!value || !phases.has(value.phase) || !outcomes.has(value.outcome)
    || typeof value.dispatchInvoked !== 'boolean') return null;
  return { phase: value.phase, outcome: value.outcome, dispatchInvoked: value.dispatchInvoked,
    elapsedMs: Math.max(0, Math.min(300_000, Math.round(Number(value.elapsedMs) || 0))),
    ...(typeof value.pageChanged === 'boolean' ? { pageChanged: value.pageChanged } : {}),
    ...(errors.has(value.errorKind) ? { errorKind: value.errorKind } : {}) };
}

// These observations explain an uncertain intent; they never authorize a retry.
export function sanitizeSubmissionDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const key of ['submissionRequestObserved', 'submissionEvidenceConfigured', 'submissionResponseConfirmed',
    'submissionRequestFailed', 'intentReserved', 'requestFailed']) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  for (const key of ['submissionRequestCount', 'submissionResponseCount', 'submissionRejectedCount',
    'submissionPendingResponseCount', 'submissionVerificationRequiredCount', 'requestCount', 'rejectionCount',
    'verificationRejectionCount', 'pendingResponseCount', 'verificationRetryCount']) {
    if (Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 10000) result[key] = value[key];
  }
  if (Number.isInteger(value.submissionResponseStatus) && value.submissionResponseStatus >= 100
    && value.submissionResponseStatus <= 599) result.submissionResponseStatus = value.submissionResponseStatus;
  const action = sanitizeSequentialClickDiagnostics(value.action);
  if (action) result.action = action;
  if (['not_attempted', 'click_returned', 'click_failed_or_uncertain'].includes(value.clickOutcome)) result.clickOutcome = value.clickOutcome;
  if (['completed', 'protected', 'rejected_intent_released'].includes(value.outcome)) result.outcome = value.outcome;
  if (value.verification && typeof value.verification === 'object') {
    const verification = {};
    for (const key of ['challengeFrameCount', 'challengeFrameDetachedCount', 'challengeFrameReplacementCount', 'challengeRequestFailedCount', 'probeCount']) {
      const count = value.verification[key];
      if (Number.isInteger(count) && count >= 0 && count <= 10000) verification[key] = count;
    }
    const first = value.verification.firstWidgetAfterMs;
    if (first === null || Number.isFinite(first) && first >= 0 && first <= 600000) verification.firstWidgetAfterMs = first;
    if (typeof value.verification.siteWatchdogElapsed === 'boolean') verification.siteWatchdogElapsed = value.verification.siteWatchdogElapsed;
    if (typeof value.verification.click?.clicked === 'boolean'
      && /^[a-z_]{1,80}$/.test(value.verification.click.outcome ?? '')) {
      verification.click = { clicked: value.verification.click.clicked, outcome: value.verification.click.outcome };
    }
    if (Array.isArray(value.verification.publicErrorCodes)) verification.publicErrorCodes = [...new Set(value.verification.publicErrorCodes
      .filter(code => Number.isInteger(code) && code >= 10000 && code <= 999999))].slice(0, 12);
    if (Array.isArray(value.verification.events)) verification.events = value.verification.events.filter(event =>
      ['frame_observed', 'frame_detached', 'request_failed', 'public_error_code', 'widget_visible'].includes(event?.kind)
      && Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0 && event.elapsedMs <= 600000)
      .slice(-24).map(event => ({ kind: event.kind, elapsedMs: Math.round(event.elapsedMs) }));
    if (Object.keys(verification).length) result.verification = verification;
  }
  return Object.keys(result).length ? result : null;
}

export function createSequentialClickDiagnostics(page, onProgress = () => {}) {
  const startedAt = Date.now(), initialUrl = page.url?.();
  let current = { phase: 'scan_control', outcome: 'in_progress', dispatchInvoked: false };
  const update = (phase, outcome = 'in_progress', extra = {}) => {
    current = sanitizeSequentialClickDiagnostics({ ...current, phase, outcome, ...extra,
      elapsedMs: Date.now() - startedAt, pageChanged: page.url?.() !== initialUrl });
    onProgress(current);
    return current;
  };
  return { update, snapshot: () => ({ ...current }), fail(error) {
    const message = String(error?.message ?? '');
    const errorKind = /timeout/i.test(message) ? 'timeout'
      : /detached|context.*destroyed|target.*closed/i.test(message) ? 'context_unavailable' : 'failed';
    const diagnostic = update(current.phase, 'failed', { errorKind });
    const failure = new Error('Sequential check-in control failed');
    failure.actionDiagnostics = diagnostic;
    return failure;
  } };
}
