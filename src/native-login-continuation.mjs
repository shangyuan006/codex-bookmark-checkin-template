export async function continueNativeCheckinAfterLogin(target, config, loginOutcome, { runPreflight, readConfirmations }) {
  if (!loginOutcome?.succeeded || loginOutcome.authoritativeCheckinStatus) return null;
  const rule = (config.nativeChallengePreflight ?? []).find(entry => {
    try { return new URL(entry.url).origin === target.origin && (entry.action || entry.newApiCheckin); }
    catch { return false; }
  });
  if (!rule) return null;
  let failed = false;
  try { await runPreflight(target.origin); }
  catch (error) {
    if (error.cleanupFailed) throw error;
    failed = true;
  }
  // A later cleanup error may follow a successfully persisted confirmation.
  const confirmation = (await readConfirmations()).get(target.origin);
  if (confirmation && ['signed', 'already_signed'].includes(confirmation.status)) {
    return {
      status: confirmation.status,
      reason: '原生登录恢复后，原生签到页面或接口明确确认今日已签到',
      url: confirmation.url,
      observedAt: confirmation.observedAt,
      nativePreflight: true,
    };
  }
  return {
    status: 'needs_attention',
    reason: failed ? '原生登录后的签到流程未完成，需要人工确认' : '原生登录已恢复，但原生签到尚未取得成功证据，需要人工确认',
    failureCode: 'native_checkin_after_login_unconfirmed',
  };
}
