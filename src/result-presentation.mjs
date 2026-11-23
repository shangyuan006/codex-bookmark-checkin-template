// Fixed diagnostic labels only. Never echo response bodies or OAuth URLs.
const causes = {
  github_autofill_missing: 'GitHub 登录会话失效，且未找到可用的自动填充',
  provider_login: '仍停在上游账号登录阶段',
  provider_authorize: '上游授权尚未完成',
  cloudflare_verification_unresolved: 'Cloudflare 验证尚未通过',
  daily_form_readiness_unconfirmed: '当日表单尚未就绪',
  daily_form_completion_unconfirmed: '表单提交后未取得完成证据',
  calendar_loading_timeout: '日历页在等待预算内未加载出当天日期',
  calendar_today_not_found: '日历页尚未找到属于今天的唯一日期控件',
  calendar_completion_unconfirmed: '日历提交后尚未取得当天完成证据',
  sequential_status_unconfirmed: '只读状态接口未给出明确结论',
  ready: '页面可继续处理，但尚无本周期可安全提交的证据',
  login_required: '登录状态尚未恢复',
  interactive_challenge: '仍需完成页面验证',
};

export function submissionProtectionCause(result) {
  if (result?.failureCode !== 'submission_quarantined') return '';
  const observed = result.submissionObservation;
  return causes[observed?.failureCode] ?? causes[observed?.oauthStage] ?? causes[observed?.status] ?? '';
}

export function resultDisplayReason(result) {
  const cause = submissionProtectionCause(result);
  const reason = String(result?.reason ?? '');
  return cause && !reason.includes(`当前阻塞：${cause}`) ? `${reason}；当前阻塞：${cause}` : reason;
}
