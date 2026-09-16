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
  const terminalPaths = raw.terminalPaths == null ? [] : raw.terminalPaths;
  if (!Array.isArray(terminalPaths) || terminalPaths.length > 4) {
    throw new Error("pre-check-in navigation terminal paths must contain 0 to 4 paths");
  }
  const normalizedTerminalPaths = [...new Set(terminalPaths.map((value) => String(value ?? "").trim()))];
  if (normalizedTerminalPaths.some((value) => !value.startsWith("/")
    || value.startsWith("//") || value.includes("?") || value.includes("#"))) {
    throw new Error("pre-check-in navigation terminal paths require exact same-origin paths");
  }
  if (!Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > 4) {
    throw new Error("pre-check-in navigation requires 1 to 4 steps");
  }

  const steps = raw.steps.map((step) => {
    const selector = String(step?.selector ?? "").trim();
    const role = String(step?.role ?? "").trim().toLowerCase();
    const name = normalizeText(step?.name ?? "");
    const allowHidden = step?.allowHidden === true;
    const usesSelector = Boolean(selector);
    const usesRole = Boolean(role || name);
    if (usesSelector === usesRole) {
      throw new Error("pre-check-in navigation step must use selector or role/name");
    }
    if (selector.length > 300) throw new Error("pre-check-in navigation selector is too long");
    if (usesRole && (!PRE_CHECKIN_NAVIGATION_ROLES.has(role) || !name || name.length > 80)) {
      throw new Error("pre-check-in navigation role/name is invalid");
    }
    return {
      selector,
      role,
      name,
      ...(allowHidden ? { allowHidden: true } : {}),
    };
  });

  return {
    expectedPath,
    steps,
    ...(normalizedTerminalPaths.length > 0 ? { terminalPaths: normalizedTerminalPaths } : {}),
    ...(raw.terminalWhenNavigationControlMissing === true
      ? { terminalWhenNavigationControlMissing: true }
      : {}),
    waitMs: Math.max(500, Math.min(30_000, Number(raw.waitMs) || 3_000)),
    afterClickWaitMs: Math.max(100, Math.min(3_000, Number(raw.afterClickWaitMs) || 500)),
  };
}

export function getConfiguredPreCheckinTerminalPath(pageUrl, target, activeOrigin, config) {
  if (!(target?.allowedOrigins ?? [target?.origin]).includes(activeOrigin)) return null;
  const rule = getConfiguredPreCheckinNavigationRule(target, activeOrigin, config);
  if (!rule?.terminalPaths?.length) return null;
  const currentUrl = assertBookmarkNavigation(pageUrl, target.allowedOrigins ?? [target.origin]);
  const currentPath = new URL(currentUrl).pathname;
  return rule.terminalPaths.includes(currentPath) ? currentPath : null;
}

function isLoginPath(pathname) {
  return /\/(?:user(?:[-_/])?)?(?:log[-_]?in|sign[-_]?in)(?:\/|$)/i.test(pathname);
}

async function waitForUniqueNavigationCandidate(page, step, waitMs, allowedOrigins, terminalPaths = []) {
  const locator = step.selector
    ? page.locator(step.selector)
    : page.getByRole(step.role, { name: step.name, exact: true });
  const deadline = Date.now() + waitMs;
  do {
    const currentUrl = assertBookmarkNavigation(page.url(), allowedOrigins);
    if (isLoginPath(new URL(currentUrl).pathname)) return null;
    const count = await locator.count();
    if (count > 20) throw new Error("pre-check-in navigation candidate set is too large");
    const candidates = [];
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (step.allowHidden || await candidate.isVisible().catch(() => false)) {
        candidates.push(candidate);
      }
    }
    if (candidates.length > 1) throw new Error("pre-check-in navigation control is not unique");
    if (candidates.length === 1
      && await candidates[0].isEnabled().catch(() => false)) {
      if (terminalPaths.length > 0) {
        const terminalPath = await candidates[0].getAttribute("href").then((href) => {
          if (!href) return null;
          try {
            const candidateUrl = new URL(href, page.url());
            return allowedOrigins.includes(candidateUrl.origin)
              && terminalPaths.includes(candidateUrl.pathname)
              ? candidateUrl.pathname
              : null;
          } catch {
            return null;
          }
        }).catch(() => null);
        if (terminalPath) return { terminalPath };
      }
      return { locator: candidates[0], allowHidden: step.allowHidden === true };
    }
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
  if (rule.terminalPaths?.includes(initialPath)) return { terminalPath: initialPath };
  if (hasCheckinAction
    || initialPath === rule.expectedPath
    || isLoginPath(initialPath)) return false;

  for (const step of rule.steps) {
    let selected;
    try {
      selected = await waitForUniqueNavigationCandidate(
        page,
        step,
        rule.waitMs,
        allowedOrigins,
        rule.terminalPaths ?? [],
      );
    } catch (error) {
      if (rule.terminalWhenNavigationControlMissing
        && error instanceof Error
        && error.message === "pre-check-in navigation control was not found") {
        return { terminalNoAction: true };
      }
      throw error;
    }
    if (!selected) return false;
    if (selected.terminalPath) return selected;
    if (selected.allowHidden) {
      await selected.locator.evaluate((element) => element.click());
    } else {
      await selected.locator.click({ timeout: 10_000 });
    }
    await page.waitForTimeout(rule.afterClickWaitMs);
    const currentUrl = assertBookmarkNavigation(page.url(), allowedOrigins);
    const currentPath = new URL(currentUrl).pathname;
    if (rule.terminalPaths?.includes(currentPath)) return { terminalPath: currentPath };
  }

  const deadline = Date.now() + rule.waitMs;
  do {
    const currentUrl = assertBookmarkNavigation(page.url(), allowedOrigins);
    const currentPath = new URL(currentUrl).pathname;
    if (rule.terminalPaths?.includes(currentPath)) return { terminalPath: currentPath };
    if (currentPath === rule.expectedPath) return true;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(100);
  } while (true);
  throw new Error("pre-check-in navigation did not reach the expected path");
}
