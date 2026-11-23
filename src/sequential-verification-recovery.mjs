import { createHash } from 'node:crypto';

// Explicit local opt-in, one daily action, a reviewed unsigned control and
// exact verification rejection rules are all required for a single retry.
export function sequentialVerificationRecoveryKey(target, config) {
  const rule = config.samePageManualCheckinRules?.[target.origin];
  const steps = config.sequentialActionRules?.[target.origin]?.steps;
  const step = steps?.[0];
  if (rule?.retryRejectedVerification !== true || rule.enabled === false || rule.browserMode !== 'native'
    || config.sequentialActionRules?.[target.origin]?.enabled === false
    || !rule.siteReplaysAfterChallenge || steps?.length !== 1 || !step?.dailyCheckin
    || step.actionType !== target.actionType || step.actionType !== rule.sequentialActionType
    || !step.dailyUnsignedControl?.selector || !step.dailyUnsignedControl?.textPattern
    || !step.rejectionEvidence?.length || step.rejectionEvidence.some(value =>
      value.verificationRequired !== true || !value.urlPath || !value.rejectedAny?.length
      || !value.statuses?.length || value.statuses.some(status => status < 400 || status >= 500))) return null;
  try { const url = new URL(step.url);
    if (url.origin !== target.origin || url.pathname !== rule.expectedPath || url.search || url.hash) return null;
  } catch { return null; }
  return createHash('sha256').update(JSON.stringify([rule.expectedPath, rule.widgetSelector,
    rule.responseSelector, step])).digest('hex');
}

export function exactVerificationRejection(diagnostics) {
  const count = diagnostics?.submissionRequestCount;
  return Number.isInteger(count) && count > 0 && count <= 10000
    && diagnostics.submissionResponseConfirmed !== true && diagnostics.submissionRequestFailed !== true
    && diagnostics.submissionResponseCount === count && diagnostics.submissionRejectedCount === count
    && diagnostics.submissionVerificationRequiredCount === count && diagnostics.submissionPendingResponseCount === 0;
}

export function frozenSequentialRejection(diagnostics) {
  if (!exactVerificationRejection(diagnostics)) return null;
  return { submissionsFrozen: true, allRejected: true, requestFailed: false,
    requestCount: diagnostics.submissionRequestCount, rejectionCount: diagnostics.submissionRejectedCount,
    verificationRejectionCount: diagnostics.submissionVerificationRequiredCount, pendingResponseCount: 0 };
}
