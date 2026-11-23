import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { continueOAuthProviderReturn } from './oauth-provider-return.mjs';
import { waitForOAuthTargetReturn, waitForOAuthTargetSession } from './oauth-target-completion.mjs';
import { recordOAuthHandoffCompletion } from './oauth-handoff-identity.mjs';
import { createOAuthTimeBudget } from './oauth-time-budget.mjs';
import { findUniqueOAuthProviderControl } from './oauth-provider-control.mjs';
import { writeOAuthFlowDiagnostic } from './oauth-flow-diagnostics.mjs';
import { getConfiguredReauthAccounts } from './reauth-checkin.mjs';
import { acquireRunLock, releaseRunLock } from './run-lock.mjs';
import { classifyOAuthFlowPage, describeOAuthFlowPages } from './oauth-target-state.mjs';
import { recoverSavedLinuxDoLogin } from './oauth-linuxdo-login.mjs';
import { assertOAuthHandoffIdentity } from './oauth-handoff-identity.mjs';
import { atomicWriteJson } from './security.mjs';

// Continue the existing provider document only. Never create a page, recover a
// password, or spend another target OAuth-start reservation here.
export async function continueRetainedNativeOAuth(context, origin, config, {
  timeBudget = createOAuthTimeBudget(), waitMs = 30_000,
  continueProvider = continueOAuthProviderReturn, confirmTarget = waitForOAuthTargetReturn,
  confirmExistingTarget = waitForOAuthTargetSession,
  recoverLogin = recoverSavedLinuxDoLogin, reserveProviderLogin = async () => true,
} = {}) {
  const observations = currentPage => describeOAuthFlowPages(context, origin, 'LinuxDO', { currentPage });
  if (!Object.hasOwn(config.savedLoginSessionRules ?? {}, origin)
    && !config.reauthCheckinRules?.[origin]?.accountMenuSelector) {
    return { status: 'needs_attention', oauthStage: 'session_verification', continuationOutcome: 'confirmation_not_configured' };
  }
  const candidates = context.pages().filter(page => !page.isClosed?.() && [
    'target_login', 'target_callback', 'target_page', 'provider_login', 'provider_home',
    'provider_sso', 'provider_authorization', 'provider_approval',
  ].includes(classifyOAuthFlowPage(page, origin, 'LinuxDO')));
  const targetPages = candidates.filter(page => classifyOAuthFlowPage(page, origin, 'LinuxDO').startsWith('target_'));
  const providerPages = candidates.filter(page => !targetPages.includes(page));
  const staleLogin = page => {
    try {
      const url = new URL(page.url());
      const configured = new URL(config.oauthLoginUrls?.[origin] ?? `${origin}/login`);
      return url.origin === origin && url.pathname === configured.pathname;
    } catch { return false; }
  };
  // A completed popup can leave the original login tab behind. Inspect the
  // existing target session before rejecting that pair as ambiguous. This
  // only records login; today's logout/credit evidence is still checked later.
  const existingTargets = targetPages.filter(page => !staleLogin(page));
  if (providerPages.length === 0 && existingTargets.length === 1) {
    const completion = await confirmExistingTarget(context, origin, config, {
      timeoutMs: Math.min(waitMs, 5000), preferredPage: existingTargets.at(-1),
      acceptPage: candidate => existingTargets.includes(candidate),
      hasProviderControl: async candidate => Boolean(await findUniqueOAuthProviderControl(candidate, 'LinuxDO')),
    });
    if (completion.loggedIn) return { status: 'logged_in', oauthStage: 'completed', continuationOutcome: 'session_confirmed',
      ...observations(existingTargets[0]) };
  }
  // A consent popup normally coexists with its unchanged target login page.
  // An unrelated authenticated target or multiple consent pages stay ambiguous.
  const page = candidates.length === 1 ? candidates[0]
    : providerPages.length === 1 && targetPages.length === 1 && staleLogin(targetPages[0])
      && await providerPages[0].opener?.() === targetPages[0] ? providerPages[0] : null;
  if (!page) return { status: 'needs_attention', oauthStage: 'provider_authorization',
    continuationOutcome: candidates.length ? 'page_not_unique' : 'page_not_found', ...observations() };
  let oauthStage = 'provider_authorization';
  let loginRecoveryOutcome;
  const result = await continueProvider(page, origin, 'LinuxDO', config, {
    timeBudget, waitMs, onStage: stage => { oauthStage = stage; },
    recoverLogin: async (activePage, timeout) => {
      if (!['GitHub', 'Google', 'Discord', 'Apple'].includes(config.linuxDoLoginRecovery?.socialProvider)) {
        loginRecoveryOutcome = 'login_not_configured';
        return { recovered: false };
      }
      const login = await recoverLogin(activePage, timeout, {
        socialProvider: config.linuxDoLoginRecovery.socialProvider, beforeSubmit: reserveProviderLogin,
      });
      loginRecoveryOutcome = login.outcome ?? (login.recovered ? 'login_recovered'
        : login.challengeObserved ? 'login_challenge_pending' : login.submitted ? 'login_submitted' : 'login_required');
      return login;
    },
    // A checkbox requiring human action remains in this retained window.
    // This pass waits for consent readiness; it must not restart CF recovery.
    clickChallenge: async () => false,
  });
  const diagnostics = {
    authorizationOutcome: result.authorizationOutcome,
    providerAuthorizationChallengeOutcome: result.providerAuthorizationChallengeOutcome,
    providerAuthorizationChallengeClicks: result.providerAuthorizationChallengeClicks,
    ...(loginRecoveryOutcome ? { loginRecoveryOutcome } : {}),
    ...observations(page),
  };
  if (!result.readyForCallback) return { status: 'needs_attention', oauthStage, ...diagnostics, continuationOutcome: 'provider_pending' };
  const completion = await confirmTarget(context, origin, config, {
    timeBudget, waitMs, preferredPage: result.page,
    acceptPage: candidate => candidate === page,
    hasProviderControl: async candidate => Boolean(await findUniqueOAuthProviderControl(candidate, 'LinuxDO')),
    onPhase: stage => { oauthStage = stage; },
  });
  return { status: completion.loggedIn ? 'logged_in' : 'needs_attention',
    oauthStage: completion.loggedIn ? 'completed' : oauthStage, ...diagnostics,
    continuationOutcome: completion.loggedIn ? 'session_confirmed' : 'target_unconfirmed' };
}

