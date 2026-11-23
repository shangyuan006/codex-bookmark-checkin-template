// Persist only counts, relative times and numeric public error codes. Never
// persist console text, frame URLs, response bodies or verification tokens.
export function watchVerificationDiagnostics(page, { now = Date.now, watchdogMs = 0 } = {}) {
  const startedAt = now(), known = new WeakSet(), codes = new Set(), events = [];
  let attached = 0, detached = 0, failed = 0, firstWidgetAt = null;
  const elapsed = () => Math.max(0, now() - startedAt);
  const isChallenge = value => {
    try { return new URL(value).hostname === 'challenges.cloudflare.com'; } catch { return false; }
  };
  const event = kind => { events.push({ kind, elapsedMs: elapsed() }); if (events.length > 24) events.shift(); };
  const frame = value => {
    if (!known.has(value) && isChallenge(value.url())) {
      known.add(value); attached++; event('frame_observed');
    }
  };
  const detach = value => { if (known.has(value)) { detached++; event('frame_detached'); } };
  const requestFailed = request => { if (isChallenge(request.url())) { failed++; event('request_failed'); } };
  const consoleMessage = message => {
    const match = /(?:turnstile|cloudflare)[\s\S]{0,80}?\b([1-9]\d{4,5})\b/i.exec(message.text());
    if (match && codes.size < 12) { codes.add(Number(match[1])); event('public_error_code'); }
  };
  page.on('frameattached', frame); page.on('framenavigated', frame); page.on('framedetached', detach);
  page.on('requestfailed', requestFailed); page.on('console', consoleMessage);
  for (const value of page.frames?.() ?? []) frame(value);
  return {
    observeReadiness(readiness) {
      if (readiness.widgetPresent && firstWidgetAt === null) { firstWidgetAt = elapsed(); event('widget_visible'); }
    },
    diagnostics: () => ({ challengeFrameCount: attached, challengeFrameDetachedCount: detached,
      challengeFrameReplacementCount: Math.min(detached, Math.max(0, attached - 1)), challengeRequestFailedCount: failed,
      publicErrorCodes: [...codes], firstWidgetAfterMs: firstWidgetAt,
      // A hint about the site's configured watchdog, not proof CF rejected it.
      siteWatchdogElapsed: watchdogMs > 0 && firstWidgetAt !== null && elapsed() - firstWidgetAt >= watchdogMs,
      events: events.map(value => ({ ...value })) }),
    stop() {
      page.off('frameattached', frame); page.off('framenavigated', frame); page.off('framedetached', detach);
      page.off('requestfailed', requestFailed); page.off('console', consoleMessage);
    },
  };
}
