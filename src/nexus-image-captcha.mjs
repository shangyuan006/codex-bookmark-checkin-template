import { createHash } from 'node:crypto';
import { recognizeAlphanumericCaptcha } from './captcha-ocr.mjs';
import { dailyReadinessEvidence, successEvidence } from './checkin-evidence.mjs';
import { readPtPassiveState } from './pt-passive-read.mjs';

export function isNexusCaptchaRejectedText(value) {
  return String(value ?? '').split(/[\r\n]+/).some(line => /^(?:错误[:：]?\s*)?(?:图片代码无效|圖片代碼無效|验证码无效|驗證碼無效|验证码错误|驗證碼錯誤|invalid\s+(?:image\s+)?code|captcha\s+invalid)[.!！。\s]*$/i.test(line.trim()));
}

export async function inspectNexusCaptchaForm(page) {
  return page.evaluate(() => {
    const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
    const inputs = [...document.querySelectorAll('input[name="imagestring"], input#imagestring')].filter(visible);
    const images = [...document.querySelectorAll('#showupimg, img[alt="CAPTCHA" i][src*="image.php"], img[src*="/image.php"]')].filter(visible);
    const hashes = [...document.querySelectorAll('input[type="hidden"][name="imagehash"]')];
    if (!inputs.length && !images.length && !hashes.length) return { present: false };
    const form = inputs.length === 1 ? inputs[0].form : null;
    if (!form || !form.contains(inputs[0]) || images.length !== 1 || !form.contains(images[0]) || hashes.length > 1
      || hashes.some(e => e.form !== form)) return { present: true, valid: false };
    const buttons = [...form.querySelectorAll('#showupbutton, input[type="submit"][value="立即签到"], input[type="submit"][value="立即簽到"]')].filter(visible);
    let action;
    try { action = new URL(form.action); } catch { return { present: true, valid: false }; }
    return { present: true, valid: document.readyState === 'complete' && inputs.length === 1 && buttons.length === 1
      && !inputs[0].disabled && !buttons[0].disabled && form.method.toLowerCase() === 'post'
      && action.origin === location.origin && !action.username && !action.password && !action.search && !action.hash,
      actionPath: action.pathname,
      authenticated: [...document.querySelectorAll('a[href]')].some(e => visible(e) && /(?:^|\/)logout\.php(?:[?#]|$)/i.test(e.getAttribute('href')))
        && ![...document.querySelectorAll('input[type="password"]')].some(visible) };
  });
}

async function readNexusDailyState(page, target, config) {
  if (config.ptPassiveReadRules?.[target.origin]) return readPtPassiveState(page.context(), target, config);
  if (new URL(page.url()).origin !== target.origin) return null;
  const observed = await page.evaluate(() => {
    const visible = e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
    const controls = [...document.querySelectorAll('#showup')].filter(visible);
    const authenticated = [...document.querySelectorAll('a[href]')].some(e => visible(e) && /(?:^|\/)logout\.php(?:[?#]|$)/i.test(e.getAttribute('href')))
      && ![...document.querySelectorAll('input[type="password"]')].some(visible);
    return { authenticated, loaded: document.readyState === 'complete', count: controls.length,
      signed: controls.length === 1 && /^(?:今日)?(?:已签到|已簽到|showed up)[.!！。\s]*$/i.test(controls[0].innerText.trim()) };
  });
  return observed.loaded && observed.authenticated && observed.count === 1 && observed.signed
    ? { status: 'signed', reason: '当前账号的每日签到控件确认完成', evidence: successEvidence('page_text', 'captcha_showup_confirmed') } : null;
}

// Keep the error response until classification finishes. No reload or return
// to the attendance URL follows an unknown result, even if its image vanishes.
export async function runNexusImageCaptcha(page, target, config, {
  readImage, reserve, retryRejected, retryUsed, rejectExhausted,
  recognize = recognizeAlphanumericCaptcha, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  readDaily = () => readNexusDailyState(page, target, config),
} = {}) {
  let structure = await inspectNexusCaptchaForm(page);
  if (!structure.present) return null;
  const fail = (failureCode, reason, attempted = false) => ({ status: 'interactive_challenge', failureCode,
    reason, retryable: false, submissionAttempted: attempted, submissionTracked: attempted });
  const originalUrl = page.url(), submitted = new Set(), attempts = [];
  let previousRejection = null, previousKey = null, held = null;
  const run = async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (held && !held.valid()) return fail('captcha_retry_protected', '验证码拒绝后出现额外请求，保留提交保护', true);
    structure = await inspectNexusCaptchaForm(page);
    if (page.url() !== originalUrl || !structure.valid || !structure.authenticated) {
      return { ...fail('captcha_structure_changed', '验证码必须与输入框和提交按钮处于同一完整表单，已停止提交', attempt > 0), captchaAttempts: attempts };
    }
    const input = page.locator('input[name="imagestring"]:visible, input#imagestring:visible');
    const form = input.locator('xpath=ancestor::form[1]');
    const image = form.locator('#showupimg:visible, img[alt="CAPTCHA" i][src*="image.php"]:visible, img[src*="/image.php"]:visible');
    const button = form.locator('#showupbutton:visible, input[type="submit"][value="立即签到"]:visible, input[type="submit"][value="立即簽到"]:visible');
    const hash = form.locator('input[type="hidden"][name="imagehash"]');
    if (await form.count() !== 1 || await image.count() !== 1 || await button.count() !== 1) return fail('captcha_structure_changed', '图片验证码表单结构不完整，未提交', attempt > 0);
    const pixels = await readImage(image), hashValue = await hash.count() === 1 ? await hash.inputValue() : '';
    const key = createHash('sha256').update(hashValue).update(pixels).digest('hex');
    if (submitted.has(key) || previousKey === key) return { ...fail('captcha_not_refreshed', '验证码仍是上一道题，已阻止重复提交', attempt > 0), captchaAttempts: attempts };
    const recognition = await recognize(pixels, { minLength: 6, maxLength: 6 });
    const diagnostic = { recognizedLength: String(recognition?.code ?? '').length,
      recognitionConfidence: Math.max(0, Math.min(100, Math.round(Number(recognition?.confidence) || 0))),
      requestCount: 0, responseCount: 0, rejectionCount: 0, requestFailed: false };
    attempts.push(diagnostic);
    if (!/^[A-Z0-9]{6}$/.test(recognition?.code ?? '') || !Number.isFinite(recognition.confidence) || recognition.confidence < 60) {
      return { ...fail('captcha_ocr_unconfirmed', '六位图片验证码识别未达到置信度要求，未提交', attempt > 0), captchaAttempts: attempts };
    }
    // Recheck the exact challenge after OCR, which can take several seconds.
    if (page.url() !== originalUrl || !(await inspectNexusCaptchaForm(page)).valid
      || createHash('sha256').update(await hash.count() === 1 ? await hash.inputValue() : '').update(await readImage(image)).digest('hex') !== key) {
      return { ...fail('captcha_changed_before_submit', '识别期间验证码或表单发生变化，未提交', attempt > 0), captchaAttempts: attempts };
    }
    const matches = url => url.origin === target.origin && url.pathname === structure.actionPath;
    const requests = new Set(), tasks = new Set(); let invalid = false, late = false;
    const matchRequest = r => { try { return r.method() === 'POST' && matches(new URL(r.url())); } catch { return false; } };
    const request = r => { if (matchRequest(r)) { requests.add(r); diagnostic.requestCount++; } };
    const failed = r => { if (matchRequest(r)) diagnostic.requestFailed = true; };
    const response = r => {
      if (!requests.has(r.request())) return;
      diagnostic.responseCount++; diagnostic.responseStatus = r.status();
      const task = (async () => {
        let timer;
        const body = await Promise.race([r.text(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Captcha response timeout')), 5000);
        })]).finally(() => clearTimeout(timer));
        if (body.length > 1_000_000) { invalid = true; return; }
        const text = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]*>/g, '\n').replace(/&nbsp;/g, ' ');
        if (r.status() === 200 && isNexusCaptchaRejectedText(text)) diagnostic.rejectionCount++;
      })().catch(() => { invalid = true; });
      tasks.add(task); void task.finally(() => tasks.delete(task));
    };
    const freeze = async route => {
      if (route.request().method() === 'POST') { late = true; await route.abort('blockedbyclient'); }
      else await route.fallback();
    };
    page.on('request', request); page.on('response', response); page.on('requestfailed', failed);
    let frozen = false, retained = false;
    try {
      if (previousRejection) {
        if (await retryUsed()) return { ...fail('captcha_retry_exhausted', '本周期验证码重试已用完', true), captchaAttempts: attempts };
        const passive = config.ptPassiveReadRules?.[target.origin] ? await readDaily() : null;
        const fresh = await inspectNexusCaptchaForm(page);
        if (!held?.valid() || !fresh.valid || !fresh.authenticated || passive && passive.status !== 'not_signed') return fail('captcha_retry_protected', '重试前每日状态未确认，保留提交保护', true);
        const proof = passive ?? dailyReadinessEvidence(target, config);
        if (!await retryRejected(proof, previousRejection)) return fail('captcha_retry_protected', '验证码重试未获提交保护许可', true);
        await held.dispose(); held = null;
      }
      await input.fill(recognition.code);
      await reserve();
      submitted.add(key); previousKey = key;
      await button.click({ timeout: 10_000 });
      await wait(3000);
      await Promise.allSettled([...tasks]);
      // Explicit refusal takes precedence over any old header on that page.
      const rejected = diagnostic.requestCount === 1 && diagnostic.responseCount === 1 && diagnostic.rejectionCount === 1
        && !diagnostic.requestFailed && !invalid && !tasks.size;
      if (!rejected) {
        const completed = await readDaily();
        if (['signed', 'already_signed'].includes(completed?.status)) return { ...completed, submissionAttempted: true, submissionTracked: true, captchaAttempts: attempts };
        return { ...fail('image_captcha_submission_unconfirmed', '验证码已提交，但尚无当前账号当日完成或明确拒绝的回执', true), captchaAttempts: attempts };
      }
      await page.route(matches, freeze); frozen = true;
      await wait(300);
      if (late || diagnostic.requestCount !== 1 || diagnostic.responseCount !== 1 || diagnostic.requestFailed || tasks.size) {
        return { ...fail('image_captcha_submission_unconfirmed', '验证码提交后出现额外请求，保留提交保护', true), captchaAttempts: attempts };
      }
      previousRejection = { submissionsFrozen: true, allRejected: true, requestFailed: false,
        requestCount: 1, rejectionCount: 1, verificationRejectionCount: 1, pendingResponseCount: 0 };
      if (attempt === 1) {
        await rejectExhausted(previousRejection);
        return { ...fail('captcha_retry_exhausted', '验证码重试仍被明确拒绝，停止提交', true), captchaAttempts: attempts };
      }
      held = { valid: () => !late && diagnostic.requestCount === 1 && diagnostic.responseCount === 1
        && !diagnostic.requestFailed && !tasks.size && !invalid,
        dispose: async () => {
          await page.unroute(matches, freeze);
          page.off('request', request); page.off('response', response); page.off('requestfailed', failed);
          await Promise.allSettled([...tasks]);
        } };
      retained = true;
    } finally {
      if (!retained) {
        if (frozen) await page.unroute(matches, freeze);
        page.off('request', request); page.off('response', response); page.off('requestfailed', failed);
        await Promise.allSettled([...tasks]);
      }
    }
  }
  };
  try { return await run(); } finally { await held?.dispose(); }
}
