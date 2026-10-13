import { createRequire } from "node:module";
import fs from "node:fs/promises";
import { runNewApiCheckinInBrowser, tryConfiguredSequentialActions } from "./browser.mjs";
import { bindNativeCompletion } from './native-completion-evidence.mjs';
import { readNativeCheckinState, waitForNativeReadOnlyCompletion, resumeNativeDailyCycle } from "./native-checkin-state.mjs";
import { connectOverCdpWithRetry, evaluateOverRawCdp } from "./native-cdp.mjs";
import {
  clickVisibleNativeChallengeControl,
  clickVisibleNativeSafeLineControl,
  normalizeNativeCheckinActionRule,
  waitForNativeCheckinAction,
} from "./native-checkin-action.mjs";
import { pagesForOrigin, selectNewestOriginPage } from "./native-page-selection.mjs";
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSubmissionScope, attachSubmissionScope, guardPageSubmissions, quarantineResult } from './submission-guard.mjs';
import { successEvidence } from './checkin-evidence.mjs';
import { dailyReadinessEvidence } from "./checkin-evidence.mjs";
import { reconcileSubmissionResult,partitionSubmissions } from "./submission-guard.mjs";

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
config.submissionJournalPath = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))),'data/submission-journal.json');
const scope = createSubmissionScope(config.submissionJournalPath,{origin:expectedOrigin},config);
const outstanding = await scope.pending();
let mayExecuteCheckin = executeCheckin && outstanding.length===0;
async function nativeEvidence(result,source='page_text',page=null) {
  if(result.status==="not_signed" && result.dailyUnsigned===true) return dailyReadinessEvidence({origin:expectedOrigin},config,{source:"status_endpoint"});
  if (source==='status_endpoint'&&/页面签到控件/.test(result.reason??'')) source='page_text';
  if (allowEndpointReady&&result.status==='ready'&&result.siteBodyLoaded&&result.attendanceEndpoint) {
    const bound=await bindNativeCompletion({...result,status:'signed',evidence:successEvidence('user_rule','configured_native_visit_confirmed')},
      {origin:expectedOrigin},config,page ? activeConfig=>tryConfiguredSequentialActions(page,{origin:expectedOrigin},activeConfig) : null);
    return ['signed','already_signed'].includes(bound.status) ? {...bound,status:result.status} : bound;
  }
  return bindNativeCompletion({...result,origin:expectedOrigin,
    ...(['signed','already_signed'].includes(result.status) ? {evidence:successEvidence(source,'native_confirmed_completion')} : {}),
  },{origin:expectedOrigin},config,page ? activeConfig=>tryConfiguredSequentialActions(page,{origin:expectedOrigin},activeConfig) : null);
}
if (!Number.isInteger(port) || port <= 0) {
  throw new Error("usage: node src/native-browser-inspect.mjs <port> <origin> [max-wait-seconds] [mode] [action-rule-base64]");
}
if (!new Set(["require-confirmed", "allow-endpoint", "execute-checkin", "execute-new-api"]).has(inspectionMode)) {
  throw new Error("native browser inspection mode is invalid");
}

async function readPageState(page) {
  return readNativeCheckinState(page,expectedOrigin,config,{unsignedRule:actionRule});
}

async function inspectNewApiWithRawCdp() {
  const probeExpression = `(async () => ({state: await (${runNewApiCheckinInBrowser.toString()})({readOnly:true})}))()`;
  const probe = await evaluateOverRawCdp(port,expectedOrigin,probeExpression,{readOnly:true,timeoutMs:15000,retryDelayMs:500});
  if (partitionSubmissions(outstanding,{origin:expectedOrigin},config).current.length || probe?.state?.status!=="not_signed") {
    const result = await nativeEvidence(probe?.state??{status:'unconfirmed'},'status_endpoint');
    await scope.observe(result);
    const reconciled=reconcileSubmissionResult(result,await scope.allPending(),{origin:expectedOrigin},config);
    console.log(JSON.stringify({...reconciled,newApiConfirmed:["signed","already_signed"].includes(reconciled.status)}));
    return;
  }
  if(outstanding.length) await scope.beginNewCycleAfterVerifiedReadiness(await nativeEvidence(probe.state,"status_endpoint"));
  else await scope.begin();
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
  const confirmed = await nativeEvidence(state,'status_endpoint');
  if (state.status==='interactive_challenge') await scope.reject('challenge_rejected');
  await scope.observe(confirmed);
  const reconciled=reconcileSubmissionResult(confirmed,await scope.allPending(),{origin:expectedOrigin},config);
  const newApiConfirmed = ["signed", "already_signed"].includes(reconciled.status);
  console.log(JSON.stringify({
    ...reconciled,
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
  attachSubmissionScope(page,scope);
  if (executeCheckin && !mayExecuteCheckin) {
    await guardPageSubmissions(page, { origin: expectedOrigin }, scope, { readOnly: () => !mayExecuteCheckin });
  }

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
  let current = executeCheckin && !mayExecuteCheckin
    ? await waitForNativeReadOnlyCompletion(page, expectedOrigin, config, {
      timeoutMs: Math.max(0, pageDeadline - Date.now()),
      readState: readPageState,
    })
    : await readPageState(page);
  if (executeCheckin && !mayExecuteCheckin) {
    mayExecuteCheckin = await resumeNativeDailyCycle(scope, current, expectedOrigin, config);
  }
  if (mayExecuteCheckin && !["signed", "already_signed"].includes(current.state.status)) {
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
      if (mayExecuteCheckin && canInteract && !safeLineAttempted) {
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
      if (mayExecuteCheckin && canInteract && retryableChallengeOutcomes.has(challengeOutcome)) {
        const challenge = await clickVisibleNativeChallengeControl(page, expectedOrigin, actionRule);
        challengeDetails = challenge.details ?? challengeDetails;
        challengeOutcome = challenge.outcome;
      }
      current = await readPageState(page);
      if (mayExecuteCheckin && !actionAttempted && current.state.status === "ready") {
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
  const verified = await nativeEvidence(output,'page_text',page);
  await scope.observe(verified);
  console.log(JSON.stringify(reconcileSubmissionResult(verified,await scope.allPending(),{origin:expectedOrigin},config)));
  } finally {
    await browser.close().catch(() => {});
  }
}

if (executeNewApiCheckin) await inspectNewApiWithRawCdp();
else await inspectWithPlaywright();
