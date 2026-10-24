import {classifyPageText} from './detector.mjs';
import {matchesNativeCompletedControlText} from './native-checkin-action.mjs';
import {readCloudflareFrameEvidence} from './challenge-frame-state.mjs';
import {readPageSnapshot} from './page-snapshot.mjs';
import {verifyConfiguredSavedLoginSession} from './saved-login-session.mjs';
import {assertBookmarkNavigation} from './security.mjs';
import {readAfterNavigation} from './page-state-read.mjs';
import {dailyReadinessEvidence} from './checkin-evidence.mjs';
import {partitionSubmissions} from './submission-guard.mjs';
import {getConfiguredPreCheckinNavigationRule, navigateConfiguredPreCheckinPage} from './pre-checkin-navigation.mjs';

const NATIVE_CHALLENGE_SELECTOR = 'iframe[src*="captcha" i], iframe[src*="turnstile" i], iframe[src*="challenge" i], .cf-turnstile, .h-captcha, .g-recaptcha, cap-widget, altcha-widget';

export async function resumeNativeDailyCycle(scope, current, expectedOrigin, config = {}) {
  if (!current?.dailyReadiness || current.state?.status !== 'ready') return false;
  const pending = await scope.pending();
  if (!pending.length || partitionSubmissions(pending, {origin:expectedOrigin}, config).current.length) return false;
  await scope.beginNewCycleAfterVerifiedReadiness(current.dailyReadiness);
  return true;
}

// Pending submissions forbid another action, but loading the final page can
// still take time. Read the existing page and, only for an opted-in local
// rule, its configured result page; never submit another check-in request.
export async function waitForNativeReadOnlyCompletion(page, expectedOrigin, config = {}, {
  timeoutMs = 30_000, pollMs = 1000, readState = readNativeCheckinState, now = Date.now,
  onObservation = () => {},
} = {}) {
  const startedAt = now(), deadline = startedAt + Math.max(0, Number(timeoutMs) || 0);
  const interval = Math.max(1, Number(pollMs) || 1000);
  const terminal = new Set(['signed', 'already_signed', 'login_required', 'interactive_challenge',
    'managed_challenge_timeout', 'deferred', 'error', 'not_available', 'needs_attention']);
  const target = { origin: expectedOrigin, allowedOrigins: [expectedOrigin] };
  const navigationRule = getConfiguredPreCheckinNavigationRule(target, expectedOrigin, config);
  let navigationChecked = false;
  let challengeWaitPolls = 0;
  let polls = 0, navigationOutcome = navigationRule?.readOnlyFallbackToExpectedPath === true
    ? 'waiting_for_page' : 'not_configured';
  const observe = (current, outcome) => {
    let atResultPage = false;
    try { atResultPage = new URL(page.url()).pathname === navigationRule?.expectedPath; } catch {}
    onObservation({ outcome, polls, elapsedMs: Math.max(0, now() - startedAt),
      pageLoaded: current.pageLoaded === true, authenticated: current.authenticated === true,
      siteBodyLoaded: current.siteBodyLoaded === true, atResultPage,
      navigationAttempted: navigationChecked, navigationOutcome, challengeWaitPolls,
      challengeLoading: current.challengeLoading === true,
      challengeRequiresInteraction: current.challengeRequiresInteraction === true });
  };
  do {
    const current = await readState(page, expectedOrigin, config);
    polls++;
    const waitingForChallenge = current.state.status === 'interactive_challenge'
      && current.state.failureCode === 'safeline_client_challenge'
      && current.challengeLoading === true && current.challengeRequiresInteraction !== true;
    const blocked = terminal.has(current.state.status) && !waitingForChallenge;
    if (waitingForChallenge) challengeWaitPolls++;
    const completed = ['signed', 'already_signed'].includes(current.state.status);
    const outcome = completed ? 'completed' : current.dailyReadiness ? 'daily_readiness'
      : blocked ? 'blocked' : now() >= deadline ? 'timed_out' : waitingForChallenge ? 'challenge_loading' : 'waiting';
    observe(current, outcome);
    if (blocked || current.dailyReadiness || now() >= deadline) return current;
    if (!navigationChecked && current.state.status === 'ready' && current.siteBodyLoaded
      && current.pageLoaded === true && current.authenticated === true
      && navigationRule?.readOnlyFallbackToExpectedPath === true) {
      navigationChecked = true;
      const remaining = deadline - now();
      if (remaining >= 500) {
        const navigationConfig = { ...config, checkinReadOnly: true,
          navigationTimeoutMs: Math.min(Number(config.navigationTimeoutMs) || 30_000, remaining),
          preCheckinNavigationRules: { ...config.preCheckinNavigationRules,
            [expectedOrigin]: { ...config.preCheckinNavigationRules[expectedOrigin],
              waitMs: Math.min(navigationRule.waitMs, remaining),
              afterClickWaitMs: Math.min(navigationRule.afterClickWaitMs, remaining),
            },
          },
        };
        try {
          const navigated = await navigateConfiguredPreCheckinPage(page, target, expectedOrigin, navigationConfig,
            { readOnlyLinksOnly: true });
          navigationOutcome = navigated === true ? 'reached_result' : 'not_reached';
          if (navigated === true) continue;
        } catch {
          // Preserve the last safe state and diagnostics for manual review.
          assertBookmarkNavigation(page.url(), [expectedOrigin]);
          navigationOutcome = 'failed';
        }
        observe(current, 'waiting');
      }
    }
    await page.waitForTimeout(Math.min(interval, Math.max(0, deadline - now())));
  } while (true);
}

