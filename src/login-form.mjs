const GENERIC_EXPANDER_PATTERN = /(?:邮箱|邮件|用户名|email|username).*(?:登录|登入|继续|continue|sign\s*in|log\s*in)|(?:登录|登入|继续|continue|sign\s*in|log\s*in).*(?:邮箱|邮件|用户名|email|username)/i;

function normalizedLabels(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export function loginFormExpanderPattern() {
  return GENERIC_EXPANDER_PATTERN;
}

export async function expandSavedPasswordLogin(page, origin, config = {}) {
  const password = page.locator('input[type="password"]:visible');
  const username = page.locator('input:visible:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])');
  if (await password.count() === 1 && await username.count() === 1) return false;
  const rule = config.savedLoginFormRules?.[origin];
  const configuredLabels = normalizedLabels(rule?.expanderTexts);
  const candidates = page.locator("button, a, [role=button]");
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const rawText = await candidate.evaluate((element) => (
      element.innerText || element.getAttribute("aria-label") || ""
    )).catch(() => "");
    const label = String(rawText).replace(/\s+/g, " ").trim();
    const configuredMatch = configuredLabels.some((value) => value === label);
    if (!configuredMatch && !GENERIC_EXPANDER_PATTERN.test(label)) continue;
    await candidate.click({ timeout: 5000 });
    await page.waitForTimeout(Math.max(0, Math.min(5000, Number(rule?.afterClickWaitMs) || 500)));
    return true;
  }
  return false;
}
