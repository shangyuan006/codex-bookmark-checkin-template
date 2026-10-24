// Self-contained: Playwright and raw CDP serialize this function. The HTTP
// adapter supplies a transport using the existing isolated request context.
export async function runNewApiProtocol({ readOnly = false, expectedAccountId = null,
  requireCalendarRecord = false, timeZone = 'Asia/Shanghai', checkinDate = null,
  cycleEndAt = null, request = null, beforeSubmit = null, rejectSubmission = null,
  fallbackOnChallenge = false, wait = null, clock = null, onFailure = null } = {}) {
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
  // Only fixed categories may leave this function. In particular, server
  // messages and HTML can contain account details and must not become logs.
  const failureKind = response => {
    if (!response) return 'network_error';
    if (response.httpStatus === 429) return 'rate_limit';
    if (response.challengePresent) return 'challenge';
    if (response.blockedRedirect || response.httpStatus >= 300 && response.httpStatus < 400) return 'redirect';
    if (response.httpStatus >= 500) return 'upstream_unavailable';
    if ([404, 405].includes(response.httpStatus)) return 'route_unavailable';
    if (response.responseKind !== 'json') return 'non_json';
    const message = String(response.body?.message ?? response.body?.error?.message ?? response.body?.error ?? '').slice(0, 4_096);
    if (/new[-_ ]?api[-_ ]?user/i.test(message)
      && /not provided|required|missing|缺少|缺失|未提供|不能为空|不能為空/i.test(message)) return 'user_header_required';
    if (response.body?.success === false && /turnstile|captcha|人机|人機/i.test(message)) return 'challenge';
    if (response.body?.success === false
      && /access[ _-]?token|bearer/i.test(message) && /invalid|expired|无效|失效|过期|無效|過期/i.test(message)) return 'token_invalid';
    if (response.httpStatus === 401 || response.body?.success === false
      && /not logged in|unauthenticated|unauthori[sz]ed|login required|未登录|未登入|未登錄|请先登录|請先登入|登录已过期|会话已失效/i.test(message)) return 'session_invalid';
    if (response.httpStatus === 403) return 'access_denied';
    return null;
  };
  const completedPageResult = () => ({
    status: 'already_signed', reason: '页面签到控件确认已签到，接口登录探测不可用',
    evidence: { source: 'page_text', outcome: 'page_completion_control', authoritative: true, confirmedAt: now().toISOString() },
  });
  const sessionFailure = () => {
    if (request && !strict) return null;
    // A configured identity must be verified by the API even if the page has a
    // completion control. Existing single-account page verification is retained.
    if (!strict && completedControl()) return completedPageResult();
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
      return { httpStatus: response.status, bodyText: await response.text(),
        contentType: response.headers.get('content-type') ?? '', cfMitigated: response.headers.get('cf-mitigated') ?? '' };
    } catch { return null; }
  });
  const read = async (...args) => {
    let response;
    try { response = await transport(...args); } catch { response = null; }
    if (response) {
      let body = response.body;
      const text = typeof response.bodyText === 'string' ? response.bodyText : '';
      const html = /text\/html|application\/xhtml/i.test(response.contentType ?? '')
        || /^\s*<(?:!doctype|html|head|body|title)\b/i.test(text);
      if (text && text.length <= 1024 * 1024 && !html) {
        try { body = JSON.parse(text); } catch { body = null; }
      }
      if (html || text.length > 1024 * 1024) body = null;
      response = { httpStatus: response.httpStatus, body,
        responseKind: body && typeof body === 'object' && !Array.isArray(body) ? 'json' : 'non_json',
        blockedRedirect: response.blockedRedirect === true,
        challengePresent: String(response.cfMitigated ?? '').toLowerCase() === 'challenge'
          || html && /challenge-platform|cf-chl-|just a moment|verify you are human|正在进行安全验证/i.test(text.slice(0, 65_536)) };
    }
    const kind = failureKind(response);
    if (kind) {
      try { onFailure?.({ kind, phase: args[1] === 'POST' ? 'submission' : args[0] === '/api/user/self' ? 'identity' : 'status' }); }
      catch { /* optional diagnostics must never change execution */ }
    }
    return response;
  };
  const preSubmitFailure = response => {
    const kind = failureKind(response);
    const extra = { apiFailureKind: kind };
    // A browser can obtain the header hint from its own storage. Do that
    // before deciding that a user must repair a still-valid session.
    if (kind === 'user_header_required' && request && !strict && fallbackOnChallenge) return null;
    if (kind === 'user_header_required') return failure('needs_attention',
      '接口要求当前账号的用户 ID，未据此判定登录失效', 'new_api_user_header_required',
      { ...extra, retryable: false, retryableLoginRecovery: false });
    if (kind === 'rate_limit') return failure('deferred', '接口触发限流', null, { ...extra, retryCause: 'rate_limit' });
    if (kind === 'upstream_unavailable' || kind === 'network_error') return failure('deferred',
      '接口暂时不可用，未据此判定登录失效', kind === 'network_error' ? 'network_error' : 'site_server_error',
      { ...extra, retryCause: 'upstream_unavailable' });
    if (kind === 'challenge') return request && fallbackOnChallenge ? null
      : failure('interactive_challenge', '接口被人机验证拦截，未据此判定登录失效', null, extra);
    if (kind === 'session_invalid' || kind === 'token_invalid') {
      const result = sessionFailure();
      return result?.status === 'login_required' ? { ...result, ...extra } : result;
    }
    if (strict && ['access_denied', 'route_unavailable'].includes(kind)) return failure('needs_attention',
      kind === 'access_denied' ? '接口拒绝访问，尚不能确认登录状态' : '站点接口路径不可用，未据此判定登录失效',
      kind === 'access_denied' ? 'new_api_access_denied' : 'new_api_route_unavailable',
      { ...extra, retryable: false, retryableLoginRecovery: false });
    if (!strict && ['access_denied', 'route_unavailable', 'non_json', 'redirect'].includes(kind)
      && completedControl()) return completedPageResult();
    return null;
  };
  const self = await read('/api/user/self', 'GET', seedId);
  if (failureKind(self)) return preSubmitFailure(self)
    ?? (strict && !['challenge', 'session_invalid', 'token_invalid'].includes(failureKind(self))
      ? failure('needs_attention', '未能核验预期账号，未提交签到', 'account_identity_unconfirmed', { retryable: false, apiFailureKind: failureKind(self) }) : null);
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
  if (failureKind(initial)) return preSubmitFailure(initial)
    ?? (strict && !['challenge', 'session_invalid', 'token_invalid'].includes(failureKind(initial))
      ? failure('unconfirmed', '未取得可核验的签到状态，未提交签到', 'new_api_proof_inconsistent', { retryable: false, apiFailureKind: failureKind(initial) }) : null);
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
    { submissionAttempted: true, retryable: false, ...(failureKind(action) ? { apiFailureKind: failureKind(action) } : {}) });
}
