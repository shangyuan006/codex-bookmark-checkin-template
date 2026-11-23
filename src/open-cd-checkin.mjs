import { recognizeOpenCdCaptcha } from './captcha-ocr.mjs';
import { submitImageCaptcha } from './image-captcha-checkin.mjs';
import { dailyReadinessEvidence, successEvidence } from './checkin-evidence.mjs';

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
    const records = links.filter(e => {
      try {
        const u = new URL(e.getAttribute('href'), location.href);
        return u.origin === location.origin && u.pathname === '/plugin_sign-in.php'
          && u.search === '?cmd=show-log' && !u.hash && /^查看(?:签到记录|簽到記錄)$/.test(e.innerText.trim());
      } catch { return false; }
    });
    return { loaded: document.readyState === 'complete',
      authenticated: links.some(e => /(?:^|\/)logout\.php(?:[?#]|$)/i.test(e.getAttribute('href'))),
      login: [...document.querySelectorAll('input[type=password]')].some(visible),
      challenge: [...document.querySelectorAll('.cf-turnstile,.h-captcha,.g-recaptcha,iframe[src*=challenges]')].some(visible),
      unsigned: !!control && visible(control) && /^(?:签到|簽到|(?:验证码|驗證碼)(?:输入|輸入)?(?:错误|錯誤|不正确|不正確|校验失败|校驗失敗)(?:[，,。.!！\s]*(?:请重试|請重試|请重新输入|請重新輸入))?[。.!！\s]*)$/.test(controlText),
      signed: !!control && visible(control) && /^(?:已签到|已簽到)$/.test(controlText),
      records: records.length === 1 && !control };
  });
  if (page.url() !== url || !state.loaded || !state.authenticated || state.login || state.challenge) return null;
  if (state.signed || state.records) return { status: 'already_signed', reason: '本站签到控件或查看签到记录入口确认今日完成',
    evidence: successEvidence('page_text', 'opencd_completion_control') };
  return state.unsigned ? { status: 'not_signed' } : null;
}

export async function runOpenCdCaptcha(page, origin, config, { readImage, reserve, retryRejected,
  rejectExhausted, retryUsed, recognize = recognizeOpenCdCaptcha,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const initial = await readOpenCdState(page, origin);
  if (initial?.status === 'already_signed') return initial;
  const unavailable = () => ({ status: 'interactive_challenge', retryable: false,
    failureCode: 'image_captcha_controls_unconfirmed', reason: '图片验证码页面控件尚未确认，未提交签到' });
  if (await retryUsed()) return { status: 'interactive_challenge', retryable: false,
    failureCode: 'image_captcha_retry_exhausted', reason: '本周期图片验证码有限重试已用完，需人工处理' };
  const attempts = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const frame = page.frameLocator('iframe#i_signin');
    if (await page.locator('iframe#i_signin').count() === 0) {
      if ((await readOpenCdState(page, origin))?.status !== 'not_signed') return unavailable();
      await page.locator('#sign_in_span').click({ timeout: 5000 });
    }
    const input = frame.locator('input[name=imagestring]'), submit = frame.locator('button#ok'), image = frame.locator('img');
    await input.waitFor({ state: 'visible', timeout: 5000 });
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
        readCompletion: async ({ serverSuccess }) => {
          if (serverSuccess) {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await wait(1000);
          }
          return readOpenCdState(page, origin);
        } });
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
