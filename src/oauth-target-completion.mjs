import { readOAuthTargetSurface } from './oauth-target-state.mjs';
import { verifyConfiguredSavedLoginSession } from './saved-login-session.mjs';
import { waitForOriginPage } from './oauth-transition.mjs';

export function isOAuthCallbackPath(pathname) {
  return /\/(?:oauth(?:2)?|callback)(?:\/|$)/i.test(pathname);
}

// Callback arrival and session confirmation are distinct waits. A provider
// page cannot consume a second wait labelled as target-session verification.
export async function waitForOAuthTargetReturn(context, origin, config = {}, {
  timeBudget, waitMs = 30_000, preferredPage = null, acceptPage = () => true,
  acceptCallbackPage = page => !/\/(?:log[-_]?in|sign[-_]?in)(?:\/|$)/i.test(new URL(page.url()).pathname),
  onPhase = () => {}, onCallbackPage = async () => {}, onCallbackProgress = () => {}, onProgress = () => {},
  ...sessionOptions
} = {}) {
  const callbackBudgetMs = timeBudget.remainingMs('callback') > 0
    ? timeBudget.timeoutMs('callback', waitMs) : 0;
  const callbackPage = await waitForOriginPage(context, origin, {
    timeoutMs: callbackBudgetMs, preferredPage,
    acceptPage: page => acceptPage(page) && acceptCallbackPage(page),
    ...(sessionOptions.now ? { now: sessionOptions.now } : {}),
    ...(sessionOptions.wait ? { wait: sessionOptions.wait } : {}),
    ...(sessionOptions.pollMs ? { pollMs: sessionOptions.pollMs } : {}),
    onObservation: value => onCallbackProgress({ ...value, budgetMs: callbackBudgetMs }),
  });
  if (!callbackPage) return { loggedIn: false, page: preferredPage, outcome: 'target_not_returned',
    terminationReason: 'wait_timeout', timeoutPhase: 'callback' };

  await onCallbackPage(callbackPage);
  const sessionBudgetMs = timeBudget.timeoutMs('session', waitMs);
  onPhase('session_verification');
  const completion = await waitForOAuthTargetSession(context, origin, config, {
    ...sessionOptions, timeoutMs: sessionBudgetMs, preferredPage: callbackPage, acceptPage,
    onProgress: value => onProgress({ ...value, budgetMs: sessionBudgetMs }),
  });
  return completion.loggedIn ? completion : { ...completion,
    terminationReason: completion.elapsedMs >= sessionBudgetMs ? 'wait_timeout' : 'flow_closed',
    ...(completion.elapsedMs >= sessionBudgetMs ? { timeoutPhase: 'session' } : {}),
  };
}

// A target-domain callback is still a transition. Wait for the application to
// establish its session; neither navigation nor an empty callback is proof.
export async function waitForOAuthTargetSession(context, origin, config = {}, {
  timeoutMs = 30_000, pollMs = 250, stableMs = 500, preferredPage = null,
  acceptPage = () => true, readSurface = readOAuthTargetSurface,
  verifySession = verifyConfiguredSavedLoginSession,
  hasProviderControl = async () => false, onObservation = () => {}, onProgress = () => {},
  now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const startedAt = now(), deadline = startedAt + Math.max(0, timeoutMs);
  let stablePage = null, stableUrl = null, stableSince = 0, polls = 0;
  let outcome = 'target_not_returned', observedPage = preferredPage;
  do {
    polls++;
    const livePages = context.pages().filter(page => !page.isClosed?.());
    if (!livePages.length) break;
    const pages = livePages.filter(acceptPage);
    const ordered = pages.includes(preferredPage)
      ? [preferredPage, ...pages.filter(page => page !== preferredPage).reverse()] : pages.reverse();
    let candidate = null;
    for (const page of ordered) {
      let url;
      try { url = new URL(page.url()); } catch { continue; }
      if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) continue;
      observedPage = page;
      if (isOAuthCallbackPath(url.pathname)) { outcome = 'callback_pending'; continue; }
      try {
        const surface = await readSurface(page, origin, config);
        onObservation({ targetSurface: surface.kind, noticeObserved: surface.noticeVisible === true });
        if (!surface.ready || surface.passwordVisible || surface.challengeVisible
          || ['target_login', 'loading', 'unavailable', 'other_origin'].includes(surface.kind)
          || await hasProviderControl(page)) {
          outcome = surface.kind === 'target_login' ? 'target_login' : 'target_not_ready';
          continue;
        }
        if (Object.hasOwn(config.savedLoginSessionRules ?? {}, origin)) {
          const session = await verifySession(page, origin, config);
          if (session?.status !== 'valid') { outcome = 'session_unconfirmed'; continue; }
        } else if (config.reauthCheckinRules?.[origin]?.accountMenuSelector) {
          if (!surface.authenticatedControl) { outcome = 'session_unconfirmed'; continue; }
        } else if (surface.noticeVisible) {
          outcome = 'target_not_ready'; continue;
        }
        // The renderer may navigate while the session request is in flight.
        if (page.url() !== url.href) { outcome = 'target_not_ready'; continue; }
        candidate = page;
        if (stablePage !== page || stableUrl !== url.href) {
          stablePage = page; stableUrl = url.href; stableSince = now();
        }
        if (now() - stableSince >= stableMs) {
          onProgress({ outcome: 'session_confirmed', polls, elapsedMs: now() - startedAt });
          return { loggedIn: true, page, outcome: 'session_confirmed', polls, elapsedMs: now() - startedAt };
        }
        outcome = 'session_stabilizing';
        break;
      } catch { outcome = 'target_not_ready'; }
    }
    if (!candidate) { stablePage = null; stableUrl = null; }
    onProgress({ outcome, polls, elapsedMs: now() - startedAt });
    if (now() >= deadline) break;
    await wait(Math.min(pollMs, Math.max(0, deadline - now())));
  } while (true);
  onProgress({ outcome, polls, elapsedMs: now() - startedAt });
  return { loggedIn: false, page: observedPage, outcome, polls, elapsedMs: now() - startedAt };
}
