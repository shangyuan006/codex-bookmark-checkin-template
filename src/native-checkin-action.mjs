import { normalizeText } from "./detector.mjs";
import { assertBookmarkNavigation } from "./security.mjs";

const ACTION_SELECTOR = 'button, a, [role="button"], input[type="button"], input[type="submit"]';

function normalizedStringArray(values, label, maximum) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const normalized = [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))];
  if (normalized.length > maximum) throw new Error(`${label} contains too many entries`);
  if (normalized.some((value) => value.length > 120)) throw new Error(`${label} contains an oversized entry`);
  return normalized;
}

export function normalizeNativeCheckinActionRule(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("native check-in action rule must be an object");
  }
  const actionTexts = normalizedStringArray(raw.actionTexts, "actionTexts", 10);
  const dismissButtonTexts = normalizedStringArray(raw.dismissButtonTexts, "dismissButtonTexts", 10);
  const dismissSelectors = normalizedStringArray(raw.dismissSelectors, "dismissSelectors", 10);
  if (actionTexts.length === 0) throw new Error("native check-in action rule requires actionTexts");
  return {
    actionTexts,
    dismissButtonTexts,
    dismissSelectors,
    maxDismissals: Math.max(0, Math.min(5, Number(raw.maxDismissals) || 3)),
    dismissWaitMs: Math.max(250, Math.min(10_000, Number(raw.dismissWaitMs) || 3000)),
    clickChallenge: raw.clickChallenge === true,
  };
}

export function nativeChallengeFrameIsAllowed(rawUrl, expectedOrigin) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:"
      && url.origin !== expectedOrigin
      && (url.hostname === "challenges.cloudflare.com"
        || url.hostname.endsWith(".challenges.cloudflare.com"));
  } catch {
    return false;
  }
}

