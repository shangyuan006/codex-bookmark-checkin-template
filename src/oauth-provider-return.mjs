import { classifyOAuthFlowPage } from './oauth-target-state.mjs';
import { isConfiguredProviderAuthorizationPage, authorizeConfiguredOAuthProvider,
  describeConfiguredAuthorizationSurface } from './oauth-provider-authorization.mjs';
import { linuxDoAuthorizationRequiresLogin, recoverSavedLinuxDoLogin } from './oauth-linuxdo-login.mjs';
import { waitForLinuxDoSsoTransition } from './oauth-linuxdo-sso.mjs';
import { clickConfiguredLoginChallengeControl } from './protected-login-flow.mjs';
import { rewriteConfiguredOAuthCallbackUrl } from './oauth-callback-rewrite.mjs';

// Consent may return to LinuxDO SSO rather than to the target. Reclassify that
// page before starting the target callback wait; a URL departure is not login.
export async function continueOAuthProviderReturn(initialPage, origin, provider, config, {
  timeBudget, waitMs = 60_000, ssoOptions = {}, resumeTargetOAuth,
  onStage = () => {}, onProgress = () => {}, onAuthorizationSurface = () => {},
  authorize = authorizeConfiguredOAuthProvider, describe = describeConfiguredAuthorizationSurface,
  clickChallenge = clickConfiguredLoginChallengeControl, requiresLogin = linuxDoAuthorizationRequiresLogin,
  recoverLogin = (page, timeout) => recoverSavedLinuxDoLogin(page, timeout, {
    socialProvider: config.linuxDoLoginRecovery?.socialProvider,
  }), waitForSso = waitForLinuxDoSsoTransition,
  now = Date.now,
} = {}) {
  let page = initialPage;
  const linuxdo = /^linux[\s._/-]*do$/i.test(String(provider));
  let authorizationOutcome = null, providerAuthorizationChallengeOutcome = null;
  let providerAuthorizationChallengeClicks = 0, ssoVisits = 0, loginRecoveries = 0, restarts = 0;
  let authorizationVisits = 0, deadline = null;
  const progress = outcome => {
    const result = { authorizationOutcome, providerAuthorizationChallengeOutcome, providerAuthorizationChallengeClicks,
      ...(linuxdo ? { providerReturnDiagnostics: { outcome, ssoVisits, loginRecoveries, restarts } } : {}) };
    onProgress(result);
    return result;
  };
  const finish = (readyForCallback, outcome) => ({ page, readyForCallback, ...progress(outcome) });
  const stalled = () => {
    onStage('linuxdo_sso_stalled');
    return finish(false, 'provider_stalled');
  };
  const remaining = () => Math.max(0, Math.min(deadline - now(), timeBudget.remainingMs('provider')));

  while (!page.isClosed?.()) {
    const kind = classifyOAuthFlowPage(page, origin, provider);
    if (kind.startsWith('target_')) return finish(true, 'target_reached');
    if (rewriteConfiguredOAuthCallbackUrl(page.url(), origin, config.oauthCallbackOriginAliases)) {
      return finish(true, 'callback_alias');
    }
    if (!linuxdo && !isConfiguredProviderAuthorizationPage(page.url(), provider)) {
      return finish(true, 'not_applicable');
    }
    deadline ??= timeBudget.deadline('provider', waitMs);
    if (remaining() <= 0) return linuxdo ? stalled() : finish(false, 'provider_stalled');

    if (linuxdo && await requiresLogin(page, provider)) {
      authorizationOutcome = 'provider_login_required';
      if (loginRecoveries === 0) {
        loginRecoveries++;
        onStage('linuxdo_session');
        progress('recovering_login');
        const login = await recoverLogin(page, Math.min(30_000, remaining()));
        if (login.recovered) continue;
        if (login.outcome === 'login_challenge_pending' || login.challengeObserved && !login.outcome) {
          onStage('linuxdo_login_challenge');
          return finish(false, 'login_required');
        }
      }
      onStage('linuxdo_provider_login_required');
      return finish(false, 'login_required');
    }
    if (linuxdo && kind === 'provider_sso') {
      if (ssoVisits >= 3) return stalled();
      ssoVisits++;
      onStage('provider_transition');
      progress('resuming_sso');
      const sso = await waitForSso(page, { ...ssoOptions,
        timeoutMs: Math.min(30_000, remaining()),
        onChallengeObserved: () => onStage('linuxdo_login_challenge'),
      });
      if (!sso.transitioned) return stalled();
      await page.waitForLoadState('domcontentloaded', { timeout: Math.max(1, Math.min(5_000, remaining())) }).catch(() => {});
      continue;
    }
    if (linuxdo && kind === 'provider_home') {
      if (!resumeTargetOAuth || restarts >= 1) return stalled();
      restarts++;
      onStage('provider_transition');
      progress('resuming_target');
      page = await resumeTargetOAuth(page);
      continue;
    }
    if (isConfiguredProviderAuthorizationPage(page.url(), provider)) {
      if (++authorizationVisits > 3) return stalled();
      onStage('provider_authorization');
      providerAuthorizationChallengeOutcome ??= 'not_observed';
      let submitted = false, challengeObserved = false, surfaceReported = false;
      while (remaining() > 0 && isConfiguredProviderAuthorizationPage(page.url(), provider)) {
        if (!submitted) {
          const authorization = await authorize(page, provider);
          authorizationOutcome = authorization.outcome;
          progress('authorizing');
          if (authorization.clicked) {
            submitted = true;
            await page.waitForTimeout(Math.min(500, remaining()));
            continue;
          }
        }
        const surface = await describe(page, provider);
        if ((surface?.challengeFrameCount ?? 0) > 0) {
          challengeObserved = true;
          if (providerAuthorizationChallengeClicks === 0) providerAuthorizationChallengeOutcome = 'observed_not_clickable';
        }
        if (!surfaceReported && surface
          && (authorizationOutcome === 'authorization_not_found' || (surface.challengeFrameCount ?? 0) > 0)) {
          onAuthorizationSurface(surface);
          surfaceReported = true;
        }
        if (remaining() <= 0) break;
        if (await clickChallenge(page, new URL(page.url()).origin, config, remaining())) {
          challengeObserved = true;
          providerAuthorizationChallengeClicks++;
          providerAuthorizationChallengeOutcome = providerAuthorizationChallengeClicks === 1 ? 'clicked_once' : 'clicked_twice';
          submitted = false;
        }
        progress('authorizing');
        if (remaining() > 0) await page.waitForTimeout(Math.min(500, remaining()));
      }
      if (isConfiguredProviderAuthorizationPage(page.url(), provider)) {
        if (challengeObserved) {
          authorizationOutcome = providerAuthorizationChallengeClicks > 0 ? 'provider_challenge_unresolved' : 'provider_challenge_not_clickable';
          providerAuthorizationChallengeOutcome = providerAuthorizationChallengeClicks > 0 ? 'unresolved_after_click' : 'observed_not_clickable';
        }
        return finish(false, 'authorization_pending');
      }
      if (challengeObserved) providerAuthorizationChallengeOutcome = 'departed_unconfirmed';
      authorizationOutcome = 'authorization_departed';
      progress('authorization_departed');
      await page.waitForLoadState('domcontentloaded', { timeout: Math.max(1, Math.min(5_000, remaining())) }).catch(() => {});
      continue;
    }
    if (!linuxdo) return finish(true, 'not_applicable');
    // Give an intermediate provider route a short settling window. Never spend
    // the target callback budget polling an unchanged provider page.
    const previousKind = kind, settleUntil = now() + Math.min(5_000, remaining());
    while (now() < settleUntil && !page.isClosed?.()
      && classifyOAuthFlowPage(page, origin, provider) === previousKind) {
      await page.waitForTimeout(Math.min(250, settleUntil - now()));
    }
    if (classifyOAuthFlowPage(page, origin, provider) === previousKind) return stalled();
  }
  return finish(false, 'flow_closed');
}
