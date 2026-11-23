import { classifyPageText, normalizeText } from "./detector.mjs";
import { assertBookmarkNavigation } from "./security.mjs";
import { dailyReadinessEvidence, successEvidence } from "./checkin-evidence.mjs";
import { readCloudflareFrameEvidence } from "./challenge-frame-state.mjs";

const PRE_CHECKIN_NAVIGATION_ROLES = new Set(["button", "link", "menuitem"]);

function dailyUnsignedFormRule(raw) {
  if (raw == null) return null;
  const selectors = key => {
    const values = raw[key];
    if (!Array.isArray(values) || values.length < 1 || values.length > 6
      || values.some(value => typeof value !== "string" || !value.trim() || value.length > 300)) {
      throw new Error("daily unsigned form requires bounded non-empty selector lists");
    }
    return values.map(value => value.trim());
  };
  const actionText = normalizeText(raw.actionText ?? "");
  if (!actionText || actionText.length > 80) throw new Error("daily unsigned form requires an exact action text");
  const actionTexts = raw.actionTexts ?? [actionText];
  if (!Array.isArray(actionTexts) || !actionTexts.length || actionTexts.length > 4
    || actionTexts.some(text => typeof text !== 'string' || !text.trim() || text.length > 80)) {
    throw new Error('daily unsigned form requires bounded exact action texts');
  }
  if (raw.pendingChallenge != null && raw.pendingChallenge !== "turnstile") {
    throw new Error("daily unsigned form pending challenge must be turnstile");
  }
  if (raw.continuationWaitMs != null && (!Number.isInteger(raw.continuationWaitMs)
    || raw.continuationWaitMs < 0 || raw.continuationWaitMs > 60000)) {
    throw new Error('daily unsigned form continuation wait must be between 0 and 60000 milliseconds');
  }
  let pendingAction;
  if (raw.pendingAction != null) {
    const selector = String(raw.pendingAction.selector ?? "").trim();
    const text = normalizeText(raw.pendingAction.text ?? "");
    if (!selector || selector.length > 300 || !text || text.length > 80 || raw.pendingAction.disabled !== true) {
      throw new Error("daily unsigned pending action requires an exact disabled control");
    }
    pendingAction = { selector, text, disabled: true };
  }
  let verifiedAction;
  if (raw.verifiedAction != null) {
    const selector = String(raw.verifiedAction.selector ?? '').trim();
    const text = normalizeText(raw.verifiedAction.text ?? '');
    const label = value => raw.ignoreActionDecorations === true
      ? value.replace(/[\p{P}\p{S}\s]/gu, '') : value;
    if (raw.pendingChallenge !== 'turnstile' || !selector || selector.length > 300
      || !text || text.length > 80 || !actionTexts.some(value => label(normalizeText(value)) === label(text))) {
      throw new Error('daily unsigned verified action requires an exact configured Turnstile submit control');
    }
    verifiedAction = { selector, text };
  }
  return { visibleSelectors: selectors("visibleSelectors"), nonEmptyValueSelectors: selectors("nonEmptyValueSelectors"),
    emptyValueSelectors: selectors("emptyValueSelectors"), actionText, actionTexts: [...new Set([actionText, ...actionTexts])],
    ignoreActionDecorations: raw.ignoreActionDecorations === true, ...(pendingAction ? { pendingAction } : {}),
    ...(verifiedAction ? { verifiedAction } : {}),
    ...(raw.continuationWaitMs > 0 ? { continuationWaitMs: raw.continuationWaitMs } : {}),
    ...(raw.pendingChallenge ? { pendingChallenge: raw.pendingChallenge } : {}) };
}

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
  const missingControlPaths = raw.terminalMissingControlPaths ?? ["/", "/index.php"];
  if (raw.terminalRequireAuthenticatedPage === true && (!Array.isArray(missingControlPaths)
    || missingControlPaths.length < 1 || missingControlPaths.length > 4
    || missingControlPaths.some((value) => typeof value !== "string" || !value.startsWith("/")
      || value.startsWith("//") || value.includes("?") || value.includes("#")))) {
    throw new Error("missing-control terminal confirmation requires exact home paths");
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
  let completedTextPattern;
  if (raw.completedTextPattern != null) {
    if (typeof raw.completedTextPattern !== "string" || !raw.completedTextPattern.trim()
      || raw.completedTextPattern.length > 300 || new RegExp(raw.completedTextPattern, "iu").test("")) {
      throw new Error("pre-check-in completion pattern must be bounded and non-empty");
    }
    completedTextPattern = raw.completedTextPattern;
  }

  return {
    expectedPath,
    steps,
    ...(completedTextPattern ? { completedTextPattern } : {}),
    ...(raw.dailyUnsignedForm ? { dailyUnsignedForm: dailyUnsignedFormRule(raw.dailyUnsignedForm) } : {}),
    ...(raw.readOnlyFallbackToExpectedPath === true ? { readOnlyFallbackToExpectedPath: true } : {}),
    ...(normalizedTerminalPaths.length > 0 ? { terminalPaths: normalizedTerminalPaths } : {}),
    ...(raw.terminalWhenNavigationControlMissing === true
      ? { terminalWhenNavigationControlMissing: true }
      : {}),
    ...(raw.terminalRequireAuthenticatedPage === true
      ? { terminalRequireAuthenticatedPage: true, terminalMissingControlPaths: [...new Set(missingControlPaths)] }
      : {}),
    waitMs: Math.max(500, Math.min(30_000, Number(raw.waitMs) || 3_000)),
    afterClickWaitMs: Math.max(100, Math.min(3_000, Number(raw.afterClickWaitMs) || 500)),
  };
}

