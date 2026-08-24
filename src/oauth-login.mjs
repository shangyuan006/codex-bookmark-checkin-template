import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBookmarkTarget } from "./bookmarks.mjs";
import { launchAutomationContext } from "./browser.mjs";
import { waitForFirstTransition, waitForOriginPage } from "./oauth-transition.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const requestedOrigin = process.argv[2];
const provider = process.argv[3] || "LinuxDO";
const loginUrlIndex = process.argv.indexOf("--login-url");
const automationProfileIndex = process.argv.indexOf("--automation-user-data-dir");
const accountIdIndex = process.argv.indexOf("--account-id");
const waitMsIndex = process.argv.indexOf("--wait-ms");
const privateResult = process.argv.includes("--private-result");
const providerOnly = process.argv.includes("--provider-only");
const agentRouterOnly = process.argv.includes("--agent-router-only");
if (!requestedOrigin) throw new Error("用法: node src/oauth-login.mjs <origin> [provider]");
if (providerOnly && agentRouterOnly) throw new Error("--provider-only and --agent-router-only cannot be combined");
if ((providerOnly || agentRouterOnly) && !/linux\s*do/i.test(provider)) {
  throw new Error("LinuxDO-only OAuth stages require the LinuxDO provider");
}
const origin = new URL(requestedOrigin).origin;
if (!providerOnly) await findBookmarkTarget(config.bookmarksPath, origin, config);

const accountId = accountIdIndex >= 0 ? String(process.argv[accountIdIndex + 1] ?? "").trim() : "default";
if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(accountId)) throw new Error("Invalid account id");
const accountProfile = automationProfileIndex >= 0
  ? String(process.argv[automationProfileIndex + 1] ?? "").trim()
  : config.automationUserDataDir;
if (!accountProfile) throw new Error("Automation profile is not configured");
const runtimeConfig = { ...config, automationUserDataDir: path.resolve(rootDirectory, accountProfile) };
const providerWaitMs = Math.max(
  30_000,
  Math.min(120_000, Number(waitMsIndex >= 0 ? process.argv[waitMsIndex + 1] : 20_000) || 20_000),
);
let oauthStage = "target_login";

function setOAuthStage(value) {
  oauthStage = value;
  if (privateResult) process.stderr.write(`${JSON.stringify({ oauthStage })}\n`);
}
setOAuthStage("target_login");

