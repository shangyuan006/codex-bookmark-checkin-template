import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBookmarkTarget } from "./bookmarks.mjs";
import { launchAutomationContext, processCandidate, dismissConfiguredPreCheckinOverlay } from "./browser.mjs";
import { prepareOAuthTargetPage, readOAuthTargetSurface, describeOAuthFlowPages } from './oauth-target-state.mjs';
import { waitForOAuthTargetSession, waitForOAuthTargetReturn } from './oauth-target-completion.mjs';
import { connectOverCdpWithRetry } from "./native-cdp.mjs";
import { selectPreferredOAuthTargetPage } from "./oauth-page-selection.mjs";
import { linuxDoProbeFailureStage, probeProviderSessionInContext } from "./oauth-provider-session.mjs";
import { writeLinuxDoProbeDiagnostic } from "./linuxdo-probe-diagnostics.mjs";
import {writeOAuthFlowDiagnostic} from './oauth-flow-diagnostics.mjs';
import { rewriteConfiguredOAuthCallbackUrl } from "./oauth-callback-rewrite.mjs";
import {
  authorizeConfiguredOAuthProvider,
  describeConfiguredAuthorizationSurface,
  isConfiguredProviderAuthorizationPage,
} from "./oauth-provider-authorization.mjs";
import { findUniqueOAuthProviderControl } from "./oauth-provider-control.mjs";
import { waitForStableOAuthProviderControl } from './oauth-provider-readiness.mjs';
import {
  waitForFirstTransition,
  waitForUsableHttpsPage,
} from "./oauth-transition.mjs";
import {
  isLinuxDoLoginPage,
  linuxDoAuthorizationRequiresLogin,
  recoverSavedLinuxDoLogin,
  shouldRetryLinuxDoLoginRecovery,
} from "./oauth-linuxdo-login.mjs";
import {
  configuredLinuxDoSsoChallengeRule,
  isLinuxDoSsoProviderPage,
  isConfiguredLinuxDoSsoFrameClick,
  waitForLinuxDoSsoTransition,
} from "./oauth-linuxdo-sso.mjs";
import { clickConfiguredLoginChallengeControl } from "./protected-login-flow.mjs";
import { verifyConfiguredSavedLoginSession } from "./saved-login-session.mjs";
import {
  isGitHubLoginUrl,
  isGitHubInteractiveVerificationUrl,
  restoreSavedGitHubLogin,
} from "./github-saved-login.mjs";
import { assertBookmarkNavigation } from "./security.mjs";
import { getConfiguredReauthAccounts, inspectConfiguredReauthRecovery } from './reauth-checkin.mjs';
import { oauthRetryBudgetBinding, updateOAuthRetryBudget } from './oauth-retry-budget.mjs';
import { createOAuthTimeBudget, OAuthTimeBudgetError } from './oauth-time-budget.mjs';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const requestedOrigin = process.argv[2];
const provider = process.argv[3] || "LinuxDO";
const loginUrlIndex = process.argv.indexOf("--login-url");
const automationProfileIndex = process.argv.indexOf("--automation-user-data-dir");
const accountIdIndex = process.argv.indexOf("--account-id");
const waitMsIndex = process.argv.indexOf("--wait-ms");
const nativeCdpPortIndex = process.argv.indexOf("--native-cdp-port");
const privateResult = process.argv.includes("--private-result");
const providerOnly = process.argv.includes("--provider-only");
const agentRouterOnly = process.argv.includes("--agent-router-only");
const providerSessionConfirmed = process.argv.includes("--provider-session-confirmed");
const checkinAfterLogin = process.argv.includes("--checkin-after-login");
const interactiveAttention = process.argv.includes("--interactive-attention");
const experimentalSsoFrameClick = process.argv.includes("--experimental-sso-frame-click");
const diagnosticStageIndex = process.argv.indexOf("--diagnostic-stage");
if (!requestedOrigin) throw new Error("用法: node src/oauth-login.mjs <origin> [provider]");
if (providerOnly && agentRouterOnly) throw new Error("--provider-only and --agent-router-only cannot be combined");
if ((providerOnly || agentRouterOnly) && !/linux\s*do/i.test(provider)) {
  throw new Error("LinuxDO-only OAuth stages require the LinuxDO provider");
}
if (agentRouterOnly && !providerSessionConfirmed) {
  throw new Error("--agent-router-only requires a fresh provider session confirmation");
}
if (experimentalSsoFrameClick && (!agentRouterOnly || !/linux\s*do/i.test(provider))) {
  throw new Error("--experimental-sso-frame-click requires LinuxDO --agent-router-only");
}
const origin = new URL(requestedOrigin).origin;
const configuredLinuxDoSsoFrameClick = isConfiguredLinuxDoSsoFrameClick(config, provider);
const allowLinuxDoSsoFrameClick = experimentalSsoFrameClick || configuredLinuxDoSsoFrameClick;
const bookmarkTarget = providerOnly
  ? null
  : (await findBookmarkTarget(config.bookmarksPath, origin, config)).target;
