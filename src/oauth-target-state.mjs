const surfaces = new Set([
  'target_login', 'authenticated_target', 'target_content', 'blocking_overlay',
  'challenge_visible', 'other_origin', 'loading', 'unavailable',
]);
const flowPageKinds = new Set(['target_login', 'target_callback', 'target_page',
  'provider_login', 'provider_home', 'provider_sso', 'provider_authorization', 'provider_approval',
  'provider_other', 'other_https', 'non_https', 'unavailable']);

// Classify URLs in memory. Only these fixed categories may leave the browser
// helper; callback parameters, provider request IDs and page text stay private.
export function classifyOAuthFlowPage(page, origin, provider) {
  try {
    if (!page || page.isClosed?.()) return 'unavailable';
    const url = new URL(page.url());
    if (url.username || url.password) return 'unavailable';
    if (url.protocol !== 'https:') return 'non_https';
    if (url.origin === new URL(origin).origin) {
      if (/\/(?:log[-_]?in|sign[-_]?in)(?:\/|$)/i.test(url.pathname)) return 'target_login';
      return /\/(?:oauth(?:2)?|callback)(?:\/|$)/i.test(url.pathname) ? 'target_callback' : 'target_page';
    }
    const normalizedProvider = String(provider).toLowerCase().replace(/\s+/g, '');
    if (normalizedProvider === 'linuxdo') {
      if (url.origin === 'https://connect.linux.do') {
        if (/^\/oauth2\/authorize\/?$/i.test(url.pathname)) return 'provider_authorization';
        if (/^\/oauth2\/approve\/[a-z0-9_-]{1,256}\/?$/i.test(url.pathname)) return 'provider_approval';
        return 'provider_other';
      }
      if (url.origin === 'https://linux.do') {
        if (/^\/login(?:\/|$)/i.test(url.pathname)) return 'provider_login';
        if (/^\/session\/sso_provider\/?$/i.test(url.pathname)) return 'provider_sso';
        return url.pathname === '/' ? 'provider_home' : 'provider_other';
      }
    }
    if (normalizedProvider === 'github' && url.origin === 'https://github.com') {
      if (/^\/login\/oauth\/authorize\/?$/i.test(url.pathname)) return 'provider_authorization';
      if (/^\/(?:login|session)(?:\/|$)/i.test(url.pathname)) return 'provider_login';
      return url.pathname === '/' ? 'provider_home' : 'provider_other';
    }
    return 'other_https';
  } catch { return 'unavailable'; }
}

export function describeOAuthFlowPages(context, origin, provider, { acceptPage = () => true, currentPage } = {}) {
  try {
    return {
      flowPageKinds: [...new Set(context.pages().filter(page => !page.isClosed?.() && acceptPage(page))
        .map(page => classifyOAuthFlowPage(page, origin, provider)))].slice(0, flowPageKinds.size),
      currentPageKind: classifyOAuthFlowPage(currentPage, origin, provider),
    };
  } catch { return { flowPageKinds: [], currentPageKind: 'unavailable' }; }
}

export function sanitizeOAuthCallbackDiagnostics(value) {
  const outcomes = new Set(['session_confirmed', 'target_not_returned', 'callback_pending',
    'target_login', 'target_not_ready', 'session_unconfirmed', 'session_stabilizing']);
  if (!outcomes.has(value?.outcome)) return {};
  return { callbackDiagnostics: {
    outcome: value.outcome,
    polls: Math.max(0, Math.min(10_000, Math.round(Number(value.polls) || 0))),
    elapsedMs: Math.max(0, Math.min(600_000, Math.round(Number(value.elapsedMs) || 0))),
    ...(Number.isFinite(value.budgetMs)
      ? { budgetMs: Math.max(0, Math.min(600_000, Math.round(value.budgetMs))) } : {}),
  } };
}

export function sanitizeOAuthTimingDiagnostics(value) {
  const callback = value?.callbackWaitDiagnostics;
  const outcomes = new Set(['waiting', 'target_returned', 'target_not_returned', 'budget_exhausted']);
  return {
    ...(outcomes.has(callback?.outcome) ? { callbackWaitDiagnostics: {
      outcome: callback.outcome,
      polls: Math.max(0, Math.min(10_000, Math.round(Number(callback.polls) || 0))),
      elapsedMs: Math.max(0, Math.min(600_000, Math.round(Number(callback.elapsedMs) || 0))),
      budgetMs: Math.max(0, Math.min(600_000, Math.round(Number(callback.budgetMs) || 0))),
    } } : {}),
    ...(['flow_timeout', 'wait_timeout', 'flow_closed', 'helper_timeout', 'helper_failed'].includes(value?.terminationReason)
      ? { terminationReason: value.terminationReason } : {}),
    ...(['provider', 'callback', 'session'].includes(value?.timeoutPhase)
      ? { timeoutPhase: value.timeoutPhase } : {}),
  };
}

