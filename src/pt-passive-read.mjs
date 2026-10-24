import { bindSuccessEvidence, dailyReadinessEvidence, successEvidence } from './checkin-evidence.mjs';
import { checkinCycle } from './checkin-cycle.mjs';
import { classifyNavigationFailure } from './site-availability.mjs';
import { withRetrySchedule } from './retry-policy.mjs';

const actionPath = /attendance|check[-_]?in|showup|bakatest|claim|draw|lottery|reward|logout|sign[_-]?out/i;
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function ptPassiveReadPolicy(target, config = {}, now = new Date()) {
  const rule = config.ptPassiveReadRules?.[target.origin];
  if (rule == null) return null;
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)
    || Object.keys(rule).some(key=>!['url','selector','authenticatedSelector','signedTextPattern','unsignedTextPattern','dailyHeader','selfProfile'].includes(key))) throw new Error('Invalid private PT read rule');
  const url = new URL(rule.url ?? '/index.php', target.origin);
  let decodedPath;
  try { decodedPath = decodeURIComponent(decodeURIComponent(url.pathname)); } catch { throw new Error('Invalid passive page path'); }
  if (url.protocol !== 'https:' || url.origin !== target.origin || url.username || url.password
    || url.search || url.hash || actionPath.test(decodedPath)) throw new Error('PT reads require a reviewed same-origin passive page');
  if (rule.dailyHeader != null && typeof rule.dailyHeader !== 'boolean') throw new Error('dailyHeader must be a boolean');
  if (rule.selfProfile != null && (!rule.selfProfile || typeof rule.selfProfile !== 'object'
    || Array.isArray(rule.selfProfile) || Object.keys(rule.selfProfile).some(key=>key!=='linkSelector')
    || typeof rule.selfProfile.linkSelector !== 'string' || !rule.selfProfile.linkSelector.trim()
    || rule.selfProfile.linkSelector.length > 300)) throw new Error('Invalid private self-profile read rule');
  for (const key of ['selector', 'authenticatedSelector']) {
    if (typeof rule[key] !== 'string' || !rule[key].trim() || rule[key].length > 300) throw new Error('PT read selectors must be explicit');
  }
  for (const key of ['signedTextPattern', 'unsignedTextPattern']) {
    if (typeof rule[key] !== 'string' || !rule[key] || rule[key].length > 300
      || (!rule[key].includes('{date}') && rule.dailyHeader !== true)) throw new Error('PT signals require a dated pattern or reviewed daily header');
    // Parse before requesting anything. Patterns and selectors remain private.
    try { new RegExp(rule[key].replaceAll('{date}', '2000-01-01'), 'u'); }
    catch { throw new Error('Invalid passive daily-state pattern'); }
  }
  const cycle = checkinCycle(target.origin, config, now);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: cycle.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(cycle.startAt)).map(part => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { url: url.href, selector: rule.selector, authenticatedSelector: rule.authenticatedSelector,
    signed: new RegExp(rule.signedTextPattern.replaceAll('{date}', escapeRegex(date)), 'u'),
    unsigned: new RegExp(rule.unsignedTextPattern.replaceAll('{date}', escapeRegex(date)), 'u'), cycleId: cycle.id,
    selfProfile: rule.selfProfile ?? null };
}

// Only a unique same-origin Nexus-style self-profile link is accepted. The
// observed ID remains in memory and must match again on the profile response.
export function ptSelfProfileUrl(links, baseUrl) {
  if (!Array.isArray(links) || !links.length || links.length > 50) return null;
  const urls = new Set();
  for (const link of links) {
    try {
      if (typeof link !== 'string') return null;
      const url = new URL(link, baseUrl);
      if (url.origin !== new URL(baseUrl).origin || url.protocol !== 'https:' || url.username || url.password
        || url.pathname !== '/userdetails.php' || url.hash || [...url.searchParams.keys()].length !== 1
        || !/^\d{1,20}$/.test(url.searchParams.get('id') ?? '')) return null;
      urls.add(url.href);
    } catch { return null; }
  }
  return urls.size === 1 ? [...urls][0] : null;
}

export function classifyPtPassiveState(observation, target, config = {}, now = new Date()) {
  const policy = ptPassiveReadPolicy(target, config, now);
  if (!policy) return null;
  const unknown = { status: 'unconfirmed', reason: '被动读取未取得当前账号的一致每日状态', failureCode: 'pt_passive_unconfirmed', retryable: false };
  if (observation?.authenticated !== true || observation.sectionCount !== 1 || typeof observation.text !== 'string') return unknown;
  const text = observation.text.slice(0, 10000);
  const signed = policy.signed.test(text), unsigned = policy.unsigned.test(text);
  if (signed === unsigned) return unknown;
  if (unsigned) return dailyReadinessEvidence(target, config, { source: 'page_text', now });
  return bindSuccessEvidence({ status: 'already_signed', reason: '被动读取当前账号的每日状态确认已签到',
    evidence: successEvidence('page_text', 'pt_authenticated_daily_state', now) }, target, config, now);
}

