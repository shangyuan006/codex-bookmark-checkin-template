import { randomUUID } from 'node:crypto';

export async function continueNativeCheckinAfterLogin(target, config, loginOutcome, { runPreflight, readConfirmations }) {
  if (!loginOutcome?.succeeded || loginOutcome.authoritativeCheckinStatus) return null;
  const rule = (config.nativeChallengePreflight ?? []).find(entry => {
    try { return new URL(entry.url).origin === target.origin && (entry.action || entry.newApiCheckin || entry.calendarDayCheckin || entry.dailyFormCheckin || entry.samePageCheckin); }
    catch { return false; }
  });
  if (!rule) return null;
  const attemptId = randomUUID().replaceAll('-', '');
  let failed = false;
  try { await runPreflight(target.origin, attemptId); }
  catch (error) {
    if (error.cleanupFailed) throw error;
    failed = true;
  }
  // A later cleanup error may follow a successfully persisted confirmation.
  const confirmation = (await readConfirmations(attemptId)).get(target.origin);
  if (confirmation && ['signed', 'already_signed'].includes(confirmation.status)) {
    return {
      status: confirmation.status,
      reason: '原生登录恢复后，原生签到页面或接口明确确认今日已签到',
      url: confirmation.url,
      observedAt: confirmation.observedAt,
      evidence: confirmation.evidence,
      cycle: confirmation.cycle,
      submissionAttempted: confirmation.submissionAttempted,
      actionResults: confirmation.actionResults,
      requiredActionTypes: confirmation.requiredActionTypes,
      submissionTrackedPerAction: confirmation.submissionTrackedPerAction,
      nativePreflight: true,
      safeLineDiagnostics: confirmation.safeLineDiagnostics,
      readOnlyDiagnostics: confirmation.readOnlyDiagnostics,
      formDiagnostics: confirmation.formDiagnostics,
      calendarDiagnostics: confirmation.calendarDiagnostics,
      readOnlyRecheck: confirmation.readOnlyRecheck === true,
    };
  }
  if (['interactive_challenge','needs_attention'].includes(confirmation?.status)
    && ['safeline_client_challenge','cloudflare_verification_unresolved','submission_quarantined',
      'daily_form_readiness_unconfirmed','daily_form_completion_unconfirmed',
      'same_page_verification_unresolved','same_page_login_required','same_page_completion_unconfirmed'].includes(confirmation.failureCode)
    && confirmation.retryable === false) {
    return {
      status: confirmation.status,
      reason: confirmation.reason ?? '原生登录恢复后尚未取得签到完成证据，停止自动重试并转人工处理',
      failureCode: confirmation.failureCode,
      retryable: false,
      url: confirmation.url,
      observedAt: confirmation.observedAt,
      actionAttempted: confirmation.actionAttempted === true,
      actionOutcome: confirmation.actionOutcome,
      nativePreflight: true,
      submissionAttempted: confirmation.submissionAttempted,
      actionResults: confirmation.actionResults,
      requiredActionTypes: confirmation.requiredActionTypes,
      submissionTrackedPerAction: confirmation.submissionTrackedPerAction,
      submissionObservation: confirmation.submissionObservation,
      quarantine: confirmation.quarantine,
      formDiagnostics: confirmation.formDiagnostics,
      calendarDiagnostics: confirmation.calendarDiagnostics,
      cloudflareDiagnostics: confirmation.cloudflareDiagnostics,
      ...(confirmation.manualBrowserMode === 'native' ? { manualBrowserMode: 'native' } : {}),
      safeLineDiagnostics: confirmation.safeLineDiagnostics,
      readOnlyDiagnostics: confirmation.readOnlyDiagnostics,
      readOnlyRecheck: confirmation.readOnlyRecheck === true,
    };
  }
  return {
    status: 'needs_attention',
    reason: failed ? '原生登录后的签到流程未完成，需要人工确认' : '原生登录已恢复，但原生签到尚未取得成功证据，需要人工确认',
    failureCode: 'native_checkin_after_login_unconfirmed',
    ...(confirmation ? { safeLineDiagnostics: confirmation.safeLineDiagnostics,
      readOnlyDiagnostics: confirmation.readOnlyDiagnostics, readOnlyRecheck: confirmation.readOnlyRecheck === true } : {}),
  };
}