const nativeCdpPort = Number.parseInt(
  nativeCdpPortIndex >= 0 ? process.argv[nativeCdpPortIndex + 1] : "",
  10,
);
const useNativeCdp = Number.isInteger(nativeCdpPort) && nativeCdpPort > 0 && nativeCdpPort <= 65535;
if (nativeCdpPortIndex >= 0 && !useNativeCdp) throw new Error("Invalid native CDP port");
if (checkinAfterLogin && (!useNativeCdp
  || !(config.nativeOAuthCheckinOrigins ?? []).includes(origin)
  || !(config.newApiCheckinOrigins ?? []).includes(origin))) {
  throw new Error("Native same-session OAuth check-in is not configured for this origin");
}

const accountId = accountIdIndex >= 0 ? String(process.argv[accountIdIndex + 1] ?? "").trim() : "default";
if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(accountId)) throw new Error("Invalid account id");
const accountProfile = automationProfileIndex >= 0
  ? String(process.argv[automationProfileIndex + 1] ?? "").trim()
  : config.automationUserDataDir;
if (!accountProfile) throw new Error("Automation profile is not configured");
const runtimeConfig = {
  ...config,
  automationUserDataDir: path.resolve(rootDirectory, accountProfile),
  ...(interactiveAttention ? { backgroundWindowMode: "visible", headless: false } : {}),
};
let connectedNativeBrowser = null;

async function openOAuthContext() {
  if (!useNativeCdp) {
    const context = await launchAutomationContext(runtimeConfig);
    try { timeBudget.assertActive(); }
    catch (error) { await context.close().catch(() => {}); throw error; }
    return context;
  }
  connectedNativeBrowser = await connectOverCdpWithRetry(chromium, nativeCdpPort, {
    timeoutMs: 15_000,
    attemptTimeoutMs: 2_000,
    retryDelayMs: 500,
  });
  const contexts = connectedNativeBrowser.contexts();
  if (contexts.length !== 1) throw new Error("Native OAuth browser context is not unique");
  try { timeBudget.assertActive(); }
  catch (error) { await closeOAuthContext(contexts[0]); throw error; }
  return contexts[0];
}

async function closeOAuthContext(context) {
  if (connectedNativeBrowser) {
    await connectedNativeBrowser.close().catch(() => {});
    connectedNativeBrowser = null;
    return;
  }
  if (context) await context.close();
}

async function acquireTargetPage(context) {
  if (!useNativeCdp) return context.newPage();
  const pages = context.pages();
  const targetPage = selectPreferredOAuthTargetPage(pages, origin) ?? await context.newPage();
  for (const candidate of pages) {
    if (candidate !== targetPage && candidate.url() === "about:blank") {
      await candidate.close({ runBeforeUnload: false }).catch(() => {});
    }
  }
  return targetPage;
}

async function runConfiguredTargetCheckin(page) {
  if (!bookmarkTarget?.candidates?.length) return null;
  let lastResult = null;
  for (const candidateUrl of bookmarkTarget.candidates) {
    const result = await processCandidate(page, bookmarkTarget, candidateUrl, config, []);
    lastResult = result;
    if (["signed", "already_signed"].includes(result?.status)) return result;
    if (result?.status === "login_required") break;
  }
  return lastResult;
}

async function reuseExistingNativeTargetSession(page) {
  if (!useNativeCdp || !(Object.hasOwn(config.savedLoginSessionRules ?? {}, origin)
    || config.reauthCheckinRules?.[origin]?.accountMenuSelector)) return null;
  await navigateNativeTargetCandidate(page);
  if (!isTargetOriginPage(page) || isTargetLoginPage(page)) return null;
  if (checkinAfterLogin) {
    setOAuthStage("checkin_verification");
    const checkinResult = await runConfiguredTargetCheckin(page);
    if (["signed", "already_signed"].includes(checkinResult?.status)) {
      return { checkinStatus: checkinResult.status };
    }
    return null;
  }
  setOAuthStage("session_verification");
  if (config.reauthCheckinRules?.[origin]?.accountMenuSelector) {
    const completion = await waitForOAuthTargetSession(page.context(), origin, config, {
      timeoutMs: Math.min(5000, providerWaitMs), preferredPage: page,
      acceptPage: candidate => candidate === page,
      hasProviderControl: async candidate => Boolean(await findUniqueOAuthProviderControl(candidate, provider)),
      onObservation: observeTargetPage,
    });
    return completion.loggedIn ? { checkinStatus: null } : null;
  }
  const verifiedSession = await verifyConfiguredSavedLoginSession(page, origin, config);
  return verifiedSession?.status === "valid" ? { checkinStatus: null } : null;
}
const providerWaitMs = Math.max(
  30_000,
  Math.min(120_000, Number(waitMsIndex >= 0 ? process.argv[waitMsIndex + 1] : 20_000) || 20_000),
);
const interactiveAttentionWaitMs = 10 * 60_000;
let oauthStage = "target_login";
let authorizationOutcome = null;
let experimentalSsoChallengeOutcome = experimentalSsoFrameClick ? "not_exercised" : null;
let providerAuthorizationChallengeOutcome = null;
let providerAuthorizationChallengeClicks = 0;
const oauthFlowStartedAt = Date.now();
const timeBudget = createOAuthTimeBudget();
const oauthStageHistory = [];
let targetSurface = 'unavailable';
let noticeObserved = false;
let noticeDismissed = false;
let noticeDismissDiagnostics = null;
let callbackDiagnostics = null;
let callbackWaitDiagnostics = null;
let terminationReason = null;
let timeoutPhase = null;
let lastProgressAt = -Infinity;
let retryBudgetBinding = null;
let retryBudgetReserved = false;
let readFlowPageObservation = () => ({});

