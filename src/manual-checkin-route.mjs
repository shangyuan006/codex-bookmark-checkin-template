import { assertBookmarkNavigation, safeLogUrl } from './security.mjs';

function configuredRoute(target, config) {
  const raw = config.manualCheckinRouteRules?.[target.origin];
  if (!raw || raw.enabled === false) return null;
  if (raw.kind !== 'wechat_mini_program' || !Array.isArray(raw.controlTexts)
    || !raw.controlTexts.length || raw.controlTexts.length > 4
    || raw.controlTexts.some(text => typeof text !== 'string' || !text.trim() || text.length > 80)) {
    throw new Error('Manual check-in route requires a supported kind and bounded exact control texts');
  }
  const url = new URL(raw.pagePath, target.origin);
  if (typeof raw.pagePath !== 'string' || !raw.pagePath.startsWith('/') || raw.pagePath.startsWith('//')
    || url.origin !== target.origin || url.search || url.hash) throw new Error('Manual check-in route requires a same-origin page path');
  return { ...raw, pageUrl: url.href };
}

// Recognize the site's explicit external route, never its QR payload. This is
// pending human work, not a disabled feature or evidence of daily completion.
export async function inspectConfiguredManualCheckinRoute(page, target, config = {}) {
  const rule = configuredRoute(target, config);
  if (!rule) return null;
  assertBookmarkNavigation(page.url(), [target.origin]);
  if (new URL(page.url()).pathname !== new URL(rule.pageUrl).pathname) return null;
  const observed = await page.evaluate(texts => {
    const visible = e => {
      const rect = e.getBoundingClientRect(), style = getComputedStyle(e);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const controls = [...document.querySelectorAll('a,button,[role="button"]')].filter(visible);
    return { external: controls.filter(e => texts.includes(e.textContent.trim())).length,
      webAction: controls.some(e => !e.disabled && /^(?:立即签到|立刻签到|签到)$/.test(e.textContent.trim())),
      password: [...document.querySelectorAll('input[type=password]')].some(visible) };
  }, rule.controlTexts);
  if (observed.external !== 1 || observed.password || observed.webAction) return null;
  return { status: 'needs_attention', failureCode: 'external_checkin_required', retryable: false,
    reason: '网页仅提供微信小程序签到入口，需在微信内完成，尚未确认今日签到',
    manualCheckinKind: rule.kind, manualBrowserMode: 'native', url: safeLogUrl(page.url()), submissionAttempted: false };
}

export async function discoverConfiguredManualCheckinRoute(page, target, config = {}) {
  const rule = configuredRoute(target, config);
  if (!rule) return null;
  const current = await inspectConfiguredManualCheckinRoute(page, target, config);
  if (current || config.checkinObservationOnly === true || page.url() === rule.pageUrl) return current;
  // Only a reviewed local page may be visited. No control is clicked, and no
  // link to WeChat, QR contents, cookies or account data leaves this page.
  await page.goto(assertBookmarkNavigation(rule.pageUrl, [target.origin]), {
    waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs,
  });
  return inspectConfiguredManualCheckinRoute(page, target, config);
}
