import {classifyPageText} from './detector.mjs';
import {matchesNativeCompletedControlText} from './native-checkin-action.mjs';
import {readCloudflareFrameEvidence} from './challenge-frame-state.mjs';
import {verifyConfiguredSavedLoginSession} from './saved-login-session.mjs';
import {assertBookmarkNavigation} from './security.mjs';
import {readAfterNavigation} from './page-state-read.mjs';
import {dailyReadinessEvidence} from './checkin-evidence.mjs';
import {partitionSubmissions} from './submission-guard.mjs';
import {getConfiguredPreCheckinNavigationRule, navigateConfiguredPreCheckinPage} from './pre-checkin-navigation.mjs';

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
} = {}) {
  const deadline = now() + Math.max(0, Number(timeoutMs) || 0);
  const interval = Math.max(1, Number(pollMs) || 1000);
  const terminal = new Set(['signed', 'already_signed', 'login_required', 'interactive_challenge',
    'managed_challenge_timeout', 'deferred', 'error', 'not_available', 'needs_attention']);
  const target = { origin: expectedOrigin, allowedOrigins: [expectedOrigin] };
  const navigationRule = getConfiguredPreCheckinNavigationRule(target, expectedOrigin, config);
  let navigationChecked = false;
  do {
    const current = await readState(page, expectedOrigin, config);
    if (terminal.has(current.state.status) || current.dailyReadiness || now() >= deadline) return current;
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
        if (await navigateConfiguredPreCheckinPage(page, target, expectedOrigin, navigationConfig,
          { readOnlyLinksOnly: true }) === true) continue;
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
    const snapshot=await page.evaluate(()=>{
      const visible=element=>{
        const style=getComputedStyle(element),rect=element.getBoundingClientRect();
        return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0;
      };
      const matches=[...document.querySelectorAll('iframe[src*="captcha" i], iframe[src*="turnstile" i], iframe[src*="challenge" i], .cf-turnstile, .h-captcha, .g-recaptcha, cap-widget, altcha-widget')];
      const roots=matches.filter(element=>!matches.some(other=>other!==element&&other.contains(element)));
      const challengeEvidence=roots.map(element=>{
        const root=element.shadowRoot||element;
        const resolvedState=Boolean(root.querySelector('input[type="checkbox"]:checked, [role="checkbox"][aria-checked="true"], [data-state="success"], [data-status="verified"]'));
        const responsePresent=[...root.querySelectorAll('input[name*="response" i], textarea[name*="response" i], input[name="altcha" i]')]
          .some(input=>String(input.value||'').trim().length>0);
        let cloudflare=element.matches('.cf-turnstile');
        try { const url=new URL(element.getAttribute('src'));cloudflare||=url.protocol==='https:'&&(url.hostname==='challenges.cloudflare.com'||url.hostname.endsWith('.challenges.cloudflare.com')); } catch {}
        return {visible:visible(element),resolvedState,responsePresent,cloudflare};
      });
      return {
        bodyText:String(document.body?.innerText||'').slice(0,30000),
        loaded:document.readyState==='complete',
        authenticated:[...document.querySelectorAll('a')].some(element => visible(element)
          && /(?:^|\/)(?:log[-_]?out(?:\.php|\/|$)|exit\.php)(?:[?#]|$)/i.test(element.getAttribute('href')||'')),
        hasPassword:[...document.querySelectorAll('input[type="password"]')].some(visible),
        challengeEvidence,
        controlTexts:[...document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')].filter(visible)
          .map(element=>String(element.innerText||element.value||element.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim()),
      };
    });
    const frames=await readFrames(page,expectedOrigin);
    const frameResolved=frames.length===1&&(frames[0].resolvedState||frames[0].responsePresent);
    const evidence=[...snapshot.challengeEvidence.map(item=>frameResolved&&item.cloudflare?{...item,responsePresent:true}:item),...frames];
    const unresolved=evidence.some(item=>item.visible&&!item.resolvedState&&!item.responsePresent);
    const resolved=evidence.some(item=>item.visible&&(item.resolvedState||item.responsePresent));
    let state=classifyPageText({url:page.url(),title:await page.title(),bodyText:snapshot.bodyText,
      hasPassword:snapshot.hasPassword,challengeSelectors:unresolved,resolvedChallengeSelectors:resolved&&!unresolved,
      confirmedCheckinControl:snapshot.controlTexts.some(matchesNativeCompletedControlText)});
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
    return {state,siteBodyLoaded,pageLoaded:snapshot.loaded===true,authenticated:snapshot.authenticated===true,
      attendanceEndpoint:/\/(?:attendance|check[-_]?in|showup)(?:\.php)?(?:[/?#]|$)/i.test(page.url()),
      ...(dailyUnsigned ? {dailyReadiness:dailyReadinessEvidence({origin:expectedOrigin},config)} : {})};
  });
}