function observeTargetPage(observation) {
  targetSurface = observation.targetSurface;
  noticeObserved ||= observation.noticeObserved === true;
  noticeDismissed ||= observation.noticeDismissed === true;
  noticeDismissDiagnostics = observation.noticeDismissDiagnostics ?? noticeDismissDiagnostics;
}

async function prepareTargetPage(page) {
  return prepareOAuthTargetPage(page, origin, config, {
    dismissOverlay: dismissConfiguredPreCheckinOverlay, onObservation: observeTargetPage,
  });
}

function setOAuthStage(value) {
  timeBudget.assertActive();
  oauthStage = value;
  if (oauthStageHistory.at(-1)!==value) oauthStageHistory.push(value);
  emitOAuthProgress(true);
}

function oauthProgress() {
  return { oauthStage, stages: oauthStageHistory, elapsedMs: Date.now() - oauthFlowStartedAt,
    targetSurface, noticeObserved, noticeDismissed,
    ...(noticeDismissDiagnostics ? { noticeDismissDiagnostics } : {}),
    ...(callbackDiagnostics ? { callbackDiagnostics } : {}),
    ...(callbackWaitDiagnostics ? { callbackWaitDiagnostics } : {}),
    ...readFlowPageObservation(),
    ...(terminationReason ? { terminationReason, ...(timeoutPhase ? { timeoutPhase } : {}) } : {}),
    ...(authorizationOutcome ? { authorizationOutcome } : {}),
    ...(providerAuthorizationChallengeOutcome ? { providerAuthorizationChallengeOutcome, providerAuthorizationChallengeClicks } : {}),
  };
}

function emitOAuthProgress(force = false) {
  if (!privateResult || (!force && Date.now() - lastProgressAt < 1000)) return;
  lastProgressAt = Date.now();
  process.stderr.write(`${JSON.stringify(oauthProgress())}\n`);
}

function observeOAuthTimeout(error) {
  if (!(error instanceof OAuthTimeBudgetError)) return false;
  terminationReason = 'flow_timeout';
  timeoutPhase = error.phase;
  emitOAuthProgress(true);
  return true;
}

function observeCallbackWait(value, budgetMs) {
  callbackWaitDiagnostics = { ...value, budgetMs };
  emitOAuthProgress(value.outcome !== 'waiting');
}

function observeSessionProgress(value, budgetMs) {
  callbackDiagnostics = { outcome: value.outcome, polls: value.polls, elapsedMs: value.elapsedMs, budgetMs };
  emitOAuthProgress(value.outcome === 'session_confirmed');
}
setOAuthStage("target_login");

async function printResult(status, details = {}) {
  if (retryBudgetReserved) {
    await updateOAuthRetryBudget(retryBudgetBinding, useNativeCdp ? 'native' : 'automatic', {
      status, oauthStage, callbackWaitDiagnostics, authorizationOutcome, providerAuthorizationChallengeOutcome,
    });
    retryBudgetReserved = false;
  }
  await writeOAuthFlowDiagnostic({
    flow:diagnosticStageIndex>=0 ? process.argv[diagnosticStageIndex+1]
      : providerOnly ? 'automatic_provider' : 'automatic_target',
    provider:/linux\s*do/i.test(provider) ? 'LinuxDO' : /github/i.test(provider) ? 'GitHub' : 'other',
    status, ...oauthProgress(),
  });
  console.log(JSON.stringify({
    status,
    ...oauthProgress(),
    ...(experimentalSsoChallengeOutcome ? { experimentalSsoChallengeOutcome } : {}),
    ...details,
  }, null, privateResult ? 0 : 2));
}

