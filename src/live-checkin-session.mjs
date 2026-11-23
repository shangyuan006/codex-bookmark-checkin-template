import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAttentionHandoff } from "./attention-urls.mjs";
import { readBookmarkPlan } from "./bookmarks.mjs";
import { launchAutomationContext, waitForConfirmedCheckinState,
  readConfiguredSequentialStepEvidence, clickConfiguredSequentialAction, dismissConfiguredPreCheckinOverlay,
  watchConfiguredSequentialResponses } from "./browser.mjs";
import { closeAutomationContext } from "./automation-context-close.mjs";
import { createSubmissionScope, guardPageSubmissions, reconcileSubmissionResult } from "./submission-guard.mjs";
import { bindSuccessEvidence, successEvidence } from "./checkin-evidence.mjs";
import { atomicWriteJson, assertBookmarkNavigation, safeLogUrl } from "./security.mjs";
import { writeScopedCheckinResult } from "./logger.mjs";
import { syncManualCompletion } from "./manual-result-reconciliation.mjs";
import { recordManualSessionClosure, dispatchRemainingManualHandoff } from './manual-session-lifecycle.mjs';
import { continueCheckinOnSamePage, getSamePageManualRule, samePageManualTargetEligible, readSamePageReadiness, readSamePageLocationState, samePageActionLocator, samePageMaySubmit, samePageErrorCode, samePageCloseReason, samePageVerificationPending } from "./same-page-checkin.mjs";
import { samePageSequentialStep, samePageSequentialResult } from './same-page-sequential.mjs';
export { samePageSequentialStep, samePageSequentialResult } from './same-page-sequential.mjs';

export function selectSamePageManualTarget(handoff, config) {
  return (handoff.targets ?? []).find(target => samePageManualTargetEligible(target, config)) ?? null;
}

