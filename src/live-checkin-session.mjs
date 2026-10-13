import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAttentionHandoff } from "./attention-urls.mjs";
import { readBookmarkPlan } from "./bookmarks.mjs";
import { launchAutomationContext, waitForConfirmedCheckinState } from "./browser.mjs";
import { closeAutomationContext } from "./automation-context-close.mjs";
import { createSubmissionScope, guardPageSubmissions, reconcileSubmissionResult } from "./submission-guard.mjs";
import { bindSuccessEvidence, successEvidence } from "./checkin-evidence.mjs";
import { atomicWriteJson, assertBookmarkNavigation, safeLogUrl } from "./security.mjs";
import { createRunLog, writeRunResult, summarizeResults } from "./logger.mjs";
import { syncManualCompletion } from "./manual-result-reconciliation.mjs";
import { continueCheckinOnSamePage, getSamePageManualRule, readSamePageReadiness } from "./same-page-checkin.mjs";

export function selectSamePageManualTarget(handoff, config) {
  return (handoff.targets ?? []).find(target => target.manualBrowserMode !== 'native'
    && getSamePageManualRule(target, config)) ?? null;
}

async function runSession(root, config, handoff, item, sessionId) {
  const statePath = path.join(root, "tmp/manual-session.json"), signalPath = path.join(root, "tmp/close-manual-session.signal");
  const verificationPath = path.join(root, "tmp/manual-verification.json");
  const plan = await readBookmarkPlan(config.bookmarksPath, config);
  const target = plan.targets.find(target => target.origin === item.origin);
  if (!target) throw new Error("Same-page target no longer exists in current bookmarks");
  const rule = getSamePageManualRule(target, config);
  config = { ...config, headless: false, backgroundWindowMode: "visible", failureScreenshots: false,
    submissionJournalPath: path.join(root, "data/submission-journal.json") };
  const scope = createSubmissionScope(config.submissionJournalPath, target, config);
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
  let context, result;
  const shouldClose = async () => {
    const signal = await fs.readFile(signalPath, "utf8").then(JSON.parse).catch(error => {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    });
    return signal?.sessionId === sessionId && signal?.command === "close";
  };
  try {
    context = await launchAutomationContext(config);
    const page = context.pages()[0] ?? await context.newPage();
    for (const other of context.pages()) if (other !== page) await other.close();
    const blocked = (await scope.pending()).length > 0;
    await guardPageSubmissions(page, target, scope, { readOnly: blocked });
    await page.goto(assertBookmarkNavigation(item.url, target.allowedOrigins ?? [target.origin]),
      { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: 80, top: 80, width: 1365, height: 900 } });
    await cdp.detach();
    await page.bringToFront();
    result = await continueCheckinOnSamePage({
      readState: () => waitForConfirmedCheckinState(page, config, 500),
      readReady: () => blocked ? Promise.resolve({ responseReady: false, buttonReady: false }) : readSamePageReadiness(page, target, rule),
      submit: async () => {
        if (await shouldClose() || page.isClosed()) return false;
        const ready = await readSamePageReadiness(page, target, rule);
        if (!ready.responseReady || !ready.buttonReady) return false;
        // A human may already have submitted while this loop was reading the
        // page. The route guard records that intent; wait instead of clicking.
        if ((await scope.pending()).length > 0) return true;
        await scope.begin();
        await page.getByRole("button", { name: rule.actionName, exact: true }).click({ timeout: 10_000 });
        return true;
      },
      isClosed: () => page.isClosed(), shouldClose, delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
      attentionAfterMs: rule.attentionAfterMs,
      onStage: async progress => {
        Object.assign(state, progress, { windowRetained: !page.isClosed(), updatedAt: new Date().toISOString() });
        await atomicWriteJson(statePath, state);
      },
    });
    result = bindSuccessEvidence({ ...result, origin: target.origin, title: target.title, folderNames: target.folderNames,
      url: safeLogUrl(page.url()), ...(["signed", "already_signed"].includes(result.status)
        ? { evidence: successEvidence("page_text", "page_completion_text") } : {}) }, target, config);
    await scope.observe(result);
    result = reconcileSubmissionResult(result, await scope.allPending(), target, config);
  } catch {
    result = { origin: target.origin, status: "unconfirmed", reason: "同页接管发生异常，未确认签到完成" };
    await scope.observe(result);
    // Startup/navigation failures also retain the visible window for inspection.
    if (context) {
      await atomicWriteJson(statePath, { ...state, stage: "needs_attention", windowRetained: context.pages().length > 0 });
      while (context.pages().some(page => !page.isClosed()) && !await shouldClose()) await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  const closed = await closeAutomationContext(context);
  if (!closed.closed) throw new Error("Same-page browser did not close; session state retained");
  const closedAt = new Date().toISOString();
  await atomicWriteJson(verificationPath, { schemaVersion: 1, state: "pending_verification", createdAt: closedAt,
    manualSessionStartedAt: state.startedAt, manualSessionClosedAt: closedAt, sourceRunId: state.sourceRunId,
    sourceFinishedAt: state.sourceFinishedAt, authoritativeEvidenceRequired: true, successInferredFromManualInteraction: false,
    targets: [{ origin: target.origin, previousStatus: item.previousStatus, verificationStatus: "pending_verification" }] });
  const log = await createRunLog(path.join(root, "logs"));
  const report = { runId: log.runId, startedAt: state.startedAt, finishedAt: closedAt, runState: "final", isComplete: true,
    scopeComplete: false, plannedTotal: 1, processedTotal: 1, selectedTotal: 1, selectedProcessedTotal: 1,
    selectedOrigins: [target.origin], summary: summarizeResults([result]), results: [result] };
  await writeRunResult(path.join(root, "logs"), log, report, { updateLatest: false, reconcileLatest: true });
  await syncManualCompletion(root, report);
  await fs.rm(statePath, { force: true });
  await fs.rm(signalPath, { force: true });
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
