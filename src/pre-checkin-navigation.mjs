import { normalizeText } from "./detector.mjs";
import { assertBookmarkNavigation } from "./security.mjs";

const PRE_CHECKIN_NAVIGATION_ROLES = new Set(["button", "link", "menuitem"]);

export function getConfiguredPreCheckinNavigationRule(target, activeOrigin, config) {
  if (!(target?.allowedOrigins ?? [target?.origin]).includes(activeOrigin)) return null;
  const raw = config?.preCheckinNavigationRules?.[activeOrigin];
  if (!raw || raw.enabled === false) return null;

  const expectedPath = String(raw.expectedPath ?? "").trim();
  if (!expectedPath.startsWith("/") || expectedPath.startsWith("//")
    || expectedPath.includes("?") || expectedPath.includes("#")) {
    throw new Error("pre-check-in navigation requires an exact same-origin path");
  }
  if (!Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > 4) {
    throw new Error("pre-check-in navigation requires 1 to 4 steps");
  }

  const steps = raw.steps.map((step) => {
    const selector = String(step?.selector ?? "").trim();
    const role = String(step?.role ?? "").trim().toLowerCase();
    const name = normalizeText(step?.name ?? "");
    const usesSelector = Boolean(selector);
    const usesRole = Boolean(role || name);
    if (usesSelector === usesRole) {
      throw new Error("pre-check-in navigation step must use selector or role/name");
    }
    if (selector.length > 300) throw new Error("pre-check-in navigation selector is too long");
    if (usesRole && (!PRE_CHECKIN_NAVIGATION_ROLES.has(role) || !name || name.length > 80)) {
      throw new Error("pre-check-in navigation role/name is invalid");
    }
    return { selector, role, name };
  });

  return {
    expectedPath,
    steps,
    waitMs: Math.max(500, Math.min(30_000, Number(raw.waitMs) || 3_000)),
    afterClickWaitMs: Math.max(100, Math.min(3_000, Number(raw.afterClickWaitMs) || 500)),
  };
}

function isLoginPath(pathname) {
  return /\/(?:user(?:[-_/])?)?(?:log[-_]?in|sign[-_]?in)(?:\/|$)/i.test(pathname);
}

async function waitForUniqueNavigationCandidate(page, step, waitMs, allowedOrigins) {
  const locator = step.selector
    ? page.locator(step.selector)
    : page.getByRole(step.role, { name: step.name, exact: true });
  const deadline = Date.now() + waitMs;
  do {
    const currentUrl = assertBookmarkNavigation(page.url(), allowedOrigins);
    if (isLoginPath(new URL(currentUrl).pathname)) return null;
    const count = await locator.count();
    if (count > 20) throw new Error("pre-check-in navigation candidate set is too large");
    const visible = [];
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
    }
    if (visible.length > 1) throw new Error("pre-check-in navigation control is not unique");
    if (visible.length === 1 && await visible[0].isEnabled().catch(() => false)) return visible[0];
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(100);
  } while (true);
  throw new Error("pre-check-in navigation control was not found");
}

export async function navigateConfiguredPreCheckinPage(
  page,
  target,
  activeOrigin,
  config,
  { hasCheckinAction = false } = {},
) {
  const rule = getConfiguredPreCheckinNavigationRule(target, activeOrigin, config);
  if (!rule) return false;
  const allowedOrigins = target.allowedOrigins ?? [target.origin];
  const initialUrl = assertBookmarkNavigation(page.url(), allowedOrigins);
  const initialPath = new URL(initialUrl).pathname;
  if (hasCheckinAction
    || initialPath === rule.expectedPath
    || isLoginPath(initialPath)) return false;

  for (const step of rule.steps) {
    const candidate = await waitForUniqueNavigationCandidate(page, step, rule.waitMs, allowedOrigins);
    if (!candidate) return false;
    await candidate.click({ timeout: 10_000 });
    await page.waitForTimeout(rule.afterClickWaitMs);
    assertBookmarkNavigation(page.url(), allowedOrigins);
  }

  const deadline = Date.now() + rule.waitMs;
  do {
    const currentUrl = assertBookmarkNavigation(page.url(), allowedOrigins);
    if (new URL(currentUrl).pathname === rule.expectedPath) return true;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(100);
  } while (true);
  throw new Error("pre-check-in navigation did not reach the expected path");
}
