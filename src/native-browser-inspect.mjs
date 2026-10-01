import { createRequire } from "node:module";
import fs from "node:fs/promises";
import { runNewApiCheckinInBrowser } from "./browser.mjs";
import { readNativeCheckinState } from "./native-checkin-state.mjs";
import { connectOverCdpWithRetry, evaluateOverRawCdp } from "./native-cdp.mjs";
import {
  clickVisibleNativeChallengeControl,
  clickVisibleNativeSafeLineControl,
  normalizeNativeCheckinActionRule,
  waitForNativeCheckinAction,
} from "./native-checkin-action.mjs";
import { pagesForOrigin, selectNewestOriginPage } from "./native-page-selection.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const port = Number.parseInt(process.argv[2], 10);
const expectedOrigin = new URL(process.argv[3]).origin;
const maxWaitSeconds = Math.max(0, Math.min(120, Number.parseInt(process.argv[4] || "0", 10) || 0));
const inspectionMode = process.argv[5] || "require-confirmed";
const allowEndpointReady = inspectionMode === "allow-endpoint";
const executeCheckin = inspectionMode === "execute-checkin";
const executeNewApiCheckin = inspectionMode === "execute-new-api";
const encodedActionRule = process.argv[6] || "";
const actionRule = executeCheckin
  ? normalizeNativeCheckinActionRule(JSON.parse(Buffer.from(encodedActionRule, "base64").toString("utf8")))
  : null;
const config = await fs.readFile(new URL('../config/config.json',import.meta.url),'utf8').then(JSON.parse).catch(error=>{
  if(error.code==='ENOENT') return {};
  throw error;
});
const retryableChallengeOutcomes = new Set([
  "pending",
  "challenge_not_found",
  "challenge_click_failed",
  "challenge_frame_not_stable",
]);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error("usage: node src/native-browser-inspect.mjs <port> <origin> [max-wait-seconds] [mode] [action-rule-base64]");
}
if (!new Set(["require-confirmed", "allow-endpoint", "execute-checkin", "execute-new-api"]).has(inspectionMode)) {
  throw new Error("native browser inspection mode is invalid");
}

async function readPageState(page) {
  return readNativeCheckinState(page,expectedOrigin,config);
}

async function inspectNewApiWithRawCdp() {
  const expression = `(async () => {
    const state = await (${runNewApiCheckinInBrowser.toString()})();
    return {
      state,
      siteBodyLoaded: String(document.body?.innerText || "").trim().length > 80,
    };
  })()`;
  const result = await evaluateOverRawCdp(port, expectedOrigin, expression, {
    timeoutMs: Math.max(5000, Math.min(15_000, maxWaitSeconds * 1000)),
    retryDelayMs: 500,
  });
  const state = result?.state ?? {
    status: "unconfirmed",
    reason: "native New API check-in did not return an authoritative status",
  };
  const newApiConfirmed = ["signed", "already_signed"].includes(state.status);
  console.log(JSON.stringify({
    status: state.status,
    siteBodyLoaded: Boolean(result?.siteBodyLoaded),
    attendanceEndpoint: false,
    actionAttempted: false,
    actionOutcome: "not_configured",
    challengeOutcome: "not_configured",
    challengeDetails: null,
    newApiAttempted: true,
    newApiConfirmed,
  }));
}

async function inspectWithPlaywright() {
  const browser = await connectOverCdpWithRetry(chromium, port, {
    timeoutMs: Math.max(5000, Math.min(15_000, maxWaitSeconds * 1000)),
    attemptTimeoutMs: 2000,
    retryDelayMs: 500,
  });
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
  let safeLineAttempted = false;
  let confirmationDeadline = pageDeadline;
  let current = await readPageState(page);
  if (executeCheckin && !["signed", "already_signed"].includes(current.state.status)) {
    const action = await waitForNativeCheckinAction(page, expectedOrigin, actionRule, {
      readState: async activePage => (await readPageState(activePage)).state,
      timeoutMs: maxWaitSeconds * 1000,
    });
    actionAttempted = action.clicked;
    actionOutcome = action.outcome;
    if (actionAttempted) confirmationDeadline = Date.now() + maxWaitSeconds * 1000;
  }

  let output = null;
  do {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
      current = await readPageState(page);
      const canInteract = !["signed", "already_signed", "login_required"].includes(current.state.status);
      if (executeCheckin && canInteract && !safeLineAttempted) {
        const safeLine = await clickVisibleNativeSafeLineControl(page, expectedOrigin, {
          waitMs: Math.min(30_000, Math.max(5_000, confirmationDeadline - Date.now())),
        });
        if (safeLine.attempted) {
          safeLineAttempted = true;
          challengeDetails = safeLine;
          challengeOutcome = safeLine.outcome;
        }
      }
      // Cloudflare may render its checkbox several seconds after the sign-in
      // click. Keep polling boundedly after an empty or failed probe so a late
      // challenge can still be clicked, while ambiguous controls remain fail-closed.
      if (executeCheckin && canInteract && retryableChallengeOutcomes.has(challengeOutcome)) {
        const challenge = await clickVisibleNativeChallengeControl(page, expectedOrigin, actionRule);
        challengeDetails = challenge.details ?? challengeDetails;
        challengeOutcome = challenge.outcome;
      }
      current = await readPageState(page);
      if (executeCheckin && !actionAttempted && current.state.status === "ready") {
        const action = await waitForNativeCheckinAction(page, expectedOrigin, actionRule, {
          readState: async activePage => (await readPageState(activePage)).state,
          timeoutMs: Math.max(0, confirmationDeadline - Date.now()),
        });
        actionAttempted = action.clicked;
        actionOutcome = action.outcome;
        if (actionAttempted) confirmationDeadline = Date.now() + maxWaitSeconds * 1000;
        current = await readPageState(page);
      }
      output = {
        status: current.state.status,
        failureCode: current.state.failureCode,
        retryable: current.state.retryable,
        siteBodyLoaded: current.siteBodyLoaded,
        attendanceEndpoint: current.attendanceEndpoint,
        actionAttempted,
        actionOutcome,
        challengeOutcome,
        challengeDetails,
        newApiAttempted: false,
        newApiConfirmed: false,
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
}

if (executeNewApiCheckin) await inspectNewApiWithRawCdp();
else await inspectWithPlaywright();
