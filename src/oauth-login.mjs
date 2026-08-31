import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBookmarkTarget } from "./bookmarks.mjs";
import { launchAutomationContext, processCandidate } from "./browser.mjs";
import { connectOverCdpWithRetry } from "./native-cdp.mjs";
import { selectPreferredOAuthTargetPage } from "./oauth-page-selection.mjs";
import { probeProviderSessionInContext } from "./oauth-provider-session.mjs";
import { rewriteConfiguredOAuthCallbackUrl } from "./oauth-callback-rewrite.mjs";
import {
  authorizeConfiguredOAuthProvider,
  describeConfiguredAuthorizationSurface,
  isConfiguredProviderAuthorizationPage,
} from "./oauth-provider-authorization.mjs";
import { findUniqueOAuthProviderControl } from "./oauth-provider-control.mjs";
import { waitForFirstTransition, waitForOriginPage } from "./oauth-transition.mjs";
import { clickConfiguredLoginChallengeControl } from "./protected-login-flow.mjs";
import { verifyConfiguredSavedLoginSession } from "./saved-login-session.mjs";
import { assertBookmarkNavigation } from "./security.mjs";

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
if (!requestedOrigin) throw new Error("用法: node src/oauth-login.mjs <origin> [provider]");
if (providerOnly && agentRouterOnly) throw new Error("--provider-only and --agent-router-only cannot be combined");
if ((providerOnly || agentRouterOnly) && !/linux\s*do/i.test(provider)) {
  throw new Error("LinuxDO-only OAuth stages require the LinuxDO provider");
}
if (agentRouterOnly && !providerSessionConfirmed) {
  throw new Error("--agent-router-only requires a fresh provider session confirmation");
}
const origin = new URL(requestedOrigin).origin;
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
  if (!useNativeCdp) return launchAutomationContext(runtimeConfig);
  connectedNativeBrowser = await connectOverCdpWithRetry(chromium, nativeCdpPort, {
    timeoutMs: 15_000,
    attemptTimeoutMs: 2_000,
    retryDelayMs: 500,
  });
  const contexts = connectedNativeBrowser.contexts();
  if (contexts.length !== 1) throw new Error("Native OAuth browser context is not unique");
  return contexts[0];
}

