import { assertBookmarkNavigation } from './security.mjs';

// Recover only explicitly reviewed slow pages, without navigating or clicking.
export async function observeNavigationTimeout(page, target, destination, config, {
  error, readState, now = Date.now, delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  const url = new URL(destination), rule = config.navigationObservationRules?.[url.origin];
  if (!rule || !Array.isArray(rule.paths) || !rule.paths.includes(url.pathname) || error?.name !== 'TimeoutError'
    || page.url() !== url.href) return null;
  assertBookmarkNavigation(page.url(), target.allowedOrigins ?? [target.origin]);
  const waitMs = Math.max(1000, Math.min(40000, Number(rule.waitMs) || 40000));
  const started = now();
  while (!page.isClosed() && now() - started < waitMs) {
    if (page.url() !== url.href) return null;
    let timer;
    try {
      const state = await Promise.race([(async () => {
        const document = await page.evaluate(() => ({ url: location.href, loaded: document.readyState === 'complete',
          startedAt: performance.timeOrigin }));
        if (!document.loaded || document.url !== url.href || !Number.isFinite(document.startedAt)) return null;
        const observed = await readState();
        return await page.evaluate(() => performance.timeOrigin) === document.startedAt ? observed : null;
      })(), new Promise(resolve => { timer = setTimeout(() => resolve(null), Math.max(1, waitMs - (now() - started))); })]);
      if (['signed', 'already_signed', 'login_required', 'interactive_challenge', 'managed_challenge', 'deferred'].includes(state?.status)
        && page.url() === url.href && now() - started < waitMs) return { ...state,
          navigationObservation: { attempted: true, outcome: 'state_observed', extraWaitMs: Math.max(0, now() - started) } };
    } catch { /* The same document can still be replacing its execution context. */ }
    finally { clearTimeout(timer); }
    await delay(Math.min(500, Math.max(0, waitMs - (now() - started))));
  }
  return { status: 'needs_attention', retryable: false, failureCode: 'navigation_observation_unconfirmed',
    reason: '页面加载超时，有限延长观察仍未确认签到状态，未刷新或提交',
    navigationObservation: { attempted: true, outcome: 'unconfirmed', extraWaitMs: Math.max(0, now() - started) } };
}