export async function readNativeCheckinState(page,expectedOrigin,config={}, {
  readFrames=readCloudflareFrameEvidence,verifySession=verifyConfiguredSavedLoginSession,
  unsignedRule=null,
}={}) {
  return readAfterNavigation(page,async()=>{
    assertBookmarkNavigation(page.url(),[expectedOrigin]);
    const snapshot = await page.evaluate(readPageSnapshot, NATIVE_CHALLENGE_SELECTOR);
    const frames=await readFrames(page,expectedOrigin);
    const frameResolved=frames.length===1&&(frames[0].resolvedState||frames[0].responsePresent);
    const evidence=[...snapshot.challengeEvidence.map(item=>frameResolved&&item.cloudflare?{...item,responsePresent:true}:item),...frames];
    const unresolved=evidence.some(item=>item.visible&&!item.resolvedState&&!item.responsePresent);
    const resolved=evidence.some(item=>item.visible&&(item.resolvedState||item.responsePresent));
    let state=classifyPageText({url:page.url(),title:await page.title(),bodyText:snapshot.bodyText,
      hasPassword:snapshot.hasPassword,challengeSelectors:unresolved,resolvedChallengeSelectors:resolved&&!unresolved,
      confirmedCheckinControl:snapshot.controlTexts.some(matchesNativeCompletedControlText),
      confirmedDailyText:snapshot.confirmedDailyText,unsignedTextObserved:snapshot.unsignedTextObserved,
      hasTwoFactorControl:snapshot.hasTwoFactorControl,loginRequiredTextObserved:snapshot.loginRequiredTextObserved});
    const siteBodyLoaded=snapshot.bodyText.trim().length>80;
    // A stale profile screen with a sign-in button is not a valid session.
    // Only explicitly configured origins need this authoritative self check.
    if (['ready','signed','already_signed'].includes(state.status)) {
      if (!siteBodyLoaded&&Object.hasOwn(config.savedLoginSessionRules??{},expectedOrigin)) {
        state={status:'unconfirmed',reason:'原生页面仍在加载，尚未校验登录状态'};
      } else {
        const session=await verifySession(page,expectedOrigin,config);
        assertBookmarkNavigation(page.url(),[expectedOrigin]);
        if (session?.status==='invalid') state={status:'login_required',reason:'原生页面的登录会话已失效'};
        if (session?.status==='unknown') state={status:'unconfirmed',reason:'原生登录会话尚未取得权威确认'};
      }
    }
    // Only explicit current-day negative text on a loaded authenticated page
    // can release an older cycle. A ready button or absent completion cannot.
    const dailyUnsigned = state.status==='ready' && snapshot.loaded===true && snapshot.authenticated===true
      && !unresolved && unsignedRule?.dailyUnsignedTextPattern
      && new RegExp(unsignedRule.dailyUnsignedTextPattern,'iu').test(snapshot.bodyText);
    const safeLineChallenge = state.failureCode === 'safeline_client_challenge';
    return {state,siteBodyLoaded,pageLoaded:snapshot.loaded===true,authenticated:snapshot.authenticated===true,
      challengeLoading: safeLineChallenge && snapshot.safeLinePrompt === true && snapshot.safeLineControlEnabled !== true,
      challengeRequiresInteraction: safeLineChallenge && snapshot.safeLineControlEnabled === true,
      attendanceEndpoint:/\/(?:attendance|check[-_]?in|showup)(?:\.php)?(?:[/?#]|$)/i.test(page.url()),
      ...(dailyUnsigned ? {dailyReadiness:dailyReadinessEvidence({origin:expectedOrigin},config)} : {})};
  });
}
