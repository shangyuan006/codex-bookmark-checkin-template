import { recognizeOpenCdCaptcha } from './captcha-ocr.mjs';
import { submitImageCaptcha } from './image-captcha-checkin.mjs';
import { dailyReadinessEvidence, successEvidence } from './checkin-evidence.mjs';
import { classifyPageText } from './detector.mjs';

export function isOpenCdCaptchaRejection(json, status) {
  return status === 200 && ['error', 'fail', 'failed'].includes(json?.state)
    && /^(?:验证码|驗證碼)(?:输入|輸入)?(?:错误|錯誤|不正确|不正確|校验失败|校驗失敗)(?:[，,。.!！\s]*(?:请重试|請重試|请重新输入|請重新輸入))?[。.!！\s]*$/.test(String(json?.msg ?? ''));
}

// This reader is called only by the existing site's adapter. A generic link
// to check-in history on an unrelated site remains insufficient evidence.
export async function readOpenCdState(page, origin) {
  const url = page.url();
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.origin !== origin || !['/', '/index.php'].includes(parsed.pathname)) return null;
  const state = await page.evaluate(() => {
    const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
    const links = [...document.querySelectorAll('a[href]')].filter(visible);
    const control = document.querySelector('#sign_in_span');
    const controlText = String(control?.innerText ?? '').trim();
    const entries = links.filter(e => {
      if (!/^(?:签到|簽到)$/.test(e.innerText.trim())) return false;
      const href = String(e.getAttribute('href') ?? '').trim();
      if (/^(?:#|javascript:\s*(?:void\s*\(\s*0\s*\)|;)\s*;?)$/i.test(href)) return true;
      try {
        const u = new URL(href, location.href);
        return u.origin === location.origin && u.pathname === '/plugin_sign-in.php' && !u.search && !u.hash;
      } catch { return false; }
    });
    const records = links.filter(e => {
      try {
        const u = new URL(e.getAttribute('href'), location.href);
        return u.origin === location.origin && u.pathname === '/plugin_sign-in.php'
          && u.search === '?cmd=show-log' && !u.hash && /^查看(?:签到记录|簽到記錄)$/.test(e.innerText.trim());
      } catch { return false; }
    });
    return { loaded: document.readyState === 'complete', bodyText: document.body?.innerText ?? '',
      authenticated: links.some(e => {
        try { const u = new URL(e.getAttribute('href'), location.href);
          return u.origin === location.origin && u.pathname === '/logout.php';
        } catch { return false; }
      }),
      login: [...document.querySelectorAll('input[type=password]')].some(visible),
      challenge: [...document.querySelectorAll('.cf-turnstile,.h-captcha,.g-recaptcha,iframe[src*=challenges]')].some(visible),
      unsigned: !!control && visible(control) && /^(?:签到|簽到|(?:验证码|驗證碼)(?:输入|輸入)?(?:错误|錯誤|不正确|不正確|校验失败|校驗失敗)(?:[，,。.!！\s]*(?:请重试|請重試|请重新输入|請重新輸入))?[。.!！\s]*)$/.test(controlText),
      entry: entries.length === 1 && !control ? 'link' : null,
      ambiguousEntry: entries.length > 1,
      entryCount: entries.length,
      signed: !!control && visible(control) && /^(?:已签到|已簽到)$/.test(controlText),
      records: records.length === 1 && !control && entries.length === 0 };
  });
  if (page.url() !== url || !state.loaded || !state.authenticated || state.login || state.challenge) return null;
  if (state.ambiguousEntry || state.signed && state.entryCount > 0) return null;
  const completion = !state.unsigned && !state.entry
    ? classifyPageText({ url, bodyText: state.bodyText }) : null;
  if (state.signed || state.records || ['signed', 'already_signed'].includes(completion?.status)) return { status: 'already_signed', reason: '本站签到控件或页面状态确认今日完成',
    evidence: successEvidence('page_text', 'opencd_completion_control') };
  return state.unsigned || state.entry ? { status: 'not_signed', entry: state.entry ?? 'id' } : null;
}

export async function waitForOpenCdCompletion(page, origin, { serverSuccess = false,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  // Read the retained page first. Only an explicit successful response permits
  // one homepage reload; an unknown submission never repeats the POST.
  let consecutive = 0;
  for (let sample = 0; sample < 8; sample++) {
    const state = await readOpenCdState(page, origin);
    if (!serverSuccess && state?.status === 'not_signed') return null;
    if (state?.status === 'already_signed') {
      if (++consecutive === 2) return state;
    } else consecutive = 0;
    if (sample === 2 && !consecutive && serverSuccess) {
      const url = new URL(page.url());
      if (url.origin === origin && ['/', '/index.php'].includes(url.pathname)) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      }
    }
    if (sample < 7) await wait(500);
  }
  return null;
}

export async function runOpenCdCaptcha(page, origin, config, { readImage, reserve, retryRejected,
  rejectExhausted, retryUsed, recognize = recognizeOpenCdCaptcha,
  readinessTimeoutMs = 10000,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const timeout = Number.isFinite(readinessTimeoutMs)
    ? Math.max(1, Math.min(15000, readinessTimeoutMs)) : 10000;
  const readReadyHome = async () => {
    const url = page.url();
    try {
      const parsed = new URL(url);
      if (parsed.origin !== origin || !['/', '/index.php'].includes(parsed.pathname)) return null;
    } catch { return null; }
    await page.waitForLoadState('load', { timeout }).catch(() => {});
    return page.url() === url ? readOpenCdState(page, origin) : null;
  };
  const initial = await readReadyHome();
  if (initial?.status === 'already_signed') return initial;
  const unavailable = () => ({ status: 'interactive_challenge', retryable: false,
    failureCode: 'image_captcha_controls_unconfirmed', reason: '图片验证码页面控件尚未确认，未提交签到' });
  if (await retryUsed()) return { status: 'interactive_challenge', retryable: false,
    failureCode: 'image_captcha_retry_exhausted', reason: '本周期图片验证码有限重试已用完，需人工处理' };
  const attempts = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const frame = page.frameLocator('iframe#i_signin');
    if (await page.locator('iframe#i_signin').count() === 0) {
      const current = await readReadyHome();
      if (current?.status !== 'not_signed') return unavailable();
      const entry = current.entry === 'link'
        ? page.locator('a[href]:visible').filter({ hasText: /^\s*(?:签到|簽到)\s*$/ }) : page.locator('#sign_in_span');
      if (await entry.count() !== 1) return unavailable();
      await entry.click({ timeout: 5000 });
    }
    const iframe = page.locator('iframe#i_signin');
    // The entry's handler may attach the iframe asynchronously. Observe the
    // retained page without clicking again or reserving submission intent.
    try { await iframe.waitFor({ state: 'attached', timeout }); }
    catch { return unavailable(); }
    if (await iframe.count() !== 1) return unavailable();
    const frameUrl = await iframe.getAttribute('src');
    try {
      const u = new URL(frameUrl, page.url());
      if (u.origin !== origin || u.pathname !== '/plugin_sign-in.php' || u.search || u.hash) return unavailable();
    } catch { return unavailable(); }
    const input = frame.locator('input[name=imagestring]'), submit = frame.locator('button#ok'), image = frame.locator('img');
    try { await input.waitFor({ state: 'visible', timeout }); }
    catch { return unavailable(); }
    if (await input.count() !== 1 || await submit.count() !== 1 || await image.count() !== 1) return unavailable();
    const matches = u => u.origin === origin && u.pathname === '/plugin_sign-in.php';
    let actionRequests = 0;
    const track = request => {
      try { if (request.method() === 'POST' && matches(new URL(request.url()))) actionRequests++; }
      catch { /* Ignore unrelated non-HTTP requests. */ }
    };
    // Keep counting until the frozen recheck ends, including the interval
    // after the captcha helper removes its own response listeners.
    page.on('request', track);
    try {
      const result = await submitImageCaptcha(page, { image, input, submit, origin, responsePath: '/plugin_sign-in.php',
        recognize, minConfidence: 55, readImage, reserve, classifyRejection: isOpenCdCaptchaRejection, wait,
        readCompletion: ({ serverSuccess }) => waitForOpenCdCompletion(page, origin, { serverSuccess, wait }) });
      attempts.push(result.captchaDiagnostics);
      const finished = { ...result, submissionTracked: true, captchaRetryCount: attempt,
        captchaAttempts: attempts.map(value => ({ ...value })) };
      if (result.failureCode !== 'image_captcha_rejected') return finished;
      // Neither a timeout nor an unknown JSON body can retry.
      let lateRequest = false;
      const freeze = async route => {
        if (route.request().method() === 'POST') { lateRequest = true; await route.abort('blockedbyclient'); }
        else await route.fallback();
      };
      await page.route(matches, freeze);
      try {
        await wait(300);
        const unsigned = await readOpenCdState(page, origin);
        if (lateRequest || actionRequests !== 1 || unsigned?.status !== 'not_signed') return finished;
        const rejection = { ...result.captchaRejection, submissionsFrozen: true };
        if (attempt === 1) {
          await rejectExhausted(rejection);
          return { ...finished, failureCode: 'image_captcha_retry_exhausted', reason: '图片验证码重试仍被明确拒绝，需人工处理' };
        }
        const proof = dailyReadinessEvidence({ origin }, config);
        if (!await retryRejected(proof, rejection)) return finished;
      } finally { await page.unroute(matches, freeze); }
    } finally { page.off('request', track); }
  }
}
