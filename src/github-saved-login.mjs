export function isGitHubLoginUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && url.hostname === "github.com" && /^\/login\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function isGitHubInteractiveVerificationUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && url.hostname === "github.com"
      && /\/(?:sessions\/(?:two-factor|verified-device)|login\/device|webauthn|passkeys?)(?:[/?#]|$)/i.test(url.pathname);
  } catch {
    return true;
  }
}

async function fieldsAreFilled(username, password) {
  const usernameFilled = await username.evaluate((element) => Boolean(element.value)).catch(() => false);
  const passwordFilled = await password.evaluate((element) => Boolean(element.value)).catch(() => false);
  return usernameFilled && passwordFilled;
}

export async function restoreSavedGitHubLogin(page, state = { attempted: false }) {
  const fail = (stage) => { state.failureStage = stage; return false; };
  if (state.attempted || page.isClosed() || !isGitHubLoginUrl(page.url())) return false;
  state.attempted = true;
  state.failureStage = null;

  const accountChooser = page.locator(
    '[data-testid*="account" i]:visible, [aria-label*="account" i][role="dialog"]:visible, form[action*="switch_account" i]:visible',
  );
  if (await accountChooser.count() > 0) return fail('github_account_selection');
  const interactiveControl = page.locator(
    'input[autocomplete="one-time-code"]:visible, input[name*="otp" i]:visible, input[name*="two_factor" i]:visible, [data-webauthn]:visible',
  );
  if (isGitHubInteractiveVerificationUrl(page.url()) || await interactiveControl.count() > 0) {
    return fail('github_interactive_verification');
  }

  // Only booleans leave the page. The encrypted browser password store owns
  // the credential; no username or password is read, copied, or logged here.
  const usernameFields = page.locator('#login_field:visible, input[name="login"]:visible, input[type="email"]:visible');
  const passwordFields = page.locator('#password:visible, input[type="password"]:visible');
  if (await usernameFields.count() !== 1 || await passwordFields.count() !== 1) return fail('github_form_not_unique');
  const username = usernameFields.first();
  const password = passwordFields.first();
  const forms = page.locator('form').filter({ has: username }).filter({ has: password });
  if (await forms.count() !== 1) return fail('github_form_not_unique');
  const form = forms.first();
  await page.waitForTimeout(1_500);
  let filled = await fieldsAreFilled(username, password);
  if (!filled) {
    for (const field of [username, password, username]) {
      await field.click().catch(() => {});
      await field.press("ArrowDown").catch(() => {});
      await field.press("Enter").catch(() => {});
      await page.waitForTimeout(750);
      filled = await fieldsAreFilled(username, password);
      if (filled) break;
    }
  }
  if (!filled) return fail('github_autofill_missing');

  // An account chooser is ambiguous because this automation never reads an
  // account name to disambiguate it. Hand it back instead of choosing one.
  if (await accountChooser.count() > 0) return fail('github_account_selection');
  const submit = form.locator('button[type="submit"]:visible, input[type="submit"]:visible');
  if (await submit.count() !== 1) return fail('github_submit_not_unique');
  if (!await submit.first().click({ timeout: 10_000 }).then(() => true).catch(() => false)) return fail('github_submit_failed');
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1_200);

  if (isGitHubInteractiveVerificationUrl(page.url()) || await interactiveControl.count() > 0) return fail('github_interactive_verification');
  if (await accountChooser.count() > 0) return fail('github_account_selection');
  if (isGitHubLoginUrl(page.url())) return fail('github_login_not_completed');
  return true;
}
