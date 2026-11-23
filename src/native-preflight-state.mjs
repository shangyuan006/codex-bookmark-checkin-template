import { isCurrentCheckinCycle } from './checkin-cycle.mjs';
import { reconcileCheckinResult } from './checkin-evidence.mjs';
import { normalizeResultActionEntries } from './sequential-action-evidence.mjs';
import { isConfirmedNotAvailable } from './result-contract.mjs';

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
    .map(normalizeResultActionEntries)
    .map(result => [result.origin, result.evidence?.binding
      ? reconcileCheckinResult(result,result.evidence,now,{config}) : result]));
}

export function freshNativePreflightResults(report, allowedOrigins, now = new Date(), config={}) {
  return freshNativeResults(report, allowedOrigins, result => ['signed', 'already_signed'].includes(result.status)
    || isConfirmedNotAvailable(result, now) && isCurrentCheckinCycle(result.origin, result.evidence.confirmedAt, config, now), now, config);
}

// Blockers apply only to the preflight that immediately precedes this runner.
// Unlike confirmations, they must not survive a new manual/explicit attempt.
export function freshNativePreflightHandoffs(report, allowedOrigins, attemptId, now = new Date()) {
  if (!/^[a-f0-9]{32}$/i.test(attemptId ?? '')) return new Map();
  return freshNativeResults(report, allowedOrigins, result =>
    result.preflightAttemptId === attemptId && result.retryable === false && (
      result.status === 'interactive_challenge' && ['safeline_client_challenge', 'cloudflare_verification_unresolved'].includes(result.failureCode)
      || result.status === 'needs_attention' && ['submission_quarantined','native_submission_unconfirmed','daily_form_readiness_unconfirmed','daily_form_completion_unconfirmed',
        'calendar_loading_timeout','calendar_today_not_found','calendar_completion_unconfirmed',
        'same_page_verification_unresolved','same_page_login_required','same_page_completion_unconfirmed',
        'native_browser_error_unresolved','daily_form_document_unbound','daily_form_browser_request_blocked'].includes(result.failureCode)), now);
}

export function nativePreflightProgress(targets, confirmations) {
  return targets.flatMap(target => {
    const result = normalizeResultActionEntries(confirmations.get(target.origin));
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
      safeLineDiagnostics: result.safeLineDiagnostics,
      cloudflareDiagnostics: result.cloudflareDiagnostics,
      verificationRecoveryDiagnostics: result.verificationRecoveryDiagnostics,
      readOnlyDiagnostics: result.readOnlyDiagnostics,
      calendarDiagnostics: result.calendarDiagnostics,
      formDiagnostics: result.formDiagnostics,
      browserErrorRecovery: result.browserErrorRecovery,
      availabilityKind: result.availabilityKind,
      disabledByConfig: result.disabledByConfig,
      temporarilyUnavailable: result.temporarilyUnavailable,
      readOnlyRecheck: result.readOnlyRecheck === true,
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
        challengeOutcome: result.challengeOutcome,
        challengeDetails: result.challengeDetails,
        ...(result.manualBrowserMode === 'native' ? { manualBrowserMode: 'native' } : {}),
        quarantine: result.quarantine,
        historicalSubmissionWarning: result.historicalSubmissionWarning,
        submissionObservation: result.submissionObservation,
      } : {}),
    }] : [];
  });
}
