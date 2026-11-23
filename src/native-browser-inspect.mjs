import { createRequire } from "node:module";
import fs from "node:fs/promises";
import { runNewApiCheckinInBrowser, tryConfiguredSequentialActions, runConfiguredCalendarDayCheckin } from "./browser.mjs";
import { bindNativeCompletion } from './native-completion-evidence.mjs';
import { readNativeCheckinState, waitForNativeReadOnlyCompletion, resumeNativeDailyCycle } from "./native-checkin-state.mjs";
import { createNativeSafeLineReader } from './native-safeline-recovery.mjs';
import { createNativeCloudflareReader } from './native-cloudflare-recovery.mjs';
import { watchNativeCheckinSubmissions, settleNativeVerificationRecovery, recoverRecordedNativeVerification, resumeNativeCycleFromStatus, nativeSubmissionHandoff } from './native-checkin-recovery.mjs';
import { connectOverCdpWithRetry, evaluateOverRawCdp } from "./native-cdp.mjs";
import {
  normalizeNativeCheckinActionRule,
  waitForNativeCheckinAction,
  clickVisibleNativeChallengeControl,
} from "./native-checkin-action.mjs";
import { pagesForOrigin, selectNewestOriginPage } from "./native-page-selection.mjs";
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSubmissionScope, attachSubmissionScope, guardPageSubmissions, quarantineResult, runWithSubmissionJournal, SUBMISSION_SCOPE } from './submission-guard.mjs';
import { newApiCheckinOptions } from './new-api-policy.mjs';
import { runConfiguredDailyFormCheckin } from './daily-form-checkin.mjs';
import { successEvidence } from './checkin-evidence.mjs';
import { dailyReadinessEvidence } from "./checkin-evidence.mjs";
import { reconcileSubmissionResult,partitionSubmissions } from "./submission-guard.mjs";
import { continueNativeSamePage } from './same-page-sequential.mjs';
import { verifyNativeVisitCheckin } from './native-visit-checkin.mjs';
import { selectNativeErrorPage, recoverNativeErrorPage } from './native-error-recovery.mjs';
import { readCheckinFeatureStatus } from './checkin-feature-status.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const { request: apiRequest } = require("playwright-core");
const port = Number.parseInt(process.argv[2], 10);
const expectedOrigin = new URL(process.argv[3]).origin;
const maxWaitSeconds = Math.max(0, Math.min(120, Number.parseInt(process.argv[4] || "0", 10) || 0));
const inspectionMode = process.argv[5] || "require-confirmed";
const allowEndpointReady = inspectionMode === "allow-endpoint";
const forceReadOnly = inspectionMode === 'verify-checkin';
const executeCheckin = inspectionMode === "execute-checkin" || forceReadOnly;
const executeNewApiCheckin = inspectionMode === "execute-new-api";
const executeCalendar = inspectionMode === 'execute-calendar' || inspectionMode === 'verify-calendar';
const executeDailyForm = inspectionMode === 'execute-daily-form' || inspectionMode === 'verify-daily-form';
const executeSamePage = inspectionMode === 'execute-same-page' || inspectionMode === 'verify-same-page';
const encodedActionRule = process.argv[6] || "";
const continuationOnly = process.argv.includes('--continuation-only');
const actionRule = executeCheckin
  ? normalizeNativeCheckinActionRule(JSON.parse(Buffer.from(encodedActionRule, "base64").toString("utf8")))
  : null;