function printResult(status, details = {}) {
  console.log(JSON.stringify({ status, oauthStage, ...details }, null, 2));
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

async function readLinuxDoSession(page) {
  const response = await page.goto("https://linux.do/session/current.json", {
    waitUntil: "commit",
    timeout: config.navigationTimeoutMs,
  }).catch(() => null);
  if (!response || !response.ok()) return false;
  const value = await response.json().catch(() => null);
  return Boolean(value?.current_user && typeof value.current_user === "object" && !Array.isArray(value.current_user));
}

async function waitForLinuxDoSession(page, attempts = 3) {
  const boundedAttempts = Math.max(1, Math.min(3, Number(attempts) || 1));
  for (let attempt = 0; attempt < boundedAttempts; attempt += 1) {
    if (await readLinuxDoSession(page)) return true;
    if (attempt + 1 < boundedAttempts) {
      await page.waitForTimeout(Math.min(2_000, providerWaitMs));
    }
  }
  return false;
}

async function runProviderOnlyFlow() {
  const providerContext = await launchAutomationContext(runtimeConfig);
  try {
    const providerPage = await providerContext.newPage();
    setOAuthStage("linuxdo_session");
    if (await waitForLinuxDoSession(providerPage, 2)) {
      setOAuthStage("completed");
      return true;
    }
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
    const valid = await waitForLinuxDoSession(providerPage);
    if (valid) setOAuthStage("completed");
    return valid;
  } finally {
    // Do not continue to Agent Router if the provider browser context did not
    // close. A successful provider stage must leave no LinuxDO page running.
    await providerContext.close();
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
  const context = await launchAutomationContext(runtimeConfig);
  const oauthFlowPages = new Set();
  context.on("page", (candidate) => oauthFlowPages.add(candidate));
  try {
  let page = await context.newPage();
  oauthFlowPages.add(page);
  if (agentRouterOnly) {
    setOAuthStage("linuxdo_session");
    if (!await waitForLinuxDoSession(page)) throw new Error("LinuxDO provider session is not confirmed before Agent Router OAuth");
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
  ]);
  const providerAltLabels = /linux\s*do/i.test(provider)
    ? ["LINUX DO", "Linux DO", "LinuxDO"]
    : [provider, `${provider}登录`, `${provider}登入`];
  async function findProviderButton(currentPage) {
    setOAuthStage("provider_button");
    const providerDeadline = Date.now() + providerWaitMs;
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

  page = await startProviderOAuth(page);
  for (let attempt = 0; attempt < 2 && isLinuxDoLoginPage(page); attempt += 1) {
    setOAuthStage("linuxdo_session");
    const recovered = await trySavedLinuxDoLogin(page, providerWaitMs);
    if (recovered || !isLinuxDoLoginPage(page)) break;
    await page.waitForTimeout(Math.min(3_000, providerWaitMs));
  }
  if (isLinuxDoLoginPage(page)) throw new Error("LinuxDO session recovery did not complete");

  if (new URL(page.url()).hostname === "linux.do") {
    // LinuxDO can finish a restored session on its own home page instead of
    // resuming the original OAuth request. Re-enter the target flow once.
    setOAuthStage("provider_transition");
    await page.goto(loginUrl.href, { waitUntil: "commit", timeout: config.navigationTimeoutMs });
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    page = await startProviderOAuth(page);
  }

  const redirectOverride = config.oauthRedirectOverrides?.[origin]?.[provider];
  if (redirectOverride && new URL(page.url()).hostname === "connect.linux.do") {
    const override = new URL(redirectOverride);
    if (override.origin !== origin || override.protocol !== "https:") throw new Error("OAuth 回调覆盖地址不属于目标站点");
    const authorizeUrl = new URL(page.url());
    authorizeUrl.searchParams.set("redirect_uri", override.href);
    await page.goto(authorizeUrl.href, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
  }

  if (new URL(page.url()).hostname === "connect.linux.do") {
    setOAuthStage("provider_authorization");
    const authorizeCandidates = ["授权", "允许", "Authorize", "Allow"];
    const challengeDeadline = Date.now() + providerWaitMs;
    let authorizeButton = null;
    while (Date.now() < challengeDeadline && new URL(page.url()).hostname === "connect.linux.do") {
      for (const label of authorizeCandidates) {
        const roleButton = page.getByRole("button", { name: label, exact: true });
        if (await roleButton.count() === 1) {
          authorizeButton = roleButton;
          break;
        }
        const exactText = page.getByText(label, { exact: true });
        if (await exactText.count() === 1 && await exactText.isVisible()) {
          authorizeButton = exactText;
          break;
        }
      }
      if (authorizeButton) break;
      await page.waitForTimeout(2000);
    }
    if (authorizeButton) {
      await authorizeButton.click();
    }
  }

  setOAuthStage("target_callback");
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
  const loggedIn = finalLocation.origin === origin
    && !/\/(?:log[-_]?in|sign[-_]?in)(?:[/?#]|$)/i.test(finalLocation.href)
    && !visiblePassword
    && !visibleProviderLogin;
  if (loggedIn) setOAuthStage("completed");
  printResult(loggedIn ? "logged_in" : "needs_attention", {
    finalOriginMatchesTarget: finalLocation.origin === origin,
    loginFormVisible: visiblePassword || visibleProviderLogin,
  });
  if (!loggedIn) process.exitCode = 2;
} catch {
  printResult("needs_attention");
  process.exitCode = 2;
} finally {
  await context.close();
}
}
