import { nativeChallengeFrameIsAllowed } from './native-checkin-action.mjs';

// Read the browser frame tree as well as the light DOM. A closed-shadow
// Turnstile frame can be absent from document.querySelectorAll('iframe').
// Return booleans only: the response value must never leave the browser.
export async function readCloudflareFrameEvidence(page, expectedOrigin) {
  if (typeof page.frames !== 'function') return [];
  const visibleFrames=[];
  for (const frame of page.frames()) {
    if (!nativeChallengeFrameIsAllowed(frame.url(),expectedOrigin)) continue;
    const element=await frame.frameElement().catch(()=>null);
    if (!element || !await element.isVisible().catch(()=>false)) continue;
    const box=await element.boundingBox().catch(()=>null);
    if (!box || box.width<=0 || box.height<=0) continue;
    const resolvedState=await frame.evaluate(()=>Boolean(document.querySelector(
      'input[type="checkbox"]:checked, [role="checkbox"][aria-checked="true"], [data-state="success"], [data-status="verified"]',
    ))).catch(()=>false);
    visibleFrames.push({visible:true,challengeLike:true,resolvedState,responsePresent:false});
  }
  if (visibleFrames.length===1) {
    visibleFrames[0].responsePresent=await page.evaluate(()=>[...document.querySelectorAll(
      'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]',
    )].some(element=>String(element.value||'').trim().length>0)).catch(()=>false);
  }
  return visibleFrames;
}