export function nativeActionCandidateIsSafe(candidate, expectedOrigin) {
  if (!candidate?.visible || candidate.disabled) return false;
  for (const rawDestination of [candidate.href, candidate.formAction]) {
    if (!rawDestination) continue;
    try {
      if (new URL(rawDestination, `${expectedOrigin}/`).origin !== expectedOrigin) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function matchesNativeCompletedControlText(value) {
  return /^(?:(?:今日|今天|当日|當日)\s*)?已\s*(?:签到|簽到)$/.test(normalizeText(value));
}

async function visibleLocators(locators) {
  const visible = [];
  for (const locator of locators) {
    const count = Math.min(20, await locator.count());
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
    }
  }
  return visible;
}

async function waitForDismissCandidate(page, rule) {
  const deadline = Date.now() + rule.dismissWaitMs;
  do {
    let candidates = await visibleLocators(rule.dismissSelectors.map((selector) => page.locator(selector)));
    if (candidates.length === 0) {
      candidates = await visibleLocators(rule.dismissButtonTexts.map((text) => (
        page.getByRole("button", { name: text, exact: true })
      )));
    }
    if (candidates.length > 0 || Date.now() >= deadline) return candidates.at(-1) ?? null;
    await page.waitForTimeout(250);
  } while (true);
}

export async function dismissNativeCheckinOverlays(page, expectedOrigin, rawRule) {
  const rule = normalizeNativeCheckinActionRule(rawRule);
  let dismissed = 0;
  while (dismissed < rule.maxDismissals) {
    assertBookmarkNavigation(page.url(), [expectedOrigin]);
    const candidate = await waitForDismissCandidate(page, rule);
    if (!candidate) break;
    await candidate.click({ timeout: 10_000 });
    dismissed += 1;
    await page.waitForTimeout(500);
  }
  return dismissed;
}

export async function clickUniqueNativeCheckinAction(page, expectedOrigin, rawRule) {
  const rule = normalizeNativeCheckinActionRule(rawRule);
  assertBookmarkNavigation(page.url(), [expectedOrigin]);
  const raw = await page.locator(ACTION_SELECTOR).evaluateAll((elements) => elements.slice(0, 400).map((element, index) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      index,
      text: String(element.innerText || element.value || element.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ").trim(),
      visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      href: element instanceof HTMLAnchorElement ? element.href : null,
      formAction: element.form ? element.form.action : null,
    };
  }));
  const candidates = raw.filter((candidate) => rule.actionTexts.includes(normalizeText(candidate.text)))
    .filter((candidate) => nativeActionCandidateIsSafe(candidate, expectedOrigin));
  if (candidates.length !== 1) {
    return { clicked: false, outcome: candidates.length === 0 ? "action_not_found" : "action_not_unique" };
  }
  await page.locator(ACTION_SELECTOR).nth(candidates[0].index).click({ timeout: 10_000 });
  assertBookmarkNavigation(page.url(), [expectedOrigin]);
  return { clicked: true, outcome: "clicked" };
}

export async function clickVisibleNativeChallengeControl(page, expectedOrigin, rawRule) {
  const rule = normalizeNativeCheckinActionRule(rawRule);
  if (!rule.clickChallenge) return { clicked: false, outcome: "challenge_not_configured" };
  assertBookmarkNavigation(page.url(), [expectedOrigin]);

  const directCandidates = [];
  const labelCandidates = [];
  const frameClickCandidates = [];
  const addFrameClickCandidate = (frameBox) => {
    if (!frameBox
      || frameBox.width < 180 || frameBox.width > 500
      || frameBox.height < 40 || frameBox.height > 180) return;
    const duplicate = frameClickCandidates.some((candidate) => (
      Math.abs(candidate.x - frameBox.x) < 2
      && Math.abs(candidate.y - frameBox.y) < 2
      && Math.abs(candidate.width - frameBox.width) < 2
      && Math.abs(candidate.height - frameBox.height) < 2
    ));
    if (!duplicate) frameClickCandidates.push(frameBox);
  };
  let allowedFrameCount = 0;
  for (const frame of page.frames()) {
    if (!nativeChallengeFrameIsAllowed(frame.url(), expectedOrigin)) continue;
    allowedFrameCount += 1;
    const frameElement = await frame.frameElement().catch(() => null);
    const frameBox = await frameElement?.boundingBox().catch(() => null);
    addFrameClickCandidate(frameBox);
    const controls = frame.locator([
      'input[type="checkbox"]',
      '[role="checkbox"]',
      '[aria-checked][tabindex]',
    ].join(", "));
    const count = Math.min(20, await controls.count());
    for (let index = 0; index < count; index += 1) {
      const candidate = controls.nth(index);
      if (await candidate.isVisible().catch(() => false)
        && await candidate.isEnabled().catch(() => true)) {
        directCandidates.push(candidate);
      }
    }

    const labels = frame.locator('label:has(input[type="checkbox"]), label[for]');
    const labelCount = Math.min(20, await labels.count());
    for (let index = 0; index < labelCount; index += 1) {
      const candidate = labels.nth(index);
      const associatedWithChallengeControl = await candidate.evaluate((label) => {
        const control = label.control
          || (label.htmlFor ? document.getElementById(label.htmlFor) : null)
          || label.querySelector('input[type="checkbox"], [role="checkbox"], [aria-checked]');
        return Boolean(control?.matches?.('input[type="checkbox"], [role="checkbox"], [aria-checked]'));
      }).catch(() => false);
      if (associatedWithChallengeControl
        && await candidate.isVisible().catch(() => false)
        && await candidate.isEnabled().catch(() => true)) {
        labelCandidates.push(candidate);
      }
    }
  }

  const parentFrames = page.locator('iframe[src]');
  const parentFrameCount = Math.min(20, await parentFrames.count());
  let allowedParentFrameCount = 0;
  for (let index = 0; index < parentFrameCount; index += 1) {
    const candidate = parentFrames.nth(index);
    const src = await candidate.getAttribute('src').catch(() => null);
    if (!nativeChallengeFrameIsAllowed(src, expectedOrigin)
      || !await candidate.isVisible().catch(() => false)) continue;
    allowedParentFrameCount += 1;
    addFrameClickCandidate(await candidate.boundingBox().catch(() => null));
  }

  const candidates = directCandidates.length > 0 ? directCandidates : labelCandidates;
  const details = {
    allowedFrameCount,
    allowedParentFrameCount,
    directCandidateCount: directCandidates.length,
    labelCandidateCount: labelCandidates.length,
    frameClickCandidateCount: frameClickCandidates.length,
  };
  if (candidates.length === 0 && frameClickCandidates.length === 1) {
    const box = frameClickCandidates[0];
    try {
      await page.mouse.click(box.x + Math.min(38, box.width * 0.15), box.y + box.height / 2);
      assertBookmarkNavigation(page.url(), [expectedOrigin]);
      return { clicked: true, outcome: "challenge_frame_clicked", details };
    } catch {
      return { clicked: false, outcome: "challenge_click_failed", details };
    }
  }
  if (candidates.length === 0) return { clicked: false, outcome: "challenge_not_found", details };
  if (candidates.length !== 1) return { clicked: false, outcome: "challenge_not_unique", details };
  try {
    await candidates[0].click({ timeout: 5_000 });
    assertBookmarkNavigation(page.url(), [expectedOrigin]);
    return { clicked: true, outcome: "challenge_clicked", details };
  } catch {
    return { clicked: false, outcome: "challenge_click_failed", details };
  }
}