export async function reserveRetainedProviderLogin(stateFile, scope, now = new Date()) {
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assertOAuthHandoffIdentity(state, scope);
  if (scope.launchMarker !== state.launchMarker) throw new Error('OAuth login session changed');
  if (state.providerLoginAttempt?.launchMarker === state.launchMarker) return false;
  await atomicWriteJson(stateFile, { ...state, providerLoginAttempt: {
    launchMarker: state.launchMarker, reservedAt: now.toISOString(),
  } });
  return true;
}

const source = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === source) {
  let browser, lease;
  try {
    const [portText, accountKey, ...flags] = process.argv.slice(2);
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(accountKey ?? '')
      || flags.some(flag => flag !== '--show-window')) throw new Error('Invalid continuation scope');
    const root = path.dirname(path.dirname(source));
    lease = await acquireRunLock(path.join(root, 'tmp/agentrouter-native-continuation.lock'));
    const config = JSON.parse(await fs.readFile(path.join(root, 'config/config.json'), 'utf8'));
    const state = JSON.parse(await fs.readFile(path.join(root, 'tmp/agentrouter-manual-state.json'), 'utf8'));
    const accounts = getConfiguredReauthAccounts({ origin: 'https://agentrouter.org', candidates: ['https://agentrouter.org'] }, config)
      .filter(account => account.accountKey === accountKey && account.provider === 'LinuxDO');
    if (accounts.length !== 1 || state.accountKey !== accountKey || state.stage !== 'agentrouter'
      || state.nativeDebugPort !== port
      || path.resolve(root, state.profile).toLowerCase() !== path.resolve(root, accounts[0].automationUserDataDir).toLowerCase()) throw new Error('Continuation identity mismatch');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10_000 });
    if (browser.contexts().length !== 1) throw new Error('Native context not unique');
    if (flags.includes('--show-window')) {
      const page = browser.contexts()[0].pages().filter(page => {
        try { return !page.isClosed() && [accounts[0].origin, 'https://linux.do', 'https://connect.linux.do'].includes(new URL(page.url()).origin); }
        catch { return false; }
      }).at(-1);
      if (!page) throw new Error('Retained page missing');
      const session = await page.context().newCDPSession(page);
      try {
        const { windowId } = await session.send('Browser.getWindowForTarget');
        await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
        await session.send('Browser.setWindowBounds', { windowId, bounds: { left: 60, top: 60, width: 1400, height: 900 } });
        await page.bringToFront();
      } finally { await session.detach(); }
    }
    const budget = createOAuthTimeBudget({ helperTimeoutMs: 90_000 });
    const scope = { root, accountKey, profile: accounts[0].automationUserDataDir, port, provider: 'LinuxDO', native: true,
      stage: 'manual_target_oauth', launchMarker: state.launchMarker };
    const result = await budget.run(() => continueRetainedNativeOAuth(browser.contexts()[0], accounts[0].origin, config, {
      timeBudget: budget, reserveProviderLogin: () => reserveRetainedProviderLogin(
        path.join(root, 'tmp/agentrouter-manual-state.json'), scope),
    }));
    await recordOAuthHandoffCompletion(path.join(root, 'tmp/agentrouter-manual-state.json'), {
      root, accountKey, profile: accounts[0].automationUserDataDir, port, provider: 'LinuxDO', native: true,
      stage: 'manual_target_oauth', launchMarker: state.launchMarker,
    }, result);
    await writeOAuthFlowDiagnostic({ ...result, flow: 'manual_target_oauth', provider: 'LinuxDO', elapsedMs: budget.elapsedMs() });
    console.log(JSON.stringify(result));
    if (result.status !== 'logged_in') process.exitCode = 2;
  } catch {
    console.log(JSON.stringify({ status: 'needs_attention', oauthStage: 'provider_authorization', continuationOutcome: 'inspection_failed' }));
    process.exitCode = 2;
  } finally { await browser?.close().catch(() => {}); if (lease) await releaseRunLock(lease); }
}
