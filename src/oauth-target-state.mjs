const surfaces = new Set([
  'target_login', 'authenticated_target', 'target_content', 'blocking_overlay',
  'challenge_visible', 'other_origin', 'loading', 'unavailable',
]);

export function sanitizeOAuthPageObservation(value) {
  return {
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
    const dismissed = await dismissOverlay(page, { origin, allowedOrigins: [origin] }, origin, config);
    Object.assign(observation, oauthTargetPageObservation(surface, dismissed));
    surface = await readSurface(page, origin, config);
    observation.targetSurface = surface.kind;
    onObservation(observation);
  }
  return observation;
}
