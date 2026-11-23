import { createHash } from 'node:crypto';
import { bindSuccessEvidence, dailyReadinessEvidence, successEvidence } from './checkin-evidence.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const piggoBusinessDate = value => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(value));

export function piggoCalendarRule(target, config = {}) {
  const raw = config.piggoCalendarRules?.[target.origin];
  if (!raw || raw.enabled === false) return null;
  if (!object(raw) || Object.keys(raw).some(key => !['enabled', 'expectedAccountFingerprint'].includes(key))
    || raw.enabled !== true || raw.expectedAccountFingerprint != null && !/^[a-f0-9]{64}$/.test(raw.expectedAccountFingerprint)) {
    throw new Error('Invalid private PigGo calendar rule');
  }
  return raw;
}

export function piggoApiData(value) {
  if (!object(value)) return null;
  return ['code', 'data', 'msg'].some(key => key in value)
    ? value.code === 0 && 'msg' in value && object(value.data) ? value.data : null : value;
}

export function piggoCalendarStatus(value, today) {
  const data = piggoApiData(value), detail = data?.detail, attendance = detail?.attendance;
  if (!Array.isArray(data?.cells) || !object(detail) || detail.is_today !== true
    || data.selected !== today || detail.ymd !== today || !object(attendance)) return null;
  return attendance.status === 'checked' ? 'already_signed' : attendance.status === 'today' ? 'not_signed' : null;
}

export function piggoAccountFingerprint(value, origin) {
  const id = piggoApiData(value)?.user?.id;
  return Number.isSafeInteger(id) && id > 0
    ? createHash('sha256').update(JSON.stringify([origin, id])).digest('hex') : null;
}

export function piggoResponseFresh(response, now) {
  const headers = Object.fromEntries(Object.entries(response.headers()).map(([key, value]) => [key.toLowerCase(), value]));
  const date = headers.date;
  const at = Date.parse(date ?? '');
  return (!headers.age || /^0+$/.test(headers.age)) && !/(?:^|[,\s])11[01]\b/.test(headers.warning ?? '')
    && Number.isFinite(at) && piggoBusinessDate(at) === piggoBusinessDate(now)
    && at <= now.getTime() + 60_000 && now.getTime() - at <= 300_000;
}

function calendarResponseUrl(value, origin, today) {
  try {
    const url = new URL(value);
    const values = { year: String(Number(today.slice(0, 4))), month: String(Number(today.slice(5, 7))), day: String(Number(today.slice(8, 10))) };
    return url.origin === origin && !url.username && !url.password && !url.hash && url.pathname === '/v1/web/calendar'
      && [...url.searchParams].every(([key, value]) => key in values && value === values[key] && url.searchParams.getAll(key).length === 1);
  } catch { return false; }
}

async function boundedJson(response, timeoutMs) {
  let timer;
  try {
    const text = await Promise.race([response.text(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Response timeout')), timeoutMs);
    })]);
    return Buffer.byteLength(text) <= 1_000_000 ? JSON.parse(text) : null;
  } finally { clearTimeout(timer); }
}

// A separate passive tab lets the site's own HTTP client supply authentication.
// Never copy storage, cookies or headers; never reload the retained check-in tab.
export async function readPiggoCalendarState(context, target, config = {}, {
  now = () => new Date(), timeoutMs = 15_000, retainedPage = null,
} = {}) {
  const rule = piggoCalendarRule(target, config);
  if (!rule) return null;
  const started = now(), today = piggoBusinessDate(started), url = target.origin + '/calendar';
  let page, cdp, timer, stopped = false, invalid = false, account = null, status = null, lock = false, login = false;
  const tasks = new Set();
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const unavailable = failureCode => ({ status: lock || login ? 'login_required' : 'unconfirmed', failureCode,
    reason: lock ? 'PigGo 会话因闲置锁定，需要解锁后在原标签接续'
      : login ? 'PigGo 当前登录会话需要恢复' : 'PigGo 尚未取得当前账号当日日历的权威状态',
    retryable: false, submissionAttempted: false });
  const observe = response => {
    if (stopped) return;
    const request = response.request();
    let isMe = false, isCalendar = false;
    try {
      if (request.method() !== 'GET' || request.frame() !== page.mainFrame()) return;
      isMe = response.url() === target.origin + '/v1/web/me';
      isCalendar = calendarResponseUrl(response.url(), target.origin, today);
      if (!isMe && !isCalendar) return;
    } catch { return; }
    const task = (async () => {
      const code = response.status();
      if (code === 401) { login = true; resolveReady(); return; }
      const data = await boundedJson(response, Math.max(1, Math.min(5000, timeoutMs)));
      if (stopped) return;
      if (code === 423 && (data?.code === 'idle_locked' || data?.data?.code === 'idle_locked')) {
        lock = true; resolveReady(); return;
      }
      if (code !== 200 || response.fromServiceWorker?.() === true || !piggoResponseFresh(response, now())) {
        invalid = true; resolveReady(); return;
      }
      if (isMe) {
        const next = piggoAccountFingerprint(data, target.origin);
        if (!next || account && account !== next || rule.expectedAccountFingerprint && next !== rule.expectedAccountFingerprint) invalid = true;
        account = next;
      } else {
        const next = piggoCalendarStatus(data, today);
        if (!next || status && status !== next) invalid = true;
        status = next;
      }
      if (invalid || account && status) resolveReady();
    })().catch(() => { invalid = true; resolveReady(); });
    tasks.add(task); void task.finally(() => tasks.delete(task));
  };
  try {
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.setBypassServiceWorker', { bypass: true });
    // Restrict writes only in this passive same-origin tab. Verification assets
    // and foreign requests are untouched, as are all other project tabs.
    await page.route(url => url.origin === target.origin, async route => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())
        || new URL(route.request().url()).pathname === '/v1/web/calendar/attendance') await route.abort('blockedbyclient');
      else await route.fallback();
    });
    page.on('response', observe);
    timer = setTimeout(resolveReady, Math.max(100, Math.min(30_000, timeoutMs)));
    await retainedPage?.bringToFront().catch(() => {});
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const currentPath = new URL(page.url()).pathname;
    lock ||= currentPath === '/locked'; login ||= currentPath === '/login';
    if (!lock && !login) await ready;
    await Promise.allSettled([...tasks]);
    const observedAt = now();
    if (lock) return unavailable('piggo_idle_locked');
    if (login) return unavailable('piggo_login_required');
    if (invalid || !account || !status || page.url() !== url || piggoBusinessDate(observedAt) !== today) {
      return unavailable('piggo_calendar_unconfirmed');
    }
    const observation = { accountFingerprint: account, businessDate: today,
      passiveObservedAt: observedAt.toISOString(), passiveDocumentStartedAt: await page.evaluate(() => performance.timeOrigin),
      passiveReader: 'piggo_calendar', submissionAttempted: false };
    return { ...(status === 'not_signed'
      ? dailyReadinessEvidence(target, config, { source: 'status_endpoint', now: observedAt })
      : bindSuccessEvidence({ status, reason: '当前账号当日日历接口确认已签到',
        evidence: successEvidence('status_endpoint', 'piggo_calendar_signed', observedAt) }, target, config, observedAt)), ...observation };
  } catch { return unavailable('piggo_calendar_unconfirmed'); }
  finally {
    stopped = true; clearTimeout(timer); page?.off('response', observe);
    await cdp?.detach().catch(() => {});
    await page?.close().catch(() => {});
    await retainedPage?.bringToFront().catch(() => {});
  }
}
