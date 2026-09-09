function isLinuxDoLoginUrl(rawUrl) {
  try {
    const location = new URL(rawUrl);
    return location.hostname === "linux.do" && /^\/login(?:[/?#]|$)/i.test(location.pathname);
  } catch {
    return false;
  }
}

export function isLinuxDoLoginPage(page) {
  return isLinuxDoLoginUrl(page?.url?.());
}

async function hasVisibleCloudflareChallenge(page) {
  const locator = page.locator([
    'iframe[src*="challenges.cloudflare.com" i]',
    'iframe[src*="/cdn-cgi/challenge-platform/" i]',
    'iframe[title*="cloudflare" i]',
    'iframe[title*="security challenge" i]',
    '.cf-turnstile',
    '[data-sitekey][data-callback]',
  ].join(", "));
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

async function waitForLinuxDoLoginTransition(
  page,
  deadline,
  { stopWhenChallengeClears = false, now = Date.now } = {},
) {
  let challengeObserved = false;
  while (now() < deadline) {
    if (!isLinuxDoLoginPage(page)) {
      return { recovered: true, challengeObserved, challengeCleared: challengeObserved };
    }
    const challengeVisible = await hasVisibleCloudflareChallenge(page);
    challengeObserved ||= challengeVisible;
    if (stopWhenChallengeClears && challengeObserved && !challengeVisible) {
      return { recovered: false, challengeObserved: true, challengeCleared: true };
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await page.waitForTimeout(Math.min(500, remaining));
  }
  return { recovered: !isLinuxDoLoginPage(page), challengeObserved, challengeCleared: false };
}

export function shouldRetryLinuxDoLoginRecovery(result) {
  return !result?.recovered && !result?.submitted && !result?.challengeObserved;
}

export async function recoverSavedLinuxDoLogin(page, waitMs, { now = Date.now } = {}) {
  if (!isLinuxDoLoginPage(page)) {
    return { recovered: false, submitted: false, challengeObserved: false };
  }
  const boundedWaitMs = Math.max(1_000, Math.min(120_000, Number(waitMs) || 60_000));
  const deadline = now() + boundedWaitMs;
  let challengeObserved = await hasVisibleCloudflareChallenge(page);
  if (challengeObserved) {
    const initialChallenge = await waitForLinuxDoLoginTransition(page, deadline, {
      stopWhenChallengeClears: true,
      now,
    });
    if (initialChallenge.recovered) {
      return { recovered: true, submitted: false, challengeObserved: true };
    }
    if (!initialChallenge.challengeCleared) {
      return { recovered: false, submitted: false, challengeObserved: true };
    }
  }

  const username = page.locator('input#login-account-name:visible, input[name="login"]:visible');
  const password = page.locator('input#login-account-password:visible, input[type="password"]:visible');
  if (await username.count() !== 1 || await password.count() !== 1) {
    return { recovered: false, submitted: false, challengeObserved };
  }
  const beforeFillRemaining = deadline - now();
  if (beforeFillRemaining <= 0) {
    return { recovered: false, submitted: false, challengeObserved };
  }
  await page.waitForTimeout(Math.min(2_000, beforeFillRemaining));

  let filled = await page.evaluate(() => {
    const user = document.querySelector('input#login-account-name, input[name="login"]');
    const secret = document.querySelector('input#login-account-password, input[type="password"]');
    return Boolean(user?.value && secret?.value);
  });
  if (!filled) {
    await username.click();
    await username.press("ArrowDown").catch(() => {});
    await username.press("Enter").catch(() => {});
    const fillRemaining = deadline - now();
    if (fillRemaining > 0) await page.waitForTimeout(Math.min(2_000, fillRemaining));
    filled = await page.evaluate(() => {
      const user = document.querySelector('input#login-account-name, input[name="login"]');
      const secret = document.querySelector('input#login-account-password, input[type="password"]');
      return Boolean(user?.value && secret?.value);
    });
  }

  let submit = null;
  if (filled) {
    const loginButton = page.getByRole("button", { name: "登录", exact: true });
    if (await loginButton.count() === 1 && await loginButton.isVisible().catch(() => false)) {
      submit = loginButton;
    }
  } else {
    const googleButton = page.getByRole("button", { name: "使用 Google 登录", exact: true });
    if (await googleButton.count() === 1 && await googleButton.isVisible().catch(() => false)) {
      submit = googleButton;
    }
  }
  if (!submit) return { recovered: false, submitted: false, challengeObserved };

  await submit.click();
  const transition = await waitForLinuxDoLoginTransition(page, deadline, { now });
  challengeObserved ||= transition.challengeObserved;
  return {
    recovered: transition.recovered,
    submitted: true,
    challengeObserved,
  };
}