function isTargetLoginPage(page) {
  try {
    const location = new URL(page.url());
    return location.origin === origin && /\/(?:log[-_]?in|sign[-_]?in)(?:[/?#]|$)/i.test(location.href);
  } catch {
    return false;
  }
}

function isTargetOriginPage(page) {
  try {
    return new URL(page.url()).origin === origin;
  } catch {
    return false;
  }
}

async function waitForInteractiveTargetSession(context) {
  timeBudget.beginInteractiveWait();
  const completion = await waitForOAuthTargetSession(context, origin, config, {
    timeoutMs: interactiveAttentionWaitMs, stableMs: 1500,
    hasProviderControl: async candidate => Boolean(await findUniqueOAuthProviderControl(candidate, provider)),
    onObservation: observeTargetPage,
    onProgress: observation => observeSessionProgress(observation, interactiveAttentionWaitMs),
  });
  callbackDiagnostics = { outcome: completion.outcome, polls: completion.polls, elapsedMs: completion.elapsedMs };
  return completion.loggedIn;
}

async function navigateNativeTargetCandidate(page) {
  if (!useNativeCdp || !isTargetLoginPage(page) || !bookmarkTarget?.candidates?.length) return;
  const allowedOrigins = bookmarkTarget.allowedOrigins ?? [origin];
  const candidateUrl = assertBookmarkNavigation(bookmarkTarget.candidates[0], allowedOrigins);
  await page.goto(candidateUrl, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
}

async function probeLinuxDoSession(context, attempts = 3) {
  const boundedAttempts = Math.max(1, Math.min(3, Number(attempts) || 1));
  const retryDelaysMs = Array.from(
    { length: boundedAttempts - 1 },
    (_, index) => Math.min(1_500 * (index + 1), 5_000, providerWaitMs),
  );
  const observations = [];
  const started = Date.now();
  let result;
  try {
    result = await probeProviderSessionInContext(
      context,
      "https://linux.do/session/current.json",
      timeBudget.timeoutMs('provider', config.navigationTimeoutMs),
      {
        retryDelaysMs,
        // The target-only context starts immediately after the provider
        // context closes. Give the renderer the same bounded warm-up window as
        // the standalone provider probe before treating a valid session as
        // indeterminate.
        pageRetryDelaysMs: retryDelaysMs,
        challengeWaitMs: Math.min(20_000, providerWaitMs),
        onObservation: (item) => observations.push(item),
      },
    );
    const failureStage = linuxDoProbeFailureStage(result);
    if (failureStage) setOAuthStage(failureStage);
    return result.status;
  } finally {
    if (origin === "https://agentrouter.org") {
      const stage = diagnosticStageIndex >= 0 ? process.argv[diagnosticStageIndex + 1]
        : providerOnly ? "automatic_provider" : agentRouterOnly ? "automatic_target" : null;
      if (stage) await writeLinuxDoProbeDiagnostic({ stage, status: result?.status ?? "unknown",
        attempts: result?.attempts ?? observations.length, elapsedMs: Date.now() - started, observations },
      { retentionDays: config.logRetentionDays });
    }
  }
}

async function runProviderOnlyFlow() {
  const providerContext = await openOAuthContext();
  try {
    const providerPage = await providerContext.newPage();
    setOAuthStage("linuxdo_session");
    const initialSession = await probeLinuxDoSession(providerContext, 3);
    if (initialSession === "valid") {
      setOAuthStage("completed");
      return true;
    }
    // Only two explicit invalid signals may open provider login. An
    // indeterminate request/page probe fails closed without showing a stale
    // or unnecessary LinuxDO window.
    if (initialSession !== "invalid") return false;
    await providerPage.goto("https://linux.do/login", {
      waitUntil: "commit",
      timeout: timeBudget.timeoutMs('provider', config.navigationTimeoutMs),
    });
    await providerPage.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    if (isLinuxDoLoginPage(providerPage)) {
      const recovery = await recoverSavedLinuxDoLogin(providerPage, timeBudget.timeoutMs('provider', providerWaitMs));
      if (recovery.challengeObserved && !recovery.recovered) {
        setOAuthStage("linuxdo_login_challenge");
      }
      if (!recovery.recovered || isLinuxDoLoginPage(providerPage)) return false;
    }
    // A restored LinuxDO page can look logged in before its session endpoint
    // is ready after a cold browser start. Let the page settle, then retry the
    // fixed endpoint without requiring a redundant interactive login.
    await providerPage.waitForTimeout(Math.min(2_500, providerWaitMs));
    const valid = await probeLinuxDoSession(providerContext) === "valid";
    if (valid) setOAuthStage("completed");
    return valid;
  } finally {
    // Do not continue to Agent Router if the provider browser context did not
    // close. A successful provider stage must leave no LinuxDO page running.
    await closeOAuthContext(providerContext);
  }
}

if (providerOnly) {
  try {
    const succeeded = await timeBudget.run(() => runProviderOnlyFlow());
    await printResult(succeeded ? "logged_in" : "needs_attention");
    if (!succeeded) process.exitCode = 2;
  } catch (error) {
    observeOAuthTimeout(error);
    await printResult("needs_attention");
    process.exitCode = 2;
  }
} else {
  if (/linux\s*do/i.test(provider)) {
    const budgetAccount = getConfiguredReauthAccounts({ origin, candidates: [origin], allowedOrigins: [origin] }, config)
      .find(account => account.accountKey === accountId);
    if (budgetAccount) {
      if (path.resolve(budgetAccount.automationUserDataDir).toLowerCase()
        !== path.resolve(runtimeConfig.automationUserDataDir).toLowerCase()) throw new Error('OAuth budget profile mismatch');
      const recovery = await inspectConfiguredReauthRecovery(budgetAccount);
      retryBudgetBinding = oauthRetryBudgetBinding(budgetAccount, recovery.previous);
      const reservation = await updateOAuthRetryBudget(retryBudgetBinding, useNativeCdp ? 'native' : 'automatic');
      if (!reservation.allowed) {
        setOAuthStage('oauth_retry_budget_exhausted');
        await printResult('needs_attention');
        process.exitCode = 2;
      } else retryBudgetReserved = retryBudgetBinding !== null;
    }
  }
  if (process.exitCode !== 2) {
  let context;
  let flowResult;
  const oauthFlowPages = new Set();
  try {
  await timeBudget.run(async () => {
  context = await openOAuthContext();
  context.on("page", (candidate) => oauthFlowPages.add(candidate));
  oauthFlow: {
  if (agentRouterOnly) {
    // The provider-only phase established the session before this context was
    // launched. Reconfirm and warm that encrypted session in this new renderer
    // before opening Agent Router, then close the probe page. This preserves
    // strict provider -> target ordering without showing a parallel window.
    setOAuthStage("linuxdo_session");
    const providerSession = await probeLinuxDoSession(context, 3);
    if (providerSession !== "valid") {
      throw new Error("LinuxDO provider session is not available in the Agent Router context");
    }
    setOAuthStage("target_login");
  }
  let page = await acquireTargetPage(context);
  oauthFlowPages.add(page);
  readFlowPageObservation = () => describeOAuthFlowPages(context, origin, provider, {
    acceptPage: candidate => oauthFlowPages.has(candidate), currentPage: page,
  });
  const reusedSession = await reuseExistingNativeTargetSession(page);
  if (reusedSession) {
    setOAuthStage("completed");
    flowResult = { status: 'logged_in', details: {
      finalOriginMatchesTarget: true,
      loginFormVisible: false,
      ...(reusedSession.checkinStatus ? { checkinStatus: reusedSession.checkinStatus } : {}),
    } };
    break oauthFlow;
  }
  const configuredLoginUrl = loginUrlIndex >= 0
    ? process.argv[loginUrlIndex + 1]
    : (config.oauthLoginUrls?.[origin] ?? `${origin}/login`);
  const loginUrl = new URL(configuredLoginUrl);
  if (loginUrl.origin !== origin || loginUrl.protocol !== "https:") throw new Error("OAuth 登录入口不属于目标站点");
  await page.goto(loginUrl.href, { waitUntil: "commit", timeout: timeBudget.timeoutMs('provider', config.navigationTimeoutMs) });
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  const providerVariants = [...new Set([provider, provider.replace(/linuxdo/i, "Linux DO")])];
  const providerLabels = providerVariants.flatMap((name) => [
    `使用 ${name} 继续`, `使用 ${name} 登录`, `使用 ${name} 登入`,
    `使用 ${name} 账号登录`, `使用 ${name} 账户登录`, `${name} 登录`,
    `Continue with ${name}`, `Sign in with ${name}`, `Log in with ${name}`,
  ]);
  const providerAltLabels = /linux\s*do/i.test(provider)
    ? ["LINUX DO", "Linux DO", "LinuxDO"]
    : [provider, `${provider}登录`, `${provider}登入`];
  async function findProviderButton(currentPage) {
    setOAuthStage("provider_button");
    const control = await waitForStableOAuthProviderControl(currentPage, {
      timeoutMs: timeBudget.timeoutMs('provider', providerWaitMs),
      assertActive: () => { timeBudget.timeoutMs('provider', 1); },
      preparePage: async () => {
        assertBookmarkNavigation(currentPage.url(), [origin]);
        const observation = await prepareTargetPage(currentPage);
        if (config.reauthCheckinRules?.[origin] && observation.targetSurface === 'authenticated_target') {
          setOAuthStage('logout_verification');
          throw new Error('Target session is still authenticated; no provider login was attempted');
        }
        const agreementCheckbox = currentPage.locator('input[type="checkbox"]:visible');
        if (await agreementCheckbox.count() === 1 && !await agreementCheckbox.isChecked()) {
          await agreementCheckbox.check({ force: true, timeout: 5000 });
        }
      },
      findControl: async () => {
        for (const label of providerLabels) {
          const candidate = currentPage.getByText(label, { exact: true });
          if (await candidate.count() === 1 && await candidate.isVisible()) return candidate;
        }
        for (const label of providerAltLabels) {
          const candidate = currentPage.locator(`img[alt="${label}"]`);
          if (await candidate.count() === 1 && await candidate.isVisible()) return candidate;
        }
        return findUniqueOAuthProviderControl(currentPage, provider);
      },
      handleChallenge: async () => {
        const challengeClicked = await clickConfiguredLoginChallengeControl(currentPage, origin, config);
        if (challengeClicked) setOAuthStage("login_challenge");
      },
    });
    if (control) return control;
    throw new Error("configured OAuth provider control was not found");
  }

  async function startProviderOAuth(currentPage) {
    const providerButton = await findProviderButton(currentPage);
    setOAuthStage("provider_transition");
    const previousUrl = currentPage.url();
    const transitionTimeout = timeBudget.timeoutMs('provider', Math.min(20_000, providerWaitMs));
    const existingPages = new Set(context.pages());
    const popupPromise = currentPage.waitForEvent("popup", { timeout: transitionTimeout })
      .then((popup) => waitForUsableHttpsPage(popup, { timeoutMs: transitionTimeout }))
      .catch(() => null);
    const contextPagePromise = context.waitForEvent("page", {
      predicate: (candidate) => !existingPages.has(candidate),
      timeout: transitionTimeout,
    })
      .then((candidate) => waitForUsableHttpsPage(candidate, { timeoutMs: transitionTimeout }))
      .catch(() => null);
    const navigationPromise = currentPage.waitForURL((url) => url.href !== previousUrl, { timeout: transitionTimeout })
      .then(() => waitForUsableHttpsPage(currentPage, { timeoutMs: transitionTimeout }))
      .catch(() => null);
    try {
      assertBookmarkNavigation(currentPage.url(), [origin]);
      timeBudget.assertActive();
      await providerButton.click({ timeout: timeBudget.timeoutMs('provider', 5_000), noWaitAfter: true });
    } finally {
      await providerButton.dispose().catch(() => {});
    }
    const destinationPage = await waitForFirstTransition([
      popupPromise,
      contextPagePromise,
      navigationPromise,
    ]);
    if (!destinationPage) throw new Error("OAuth provider navigation did not start");
    if (destinationPage !== currentPage) await currentPage.close({ runBeforeUnload: false }).catch(() => {});
    oauthFlowPages.add(destinationPage);
    await destinationPage.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    return destinationPage;
  }

  const providerHomeRecoveryAttempts = 3;
  const githubSavedLoginState = { attempted: false };
  for (let flowAttempt = 0; flowAttempt < providerHomeRecoveryAttempts; flowAttempt += 1) {
    page = await startProviderOAuth(page);
    if (/linux\s*do/i.test(provider) && isLinuxDoSsoProviderPage(page.url())) {
      const ssoChallengeRule = configuredLinuxDoSsoChallengeRule(config, provider);
      const ssoTransition = await waitForLinuxDoSsoTransition(page, {
        timeoutMs: timeBudget.timeoutMs('provider', providerWaitMs),
        onChallengeObserved: () => setOAuthStage("linuxdo_login_challenge"),
        allowFrameCoordinateFallback: allowLinuxDoSsoFrameClick,
        frameStableMs: ssoChallengeRule.frameStableMs,
        maxChallengeClicks: ssoChallengeRule.loginMaxClicks,
        challengeRetryDelayMs: ssoChallengeRule.loginRetryDelayMs,
      });
      if (experimentalSsoFrameClick) {
        experimentalSsoChallengeOutcome = ssoTransition.challengeOutcome;
      }
      if (!ssoTransition.transitioned) {
        if (ssoTransition.challengeObserved) setOAuthStage("linuxdo_login_challenge");
        throw new Error("LinuxDO SSO provider transition did not complete");
      }
      setOAuthStage("provider_transition");
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    } else {
      await page.waitForTimeout(Math.min(1_500, providerWaitMs));
    }
    if (new URL(page.url()).hostname === 'github.com' && isGitHubInteractiveVerificationUrl(page.url())) {
      setOAuthStage('github_interactive_verification');
      throw new Error('GitHub interactive verification requires manual completion');
    }
    if (isGitHubLoginUrl(page.url())) {
      setOAuthStage("provider_session");
      const recovered = await restoreSavedGitHubLogin(page, githubSavedLoginState);
      if (!recovered || isGitHubLoginUrl(page.url())) {
        setOAuthStage(githubSavedLoginState.failureStage ?? 'provider_session');
        throw new Error("GitHub saved login recovery did not complete");
      }
    }
    const providerLocation = new URL(page.url());
    if (providerLocation.hostname === "github.com"
      && !isConfiguredProviderAuthorizationPage(page.url(), provider)) {
      if (flowAttempt + 1 >= providerHomeRecoveryAttempts) {
        throw new Error("GitHub OAuth repeatedly resumed outside authorization");
      }
      setOAuthStage("provider_transition");
      await page.goto(loginUrl.href, { waitUntil: "commit", timeout: timeBudget.timeoutMs('provider', config.navigationTimeoutMs) });
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
      continue;
    }
    for (let attempt = 0; attempt < 2 && isLinuxDoLoginPage(page); attempt += 1) {
      setOAuthStage("linuxdo_session");
      const recovery = await recoverSavedLinuxDoLogin(page, timeBudget.timeoutMs('provider', providerWaitMs));
      if (recovery.challengeObserved && !recovery.recovered) {
        setOAuthStage("linuxdo_login_challenge");
      }
      if (recovery.recovered) break;
      if (!isLinuxDoLoginPage(page)) throw new Error('LinuxDO login recovery left the login page without a verified session');
      if (!shouldRetryLinuxDoLoginRecovery(recovery)) break;
      await page.waitForTimeout(Math.min(3_000, providerWaitMs));
    }
    if (isLinuxDoLoginPage(page)) throw new Error("LinuxDO session recovery did not complete");
    if (new URL(page.url()).hostname !== "linux.do") break;
    if (flowAttempt + 1 >= providerHomeRecoveryAttempts) {
      setOAuthStage("provider_transition");
      throw new Error("OAuth provider repeatedly resumed at its home page");
    }

    // A restored LinuxDO session can land on the provider home page without
    // resuming the original OAuth request. Re-enter Agent Router in the same
    // page after the navigation settles; never open a parallel provider page.
    setOAuthStage("provider_transition");
    await page.goto(loginUrl.href, { waitUntil: "commit", timeout: timeBudget.timeoutMs('provider', config.navigationTimeoutMs) });
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
  }

  const redirectOverride = config.oauthRedirectOverrides?.[origin]?.[provider];
  if (redirectOverride && new URL(page.url()).hostname === "connect.linux.do") {
    const override = new URL(redirectOverride);
    if (override.origin !== origin || override.protocol !== "https:") throw new Error("OAuth 回调覆盖地址不属于目标站点");
    const authorizeUrl = new URL(page.url());
    authorizeUrl.searchParams.set("redirect_uri", override.href);
    await page.goto(authorizeUrl.href, { waitUntil: "domcontentloaded", timeout: timeBudget.timeoutMs('provider', config.navigationTimeoutMs) });
  }

  if (isConfiguredProviderAuthorizationPage(page.url(), provider)) {
    setOAuthStage("provider_authorization");
    providerAuthorizationChallengeOutcome = "not_observed";
    providerAuthorizationChallengeClicks = 0;
    const authorizationDeadline = timeBudget.deadline('provider', providerWaitMs);
    let authorization = null;
    let authorizationSubmitted = false;
    let providerChallengeObserved = false;
    let providerChallengeClicked = false;
    let authorizationSurfaceReported = false;
    while (Date.now() < authorizationDeadline
      && isConfiguredProviderAuthorizationPage(page.url(), provider)) {
      if (!authorizationSubmitted) {
        authorization = await authorizeConfiguredOAuthProvider(page, provider);
        authorizationOutcome = authorization.outcome;
        if (authorization.clicked) {
          authorizationSubmitted = true;
          await page.waitForTimeout(500);
          continue;
        }
      }
      const authorizationSurface = await describeConfiguredAuthorizationSurface(page, provider);
      if ((authorizationSurface?.challengeFrameCount ?? 0) > 0) {
        providerChallengeObserved = true;
        if (providerAuthorizationChallengeClicks === 0) {
          providerAuthorizationChallengeOutcome = "observed_not_clickable";
        }
      }
      if (privateResult && !authorizationSurfaceReported && authorizationSurface
        && (authorization.outcome === "authorization_not_found"
          || (authorizationSurface.challengeFrameCount ?? 0) > 0)) {
        process.stderr.write(`${JSON.stringify({ oauthStage, authorizationSurface })}\n`);
        authorizationSurfaceReported = true;
      }
      const providerOrigin = new URL(page.url()).origin;
      const remaining = Math.max(1, authorizationDeadline - Date.now());
      const providerChallengeClick = await clickConfiguredLoginChallengeControl(
        page,
        providerOrigin,
        config,
        remaining,
      );
      if (providerChallengeClick) {
        providerChallengeClicked = true;
        providerChallengeObserved = true;
        providerAuthorizationChallengeClicks += 1;
        providerAuthorizationChallengeOutcome = providerAuthorizationChallengeClicks === 1
          ? "clicked_once"
          : "clicked_twice";
        authorizationSubmitted = false;
      }
      await page.waitForTimeout(500);
    }
    if (isConfiguredProviderAuthorizationPage(page.url(), provider)) {
      if (providerChallengeObserved) {
        authorizationOutcome = providerChallengeClicked
          ? "provider_challenge_unresolved"
          : "provider_challenge_not_clickable";
        providerAuthorizationChallengeOutcome = providerChallengeClicked
          ? "unresolved_after_click"
          : "observed_not_clickable";
      }
      throw new Error("configured OAuth provider authorization did not complete");
    }
    if (providerChallengeObserved) {
      providerAuthorizationChallengeOutcome = "departed_unconfirmed";
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    if (await linuxDoAuthorizationRequiresLogin(page, provider)) {
      authorizationOutcome = "provider_login_required";
      setOAuthStage("linuxdo_provider_login_required");
      throw new Error("LinuxDO authorization returned to the provider login form");
    }
    // Leaving the authorize URL is a transition, not a completed callback.
    authorizationOutcome = "authorization_departed";
  }

  setOAuthStage("target_callback");
  const rewrittenCallback = rewriteConfiguredOAuthCallbackUrl(
    page.url(),
    origin,
    config.oauthCallbackOriginAliases,
  );
  if (rewrittenCallback) {
    await page.goto(rewrittenCallback, {
      waitUntil: "domcontentloaded",
      timeout: timeBudget.timeoutMs('callback', config.navigationTimeoutMs),
    });
  }
  if (await linuxDoAuthorizationRequiresLogin(page, provider)) {
    authorizationOutcome = "provider_login_required";
    setOAuthStage("linuxdo_provider_login_required");
    throw new Error("LinuxDO callback did not proceed beyond the provider login form");
  }
  const completion = await waitForOAuthTargetReturn(context, origin, config, {
    timeBudget, waitMs: providerWaitMs, preferredPage: page,
    acceptPage: candidate => oauthFlowPages.has(candidate),
    acceptCallbackPage: candidate => !isTargetLoginPage(candidate),
    onCallbackPage: async callbackPage => {
      if (callbackPage !== page) await page.close({ runBeforeUnload: false }).catch(() => {});
      page = callbackPage;
    },
    hasProviderControl: async candidate => Boolean(await findUniqueOAuthProviderControl(candidate, provider)),
    onPhase: setOAuthStage,
    onCallbackProgress: observation => observeCallbackWait(observation, observation.budgetMs),
    onObservation: observeTargetPage,
    onProgress: observation => observeSessionProgress(observation, observation.budgetMs),
  });
  page = completion.page ?? page;
  if (!completion.loggedIn && await linuxDoAuthorizationRequiresLogin(page, provider)) {
    authorizationOutcome = 'provider_login_required';
    setOAuthStage('linuxdo_provider_login_required');
    throw new Error('LinuxDO callback returned to the provider login form');
  }
  let loggedIn = completion.loggedIn;
  if (!loggedIn) {
    terminationReason = completion.terminationReason;
    timeoutPhase = completion.timeoutPhase ?? null;
    emitOAuthProgress(true);
  }
  let checkinStatus = null;
  if (loggedIn && checkinAfterLogin) {
    setOAuthStage("checkin_verification");
    const checkinResult = await runConfiguredTargetCheckin(page);
    if (["signed", "already_signed"].includes(checkinResult?.status)) {
      checkinStatus = checkinResult.status;
    } else if (checkinResult?.status === "login_required") {
      loggedIn = false;
    }
  }
  if (!loggedIn && interactiveAttention) {
    loggedIn = await waitForInteractiveTargetSession(context);
  }
  if (loggedIn) {
    terminationReason = timeoutPhase = null;
    if (authorizationOutcome === "authorization_departed") authorizationOutcome = "authorization_completed";
    if (providerAuthorizationChallengeOutcome === 'departed_unconfirmed') {
      providerAuthorizationChallengeOutcome = providerAuthorizationChallengeClicks > 0
        ? 'resolved_after_click' : 'observed_auto_resolved';
    }
    setOAuthStage("completed");
  }
  flowResult = { status: loggedIn ? 'logged_in' : 'needs_attention', details: {
    finalOriginMatchesTarget: loggedIn || isTargetOriginPage(page),
    loginFormVisible: loggedIn ? false : isTargetLoginPage(page),
    ...(checkinStatus ? { checkinStatus } : {}),
  } };
  if (!loggedIn) process.exitCode = 2;
  }
  });
  await printResult(flowResult.status, flowResult.details);
} catch (error) {
  const timedOut = observeOAuthTimeout(error);
  const interactivelyRecovered = interactiveAttention && !timedOut && context
    ? await waitForInteractiveTargetSession(context)
    : false;
  if (interactivelyRecovered) {
    terminationReason = timeoutPhase = null;
    if (oauthStage === "provider_authorization" || authorizationOutcome === 'authorization_departed') {
      authorizationOutcome = "authorization_completed";
      if (providerAuthorizationChallengeClicks > 0) {
        providerAuthorizationChallengeOutcome = "resolved_after_click";
      } else if (['observed_not_clickable', 'departed_unconfirmed'].includes(providerAuthorizationChallengeOutcome)) {
        providerAuthorizationChallengeOutcome = "observed_auto_resolved";
      }
    }
    setOAuthStage("completed");
    await printResult("logged_in", {
      finalOriginMatchesTarget: true,
      loginFormVisible: false,
    });
  } else {
    await printResult("needs_attention");
    process.exitCode = 2;
  }
} finally {
  await closeOAuthContext(context);
}
}
}