export function sanitizeOAuthPageObservation(value) {
  const raw = value?.noticeDismissDiagnostics;
  const noticeDismissDiagnostics = ['dismissed', 'not_observed', 'control_disabled', 'observation_failed',
    'click_failed', 'no_progress', 'transition_confirmed', 'dismissal_limit'].includes(raw?.outcome)
    ? { outcome: raw.outcome,
      clicks: Math.max(0, Math.min(5, Math.round(Number(raw.clicks) || 0))),
      transitions: Math.max(0, Math.min(5, Math.round(Number(raw.transitions) || 0))),
      elapsedMs: Math.max(0, Math.min(120_000, Math.round(Number(raw.elapsedMs) || 0))) } : null;
  return {
    ...(Array.isArray(value?.flowPageKinds) ? { flowPageKinds: [...new Set(value.flowPageKinds
      .filter(kind => flowPageKinds.has(kind)))].slice(0, flowPageKinds.size) } : {}),
    ...(flowPageKinds.has(value?.currentPageKind) ? { currentPageKind: value.currentPageKind } : {}),
    ...(noticeDismissDiagnostics ? { noticeDismissDiagnostics } : {}),
    ...(surfaces.has(value?.targetSurface) ? { targetSurface: value.targetSurface } : {}),
    ...Object.fromEntries(['noticeObserved', 'noticeDismissed', 'logoutConfirmed']
      .filter(key => typeof value?.[key] === 'boolean').map(key => [key, value[key]])),
  };
}

export function oauthTargetPageObservation(surface, noticeDismissed = false) {
  return sanitizeOAuthPageObservation({
    targetSurface: surface?.kind,
    noticeObserved: surface?.noticeVisible === true || noticeDismissed === true,
    noticeDismissed: noticeDismissed === true,
  });
}

export async function readOAuthTargetSurface(page, origin, config = {}) {
  try {
    const url = new URL(page.url());
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) {
      return { kind: 'other_origin', ready: false };
    }
    const loginPath = config.reauthCheckinRules?.[origin]?.loginUrl;
    const loginRoute = /\/(?:log[-_]?in|sign[-_]?in)(?:\/|$)/i.test(url.pathname)
      || Boolean(loginPath && new URL(loginPath).pathname === url.pathname);
    return await page.evaluate(({ loginRoute, accountSelector }) => {
      const visible = element => {
        const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const anyVisible = selector => [...document.querySelectorAll(selector)].some(visible);
      const ready = document.readyState !== 'loading';
      const noticeVisible = anyVisible('.semi-modal-wrap, [role="dialog"], [aria-modal="true"]');
      const challengeVisible = anyVisible('iframe[src*="challenge" i], iframe[src*="turnstile" i], .cf-turnstile, .h-captcha, .g-recaptcha');
      const authenticatedControl = Boolean(accountSelector && anyVisible(accountSelector));
      const passwordVisible = anyVisible('input[type="password"]');
      const passwordReady = [...document.querySelectorAll('input[type="password"]')]
        .some(element => visible(element) && !element.disabled && !element.readOnly);
      const kind = !ready ? 'loading' : noticeVisible ? 'blocking_overlay' : challengeVisible ? 'challenge_visible'
        : authenticatedControl ? 'authenticated_target' : loginRoute ? 'target_login' : 'target_content';
      return { kind, ready, noticeVisible, challengeVisible, authenticatedControl, passwordVisible, passwordReady };
    }, { loginRoute, accountSelector: config.reauthCheckinRules?.[origin]?.accountMenuSelector ?? null });
  } catch {
    return { kind: 'unavailable', ready: false };
  }
}

export async function prepareOAuthTargetPage(page, origin, config, {
  dismissOverlay, readSurface = readOAuthTargetSurface, onObservation = () => {},
} = {}) {
  let surface = await readSurface(page, origin, config);
  const observation = oauthTargetPageObservation(surface);
  onObservation(observation);
  if (surface.kind !== 'other_origin' && surface.noticeVisible === true
    && config.preCheckinDismissRules?.[origin]?.enabled !== false
    && config.preCheckinDismissRules?.[origin] && dismissOverlay) {
    const dismissed = await dismissOverlay(page, { origin, allowedOrigins: [origin] }, origin, config, {
      onObservation: diagnostics => {
        Object.assign(observation, sanitizeOAuthPageObservation({ noticeDismissDiagnostics: diagnostics }));
        onObservation(observation);
      },
    });
    Object.assign(observation, oauthTargetPageObservation(surface, dismissed));
    surface = await readSurface(page, origin, config);
    observation.targetSurface = surface.kind;
    onObservation(observation);
  }
  return observation;
}
