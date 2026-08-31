import { clickVisibleNativeChallengeControl } from "./native-checkin-action.mjs";

const challengeClickedPages = new WeakSet();

function normalizedHttpsOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function configuredForOrigin(values, origin) {
  if (!Array.isArray(values)) return false;
  return values.some((value) => normalizedHttpsOrigin(value) === origin);
}

function pageMatchesOrigin(page, origin) {
  if (typeof page?.url !== "function") return false;
  return normalizedHttpsOrigin(page.url()) === origin;
}

function boundedMilliseconds(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

async function visibleUnique(locator) {
  return await locator.count().catch(() => 0) === 1
    && await locator.isVisible().catch(() => false);
}

async function clickKnownChallengeControl(page, timeout, expectedOrigin) {
  const capButton = page.getByRole("button", { name: /确认.*真人|真人.*确认/ });
  if (await visibleUnique(capButton)) {
    return capButton.click({ timeout }).then(() => true).catch(() => false);
  }

  const capWidget = page.locator("cap-widget:visible, [data-cap-api-endpoint]:visible");
  if (await capWidget.count().catch(() => 0) === 1) {
    return capWidget.click({ timeout }).then(() => true).catch(() => false);
  }

  const challenge = await clickVisibleNativeChallengeControl(page, expectedOrigin, {
    actionTexts: ["__login_challenge_only__"],
    clickChallenge: true,
  }).catch(() => ({ clicked: false }));
  return challenge.clicked === true;
}

export async function clickConfiguredLoginChallengeControl(page, origin, config = {}, timeoutMs = null) {
  const expectedOrigin = normalizedHttpsOrigin(origin);
  if (!expectedOrigin
    || !configuredForOrigin(config.autoClickTurnstileOrigins, expectedOrigin)
    || !pageMatchesOrigin(page, expectedOrigin)) return false;
  const configuredTimeoutMs = boundedMilliseconds(config.actionTimeoutMs, 10000, 1000, 10000);
  const clickTimeoutMs = Number.isFinite(Number(timeoutMs))
    ? Math.max(1, Math.min(configuredTimeoutMs, Number(timeoutMs)))
    : configuredTimeoutMs;
  if (challengeClickedPages.has(page)) return false;
  const clicked = await clickKnownChallengeControl(page, clickTimeoutMs, expectedOrigin);
  if (clicked) challengeClickedPages.add(page);
  return clicked;
}

export async function acceptConfiguredLoginTerms(page, origin, config = {}) {
  const expectedOrigin = normalizedHttpsOrigin(origin);
  if (!expectedOrigin
    || !configuredForOrigin(config.autoAcceptUpdatedTermsOrigins, expectedOrigin)
    || !pageMatchesOrigin(page, expectedOrigin)) return false;

  const accept = page.getByRole("button", { name: "同意并继续", exact: true });
  if (!await visibleUnique(accept)) return false;
  const clickTimeoutMs = boundedMilliseconds(config.actionTimeoutMs, 10000, 1000, 10000);
  await accept.click({ timeout: clickTimeoutMs });
  const actionWaitMs = boundedMilliseconds(config.actionWaitMs, 500, 500, 10000);
  await page.waitForTimeout(actionWaitMs);
  return true;
}

export async function waitForLoginSubmitEnabled(page, submit, origin, config = {}) {
  if (await submit.isEnabled().catch(() => false)) return true;

  const expectedOrigin = normalizedHttpsOrigin(origin);
  if (!expectedOrigin
    || !configuredForOrigin(config.autoClickTurnstileOrigins, expectedOrigin)
    || !pageMatchesOrigin(page, expectedOrigin)) return false;

  const timeoutMs = boundedMilliseconds(config.cloudflareWaitMs, 60000, 10000, 90000);
  const deadline = Date.now() + timeoutMs;
  let challengeClicked = false;
  while (Date.now() < deadline) {
    if (!pageMatchesOrigin(page, expectedOrigin)) return false;
    if (await submit.isEnabled().catch(() => false)) return true;
    if (!challengeClicked) {
      const remaining = Math.max(1, deadline - Date.now());
      challengeClicked = await clickConfiguredLoginChallengeControl(page, expectedOrigin, config, remaining);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await page.waitForTimeout(Math.min(1000, remaining));
  }
  return submit.isEnabled().catch(() => false);
}
