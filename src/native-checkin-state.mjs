import {classifyPageText} from './detector.mjs';
import {matchesNativeCompletedControlText} from './native-checkin-action.mjs';
import {readCloudflareFrameEvidence} from './challenge-frame-state.mjs';
import {verifyConfiguredSavedLoginSession} from './saved-login-session.mjs';
import {assertBookmarkNavigation} from './security.mjs';
import {readAfterNavigation} from './page-state-read.mjs';

export async function readNativeCheckinState(page,expectedOrigin,config={}, {
  readFrames=readCloudflareFrameEvidence,verifySession=verifyConfiguredSavedLoginSession,
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
    return {state,siteBodyLoaded,attendanceEndpoint:/\/(?:attendance|check[-_]?in|showup)(?:\.php)?(?:[/?#]|$)/i.test(page.url())};
  });
}
