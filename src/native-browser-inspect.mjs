import { createRequire } from "node:module";
import { classifyPageText } from "./detector.mjs";
import {
  clickVisibleNativeChallengeControl,
  clickUniqueNativeCheckinAction,
  dismissNativeCheckinOverlays,
  matchesNativeCompletedControlText,
  normalizeNativeCheckinActionRule,
} from "./native-checkin-action.mjs";
import { pagesForOrigin, selectNewestOriginPage } from "./native-page-selection.mjs";
import { assertBookmarkNavigation } from "./security.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const port = Number.parseInt(process.argv[2], 10);
const expectedOrigin = new URL(process.argv[3]).origin;
const maxWaitSeconds = Math.max(0, Math.min(120, Number.parseInt(process.argv[4] || "0", 10) || 0));
const inspectionMode = process.argv[5] || "require-confirmed";
const allowEndpointReady = inspectionMode === "allow-endpoint";
const executeCheckin = inspectionMode === "execute-checkin";
const encodedActionRule = process.argv[6] || "";
const actionRule = executeCheckin
  ? normalizeNativeCheckinActionRule(JSON.parse(Buffer.from(encodedActionRule, "base64").toString("utf8")))
  : null;
if (!Number.isInteger(port) || port <= 0) {
  throw new Error("usage: node src/native-browser-inspect.mjs <port> <origin> [max-wait-seconds] [mode] [action-rule-base64]");
}
if (!new Set(["require-confirmed", "allow-endpoint", "execute-checkin"]).has(inspectionMode)) {
  throw new Error("native browser inspection mode is invalid");
}

async function readPageState(page) {
  assertBookmarkNavigation(page.url(), [expectedOrigin]);
  const snapshot = await page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const controls = [...document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')]
      .filter(visible)
      .map((element) => String(element.innerText || element.value || element.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ").trim());
    return {
      bodyText: String(document.body?.innerText || "").slice(0, 30000),
      hasPassword: [...document.querySelectorAll('input[type="password"]')].some(visible),
      challengeSelectors: [...document.querySelectorAll('iframe[src*="captcha" i], iframe[src*="turnstile" i], iframe[src*="challenge" i], .cf-turnstile, .h-captcha, .g-recaptcha, cap-widget, altcha-widget')]
        .some(visible),
      controlTexts: controls,
    };
  });
  const state = classifyPageText({
    url: page.url(),
    title: await page.title(),
    bodyText: snapshot.bodyText,
    hasPassword: snapshot.hasPassword,
    challengeSelectors: snapshot.challengeSelectors,
    confirmedCheckinControl: snapshot.controlTexts.some(matchesNativeCompletedControlText),
  });
  return {
    state,
    siteBodyLoaded: snapshot.bodyText.trim().length > 80,
    attendanceEndpoint: /\/(?:attendance|check[-_]?in|showup)(?:\.php)?(?:[/?#]|$)/i.test(page.url()),
  };
}

let browser = null;
const connectDeadline = Date.now() + Math.max(5000, Math.min(15_000, maxWaitSeconds * 1000));
while (!browser && Date.now() < connectDeadline) {
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 });
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
if (!browser) throw new Error("unable to connect to the native browser debugging port");

try {
  const pageDeadline = Date.now() + maxWaitSeconds * 1000;
  let page = null;
  while (!page && Date.now() <= pageDeadline) {
    page = selectNewestOriginPage(
      browser.contexts().flatMap((context) => context.pages()),
      expectedOrigin,
    );
    if (!page) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!page) throw new Error("target origin was not found in the native browser");

  const duplicatePages = pagesForOrigin(
    browser.contexts().flatMap((context) => context.pages()),
    expectedOrigin,
  ).filter((candidate) => candidate !== page);
  for (const duplicate of duplicatePages) await duplicate.close().catch(() => {});

  await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  let actionAttempted = false;
  let actionOutcome = executeCheckin ? "not_attempted" : "not_configured";
  let challengeOutcome = executeCheckin && actionRule.clickChallenge ? "pending" : "not_configured";
  let challengeDetails = null;
  let confirmationDeadline = pageDeadline;
  let current = await readPageState(page);
  if (executeCheckin && !["signed", "already_signed"].includes(current.state.status)) {
    await dismissNativeCheckinOverlays(page, expectedOrigin, actionRule);
    current = await readPageState(page);
    if (current.state.status === "ready") {
      const action = await clickUniqueNativeCheckinAction(page, expectedOrigin, actionRule);
      actionAttempted = action.clicked;
      actionOutcome = action.outcome;
      if (actionAttempted) confirmationDeadline = Date.now() + maxWaitSeconds * 1000;
    }
  }

  let output = null;
  do {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
      if (executeCheckin && actionAttempted && challengeOutcome === "pending") {
        const challenge = await clickVisibleNativeChallengeControl(page, expectedOrigin, actionRule);
        challengeDetails = challenge.details ?? challengeDetails;
        if (challenge.outcome !== "challenge_not_found") challengeOutcome = challenge.outcome;
      }
      current = await readPageState(page);
      output = {
        status: current.state.status,
        siteBodyLoaded: current.siteBodyLoaded,
        attendanceEndpoint: current.attendanceEndpoint,
        actionAttempted,
        actionOutcome,
        challengeOutcome,
        challengeDetails,
      };
      const explicitlyConfirmed = ["signed", "already_signed"].includes(current.state.status);
      const endpointReady = allowEndpointReady && current.state.status === "ready"
        && current.siteBodyLoaded && current.attendanceEndpoint;
      const confirmationTimedOut = Date.now() >= confirmationDeadline;
      if (confirmationTimedOut && executeCheckin && actionAttempted && !explicitlyConfirmed) {
        actionOutcome = "confirmation_timeout";
        output.actionOutcome = actionOutcome;
      }
      if (explicitlyConfirmed || endpointReady || (executeCheckin && !actionAttempted) || confirmationTimedOut) break;
    } catch {
      if (Date.now() >= confirmationDeadline) throw new Error("native page did not stabilize before the deadline");
    }
    await page.waitForTimeout(1000);
  } while (true);
  console.log(JSON.stringify(output));
} finally {
  await browser.close().catch(() => {});
}