const config = await fs.readFile(new URL('../config/config.json',import.meta.url),'utf8').then(JSON.parse).catch(error=>{
  if(error.code==='ENOENT') return {};
  throw error;
});
config.submissionJournalPath = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))),'data/submission-journal.json');
const scope = createSubmissionScope(config.submissionJournalPath,{origin:expectedOrigin},config);
const outstanding = await scope.pending();
let mayExecuteCheckin = executeCheckin && !forceReadOnly && outstanding.length===0;
async function nativeEvidence(result,source='page_text',page=null) {
  if(result.status==="not_signed" && result.dailyUnsigned===true) return dailyReadinessEvidence({origin:expectedOrigin},config,{source:"status_endpoint"});
  if (source==='status_endpoint'&&/页面签到控件/.test(result.reason??'')) source='page_text';
  if (allowEndpointReady&&result.status==='ready'&&result.siteBodyLoaded&&result.attendanceEndpoint) {
    const bound=await bindNativeCompletion({...result,status:'signed',evidence:successEvidence('user_rule','configured_native_visit_confirmed')},
      {origin:expectedOrigin},config,page ? activeConfig=>tryConfiguredSequentialActions(page,{origin:expectedOrigin},activeConfig) : null);
    return ['signed','already_signed'].includes(bound.status) ? {...bound,status:result.status} : bound;
  }
  return bindNativeCompletion({...result,origin:expectedOrigin,
    ...(['signed','already_signed'].includes(result.status) ? {evidence:result.evidence??successEvidence(source,'native_confirmed_completion')} : {}),
  },{origin:expectedOrigin},config,page ? activeConfig=>tryConfiguredSequentialActions(page,{origin:expectedOrigin},activeConfig) : null);
}
if (!Number.isInteger(port) || port <= 0) {
  throw new Error("usage: node src/native-browser-inspect.mjs <port> <origin> [max-wait-seconds] [mode] [action-rule-base64]");
}
if (!new Set(["require-confirmed", "allow-endpoint", "execute-checkin", "verify-checkin", "execute-new-api", 'execute-calendar', 'verify-calendar', 'execute-daily-form', 'verify-daily-form', 'execute-same-page', 'verify-same-page', 'verify-visit']).has(inspectionMode)) {
  throw new Error("native browser inspection mode is invalid");
}

async function readPageState(page) {
  return readNativeCheckinState(page,expectedOrigin,config,{unsignedRule:actionRule});
}

