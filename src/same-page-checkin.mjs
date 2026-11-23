import { assertBookmarkNavigation } from "./security.mjs";
import { sanitizeSequentialClickDiagnostics } from './sequential-click-diagnostics.mjs';

export function getSamePageManualRule(target, config) {
  const raw = config.samePageManualCheckinRules?.[target.origin];
  if (!raw || raw.enabled === false) return null;
  if (typeof raw.expectedPath !== "string" || !/^\/(?!\/)/.test(raw.expectedPath) || /[?#]/.test(raw.expectedPath)
    || ![raw.widgetSelector, raw.responseSelector].every(value => typeof value === "string" && value.trim() && value.length <= 300)
    || !(typeof raw.actionName === 'string' && raw.actionName.trim() && raw.actionName.length <= 300
      || typeof raw.sequentialActionType === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(raw.sequentialActionType))) {
    throw new Error("Same-page manual check-in requires an exact path and explicit controls");
  }
  return { ...raw, attentionAfterMs: Math.max(1000, Math.min(600_000, Number(raw.attentionAfterMs) || 120_000)) };
}

export function samePageManualTargetEligible(target, config) {
  const rule = getSamePageManualRule(target, config);
  return !!rule && rule.browserMode !== 'native' && (target.manualBrowserMode !== 'native' || rule.preferSamePage === true);
}

export function samePageActionLocator(page, rule) {
  return page.getByRole('button', { name: rule.actionTextPattern ? new RegExp(rule.actionTextPattern, 'u') : rule.actionName, exact: true });
}

export function samePageMaySubmit(readiness, rule = {}) {
  if (!readiness?.buttonReady) return false;
  if (rule.siteReplaysAfterChallenge === true) {
    return rule.startActionBeforeChallenge === true && readiness.widgetPresent === false;
  }
  return readiness.responseReady === true || rule.allowSubmitWithoutChallenge === true
    && readiness.challengeAbsentReady === true && readiness.widgetPresent === false && readiness.responseFieldPresent === false;
}

export function createSamePageReadinessReader(page, target, rule, { readReady = readSamePageReadiness, now = Date.now } = {}) {
  let absenceSince = null, documentStartedAt = null;
  return async () => {
    const ready = await readReady(page, target, rule);
    if (rule.allowSubmitWithoutChallenge !== true) return ready;
    if (!ready.challengeAbsentCandidate || !Number.isFinite(ready.documentStartedAt)
      || documentStartedAt !== ready.documentStartedAt) {
      absenceSince = null; documentStartedAt = ready.documentStartedAt;
    }
    if (ready.challengeAbsentCandidate) absenceSince ??= now();
    const stable = absenceSince !== null && now() - absenceSince >= 2000;
    return { ...ready, challengeAbsentReady: ready.challengeAbsentCandidate === true && stable };
  };
}

export async function readSamePageLocationState(page, target, rule) {
  const url = assertBookmarkNavigation(page.url(), target.allowedOrigins ?? [target.origin]);
  if (new URL(url).origin === target.origin && new URL(url).pathname === rule.expectedPath) return null;
  const loginVisible = await page.evaluate(() => [...document.querySelectorAll('input[type="password"]')].some(element => {
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }));
  assertBookmarkNavigation(page.url(), target.allowedOrigins ?? [target.origin]);
  if (page.url() !== url) return { status: 'unconfirmed' };
  return loginVisible ? { status: 'login_required', failureCode: 'same_page_login_required', reason: '原签到标签已返回登录表单，需要恢复登录' }
    : { status: 'unconfirmed', reason: '等待原标签返回配置的签到页面' };
}

export async function readSamePageReadiness(page, target, rule) {
  const url = assertBookmarkNavigation(page.url(), target.allowedOrigins ?? [target.origin]);
  if (new URL(url).origin !== target.origin || new URL(url).pathname !== rule.expectedPath) {
    const location = await readSamePageLocationState(page, target, rule);
    return { widgetPresent: false, responseReady: false, buttonReady: false,
      pageStatus: location?.status === 'login_required' ? 'login_required' : 'unexpected_page' };
  }
  const response = await page.evaluate(({ widgetSelector, responseSelector }) => ({
    widgetElementPresent: document.querySelector(widgetSelector) !== null,
    widgetPresent: [...document.querySelectorAll(widgetSelector)].some(element => {
      const r = element.getBoundingClientRect(), s = getComputedStyle(element);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    }),
    responseReady: [...document.querySelectorAll(responseSelector)].some(element =>
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && String(element.value).trim().length > 0),
    responseFieldPresent: document.querySelector(responseSelector) !== null,
  }), rule);
  const action = samePageActionLocator(page, rule);
  const actionCount = await action.count();
  const buttonVisible = actionCount === 1 && await action.isVisible();
  const buttonEnabled = buttonVisible && await action.isEnabled();
  let absence = {};
  if (rule.allowSubmitWithoutChallenge === true && buttonEnabled && !response.widgetElementPresent
    && !response.responseReady && !response.responseFieldPresent) {
    absence = await action.evaluate((element, expectedPath) => {
      const form = element.form, visible = e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
      const challenge = document.querySelector('.cf-turnstile,.h-captcha,.g-recaptcha,[data-sitekey],'
        + 'iframe[src*=challenge],iframe[src*=captcha],iframe[src*=turnstile],'
        + 'input[name*=turnstile],textarea[name*=turnstile],input[name*=captcha],textarea[name*=captcha]');
      const script = [...document.scripts].some(e => /turnstile|hcaptcha|recaptcha|challenges\.cloudflare/i.test(e.src + e.textContent));
      return { documentStartedAt: performance.timeOrigin,
        challengeAbsentCandidate: document.readyState === 'complete' && !challenge && !script
          && ![...document.querySelectorAll('input[type=password]')].some(visible)
          && [...document.querySelectorAll('a[href]')].some(e => visible(e)
            && /(?:^|\/)logout\.php(?:[?#]|$)/i.test(e.getAttribute('href')))
          && form?.method.toLowerCase() === 'post' && new URL(form.action).origin === location.origin
          && new URL(form.action).pathname === expectedPath
          && [...form.elements].every(e => e.type === 'hidden' || e === element) };
    }, rule.expectedPath);
  }
  return { ...response, ...absence, actionCount, buttonVisible, buttonEnabled, buttonReady: buttonEnabled && page.url() === url,
    pageStatus: !buttonVisible ? 'action_not_found' : !buttonEnabled ? 'button_disabled'
      : response.widgetPresent && !response.responseReady ? 'verification_required' : 'ready' };
}

export function samePageVerificationPending(diagnostics = {}, rule = {}) {
  // Only an explicitly matched verification response can be a replay
  // handshake. An arbitrary 422/403 remains a rejection.
  return rule.siteReplaysAfterChallenge === true && diagnostics.submissionResponseConfirmed !== true
    && diagnostics.submissionVerificationRequiredCount > 0
    && diagnostics.submissionVerificationRequiredCount === diagnostics.submissionResponseCount
    && diagnostics.submissionRejectedCount === diagnostics.submissionResponseCount
    && diagnostics.submissionRequestFailed !== true;
}

export function samePageSubmissionFailure(diagnostics = {}, rule = {}) {
  if (diagnostics.submissionResponseConfirmed === true || samePageVerificationPending(diagnostics, rule)) return null;
  if (diagnostics.submissionRequestFailed === true) {
    return { failureCode: 'same_page_submission_network_failed', reason: '签到请求网络失败，尚未确认签到完成' };
  }
  const status = diagnostics.submissionResponseStatus;
  if (Number.isInteger(status) && status >= 400 && status < 500 && diagnostics.submissionResponseCount > 0) {
    return { failureCode: `same_page_http_${status}_rejected`, reason: `签到请求返回 HTTP ${status}，尚未确认签到完成` };
  }
  return null;
}

export function samePageCloseReason(signal, sessionId) {
  if (signal?.sessionId !== sessionId || signal?.command !== 'close') return 'external_close';
  return signal.reason === 'abandoned' ? 'abandoned' : 'user_requested';
}

// Fixed diagnostic codes only: browser exceptions can contain page text,
// credentials or response URLs and must not enter the session record.
export function samePageErrorCode(error, phase = 'inspection') {
  const message = String(error?.message ?? '');
  const kind = /timeout/i.test(message) ? 'timeout' : /detached|context.*destroyed/i.test(message)
    ? 'context_unavailable' : 'failed';
  return `same_page_${phase}_${kind}`;
}

// Keep the original verified document alive. Human completion can remove the
// verification response, so always look for success before waiting for readiness.
// A wait timeout reports attention; it never closes or refreshes the window.
export async function continueCheckinOnSamePage({ readState, readReady, submit, isClosed, shouldClose,
  onStage, delay, now = Date.now, attentionAfterMs = 120_000, rule = {}, initialSubmissionAttempted = false,
  readSubmissionDiagnostics = async () => ({}), recoverRejectedVerification = async () => false,
  stopReason = '用户已停止同页接管' }) {
  let attempted = initialSubmissionAttempted, waitingSince = now(), lastProgress = null, lastPublishedAt = -Infinity;
  let failureCode = null, clickOutcome = initialSubmissionAttempted ? 'existing_intent' : 'not_attempted';
  let submissionDiagnostics = {}, submissionAttempted = initialSubmissionAttempted, failureReason = null;
  let firstSubmissionFailure = null, preDispatchRetries = 0;
  const stage = async (name, readiness) => {
    submissionDiagnostics = { ...await readSubmissionDiagnostics(), clickOutcome };
    const rejection = samePageSubmissionFailure(submissionDiagnostics, rule);
    if (name !== 'completed' && rejection) {
      failureCode = rejection.failureCode; failureReason = rejection.reason; name = 'submission_rejected';
    }
    submissionAttempted = submissionDiagnostics.intentReserved === true
      || submissionDiagnostics.submissionRequestObserved === true
      || (attempted && submissionDiagnostics.intentReserved !== false);
    const progress = { stage: name, submissionAttempted, failureCode, ...(failureReason ? { reason: failureReason } : {}),
      submissionDiagnostics, ...(readiness ? { readiness } : {}),
      waitTimedOut: now() - waitingSince >= attentionAfterMs };
    const key = JSON.stringify(progress);
    if (key === lastProgress && now() - lastPublishedAt < 5000) return;
    await onStage(progress);
    lastProgress = key; lastPublishedAt = now();
  };
  const finish = result => ({ ...result, submissionAttempted, submissionDiagnostics,
    ...(firstSubmissionFailure ? { firstSubmissionFailure } : {}),
    ...(!['signed', 'already_signed'].includes(result.status) && failureCode
      ? { failureCode, ...(failureReason ? { reason: failureReason } : {}) } : {}) });
  while (!isClosed()) {
    if (await shouldClose()) return finish({ status: "unconfirmed", reason: stopReason });
    let phase = 'inspection';
    try {
      const state = await readState();
      if (["signed", "already_signed"].includes(state?.status)) {
        failureCode = null; failureReason = null;
        await stage("completed");
        return finish(state);
      }
      if (isClosed() || await shouldClose()) break;
      // Keep observing controls after an attempted click; a stale pre-click
      // readiness snapshot cannot describe the page the user is looking at.
      const readiness = { ...await readReady(), ...(['login_required', 'deferred'].includes(state?.status)
        ? { pageStatus: state.status, buttonReady: false } : {}) };
      if (attempted && await recoverRejectedVerification(readiness)) {
        attempted = false; failureCode = null; failureReason = null;
        clickOutcome = 'not_attempted'; waitingSince = now();
      }
      if (!attempted && samePageMaySubmit(readiness, rule)) {
        // Lock this invocation before calling submit, but do not claim the
        // click was dispatched. The durable intent and request are separate.
        attempted = true;
        clickOutcome = 'in_progress';
        await stage("submitting_once", readiness);
        phase = 'submission';
        const submitted = await submit();
        if (submitted === false || submitted?.clicked === false && submitted.intentReserved !== true) {
          attempted = false; clickOutcome = 'not_dispatched';
        } else {
          clickOutcome = submitted?.clicked === false ? 'existing_intent' : 'click_returned';
          waitingSince = now();
          failureCode = null; failureReason = null;
        }
        phase = 'inspection';
      }
      const timedOut = now() - waitingSince >= attentionAfterMs;
      const verificationPending = samePageVerificationPending(submissionDiagnostics, rule);
      const pageWait = { login_required: 'waiting_for_login', deferred: 'waiting_for_schedule', unexpected_page: 'waiting_for_checkin_page',
        action_not_found: 'waiting_for_checkin_button',
        button_disabled: readiness.widgetPresent ? 'waiting_for_verification' : 'waiting_for_button_enabled' }[readiness.pageStatus];
      await stage(readiness.pageStatus === 'login_required' ? 'waiting_for_login' : failureCode ? 'needs_attention' : verificationPending ? (timedOut ? 'verification_wait_timeout' : 'waiting_for_verification') : pageWait ?? (timedOut ? (attempted ? "completion_wait_timeout" : "verification_wait_timeout")
        : (attempted ? "waiting_for_completion" : "waiting_for_verification")), readiness);
    } catch (error) {
      if (isClosed()) break;
      const action = sanitizeSequentialClickDiagnostics(error?.actionDiagnostics);
      failureCode = action ? `same_page_action_${action.phase}_${action.errorKind ?? 'failed'}` : samePageErrorCode(error, phase);
      if (phase === 'submission') {
        firstSubmissionFailure ??= { failureCode, ...(action ? { action } : {}) };
        const current = await readSubmissionDiagnostics();
        // Only a known pre-dispatch failure with no durable intent can retry.
        // Zero matched network requests alone never establishes that proof.
        const retry = action?.dispatchInvoked === false && current.intentReserved === false
          && current.submissionRequestObserved !== true && preDispatchRetries < 1;
        if (retry) { attempted = false; preDispatchRetries++; }
        clickOutcome = retry ? 'not_dispatched' : 'click_failed_or_uncertain';
      }
      await stage("needs_attention");
    }
    await delay(500);
  }
  return finish({ status: "unconfirmed", reason: "同页接管窗口已关闭，尚未确认签到完成" });
}
