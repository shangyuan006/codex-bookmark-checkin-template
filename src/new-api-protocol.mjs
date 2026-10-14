// Self-contained: Playwright and raw CDP serialize this function. The HTTP
// adapter supplies a transport using the existing isolated request context.
export async function runNewApiProtocol({ readOnly = false, expectedAccountId = null,
  requireCalendarRecord = false, timeZone = 'Asia/Shanghai', checkinDate = null,
  cycleEndAt = null, request = null, beforeSubmit = null, rejectSubmission = null,
  fallbackOnChallenge = false, wait = null, clock = null } = {}) {
  const now = () => clock ? clock() : new Date();
  const pause = wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const normalizeId = value => (typeof value !== 'number' || Number.isSafeInteger(value))
    && /^[1-9][0-9]{0,19}$/.test(String(value ?? '')) ? String(value) : null;
  const strict = expectedAccountId != null || requireCalendarRecord;
  if (expectedAccountId != null && !normalizeId(expectedAccountId)) throw new Error('Invalid expected New API identity');
  const day = date => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const today = checkinDate ?? day(now());
  const currentCycle = () => cycleEndAt ? now().getTime() < Date.parse(cycleEndAt) : day(now()) === today;
  const completedControl = () => !request && [...(globalThis.document?.querySelectorAll?.('button, [role=button], input[type=button], input[type=submit], a') ?? [])]
    .some(element => {
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      const text = String(element.innerText || element.value || element.getAttribute('aria-label') || element.title || '').replace(/\s+/g, ' ').trim();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
        && /^(?:(?:今日|今天|当日|當日)\s*)?已\s*(?:签到|簽到)$|签到成功|簽到成功/i.test(text);
    });
  const failure = (status, reason, failureCode, extra = {}) => ({ status, reason, ...(failureCode ? { failureCode } : {}), ...extra });
  const sessionFailure = () => {
    if (request && !strict) return null;
    // A configured identity must be verified by the API even if the page has a
    // completion control. Existing single-account page verification is retained.
    if (!strict && completedControl()) return {
      status: 'already_signed', reason: '页面签到控件确认已签到，接口登录探测不可用',
      evidence: { source: 'page_text', outcome: 'page_completion_control', authoritative: true, confirmedAt: now().toISOString() },
    };
    if (!request && !strict) {
      const controls = [...(globalThis.document?.querySelectorAll?.('button, [role=button], input[type=submit], a') ?? [])];
      const visible = element => {
        const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const password = [...(globalThis.document?.querySelectorAll?.('input[type="password"]') ?? [])].some(visible);
      if (!password && controls.some(element => visible(element) && /立即签到|立即簽到|每日签到|每日簽到|check.?in|attendance/i.test(element.innerText || element.value || ''))) return null;
    }
    return failure('login_required', '签到接口显示登录状态无效');
  };
  let seedId = expectedAccountId;
  if (!request && !seedId) {
    for (const storage of [globalThis.localStorage, globalThis.sessionStorage]) {
      if (!storage) continue;
      for (let i = 0; i < storage.length; i++) {
        try {
          const key = storage.key(i), raw = storage.getItem(key);
          let value; try { value = JSON.parse(raw); } catch { value = raw; }
          const id = normalizeId(value?.id ?? value?.user?.id ?? value?.state?.user?.id ?? value?.data?.id ?? value?.data?.user?.id
            ?? (/^(?:uid|user[_-]?id)$/i.test(key) ? value : null));
          if (id) { seedId = id; break; }
        } catch { /* storage is only an untrusted header hint */ }
      }
      if (seedId) break;
    }
    // Legacy page/storage IDs are only header hints; /self must authenticate
    // them before they can participate in completion proof.
    if (!seedId) seedId = normalizeId(String(globalThis.document?.body?.innerText ?? '')
      .match(/(?:用户|使用者)?\s*ID\s*[:：]?\s*(\d+)/i)?.[1]);
  }
  const transport = request ?? (async (path, method = 'GET', userId = null) => {
    try {
      const response = await fetch(path, { method, credentials: 'include', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json', ...(userId ? { 'New-Api-User': userId } : {}) }, signal: AbortSignal.timeout(8000) });
      return { httpStatus: response.status, body: await response.json().catch(() => null) };
    } catch { return null; }
  });
  const read = async (...args) => { try { return await transport(...args); } catch { return null; } };
  const self = await read('/api/user/self', 'GET', seedId);
  if ([401, 403].includes(self?.httpStatus)) return sessionFailure();
  if (self?.httpStatus === 429) return failure('deferred', '账号接口触发限流', null, { retryCause: 'rate_limit' });
  const userId = normalizeId(self?.body?.data?.id ?? self?.body?.data?.user?.id);
  if (self?.httpStatus < 200 || self?.httpStatus >= 300 || self?.body?.success !== true || !userId) {
    return strict ? failure('needs_attention', '未能核验预期账号，未提交签到', 'account_identity_unconfirmed', { retryable: false }) : null;
  }
  if (expectedAccountId != null && userId !== String(expectedAccountId)) {
    return failure('needs_attention', '登录账号与预期账号不一致，未提交签到', 'account_mismatch', { retryable: false });
  }
  const statusPath = `/api/user/checkin?month=${today.slice(0, 7)}`;
  const checked = response => {
    if (!response || response.httpStatus < 200 || response.httpStatus >= 300 || response.body?.success !== true) return null;
    const data = response.body.data;
    const value = data?.stats?.checked_in_today ?? data?.checked_in_today ?? data?.checkedInToday;
    return typeof value === 'boolean' ? value : null;
  };
  const proof = response => {
    if (checked(response) !== true || !currentCycle()) return null;
    const data = response.body.data;
    const records = data?.stats?.records ?? data?.records;
    if (records != null) {
      if (!Array.isArray(records)) return null;
      const matches = records.filter(record => record?.checkin_date === today);
      if (matches.length !== 1) return null;
      const record = matches[0], reward = record.quota_awarded;
      if ((record.user_id != null && normalizeId(record.user_id) !== userId) || reward == null
        || !['number', 'string'].includes(typeof reward) || String(reward).trim() === ''
        || !Number.isFinite(Number(reward)) || Number(reward) < 0) return null;
    } else if (requireCalendarRecord) return null;
    return { source: 'status_endpoint', outcome: records != null ? 'new_api_calendar_confirmed' : 'checked_in_today',
      authoritative: true, confirmedAt: now().toISOString(), checkinDate: today,
      accountVerified: true, calendarVerified: records != null };
  };
  const confirmIdentity = async () => {
    const after = await read('/api/user/self', 'GET', userId);
    return after?.httpStatus >= 200 && after.httpStatus < 300 && after.body?.success === true
      && normalizeId(after.body?.data?.id ?? after.body?.data?.user?.id) === userId && currentCycle();
  };
  const unavailable = response => {
    const body = response?.body;
    return response?.httpStatus >= 200 && response.httpStatus < 300
      && ((body?.success === true && body?.data?.enabled === false)
        || (body?.success === false && /未启用|未啟用|not enabled/i.test(String(body.message ?? ''))));
  };
  const disabled = source => ({ status: 'not_available', reason: '站点签到功能未启用', availabilityKind: 'feature_disabled',
    evidence: { source, outcome: 'message_not_enabled', authoritative: true, confirmedAt: now().toISOString() } });
  const initial = await read(statusPath, 'GET', userId);
  if ([401, 403].includes(initial?.httpStatus)) return sessionFailure();
  if (initial?.httpStatus === 429) return failure('deferred', '签到接口触发限流', null, { retryCause: 'rate_limit' });
  if (unavailable(initial)) return disabled('new_api_checkin_status');
  if (checked(initial) === true) {
    const evidence = proof(initial);
    if (evidence && await confirmIdentity()) return { status: 'already_signed', reason: '当前账号与本周期签到状态已确认', evidence };
    return failure('unconfirmed', '签到完成声明缺少一致的账号或当日记录，未重复提交', 'new_api_proof_inconsistent', { retryable: false });
  }
  if (checked(initial) !== false) {
    if (/turnstile|captcha|人机|人機/i.test(String(initial?.body?.message ?? ''))) return failure('interactive_challenge', '站点签到接口要求人机验证');
    return expectedAccountId || requireCalendarRecord ? failure('unconfirmed', '未取得可核验的签到状态，未提交签到', 'new_api_proof_inconsistent', { retryable: false }) : null;
  }
  const initialRecords = initial.body?.data?.stats?.records ?? initial.body?.data?.records;
  if (requireCalendarRecord && !Array.isArray(initialRecords)) {
    return failure('unconfirmed', '站点未提供要求的签到日历记录，未提交签到', 'new_api_proof_inconsistent', { retryable: false });
  }
  if (initialRecords != null && (!Array.isArray(initialRecords) || initialRecords.some(record => record?.checkin_date === today))) {
    return failure('unconfirmed', '签到标志与当天记录不一致，未提交签到', 'new_api_proof_inconsistent', { retryable: false });
  }
  if (!currentCycle()) return failure('unconfirmed', '核验期间签到周期已变化，未提交签到', 'site_cycle_expired');
  if (readOnly) {
    if (!await confirmIdentity()) return failure('unconfirmed', '未签到观察期间账号或周期已变化', 'account_identity_unconfirmed', { retryable: false });
    return { status: 'not_signed', reason: '当前账号的状态接口确认本周期未签到', dailyUnsigned: true };
  }
  await beforeSubmit?.();
  if (!currentCycle()) {
    await rejectSubmission?.('site_cycle_expired');
    return failure('unconfirmed', '提交前签到周期已变化，未提交签到', 'site_cycle_expired', { retryable: false });
  }
  const action = await read('/api/user/checkin', 'POST', userId);
  if (action?.httpStatus >= 200 && action.httpStatus < 300 && action.body?.success === false
    && /turnstile|captcha|人机|人機/i.test(String(action.body.message ?? ''))) {
    await rejectSubmission?.('challenge_rejected');
    return fallbackOnChallenge ? null : failure('interactive_challenge', '站点签到接口要求人机验证', null,
      { submissionAttempted: false, submissionRejected: true });
  }
  if (unavailable(action)) { await rejectSubmission?.('feature_disabled'); return disabled('new_api_checkin_action'); }
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await pause(750);
    const evidence = proof(await read(statusPath, 'GET', userId));
    if (evidence && await confirmIdentity()) return {
      status: action?.body?.success === true ? 'signed' : 'already_signed', reason: '提交后已核验当前账号与本周期签到状态', evidence,
    };
  }
  return failure('needs_attention', '签到请求已发出，但账号或完成证据未确认，禁止重复提交', 'api_submission_unconfirmed',
    { submissionAttempted: true, retryable: false });
}