// Negative daily evidence must come from the current authenticated form reached
// through the site's visible navigation. A button or missing success text alone
// must never release an older uncertain submission.
async function readConfiguredDailyFormSnapshot(page, form) {
  return page.evaluate(form => {
    const visible = element => {
      if (!element) return false;
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const unique = selector => { const nodes = document.querySelectorAll(selector); return nodes.length === 1 ? nodes[0] : null; };
    const valueMatches = (selector, nonEmpty) => {
      const element = unique(selector);
      return !!element && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
        && (String(element.value).trim().length > 0) === nonEmpty;
    };
    const pending = form.pendingAction ? unique(form.pendingAction.selector) : null;
    const response = unique('input[name="cf-turnstile-response"]');
    const label = value => form.ignoreActionDecorations ? String(value).replace(/[\p{P}\p{S}\s]/gu, '')
      : String(value).replace(/\s+/g, ' ').trim();
    const controls = [...document.querySelectorAll('button,input[type="submit"]')];
    const action = controls.filter(element => visible(element)
      && form.actionTexts.some(text => label(element.innerText || element.value || '') === label(text)));
    const pendingActionReady = !!pending && visible(pending) && ["BUTTON", "INPUT"].includes(pending.tagName)
      && (pending.disabled === true || pending.getAttribute("aria-disabled") === "true")
      && label(pending.innerText || pending.value || '') === label(form.pendingAction.text);
    const responseForm = response?.closest('form');
    const boundControl = action.length === 1 ? action[0] : pendingActionReady ? pending : null;
    const sameOriginForm = responseForm && (() => {
      try { const override = boundControl?.getAttribute('formaction');
        const destination = new URL(override ?? responseForm.action ?? location.href, location.href);
        return destination.origin === location.origin && !destination.username && !destination.password;
      } catch { return false; }
    })();
    const boundResponse = !!sameOriginForm && responseForm === boundControl?.closest('form')
      && [...form.nonEmptyValueSelectors, ...form.emptyValueSelectors].every(selector => unique(selector)?.closest('form') === responseForm);
    const challengeSelectors = [...document.querySelectorAll('#sl-check,.cf-turnstile,iframe[src*="captcha" i],iframe[src*="challenge" i],iframe[src*="turnstile" i],.h-captcha,.g-recaptcha,altcha-widget')].some(visible);
    const verified = form.verifiedAction ? unique(form.verifiedAction.selector) : null;
    // Some sites consume the widget response before enabling their server-issued
    // submit form. This fallback requires an explicit local label, the same
    // bound form and no remaining visible challenge; a ready button alone is
    // never sufficient.
    const verifiedActionReady = !!verified && verified === boundControl && visible(verified)
      && ['BUTTON', 'INPUT'].includes(verified.tagName) && !verified.disabled
      && verified.getAttribute('aria-disabled') !== 'true'
      && label(verified.innerText || verified.value || '') === label(form.verifiedAction.text)
      && boundResponse && !challengeSelectors;
    const verifiedTurnstile = form.pendingChallenge === 'turnstile' && boundResponse
      && (String(response.value ?? '').trim() !== '' || verifiedActionReady) && action.length === 1
      && !action[0].disabled && action[0].getAttribute('aria-disabled') !== 'true';
    return {
      bodyText: String(document.body?.innerText ?? ""),
      loaded: document.readyState === "complete",
      authenticated: [...document.querySelectorAll("a")].some(a => visible(a) && /log[-_]?out|exit\.php/i.test(a.getAttribute("href") ?? "")),
      hasPassword: [...document.querySelectorAll('input[type="password"]')].some(visible),
      challengeSelectors,
      pendingTurnstile: form.pendingChallenge === "turnstile" && !!response
        && String(response.value ?? "").trim() === "" && boundResponse,
      verifiedTurnstile,
      actionIndex: action.length === 1 ? controls.indexOf(action[0]) : -1,
      otherChallengeSelectors: [...document.querySelectorAll('#sl-check,.h-captcha,.g-recaptcha,altcha-widget,iframe[src*="captcha" i]:not([src*="challenges.cloudflare.com" i])')].some(visible),
      formReady: form.visibleSelectors.every(selector => visible(unique(selector)))
        && form.nonEmptyValueSelectors.every(selector => valueMatches(selector, true))
        && form.emptyValueSelectors.every(selector => valueMatches(selector, false)
          || verifiedTurnstile && unique(selector) === response),
      pendingActionReady,
    };
  }, form);
}

export async function inspectConfiguredDailyUnsignedForm(page, target, activeOrigin, config) {
  const rule = getConfiguredPreCheckinNavigationRule(target, activeOrigin, config);
  if (!rule?.dailyUnsignedForm) return null;
  const url = assertBookmarkNavigation(page.url(), target.allowedOrigins ?? [target.origin]);
  if (new URL(url).origin !== activeOrigin || new URL(url).pathname !== rule.expectedPath) return null;
  const snapshot = await readConfiguredDailyFormSnapshot(page, rule.dailyUnsignedForm);
  // This proves only that today's server-issued form is unsigned. Verification
  // stays pending and the ordinary challenge phase must finish before submit.
  const frames = rule.dailyUnsignedForm.pendingChallenge === "turnstile" && (snapshot.pendingTurnstile || snapshot.verifiedTurnstile)
    ? await readCloudflareFrameEvidence(page, activeOrigin) : [];
  const pendingTurnstile = snapshot.pendingTurnstile === true && !snapshot.otherChallengeSelectors
    && frames.length === 1 && !frames[0].responsePresent && !frames[0].resolvedState;
  const verifiedTurnstile = snapshot.verifiedTurnstile === true && !snapshot.otherChallengeSelectors
    && frames.length <= 1 && frames.every(frame => frame.responsePresent || frame.resolvedState);
  const challengeAllowed = pendingTurnstile || verifiedTurnstile;
  // Configured form instructions are not a separate blocking challenge. Only
  // the explicitly bound pending widget may prove unsigned readiness.
  const state = classifyPageText({ url, ...snapshot, challengeSelectors: snapshot.challengeSelectors && !challengeAllowed,
    resolvedChallengeSelectors: true });
  if (!snapshot.loaded || !snapshot.authenticated || snapshot.hasPassword || (snapshot.challengeSelectors && !challengeAllowed) || !snapshot.formReady
    || (rule.dailyUnsignedForm.pendingChallenge === 'turnstile' && !challengeAllowed)
    || state.status !== "ready") return null;
  if (!snapshot.pendingActionReady && !verifiedTurnstile) {
    const action = page.getByText(rule.dailyUnsignedForm.actionText, { exact: true });
    if (await action.count() !== 1 || !await action.isVisible() || !await action.isEnabled()) return null;
  }
  if (page.url() !== url) return null;
  return dailyReadinessEvidence(target, config, { observedOrigin: activeOrigin });
}

export async function findConfiguredVerifiedFormAction(page, target, activeOrigin, config) {
  const rule = getConfiguredPreCheckinNavigationRule(target, activeOrigin, config);
  if (rule?.dailyUnsignedForm?.pendingChallenge !== 'turnstile'
    || new URL(page.url()).pathname !== rule.expectedPath) return null;
  if (!await inspectConfiguredDailyUnsignedForm(page, target, activeOrigin, config)) return null;
  const snapshot = await readConfiguredDailyFormSnapshot(page, rule.dailyUnsignedForm);
  if (!snapshot.verifiedTurnstile || snapshot.actionIndex < 0) return null;
  const action = page.locator('button,input[type="submit"]').nth(snapshot.actionIndex);
  return await action.isVisible() && await action.isEnabled() ? action : null;
}

export async function inspectConfiguredFormCompletion(page, config = {}) {
  if (!Object.values(config.preCheckinNavigationRules ?? {}).some(rule => rule?.completedTextPattern)) return null;
  let url;
  try { url = new URL(page.url()); } catch { return null; }
  const target = { origin: url.origin, allowedOrigins: [url.origin] };
  const rule = getConfiguredPreCheckinNavigationRule(target, url.origin, config);
  if (!rule?.completedTextPattern || url.pathname !== rule.expectedPath) return null;
  const snapshot = await page.evaluate(({ pattern, actionTexts, ignoreActionDecorations }) => {
    const visible = element => {
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const bodyText = String(document.body?.innerText ?? '');
    return {
      bodyText, loaded: document.readyState === 'complete',
      matched: new RegExp(pattern, 'iu').test(bodyText),
      authenticated: [...document.querySelectorAll('a')].some(a => visible(a) && /log[-_]?out|exit\.php/i.test(a.getAttribute('href') ?? '')),
      hasPassword: [...document.querySelectorAll('input[type="password"]')].some(visible),
      challengeSelectors: [...document.querySelectorAll('#sl-check,.cf-turnstile,iframe[src*="captcha" i],iframe[src*="challenge" i],iframe[src*="turnstile" i],.h-captcha,.g-recaptcha,altcha-widget')].some(visible),
      actionVisible: [...document.querySelectorAll('button,input[type="submit"]')].some(element => visible(element)
        && actionTexts.some(text => {
          const label = value => ignoreActionDecorations ? String(value).replace(/[\p{P}\p{S}\s]/gu, '') : String(value).replace(/\s+/g, ' ').trim();
          return label(element.innerText || element.value || '') === label(text);
        })),
    };
  }, { pattern: rule.completedTextPattern, actionTexts: rule.dailyUnsignedForm?.actionTexts ?? [],
    ignoreActionDecorations: rule.dailyUnsignedForm?.ignoreActionDecorations === true });
  const state = classifyPageText({ url: url.href, ...snapshot });
  if (!snapshot.loaded || !snapshot.authenticated || !snapshot.matched || snapshot.hasPassword
    || snapshot.challengeSelectors || snapshot.actionVisible || page.url() !== url.href
    || !['ready', 'signed', 'already_signed'].includes(state.status)
    || state.reason === '页面明确显示尚未签到') return null;
  const frames = await readCloudflareFrameEvidence(page, url.origin);
  if (frames.some(frame => !frame.responsePresent && !frame.resolvedState) || page.url() !== url.href) return null;
  return { status: 'signed', reason: '配置的签到结果页明确确认完成',
    evidence: successEvidence('page_text', 'configured_form_completion') };
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
  return /\/(?:user(?:[-_/])?)?(?:log[-_]?in|sign[-_]?in)(?:\.php|\/|$)/i.test(pathname);
}

function navigationLocator(page, step) {
  return step.selector
    ? page.locator(step.selector)
    : page.getByRole(step.role, { name: step.name, exact: true });
}

export async function verifyMissingNavigationControl(page, target, activeOrigin, config, stepIndex = 0) {
  const rule = getConfiguredPreCheckinNavigationRule(target, activeOrigin, config);
  if (!rule?.terminalRequireAuthenticatedPage) return { terminalNoAction: true };
  const allowedOrigins = target.allowedOrigins ?? [target.origin];
  let previousUrl = null;
  for (let observation = 0; observation < 2; observation += 1) {
    if (/^(?:chrome|edge)-error:\/\//.test(page.url())) return { terminalUnconfirmed: { status: 'needs_attention',
      failureCode: 'terminal_browser_error', reason: '浏览器错误页不能证明首页签到入口已消失' } };
    const url = assertBookmarkNavigation(page.url(), allowedOrigins);
    if (!rule.terminalMissingControlPaths.includes(new URL(url).pathname)) {
      return { terminalUnconfirmed: { status: "unconfirmed", reason: "签到入口消失，但当前页面不是配置的首页", failureCode: "terminal_home_unconfirmed" } };
    }
    const snapshot = await page.evaluate(({ origin, expectedPath }) => {
      const visible = (element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const bodyText = String(document.body?.innerText ?? "");
      const controls = [...document.querySelectorAll('a,button,input[type="submit"],[role="button"]')].filter(visible);
      return {
        bodyText,
        errorDocument: !!document.querySelector('#main-frame-error') && /\bERR_BLOCKED_BY_CLIENT\b/.test(bodyText),
        loaded: document.readyState === "complete" && bodyText.trim().length > 100,
        authenticated: controls.some((element) => /log[-_]?out|exit\.php/i.test(element.getAttribute("href") ?? "")
          || /^(?:退出|登出|注销|退出登录|Log out|Logout)$/i.test(String(element.innerText ?? "").trim())),
        expectedNavigationPresent: controls.some(element => {
          if (element.tagName !== 'A' || !element.getAttribute('href')) return false;
          try {
            const destination = new URL(element.getAttribute('href'), location.href);
            return destination.origin === origin && destination.pathname === expectedPath;
          } catch { return false; }
        }),
        hasPassword: [...document.querySelectorAll('input[type="password"]')].some(visible),
        challengeSelectors: [...document.querySelectorAll('#sl-check,iframe[src*="captcha" i],iframe[src*="challenge" i],iframe[src*="turnstile" i],.cf-turnstile,.h-captcha,.g-recaptcha,altcha-widget')].some(visible),
      };
    }, { origin: activeOrigin, expectedPath: rule.expectedPath });
    if (snapshot.errorDocument) return { terminalUnconfirmed: { status: 'needs_attention',
      failureCode: 'daily_form_browser_request_blocked', reason: '客户端拦截错误页不能证明首页签到入口已消失' } };
    const state = classifyPageText({ url, ...snapshot });
    if (["login_required", "interactive_challenge", "managed_challenge", "deferred"].includes(state.status)) {
      return { terminalUnconfirmed: state };
    }
    if (!snapshot.loaded || !snapshot.authenticated || snapshot.hasPassword) {
      return { terminalUnconfirmed: { status: "unconfirmed", reason: "签到入口消失，但首页加载或有效登录尚未确认", failureCode: "terminal_session_unconfirmed" } };
    }
    if (snapshot.expectedNavigationPresent) {
      return { terminalUnconfirmed: { status: "unconfirmed", reason: "首页仍有通往签到页的可见链接，不能按旧入口消失确认完成", failureCode: "terminal_navigation_changed" } };
    }
    const locator = navigationLocator(page, rule.steps[stepIndex]);
    const count = await locator.count();
    if (count > 20) throw new Error("pre-check-in navigation candidate set is too large");
    for (let index = 0; index < count; index += 1) {
      if (await locator.nth(index).isVisible().catch(() => false)) {
        return { terminalUnconfirmed: { status: "unconfirmed", reason: "签到入口重新出现，不能按入口消失确认完成", failureCode: "terminal_control_reappeared" } };
      }
    }
    if (page.url() !== url || (previousUrl && previousUrl !== url)) {
      return { terminalUnconfirmed: { status: "unconfirmed", reason: "首页仍在跳转，签到入口消失信号尚不稳定", failureCode: "terminal_page_unstable" } };
    }
    previousUrl = url;
    if (observation === 0) await page.waitForTimeout(500);
  }
  return { terminalNoAction: true };
}

async function waitForUniqueNavigationCandidate(page, step, waitMs, allowedOrigins, terminalPaths = []) {
  const locator = navigationLocator(page, step);
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
  { hasCheckinAction = false, readOnlyLinksOnly = false } = {},
) {
  const rule = getConfiguredPreCheckinNavigationRule(target, activeOrigin, config);
  if (!rule) return false;
  // Native quarantine verification may follow one explicitly configured
  // result-page link, but must never click a button or execute a JS action.
  if (readOnlyLinksOnly && (config.checkinReadOnly !== true || !rule.readOnlyFallbackToExpectedPath
    || rule.terminalWhenNavigationControlMissing || rule.steps.length !== 1
    || rule.steps[0].role !== 'link' || rule.steps[0].allowHidden)) return false;
  const allowedOrigins = target.allowedOrigins ?? [target.origin];
  const initialUrl = assertBookmarkNavigation(page.url(), allowedOrigins);
  const initialPath = new URL(initialUrl).pathname;
  if (rule.terminalPaths?.includes(initialPath)) return { terminalPath: initialPath };
  if (hasCheckinAction
    || initialPath === rule.expectedPath
    || isLoginPath(initialPath)) return false;

  for (const [stepIndex, step] of rule.steps.entries()) {
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
      if (config.checkinReadOnly === true && rule.readOnlyFallbackToExpectedPath === true
        && !rule.terminalWhenNavigationControlMissing
        && error instanceof Error && error.message === "pre-check-in navigation control was not found") {
        const snapshot = await page.evaluate(() => {
          const visible = element => { const box = element.getBoundingClientRect(), style = getComputedStyle(element);
            return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden"; };
          return { bodyText: String(document.body?.innerText ?? ""), loaded: document.readyState === "complete",
            authenticated: [...document.querySelectorAll("a")].some(a => visible(a) && /log[-_]?out|exit\.php/i.test(a.getAttribute("href") ?? "")),
            hasPassword: [...document.querySelectorAll('input[type="password"]')].some(visible),
            challengeSelectors: [...document.querySelectorAll('#sl-check,.cf-turnstile,iframe[src*="challenge" i],iframe[src*="turnstile" i],.h-captcha,.g-recaptcha')].some(visible) };
        });
        const url = assertBookmarkNavigation(page.url(), allowedOrigins);
        const state = classifyPageText({ url, ...snapshot });
        if (!snapshot.loaded || !snapshot.authenticated || snapshot.hasPassword || snapshot.challengeSelectors
          || !["ready", "signed", "already_signed"].includes(state.status)) return { terminalUnconfirmed: state };
        await page.goto(assertBookmarkNavigation(`${activeOrigin}${rule.expectedPath}`, allowedOrigins), {
          waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs,
        });
        await page.waitForTimeout(rule.afterClickWaitMs);
        assertBookmarkNavigation(page.url(), allowedOrigins);
        return new URL(page.url()).pathname === rule.expectedPath;
      }
      if (rule.terminalWhenNavigationControlMissing
        && error instanceof Error
        && error.message === "pre-check-in navigation control was not found") {
        return verifyMissingNavigationControl(page, target, activeOrigin, config, stepIndex);
      }
      throw error;
    }
    if (!selected) return false;
    if (selected.terminalPath) return selected;
    if (readOnlyLinksOnly) {
      const href = await selected.locator.getAttribute('href');
      if (!href) return false;
      let destination;
      try { destination = new URL(href, page.url()); } catch { return false; }
      if (destination.origin !== activeOrigin || destination.pathname !== rule.expectedPath
        || destination.protocol !== 'https:' || destination.username || destination.password
        || destination.search || destination.hash) return false;
      await page.goto(assertBookmarkNavigation(destination.href, allowedOrigins), {
        waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs,
      });
    } else if (selected.allowHidden) {
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