async function runSession(root, config, handoff, item, sessionId) {
  const statePath = path.join(root, "tmp/manual-session.json"), signalPath = path.join(root, "tmp/close-manual-session.signal");
  const verificationPath = path.join(root, "tmp/manual-verification.json");
  const plan = await readBookmarkPlan(config.bookmarksPath, config);
  const target = plan.targets.find(target => target.origin === item.origin);
  if (!target) throw new Error("Same-page target no longer exists in current bookmarks");
  const rawRule = getSamePageManualRule(target, config);
  const step = samePageSequentialStep(target, config, rawRule);
  const rule = step ? { ...rawRule, actionName: step.actionTexts[0], actionTextPattern: step.actionTextPattern } : rawRule;
  config = { ...config, headless: false, backgroundWindowMode: "visible", failureScreenshots: false,
    submissionJournalPath: path.join(root, "data/submission-journal.json") };
  const actionTarget = step ? { ...target, actionType: step.actionType } : target;
  const scope = createSubmissionScope(config.submissionJournalPath, actionTarget, config);
  const state = { schemaVersion: 3, mode: "live_checkin", sessionId, pid: process.pid,
    startedAt: new Date().toISOString(), processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), profile: config.automationUserDataDir,
    sourceRunId: handoff.sourceRunId, sourceFinishedAt: handoff.sourceFinishedAt,
    selectionMode: handoff.selectionMode, bookmarkPlanGeneratedAt: handoff.bookmarkPlanGeneratedAt,
    bookmarkLastModifiedAt: handoff.bookmarkLastModifiedAt, targetCount: 1,
    targets: [{ origin: target.origin, previousStatus: item.previousStatus }], stage: "starting", windowRetained: false };
  // Reserve before launching; direct CLI use must not replace another human's
  // active session even if it bypasses the PowerShell dispatch mutex.
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const reservation = await fs.open(statePath, "wx", 0o600);
  try { await reservation.writeFile(JSON.stringify(state)); } finally { await reservation.close(); }
  await fs.rm(signalPath, { force: true });
  let context, result, watcher;
  const readCloseSignal = async () => fs.readFile(signalPath, "utf8").then(JSON.parse).catch(error => {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    });
  const shouldClose = async () => {
    const signal = await readCloseSignal();
    return signal?.sessionId === sessionId && signal?.command === "close";
  };
  try {
    context = await launchAutomationContext(config);
    const page = context.pages()[0] ?? await context.newPage();
    for (const other of context.pages()) if (other !== page) await other.close();
    if (step) watcher = watchConfiguredSequentialResponses(page, step, target.origin);
    const blocked = (await scope.pending()).length > 0;
    let intentReserved = blocked, actionDiagnostics = null;
    await guardPageSubmissions(page, actionTarget, scope, { readOnly: blocked });
    await page.goto(assertBookmarkNavigation(item.url, target.allowedOrigins ?? [target.origin]),
      { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: 80, top: 80, width: 1365, height: 900 } });
    await cdp.detach();
    await page.bringToFront();
    result = await continueCheckinOnSamePage({
      readState: async () => {
        const url = assertBookmarkNavigation(page.url(), target.allowedOrigins ?? [target.origin]);
        if (new URL(url).origin !== target.origin || new URL(url).pathname !== rule.expectedPath) {
          return await readSamePageLocationState(page, target, rule) ?? { status: 'unconfirmed' };
        }
        if (!step) {
          const observation = await waitForConfirmedCheckinState(page, config, 500);
          return page.url() === url ? observation : { status: 'unconfirmed' };
        }
        await dismissConfiguredPreCheckinOverlay(page, target, target.origin, config, { waitForAppearance: false });
        const observation = await readConfiguredSequentialStepEvidence(page, step, 'after');
        if (page.url() !== url) return { status: 'unconfirmed' };
        return observation.done ? observation : observation.state;
      },
      readReady: () => readSamePageReadiness(page, target, rule),
      readSubmissionDiagnostics: async () => ({ ...watcher?.diagnostics(),
        ...(actionDiagnostics ? { action: actionDiagnostics } : {}),
        intentReserved: intentReserved || (await scope.pending()).length > 0 }),
      submit: async () => {
        if (await shouldClose() || page.isClosed()) return false;
        const ready = await readSamePageReadiness(page, target, rule);
        if (!samePageMaySubmit(ready, rule)) return false;
        // A human may already have submitted while this loop was reading the
        // page. The route guard records that intent; wait instead of clicking.
        if ((await scope.pending()).length > 0) return { clicked: false, intentReserved: true };
        if (step) {
          const clicked = await clickConfiguredSequentialAction(page, step, target.allowedOrigins ?? [target.origin], async () => {
            await scope.begin(); intentReserved = true;
          }, { onProgress: value => { actionDiagnostics = value; } });
          return { clicked: clicked.clicked, intentReserved };
        }
        await samePageActionLocator(page, rule).click({ trial: true, timeout: 5000 });
        await scope.begin();
        intentReserved = true;
        await samePageActionLocator(page, rule).click({ timeout: 10_000 });
        return { clicked: true, intentReserved: true };
      },
      isClosed: () => page.isClosed(), shouldClose, delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
      attentionAfterMs: rule.attentionAfterMs, rule, initialSubmissionAttempted: blocked,
      onStage: async progress => {
        Object.assign(state, progress, { windowRetained: !page.isClosed(), updatedAt: new Date().toISOString() });
        await atomicWriteJson(statePath, state);
      },
    });
    result = bindSuccessEvidence({ ...result, origin: target.origin, title: target.title, folderNames: target.folderNames,
      url: safeLogUrl(page.url()), ...(["signed", "already_signed"].includes(result.status)
        ? { evidence: successEvidence("page_text", step ? 'sequential_step_confirmed' : "page_completion_text") } : {}) }, actionTarget, config);
    await scope.observe(result);
  } catch (error) {
    result = { origin: target.origin, status: "unconfirmed", reason: "同页接管发生异常，未确认签到完成",
      failureCode: samePageErrorCode(error), submissionDiagnostics: state.submissionDiagnostics };
    await scope.observe(result);
    // Startup/navigation failures also retain the visible window for inspection.
    if (context) {
      await atomicWriteJson(statePath, { ...state, stage: "needs_attention", failureCode: result.failureCode,
        windowRetained: context.pages().length > 0 });
      while (context.pages().some(page => !page.isClosed()) && !await shouldClose()) await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  const closureReason = samePageCloseReason(await readCloseSignal(), sessionId);
  const closed = await closeAutomationContext(context);
  if (!closed.closed) throw new Error("Same-page browser did not close; session state retained");
  await watcher?.stop();
  if (!['signed', 'already_signed'].includes(result.status) && watcher?.allSubmissionsRejected()
    && !samePageVerificationPending(watcher.diagnostics(), rule)) await scope.reject('verification_required');
  result = reconcileSubmissionResult(result, await scope.allPending(), actionTarget, config);
  result = samePageSequentialResult(result, target, config, step);
  const closedAt = new Date().toISOString();
  if (closureReason !== 'abandoned') {
    const previous = await fs.readFile(verificationPath, 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const day = String(state.sourceRunId ?? '').match(/^\d{8}(?=-)/)?.[0];
    const retained = day && previous?.sourceRunId?.startsWith(`${day}-`)
      && previous.state === 'pending_verification' && previous.authoritativeEvidenceRequired === true
      ? previous.targets.filter(entry => entry.origin !== target.origin)
        .map(entry => ({ manualSessionId: previous.manualSessionId ?? '', ...entry })) : [];
    await atomicWriteJson(verificationPath, { schemaVersion: 1, state: "pending_verification", createdAt: closedAt,
      manualSessionStartedAt: state.startedAt, manualSessionClosedAt: closedAt, sourceRunId: state.sourceRunId,
      sourceFinishedAt: state.sourceFinishedAt, authoritativeEvidenceRequired: true, successInferredFromManualInteraction: false,
      targets: [{ origin: target.origin, previousStatus: item.previousStatus, verificationStatus: "pending_verification" }, ...retained] });
  }
  const { report } = await writeScopedCheckinResult(root, target, result, config, {
    startedAt: state.startedAt, finishedAt: closedAt,
  });
  await syncManualCompletion(root, report);
  const closure = await recordManualSessionClosure(root, state, report, config, {
    reason: closureReason,
  });
  await fs.rm(statePath, { force: true });
  await fs.rm(signalPath, { force: true });
  if (closure.completionConfirmed) await dispatchRemainingManualHandoff(root, config);
}

const sourcePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === sourcePath) {
  const root = path.dirname(path.dirname(sourcePath));
  const args = process.argv.slice(2), planOnly = args.includes("--plan");
  const sessionIndex = args.indexOf("--session-id"), sessionId = sessionIndex >= 0 ? args.splice(sessionIndex, 2)[1] : null;
  const handoff = await loadAttentionHandoff(root, args.filter(arg => arg !== "--plan"));
  const config = JSON.parse(await fs.readFile(path.join(root, "config/config.json"), "utf8"));
  const item = selectSamePageManualTarget(handoff, config);
  if (planOnly) process.stdout.write(JSON.stringify({ origin: item?.origin ?? null }));
  else {
    if (!item || !/^[a-f0-9]{32}$/.test(sessionId ?? "")) throw new Error("Invalid same-page manual session request");
    await runSession(root, config, handoff, item, sessionId);
  }
}