export async function readPtPassiveState(context, target, config = {}, { now = () => new Date() } = {}) {
  const policy = ptPassiveReadPolicy(target, config, now());
  if (!policy) return null;
  const refused = code => ({ status: 'unconfirmed', reason: '严格被动核验未完成，未执行签到动作', failureCode: code, retryable: false });
  const classify = observation => {
    const observedAt = now();
    return checkinCycle(target.origin,config,observedAt).id === policy.cycleId
      ? classifyPtPassiveState(observation,target,config,observedAt) : refused('site_cycle_expired');
  };
  const read = async url => {
    if (checkinCycle(target.origin,config,now()).id !== policy.cycleId) return {result:refused('site_cycle_expired')};
    let response, view;
    try {
      // The authenticated GET stays in the existing encrypted profile's request
      // context. No cookie, storage state or token is copied to the display context.
      response = await context.request.fetch(url, { method: 'GET', maxRedirects: 0, timeout: 15000,
        failOnStatusCode: false, headers: { 'Cache-Control': 'no-cache', Accept: 'text/html' } });
      if (response.url() !== url) return {result:refused('pt_passive_redirect_blocked')};
      const status = response.status();
      if ([401, 403].includes(status)) return {result:{ status: 'login_required', reason: '被动核验页面要求恢复登录' }};
      if (status === 429) return {result:{ status: 'deferred', retryCause: 'rate_limit', reason: '被动核验触发站点限流' }};
      if (status >= 300 && status < 400) return {result:refused('pt_passive_redirect_blocked')};
      if (status !== 200) return {result:{ status: 'deferred', retryCause: 'upstream_unavailable', reason: '被动核验页面暂不可用' }};
      if (policy.selfProfile) {
        const serverTime = Date.parse(response.headers?.().date ?? '');
        if (!Number.isFinite(serverTime) || serverTime > now().getTime() + 300_000
          || checkinCycle(target.origin, config, new Date(serverTime)).id !== policy.cycleId) {
          return {result:refused('pt_passive_unconfirmed')};
        }
      }
      const html = await response.text();
      if (html.length > 2 * 1024 * 1024) return {result:refused('pt_passive_page_too_large')};
      const browser = context.browser?.();
      if (!browser?.newContext) return {result:refused('pt_passive_reader_unavailable')};
      view = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false });
      let consumed = false;
      await view.route('**/*', async route => {
        const request = route.request();
        let allowed = false;
        try { allowed = !consumed && request.method() === 'GET' && request.url() === url
          && request.resourceType() === 'document' && request.isNavigationRequest()
          && request.frame() === request.frame().page().mainFrame(); } catch { /* deny */ }
        if (!allowed) return route.abort('blockedbyclient');
        consumed = true;
        // Forward only markup and its type; Set-Cookie and redirects are omitted.
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
      });
      const page = await view.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const section = page.locator(policy.selector), auth = page.locator(policy.authenticatedSelector);
      const sectionCount = await section.count();
      const authenticated = await auth.count() === 1 && await auth.isVisible();
      if (page.url() !== url || checkinCycle(target.origin, config, now()).id !== policy.cycleId) return {result:refused('site_cycle_expired')};
      const observation = {sectionCount, authenticated, text:sectionCount === 1 ? await section.innerText({timeout:3000}) : ''};
      const selfUrl = policy.selfProfile && authenticated && sectionCount === 1
        ? ptSelfProfileUrl(await page.locator(policy.selfProfile.linkSelector).evaluateAll(elements => elements.map(element=>element.getAttribute('href'))), url)
        : null;
      return {observation,selfUrl};
    } catch (error) { return {result:withRetrySchedule(classifyNavigationFailure(error),config,now()) ?? refused('pt_passive_reader_unavailable')}; }
    finally { await view?.close().catch(() => {}); await response?.dispose().catch(() => {}); }
  };
  const initial = await read(policy.url);
  if (initial.result) return initial.result;
  const result = classify(initial.observation);
  if (result.status !== 'unconfirmed' || !policy.selfProfile || !initial.selfUrl) return result;
  const profile = await read(initial.selfUrl);
  if (profile.result) return profile.result;
  if (profile.selfUrl !== initial.selfUrl) return refused('pt_passive_unconfirmed');
  return classify(profile.observation);
}
