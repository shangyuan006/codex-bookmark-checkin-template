import { isCurrentCheckinCycle } from './checkin-cycle.mjs';
import { reconcileCheckinResult } from './checkin-evidence.mjs';

function freshNativeResults(report, allowedOrigins, accept, now, config={}) {
  const current = now.getTime();
  const fresh = value => {
    const time = Date.parse(value ?? '');
    return Number.isFinite(time) && time <= current
      && new Date(time).toDateString() === now.toDateString();
  };
  const generated=Date.parse(report?.generatedAt??'');
  if (!Number.isFinite(generated) || generated>current) return new Map();
  return new Map((report?.results ?? [])
    .filter(result => allowedOrigins.has(result?.origin) && accept(result)
      && (config.siteCycleRules?.[result.origin]
        ? isCurrentCheckinCycle(result.origin,result.observedAt??report.generatedAt,config,now)
        : fresh(report.generatedAt) && fresh(result.observedAt ?? report.generatedAt)))
    .map(result => [result.origin, result.evidence?.binding
      ? reconcileCheckinResult(result,result.evidence,now,{config}) : result]));
}

export function freshNativePreflightResults(report, allowedOrigins, now = new Date(), config={}) {
  return freshNativeResults(report, allowedOrigins, result => ['signed', 'already_signed'].includes(result.status), now, config);
}

// Blockers apply only to the preflight that immediately precedes this runner.
// Unlike confirmations, they must not survive a new manual/explicit attempt.
export function freshNativePreflightHandoffs(report, allowedOrigins, attemptId, now = new Date()) {
  if (!/^[a-f0-9]{32}$/i.test(attemptId ?? '')) return new Map();
  return freshNativeResults(report, allowedOrigins, result =>
    result.preflightAttemptId === attemptId && result.retryable === false && (
      result.status === 'interactive_challenge' && result.failureCode === 'safeline_client_challenge'
      || result.status === 'needs_attention' && result.failureCode === 'submission_quarantined'), now);
}

export function nativePreflightProgress(targets, confirmations) {
  return targets.flatMap(target => {
    const result = confirmations.get(target.origin);
    return result ? [{
      origin: target.origin,
      title: target.title,
      folderNames: target.folderNames,
      status: result.status,
      reason: result.reason,
      url: result.url,
      observedAt: result.observedAt,
      attempt: 0,
      durationMs: 0,
      nativePreflight: true,
      evidence: result.evidence,
      cycle: result.cycle,
      actionResults: result.actionResults,
      requiredActionTypes: result.requiredActionTypes,
      submissionTrackedPerAction: result.submissionTrackedPerAction,
      submissionAttempted: result.submissionAttempted,
      ...(result.retryable === false ? {
        retryable: false,
        failureCode: result.failureCode,
        actionAttempted: result.actionAttempted === true,
        actionOutcome: result.actionOutcome,
        quarantine: result.quarantine,
        historicalSubmissionWarning: result.historicalSubmissionWarning,
        submissionObservation: result.submissionObservation,
      } : {}),
    }] : [];
  });
}