async function inspectNewApiWithRawCdp() {
  if (config.newApiFeatureStatusOrigins?.includes(expectedOrigin)) {
    const request = await apiRequest.newContext();
    try {
      const feature = await readCheckinFeatureStatus(request, { origin: expectedOrigin }, config);
      if (feature) { console.log(JSON.stringify(feature)); return; }
    } finally { await request.dispose(); }
  }
  const options = newApiCheckinOptions({origin:expectedOrigin},config);
  const probeExpression = `(async () => ({state: await (${runNewApiCheckinInBrowser.toString()})(${JSON.stringify({...options,readOnly:true})})}))()`;
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
    const state = await (${runNewApiCheckinInBrowser.toString()})(${JSON.stringify(options)});
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
  let submissionWatcher = null;
  let browserErrorRecovery = null;
  const emit = result => console.log(JSON.stringify({ ...result,
    ...(browserErrorRecovery ? { browserErrorRecovery } : {}) }));
  try {
  const pageDeadline = Date.now() + maxWaitSeconds * 1000;
  let page = null;
  while (!page && Date.now() <= pageDeadline) {
    page = selectNewestOriginPage(
      browser.contexts().flatMap((context) => context.pages()),
      expectedOrigin,
    );
    if (!page && (executeDailyForm || executeSamePage)) page = await selectNativeErrorPage(
      browser.contexts().flatMap(context => context.pages()), { origin: expectedOrigin }, config);
    if (!page) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!page) throw new Error("target origin was not found in the native browser");
  const feature = await readCheckinFeatureStatus(page.request, { origin: expectedOrigin }, config);
  if (feature) { emit(feature); return; }
  if (executeDailyForm || executeSamePage) {
    const actionType = executeSamePage ? config.samePageManualCheckinRules?.[expectedOrigin]?.sequentialActionType : 'checkin';
    const recoveryTarget = { origin: expectedOrigin, actionType };
    const recoveryScope = createSubmissionScope(config.submissionJournalPath, recoveryTarget, config);
    browserErrorRecovery = await recoverNativeErrorPage(page, recoveryTarget, config, {
      currentPending: partitionSubmissions(await recoveryScope.pending(), recoveryTarget, config).current.length > 0,
      attempted: process.argv.includes('--no-error-recovery'),
      pages: browser.contexts().flatMap(context => context.pages()),
    });
    if (browserErrorRecovery && !browserErrorRecovery.recovered) {
      emit({ status: 'needs_attention', retryable: false, failureCode: 'native_browser_error_unresolved',
        reason: '当前浏览器错误页未能安全恢复，保留页面且未提交签到' });
      return;
    }
  }
  const submissionTarget = { origin: expectedOrigin,
    submissionPaths: actionRule?.verificationRecovery ? [actionRule.verificationRecovery.checkinPath] : [] };
  if (mayExecuteCheckin && actionRule?.verificationRecovery) {
    submissionWatcher = watchNativeCheckinSubmissions(page, expectedOrigin, actionRule.verificationRecovery);
  }
  attachSubmissionScope(page,scope);
  if (executeCheckin) {
    // Context routes cover new/replacement tabs before the next page scan.
    for (const context of browser.contexts()) {
      if (typeof context.route === 'function') {
        await guardPageSubmissions(context, submissionTarget, scope, { readOnly: () => !mayExecuteCheckin });
      }
    }
    await guardPageSubmissions(page, submissionTarget, scope, { readOnly: () => !mayExecuteCheckin });
  }
  const guardedPages = new WeakSet(executeCheckin ? [page] : []);
  const resolvePage = async () => {
    const newest = selectNewestOriginPage(browser.contexts().flatMap(context => context.pages()), expectedOrigin);
    if (!newest) throw new Error('native target page is temporarily unavailable');
    attachSubmissionScope(newest, scope);
    if (executeCheckin && !guardedPages.has(newest)) {
      await guardPageSubmissions(newest, submissionTarget, scope, { readOnly: () => !mayExecuteCheckin });
      guardedPages.add(newest);
    }
    submissionWatcher?.attach(newest);
    page = newest;
    return newest;
  };

  const duplicatePages = pagesForOrigin(
    browser.contexts().flatMap((context) => context.pages()),
    expectedOrigin,
  ).filter((candidate) => candidate !== page);
  for (const duplicate of duplicatePages) await duplicate.close().catch(() => {});

  if (executeCheckin && !mayExecuteCheckin && !forceReadOnly && actionRule?.verificationRecovery) {
    const recovery = { page, origin: expectedOrigin, rule: actionRule.verificationRecovery, config, scope };
    const recovered = await resumeNativeCycleFromStatus(recovery)
      || !continuationOnly && await recoverRecordedNativeVerification(recovery);
    if (recovered && !(await scope.pending()).length) {
      mayExecuteCheckin = true;
      submissionWatcher = watchNativeCheckinSubmissions(page, expectedOrigin, actionRule.verificationRecovery);
    }
  }

  if (inspectionMode === 'verify-visit') {
    const result = await verifyNativeVisitCheckin(page, { origin: expectedOrigin }, config);
    await scope.observe(result);
    console.log(JSON.stringify(reconcileSubmissionResult(result, await scope.allPending(), { origin: expectedOrigin }, config)));
    return;
  }

  if (executeSamePage) {
    const result = await continueNativeSamePage(page, { origin: expectedOrigin, allowedOrigins: [expectedOrigin] }, config, {
      readOnly: inspectionMode === 'verify-same-page', continuationOnly, waitMs: maxWaitSeconds * 1000,
      advanceChallenge: (activePage, origin) => clickVisibleNativeChallengeControl(activePage, origin, {
        actionTexts: ['签到'], clickChallenge: true,
        challengeFrameStableMs: config.samePageManualCheckinRules[origin].challengeFrameStableMs ?? 3000,
      }),
    });
    emit(result);
    return;
  }

  if (executeDailyForm) {
    const target = { origin: expectedOrigin, allowedOrigins: [expectedOrigin] };
    let activeConfig = config, blockedTerminalPath = null;
    const submissionGuard = await guardPageSubmissions(page, target, null, { readOnly: () => activeConfig.checkinReadOnly === true });
    const terminalPaths = config.preCheckinNavigationRules?.[expectedOrigin]?.terminalPaths ?? [];
    const terminalMatches = url => url.origin === expectedOrigin && terminalPaths.includes(url.pathname);
    const terminalHandler = async route => {
      blockedTerminalPath = new URL(route.request().url()).pathname;
      await route.abort('blockedbyclient');
    };
    await page.route(terminalMatches, terminalHandler);
    try {
      const result = await runWithSubmissionJournal(config.submissionJournalPath, target,
      { ...config, checkinReadOnly: inspectionMode === 'verify-daily-form' }, async active => {
        activeConfig = active;
        attachSubmissionScope(page, active[SUBMISSION_SCOPE]);
        return runConfiguredDailyFormCheckin(page, target, active, {
          waitMs: maxWaitSeconds * 1000, terminalPath: () => blockedTerminalPath,
          retainedOnly: continuationOnly,
          advanceChallenge: continuationOnly ? null : (activePage, origin) => clickVisibleNativeChallengeControl(activePage, origin, {
            actionTexts: [config.preCheckinNavigationRules[origin].dailyUnsignedForm.actionText], clickChallenge: true,
          }),
        });
      });
      emit({ ...result, siteBodyLoaded: ['signed','already_signed','not_signed'].includes(result.status),
        requestBlockDiagnostics: { ...submissionGuard.diagnostics(), terminalBlockedCount: Number(!!blockedTerminalPath) },
        actionOutcome: result.formDiagnostics?.submitted ? 'submitted' : 'not_attempted' });
    } finally {
      await page.unroute(terminalMatches, terminalHandler);
      await submissionGuard.stop();
    }
    return;
  }

  if (executeCalendar) {
    const target = { origin: expectedOrigin, allowedOrigins: [expectedOrigin] };
    const calendarDeadline = Date.now() + maxWaitSeconds * 1000;
    let activeConfig = config;
    await guardPageSubmissions(page, target, null, { readOnly: () => activeConfig.checkinReadOnly === true });
    const result = await runWithSubmissionJournal(config.submissionJournalPath, target,
      { ...config, checkinReadOnly: inspectionMode === 'verify-calendar' }, async active => {
        activeConfig = active;
        attachSubmissionScope(page, active[SUBMISSION_SCOPE]);
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        return runConfiguredCalendarDayCheckin(page, target, active, { deadline: calendarDeadline });
      });
    console.log(JSON.stringify({ ...result, siteBodyLoaded: ['signed','already_signed','not_signed'].includes(result.status),
      actionAttempted: result.status === 'signed', actionOutcome: result.status === 'signed' ? 'confirmed' : 'not_attempted' }));
    return;
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  if (!continuationOnly) await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  let actionAttempted = false;
  let actionOutcome = executeCheckin ? "not_attempted" : "not_configured";
  let confirmationDeadline = pageDeadline;
  let readOnlyDiagnostics = null;
  const safeLine = createNativeSafeLineReader(expectedOrigin, {
    readState: readPageState,
    enabled: executeCheckin && !forceReadOnly && !continuationOnly,
    submissionBlocked: () => !mayExecuteCheckin,
    deadline: () => confirmationDeadline,
    now: () => Date.now(),
  });
  const cloudflare = createNativeCloudflareReader(expectedOrigin, {
    readState: activePage => safeLine.read(activePage), rule: actionRule,
    enabled: () => executeCheckin && !forceReadOnly && !continuationOnly && mayExecuteCheckin && actionRule?.clickChallenge === true,
    deadline: () => confirmationDeadline, resolvePage,
  });
  const readInspectionState = activePage => cloudflare.read(activePage);
  let current = executeCheckin && !mayExecuteCheckin
    ? await waitForNativeReadOnlyCompletion(page, expectedOrigin, config, {
      timeoutMs: Math.max(0, pageDeadline - Date.now()),
      readState: readInspectionState,
      onObservation: observation => { readOnlyDiagnostics = observation; },
    })
    : await readInspectionState(page);
  if (executeCheckin && !mayExecuteCheckin && !forceReadOnly) {
    mayExecuteCheckin = await resumeNativeDailyCycle(scope, current, expectedOrigin, config);
    if (mayExecuteCheckin && actionRule?.verificationRecovery && !submissionWatcher) {
      submissionWatcher = watchNativeCheckinSubmissions(page, expectedOrigin, actionRule.verificationRecovery);
    }
  }
  if (mayExecuteCheckin && !["signed", "already_signed"].includes(current.state.status)) {
    const action = await waitForNativeCheckinAction(page, expectedOrigin, actionRule, {
      readState: async activePage => (await readInspectionState(activePage)).state,
      timeoutMs: maxWaitSeconds * 1000,
    });
    actionAttempted = action.clicked;
    actionOutcome = action.outcome;
    if (actionAttempted) confirmationDeadline = Date.now() + maxWaitSeconds * 1000;
  }

  let output = null, completionGraceObserved = false;
  do {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
      current = await readInspectionState(page);
      if (!continuationOnly && actionAttempted && !completionGraceObserved
        && current.state.failureCode === 'cloudflare_verification_unresolved') {
        completionGraceObserved = true;
        current = await waitForNativeReadOnlyCompletion(page, expectedOrigin, config, {
          timeoutMs: 30000, waitForCloudflareCompletion: true,
          // The exhausted recovery budget must not hide delayed completion.
          readState: activePage => safeLine.read(activePage),
          delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
          onObservation: observation => { readOnlyDiagnostics = observation; },
        });
      }
      if (mayExecuteCheckin && !actionAttempted && current.state.status === "ready") {
        const action = await waitForNativeCheckinAction(page, expectedOrigin, actionRule, {
          readState: async activePage => (await readInspectionState(activePage)).state,
          timeoutMs: Math.max(0, confirmationDeadline - Date.now()),
        });
        actionAttempted = action.clicked;
        actionOutcome = action.outcome;
        if (actionAttempted) confirmationDeadline = Date.now() + maxWaitSeconds * 1000;
        current = await readInspectionState(page);
      }
      const cloudflareDiagnostics = cloudflare.diagnostics();
      output = {
        status: current.state.status,
        failureCode: current.state.failureCode,
        retryable: current.state.retryable,
        ...(current.state.manualBrowserMode === 'native' ? { manualBrowserMode: 'native' } : {}),
        ...(Number.isInteger(current.state.challengeAttempts) ? { challengeAttempts: current.state.challengeAttempts } : {}),
        siteBodyLoaded: current.siteBodyLoaded,
        attendanceEndpoint: current.attendanceEndpoint,
        actionAttempted,
        actionOutcome,
        challengeOutcome: cloudflareDiagnostics?.outcome ?? (actionRule?.clickChallenge ? 'pending' : 'not_configured'),
        challengeDetails: cloudflareDiagnostics?.details ?? null,
        cloudflareDiagnostics,
        safeLineDiagnostics: safeLine.diagnostics(),
        ...(readOnlyDiagnostics ? { readOnlyDiagnostics } : {}),
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
      if (explicitlyConfirmed || endpointReady || (executeCheckin && !actionAttempted) || confirmationTimedOut
        || current.state.failureCode === 'cloudflare_verification_unresolved') break;
    } catch {
      if (Date.now() >= confirmationDeadline) throw new Error("native page did not stabilize before the deadline");
    }
    await page.waitForTimeout(1000);
  } while (true);
  if (submissionWatcher) output = await settleNativeVerificationRecovery({
    page, origin: expectedOrigin, rule: actionRule.verificationRecovery, config, scope,
    watcher: submissionWatcher, result: output, freeze: async () => { mayExecuteCheckin = false; },
  });
  if (executeCheckin) output = nativeSubmissionHandoff(output);
  const verified = await nativeEvidence(output,'page_text',page);
  await scope.observe(verified);
  console.log(JSON.stringify(reconcileSubmissionResult(verified,await scope.allPending(),{origin:expectedOrigin},config)));
  } catch (error) {
    if (!browserErrorRecovery?.attempted) throw error;
    emit({ status: 'needs_attention', retryable: false, failureCode: 'native_browser_error_unresolved',
      reason: '已尝试恢复浏览器错误页，后续未取得完成信号，保留页面继续复核' });
  } finally {
    mayExecuteCheckin = false;
    await submissionWatcher?.stop();
    await browser.close().catch(() => {});
  }
}

if (executeNewApiCheckin) await inspectNewApiWithRawCdp();
else await inspectWithPlaywright();
