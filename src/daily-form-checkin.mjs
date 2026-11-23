import { classifyPageText } from './detector.mjs';
import { assertBookmarkNavigation, safeLogUrl } from './security.mjs';
import { bindSuccessEvidence, stopAtConfiguredTerminal } from './checkin-evidence.mjs';
import { beforePageSubmission } from './submission-guard.mjs';
import { readAfterNavigation } from './page-state-read.mjs';
import {
  getConfiguredPreCheckinNavigationRule, navigateConfiguredPreCheckinPage,
  inspectConfiguredDailyUnsignedForm, inspectConfiguredFormCompletion, findConfiguredVerifiedFormAction,
} from './pre-checkin-navigation.mjs';

export async function isBlockedDailyFormDocument(page) {
  return await page.evaluate(() => /\bERR_BLOCKED_BY_CLIENT\b/.test(String(document.body?.innerText ?? ''))
    && (/^(?:chrome|edge)-error:$/.test(location.protocol)
      || !!document.querySelector('#main-frame-error'))).catch(() => false) === true;
}

export async function dailyFormTargetUrl(page, target, config) {
  const visibleUrl = page.url();
  try { return assertBookmarkNavigation(visibleUrl, target.allowedOrigins ?? [target.origin]); }
  catch {
    if (!/^(?:chrome|edge)-error:\/\//.test(visibleUrl) || !await isBlockedDailyFormDocument(page)) return null;
  }
  let session;
  try {
    session = await page.context().newCDPSession(page);
    const [history, info] = await Promise.all([session.send('Page.getNavigationHistory'), session.send('Target.getTargetInfo')]);
    const url = history.entries?.[history.currentIndex]?.url;
    if (!url || url !== info.targetInfo?.url) return null;
    const parsed = new URL(assertBookmarkNavigation(url, target.allowedOrigins ?? [target.origin]));
    return parsed.origin === target.origin && parsed.pathname === config.preCheckinNavigationRules?.[target.origin]?.expectedPath ? url : null;
  } catch { return null; }
  finally { await session?.detach().catch(() => {}); }
}

export async function selectBlockedDailyFormPage(pages, target, config) {
  const candidates = [];
  for (const page of pages) {
    if (/^(?:chrome|edge)-error:\/\//.test(page.url()) && await dailyFormTargetUrl(page, target, config)) candidates.push(page);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

export async function recoverBlockedDailyFormDocument(page, target, config, rule) {
  if (!await isBlockedDailyFormDocument(page)) return { blocked: false, recovered: false };
  const failed = { blocked: true, recovered: false };
  const effectiveUrl = await dailyFormTargetUrl(page, target, config);
  if (!effectiveUrl) return failed;
  const current = new URL(effectiveUrl);
  if (current.origin !== target.origin || current.pathname !== rule.expectedPath || config.checkinReadOnly === true) return failed;
  const entries = (config.nativeChallengePreflight ?? []).filter(entry => {
    try { const url = new URL(entry.url);
      return url.origin === target.origin && !url.search && !url.hash
        && (rule.terminalMissingControlPaths ?? ['/', '/index.php']).includes(url.pathname);
    } catch { return false; }
  });
  if (entries.length !== 1) return failed;
  // This is a browser error document, not a usable home page or retained
  // verification form. Recover to the configured home once; the caller then
  // follows its visible entry. Never reload the failed endpoint itself.
  await page.goto(assertBookmarkNavigation(entries[0].url, target.allowedOrigins ?? [target.origin]), {
    waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs ?? 15000,
  }).catch(() => {});
  const recovered = !await isBlockedDailyFormDocument(page) && page.url() === entries[0].url;
  return { blocked: true, recovered };
}

export async function waitForConfiguredDailyFormEvidence(page, target, origin, config) {
  const deadline = Date.now() + Math.max(0, Math.min(30000, Number(config.dailyFormReadinessWaitMs) || 5000));
  do {
    const result = await readAfterNavigation(page, async () => await inspectConfiguredFormCompletion(page, config)
      ?? await inspectConfiguredDailyUnsignedForm(page, target, origin, config));
    if (result || Date.now() >= deadline) return result;
    await page.waitForTimeout(250);
  } while (true);
}

// Keep the server-issued form and verification response on the same page.
// Read-only continuation proves readiness; it never reserves an action intent.
export async function runConfiguredDailyFormCheckin(page, target, config, {
  waitMs, terminalPath = () => null, advanceChallenge = null, retainedOnly = false,
} = {}) {
  const allowed = target.allowedOrigins ?? [target.origin];
  const effectiveUrl = await dailyFormTargetUrl(page, target, config);
  if (!effectiveUrl) return { status: 'needs_attention', failureCode: 'daily_form_document_unbound',
    reason: '当前页面无法与配置的签到目标对应，未导航或提交', retryable: false };
  const origin = new URL(effectiveUrl).origin;
  const rule = getConfiguredPreCheckinNavigationRule(target, origin, config);
  if (!rule?.dailyUnsignedForm) return null;
  const diagnostics = { observations: 0, readinessObserved: false, verificationReady: false,
    submitted: false, samePage: true, challengeProbes: 0, challengeClicks: 0, outcome: 'waiting' };
  const finish = result => ({ ...bindSuccessEvidence({ ...result,
    url: result.url ?? safeLogUrl(/^(?:chrome|edge)-error:/.test(page.url()) ? effectiveUrl : page.url()) }, target, config),
    formDiagnostics: { ...diagnostics, outcome: result.status }, actionAttempted: diagnostics.submitted });
  const terminal = path => finish(stopAtConfiguredTerminal(`${origin}${path}`, config, 'terminal_path'));
  let navigation;
  try {
    const recovery = await recoverBlockedDailyFormDocument(page, target, config, rule);
    if (recovery.blocked) {
      diagnostics.browserErrorObserved = true; diagnostics.homeRecoveryUsed = recovery.recovered;
      if (!recovery.recovered) return finish({ status: 'needs_attention', failureCode: 'daily_form_browser_request_blocked',
        reason: '浏览器请求被客户端拦截，未把错误页视为首页或签到完成', retryable: false });
    }
    if (rule.terminalPaths?.includes(new URL(page.url()).pathname)) return terminal(new URL(page.url()).pathname);
    if (retainedOnly && new URL(page.url()).pathname !== rule.expectedPath) {
      if (!(rule.terminalMissingControlPaths ?? ['/', '/index.php']).includes(new URL(page.url()).pathname)) {
        return finish({ status: 'needs_attention', failureCode: 'daily_form_page_changed',
          reason: '保留页面尚不在签到表单，未重新导航或提交', retryable: false });
      }
      // A login may return to home. Follow only its configured visible entry;
      // never reload or reconstruct an existing verification-bearing form.
      navigation = await navigateConfiguredPreCheckinPage(page, target, origin, config);
    }
    if (!retainedOnly) navigation = await navigateConfiguredPreCheckinPage(page, target, origin, config);
  }
  catch (error) {
    if (terminalPath()) return terminal(terminalPath());
    throw error;
  }
  if (navigation?.terminalPath) return terminal(navigation.terminalPath);
  if (navigation?.terminalNoAction) return finish(stopAtConfiguredTerminal(page.url(), config, 'missing_navigation_control'));
  if (navigation?.terminalUnconfirmed) return finish(navigation.terminalUnconfirmed);
  if (await isBlockedDailyFormDocument(page)) return finish({ status: 'needs_attention',
    failureCode: 'daily_form_browser_request_blocked', reason: '浏览器请求被客户端拦截，未提交签到', retryable: false });
  const requestedWait = Number(waitMs ?? config.dailyFormWaitMs ?? 30000);
  let deadline = Date.now() + Math.max(0, Math.min(120000, Number.isFinite(requestedWait) ? requestedWait : 30000));
  const retainedFormUrl = page.url();
  const retainedDocument = await page.evaluateHandle(() => document);
  const isRetainedDocument = async () => page.url() === retainedFormUrl
    && await retainedDocument.evaluate(original => original === document).catch(() => false);
  let ready = null;
  let nextChallengeAt = 0;
  let challengeStopped = false;
  try {
    do {
      if (terminalPath()) return terminal(terminalPath());
      assertBookmarkNavigation(page.url(), allowed);
      if (!await isRetainedDocument()) {
        diagnostics.samePage = false;
        return finish({ status: 'needs_attention', failureCode: 'daily_form_page_changed',
          reason: '签到表单页面已改变，未重新导航或提交', submissionAttempted: false, retryable: false });
      }
      const completion = await readAfterNavigation(page, () => inspectConfiguredFormCompletion(page, config));
      diagnostics.observations++;
      if (completion) return finish({ ...completion, submissionAttempted: diagnostics.submitted });
      ready = await readAfterNavigation(page, () => inspectConfiguredDailyUnsignedForm(page, target, origin, config));
      diagnostics.readinessObserved ||= !!ready;
      if (ready && config.checkinReadOnly) return finish(ready);
      const action = ready && await findConfiguredVerifiedFormAction(page, target, origin, config);
      if (action) {
        diagnostics.verificationReady = true;
        // Bind the actual DOM control so a rerender cannot redirect the click
        // to a new element at the same locator index after intent is reserved.
        const handle = await action.elementHandle();
        if (!handle) break;
        try {
          await handle.click({ trial: true, timeout: 5000 });
          const fresh = await findConfiguredVerifiedFormAction(page, target, origin, config);
          const current = fresh && await fresh.elementHandle();
          let same = false;
          try { same = !!current && await handle.evaluate((element, latest) => element === latest, current); }
          finally { await current?.dispose(); }
          if (!same || !await isRetainedDocument()
            || !await inspectConfiguredDailyUnsignedForm(page, target, origin, config)) break;
          await beforePageSubmission(page);
          diagnostics.submitted = true;
          await handle.click({ timeout: 10000 });
        } finally { await handle.dispose(); }
        break;
      }
      const state = await page.evaluate(() => ({ url: location.href, bodyText: String(document.body?.innerText ?? ''),
        passwordInputs: [...document.querySelectorAll('input[type=password]')].some(e => e.getBoundingClientRect().width > 0) }));
      const classified = classifyPageText(state);
      if (classified.status === 'login_required' || classified.status === 'deferred') return finish(classified);
      if (!config.checkinReadOnly && rule.dailyUnsignedForm.pendingChallenge === 'turnstile'
        && advanceChallenge && !challengeStopped && diagnostics.challengeClicks < 3
        && Date.now() < deadline && Date.now() >= nextChallengeAt) {
        // This advances only the observed widget. It cannot submit the form,
        // reload the document or treat verification as check-in completion.
        diagnostics.challengeProbes++;
        const challenge = await advanceChallenge(page, origin);
        diagnostics.challengeClicks += Number(challenge.clicked === true);
        diagnostics.challengeOutcome = challenge.outcome;
        challengeStopped = ['challenge_not_unique', 'challenge_frame_not_unique', 'challenge_click_failed',
          'challenge_verification_failed', 'challenge_obstructed'].includes(challenge.outcome);
        nextChallengeAt = Date.now() + 5000;
        continue;
      }
      if (Date.now() >= deadline) {
        // A reviewed server form can finish verification just after the primary
        // wait. Re-read that exact document without reloading or reserving intent.
        if (!retainedOnly && !diagnostics.continuationUsed && diagnostics.readinessObserved && rule.dailyUnsignedForm.continuationWaitMs > 0) {
          diagnostics.continuationUsed = true;
          diagnostics.continuationWaitMs = rule.dailyUnsignedForm.continuationWaitMs;
          deadline = Date.now() + rule.dailyUnsignedForm.continuationWaitMs;
        } else break;
      }
      await page.waitForTimeout(Math.min(500, Math.max(1, deadline - Date.now())));
    } while (true);
    if (diagnostics.submitted) {
      const completionDeadline = Date.now() + Math.max(1000, Math.min(60000, Number(config.checkinStateWaitMs) || 30000));
      do {
        if (terminalPath()) return terminal(terminalPath());
        assertBookmarkNavigation(page.url(), allowed);
        const completion = await inspectConfiguredFormCompletion(page, config).catch(() => null);
        diagnostics.observations++;
        if (completion) return finish({ ...completion, submissionAttempted: true });
        if (Date.now() >= completionDeadline) break;
        await page.waitForTimeout(500);
      } while (true);
      return finish({ status: 'needs_attention', failureCode: 'daily_form_completion_unconfirmed',
        reason: '表单已提交，但尚未取得明确完成信号', submissionAttempted: true, retryable: false });
    }
    return finish({ status: ready ? 'interactive_challenge' : 'needs_attention',
      failureCode: ready ? 'cloudflare_verification_unresolved' : 'daily_form_readiness_unconfirmed',
      reason: ready ? '同页等待后验证仍未就绪，未提交签到' : '有限等待内未取得完整的当日表单证据，未提交签到',
      manualBrowserMode: 'native', submissionAttempted: false, retryable: false });
  } finally { await retainedDocument.dispose(); }
}