async function closeOAuthContext(context) {
  if (connectedNativeBrowser) {
    await connectedNativeBrowser.close().catch(() => {});
    connectedNativeBrowser = null;
    return;
  }
  await context.close();
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
  if (!useNativeCdp || !Object.hasOwn(config.savedLoginSessionRules ?? {}, origin)) return null;
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

function setOAuthStage(value) {
  oauthStage = value;
  if (privateResult) process.stderr.write(`${JSON.stringify({ oauthStage })}\n`);
}
setOAuthStage("target_login");

function printResult(status, details = {}) {
  console.log(JSON.stringify({
    status,
    oauthStage,
    ...(authorizationOutcome ? { authorizationOutcome } : {}),
    ...details,
  }, null, privateResult ? 0 : 2));
}

function isLinuxDoLoginPage(page) {
  try {
    const location = new URL(page.url());
    return location.hostname === "linux.do" && /^\/login(?:[/?#]|$)/i.test(location.pathname);
  } catch {
    return false;
  }
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

async function isConfirmedTargetSessionPage(page) {
  if (!isTargetOriginPage(page) || isTargetLoginPage(page)) return false;
  if (await page.locator('input[type="password"]:visible').count() > 0) return false;
  if (await findUniqueOAuthProviderControl(page, provider)) return false;
  return true;
}

async function waitForInteractiveTargetSession(context) {
  const deadline = Date.now() + interactiveAttentionWaitMs;
  let stablePage = null;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const pages = context.pages().filter((candidate) => !candidate.isClosed());
    if (pages.length === 0) return false;
    let candidate = null;
    for (const currentPage of pages) {
      if (await isConfirmedTargetSessionPage(currentPage)) {
        candidate = currentPage;
        break;
      }
    }
    if (candidate) {
      if (candidate !== stablePage) {
        stablePage = candidate;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 1_500) {
        return true;
      }
    } else {
      stablePage = null;
      stableSince = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function navigateNativeTargetCandidate(page) {
  if (!useNativeCdp || !isTargetLoginPage(page) || !bookmarkTarget?.candidates?.length) return;
  const allowedOrigins = bookmarkTarget.allowedOrigins ?? [origin];
  const candidateUrl = assertBookmarkNavigation(bookmarkTarget.candidates[0], allowedOrigins);
  await page.goto(candidateUrl, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
}

async function waitForTargetCallback(preferredPage) {
  return waitForOriginPage(context, origin, {
    timeoutMs: providerWaitMs,
    preferredPage,
    acceptPage: (candidate) => oauthFlowPages.has(candidate) && !isTargetLoginPage(candidate),
  });
}

async function trySavedLinuxDoLogin(page, waitMs = providerWaitMs) {
  if (!isLinuxDoLoginPage(page)) return false;

  const username = page.locator('input#login-account-name:visible, input[name="login"]:visible');
  const password = page.locator('input#login-account-password:visible, input[type="password"]:visible');
  if (await username.count() !== 1 || await password.count() !== 1) return false;
  await page.waitForTimeout(Math.min(2_000, waitMs));

  let filled = await page.evaluate(() => {
    const user = document.querySelector('input#login-account-name, input[name="login"]');
    const secret = document.querySelector('input#login-account-password, input[type="password"]');
    return Boolean(user?.value && secret?.value);
  });
  if (!filled) {
    // A real focus/keyboard gesture asks the browser password manager to apply the
    // encrypted credential copied into this dedicated profile.  Values are
    // never read or logged by the automation.
    await username.click();
    await username.press("ArrowDown").catch(() => {});
    await username.press("Enter").catch(() => {});
    await page.waitForTimeout(Math.min(2_000, waitMs));
    filled = await page.evaluate(() => {
      const user = document.querySelector('input#login-account-name, input[name="login"]');
      const secret = document.querySelector('input#login-account-password, input[type="password"]');
      return Boolean(user?.value && secret?.value);
    });
  }
  if (!filled) {
    // LinuxDO also exposes a Google login button.  Once the dedicated browser
    // has a valid Google session this is the simplest unattended recovery
    // path and does not require handling a password or Windows Hello prompt.
    const googleButton = page.getByRole("button", { name: "使用 Google 登录", exact: true });
    if (await googleButton.count() === 1) {
      await googleButton.click();
      await page.waitForURL((url) => {
        const loginPath = /^\/login(?:[/?#]|$)/i.test(url.pathname);
        return url.hostname === "connect.linux.do" || (url.hostname === "linux.do" && !loginPath);
      }, { timeout: Math.min(60_000, waitMs) }).catch(() => {});
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      const afterGoogle = new URL(page.url());
      const loginPath = /^\/login(?:[/?#]|$)/i.test(afterGoogle.pathname);
      return afterGoogle.hostname === "connect.linux.do" || (afterGoogle.hostname === "linux.do" && !loginPath);
    }
    return false;
  }

  const loginButton = page.getByRole("button", { name: "登录", exact: true });
  if (await loginButton.count() !== 1) return false;
  await loginButton.click();
  await page.waitForURL((url) => url.hostname !== "linux.do" || !/^\/login(?:[/?#]|$)/i.test(url.pathname), {
    timeout: Math.min(60_000, waitMs),
  }).catch(() => {});
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  const finalLocation = new URL(page.url());
  return finalLocation.hostname !== "linux.do" || !/^\/login(?:[/?#]|$)/i.test(finalLocation.pathname);
}

async function probeLinuxDoSession(context, attempts = 3) {
  const boundedAttempts = Math.max(1, Math.min(3, Number(attempts) || 1));
  const retryDelaysMs = Array.from(
    { length: boundedAttempts - 1 },
    () => Math.min(2_000, providerWaitMs),
  );
  const result = await probeProviderSessionInContext(
    context,
    "https://linux.do/session/current.json",
    config.navigationTimeoutMs,
    { retryDelaysMs },
  );
  return result.status;
}

async function runProviderOnlyFlow() {
  const providerContext = await openOAuthContext();
  try {
    const providerPage = await providerContext.newPage();
    setOAuthStage("linuxdo_session");
    const initialSession = await probeLinuxDoSession(providerContext, 2);
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
      timeout: config.navigationTimeoutMs,
    });
    await providerPage.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    if (isLinuxDoLoginPage(providerPage)) {
      const recovered = await trySavedLinuxDoLogin(providerPage, providerWaitMs);
      if (!recovered || isLinuxDoLoginPage(providerPage)) return false;
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
    const succeeded = await runProviderOnlyFlow();
    printResult(succeeded ? "logged_in" : "needs_attention");
    if (!succeeded) process.exitCode = 2;
  } catch {
    printResult("needs_attention");
    process.exitCode = 2;
  }
} else {
  const context = await openOAuthContext();
  const oauthFlowPages = new Set();
  context.on("page", (candidate) => oauthFlowPages.add(candidate));
  try {
  oauthFlow: {
  if (agentRouterOnly) {
    // The provider-only phase established the session before this context was
    // launched. Reconfirm and warm that encrypted session in this new renderer
    // before opening Agent Router, then close the probe page. This preserves
    // strict provider -> target ordering without showing a parallel window.
    setOAuthStage("linuxdo_session");
    const providerSession = await probeLinuxDoSession(context, 2);
    if (providerSession !== "valid") {
      throw new Error("LinuxDO provider session is not available in the Agent Router context");
    }
    setOAuthStage("target_login");
  }
  let page = await acquireTargetPage(context);
  oauthFlowPages.add(page);
  const reusedSession = await reuseExistingNativeTargetSession(page);
  if (reusedSession) {
    setOAuthStage("completed");
    printResult("logged_in", {
      finalOriginMatchesTarget: true,
      loginFormVisible: false,
      ...(reusedSession.checkinStatus ? { checkinStatus: reusedSession.checkinStatus } : {}),
    });
    break oauthFlow;
  }
  const configuredLoginUrl = loginUrlIndex >= 0
    ? process.argv[loginUrlIndex + 1]
    : (config.oauthLoginUrls?.[origin] ?? `${origin}/login`);
  const loginUrl = new URL(configuredLoginUrl);
  if (loginUrl.origin !== origin || loginUrl.protocol !== "https:") throw new Error("OAuth 登录入口不属于目标站点");
  await page.goto(loginUrl.href, { waitUntil: "commit", timeout: config.navigationTimeoutMs });
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
    const providerDeadline = Date.now() + providerWaitMs;
    let challengeClicked = false;
    while (Date.now() < providerDeadline) {
      const agreementCheckbox = currentPage.locator('input[type="checkbox"]:visible');
      if (await agreementCheckbox.count() === 1 && !await agreementCheckbox.isChecked()) {
        await agreementCheckbox.check({ force: true, timeout: 5000 });
      }
      for (const label of providerLabels) {
        const candidate = currentPage.getByText(label, { exact: true });
        if (await candidate.count() === 1 && await candidate.isVisible()) return candidate;
      }
      for (const label of providerAltLabels) {
        const candidate = currentPage.locator(`img[alt="${label}"]`);
        if (await candidate.count() === 1 && await candidate.isVisible()) return candidate;
      }
      const semanticFallback = await findUniqueOAuthProviderControl(currentPage, provider);
      if (semanticFallback) return semanticFallback;
      if (!challengeClicked) {
        challengeClicked = await clickConfiguredLoginChallengeControl(currentPage, origin, config);
        if (challengeClicked) setOAuthStage("login_challenge");
      }
      await currentPage.waitForTimeout(500);
    }
    throw new Error("configured OAuth provider control was not found");
  }

  async function startProviderOAuth(currentPage) {
    const providerButton = await findProviderButton(currentPage);
    setOAuthStage("provider_transition");
    const previousUrl = currentPage.url();
    const transitionTimeout = Math.min(20_000, providerWaitMs);
    const popupPromise = currentPage.waitForEvent("popup", { timeout: transitionTimeout })
      .then((popup) => popup)
      .catch(() => null);
    const navigationPromise = currentPage.waitForURL((url) => url.href !== previousUrl, { timeout: transitionTimeout })
      .then(() => currentPage)
      .catch(() => null);
    await providerButton.click();
    const destinationPage = await waitForFirstTransition([popupPromise, navigationPromise]);
    if (!destinationPage) throw new Error("OAuth provider navigation did not start");
    if (destinationPage !== currentPage) await currentPage.close({ runBeforeUnload: false }).catch(() => {});
    oauthFlowPages.add(destinationPage);
    await destinationPage.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    return destinationPage;
  }

  const providerHomeRecoveryAttempts = 3;
  for (let flowAttempt = 0; flowAttempt < providerHomeRecoveryAttempts; flowAttempt += 1) {
    page = await startProviderOAuth(page);
    await page.waitForTimeout(Math.min(1_500, providerWaitMs));
    for (let attempt = 0; attempt < 2 && isLinuxDoLoginPage(page); attempt += 1) {
      setOAuthStage("linuxdo_session");
      const recovered = await trySavedLinuxDoLogin(page, providerWaitMs);
      if (recovered || !isLinuxDoLoginPage(page)) break;
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
    await page.goto(loginUrl.href, { waitUntil: "commit", timeout: config.navigationTimeoutMs });
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
  }

  const redirectOverride = config.oauthRedirectOverrides?.[origin]?.[provider];
  if (redirectOverride && new URL(page.url()).hostname === "connect.linux.do") {
    const override = new URL(redirectOverride);
    if (override.origin !== origin || override.protocol !== "https:") throw new Error("OAuth 回调覆盖地址不属于目标站点");
    const authorizeUrl = new URL(page.url());
    authorizeUrl.searchParams.set("redirect_uri", override.href);
    await page.goto(authorizeUrl.href, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
  }

  if (isConfiguredProviderAuthorizationPage(page.url(), provider)) {
    setOAuthStage("provider_authorization");
    const authorizationDeadline = Date.now() + providerWaitMs;
    let authorization = null;
    let authorizationSubmitted = false;
    let providerChallengeClicked = false;
    let authorizationSurfaceReported = false;
    while (Date.now() < authorizationDeadline
      && isConfiguredProviderAuthorizationPage(page.url(), provider)) {
      if (!authorizationSubmitted) {
        authorization = await authorizeConfiguredOAuthProvider(page, provider);
        authorizationOutcome = authorization.outcome;
        if (privateResult
          && !authorizationSurfaceReported
          && authorization.outcome === "authorization_not_found") {
          const authorizationSurface = await describeConfiguredAuthorizationSurface(page, provider);
          if (authorizationSurface) {
            process.stderr.write(`${JSON.stringify({ oauthStage, authorizationSurface })}\n`);
            authorizationSurfaceReported = true;
          }
        }
        if (authorization.clicked) {
          authorizationSubmitted = true;
          await page.waitForTimeout(500);
          continue;
        }
      }
      if (!providerChallengeClicked) {
        const providerOrigin = new URL(page.url()).origin;
        const remaining = Math.max(1, authorizationDeadline - Date.now());
        providerChallengeClicked = await clickConfiguredLoginChallengeControl(
          page,
          providerOrigin,
          config,
          remaining,
        );
        if (providerChallengeClicked) authorizationSubmitted = false;
      }
      await page.waitForTimeout(500);
    }
    if (isConfiguredProviderAuthorizationPage(page.url(), provider)) {
      throw new Error("configured OAuth provider authorization did not complete");
    }
    authorizationOutcome = "authorization_completed";
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
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
      timeout: config.navigationTimeoutMs,
    });
  }
  if (new URL(page.url()).origin !== origin) {
    const callbackPage = await waitForTargetCallback(page);
    if (callbackPage) {
      if (callbackPage !== page) await page.close({ runBeforeUnload: false }).catch(() => {});
      page = callbackPage;
    }
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const finalUrl = page.url();
  const finalLocation = new URL(finalUrl);
  const visiblePassword = await page.locator('input[type="password"]:visible').count() > 0;
  let visibleProviderLogin = false;
  for (const label of providerLabels) {
    const candidate = page.getByText(label, { exact: true });
    if (await candidate.count() === 1 && await candidate.isVisible()) {
      visibleProviderLogin = true;
      break;
    }
  }
  if (!visibleProviderLogin) {
    for (const label of providerAltLabels) {
      const candidate = page.locator(`img[alt="${label}"]`);
      if (await candidate.count() === 1 && await candidate.isVisible()) {
        visibleProviderLogin = true;
        break;
      }
    }
  }
  if (!visibleProviderLogin) {
    visibleProviderLogin = Boolean(await findUniqueOAuthProviderControl(page, provider));
  }
  let loggedIn = finalLocation.origin === origin
    && !/\/(?:log[-_]?in|sign[-_]?in)(?:[/?#]|$)/i.test(finalLocation.href)
    && !visiblePassword
    && !visibleProviderLogin;
  if (loggedIn && Object.hasOwn(config.savedLoginSessionRules ?? {}, origin)) {
    setOAuthStage("session_verification");
    const verifiedSession = await verifyConfiguredSavedLoginSession(page, origin, config);
    loggedIn = verifiedSession?.status === "valid";
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
  if (loggedIn) setOAuthStage("completed");
  printResult(loggedIn ? "logged_in" : "needs_attention", {
    finalOriginMatchesTarget: loggedIn || finalLocation.origin === origin,
    loginFormVisible: loggedIn ? false : visiblePassword || visibleProviderLogin,
    ...(checkinStatus ? { checkinStatus } : {}),
  });
  if (!loggedIn) process.exitCode = 2;
  }
} catch {
  const interactivelyRecovered = interactiveAttention
    ? await waitForInteractiveTargetSession(context)
    : false;
  if (interactivelyRecovered) {
    if (oauthStage === "provider_authorization") authorizationOutcome = "authorization_completed";
    setOAuthStage("completed");
    printResult("logged_in", {
      finalOriginMatchesTarget: true,
      loginFormVisible: false,
    });
  } else {
    printResult("needs_attention");
    process.exitCode = 2;
  }
} finally {
  await closeOAuthContext(context);
}
}
