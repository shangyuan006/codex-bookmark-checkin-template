import { getConfiguredSequentialActionRule, readConfiguredSequentialStepEvidence, clickConfiguredSequentialAction,
  dismissConfiguredPreCheckinOverlay, watchConfiguredSequentialResponses } from './browser.mjs';
import { bindSuccessEvidence, successEvidence, dailyReadinessEvidence } from './checkin-evidence.mjs';
import { createSubmissionScope, guardPageSubmissions, reconcileSubmissionResult, partitionSubmissions } from './submission-guard.mjs';
import { readSequentialStatus } from './sequential-status.mjs';
import { continueCheckinOnSamePage, getSamePageManualRule, readSamePageReadiness, readSamePageLocationState, samePageMaySubmit, samePageVerificationPending, createSamePageReadinessReader } from './same-page-checkin.mjs';
import { watchVerificationDiagnostics } from './verification-diagnostics.mjs';
import { assertBookmarkNavigation, safeLogUrl } from './security.mjs';
import { sequentialVerificationRecoveryKey, exactVerificationRejection, frozenSequentialRejection } from './sequential-verification-recovery.mjs';
import { piggoCalendarRule, readPiggoCalendarState } from './piggo-calendar.mjs';
import { unsignedRecoveryPolicy } from './unsigned-recovery.mjs';

export function samePageSequentialStep(target, config, rule) {
  if (!rule.sequentialActionType) return null;
  const steps = getConfiguredSequentialActionRule(target, config)?.steps;
  if (steps?.length !== 1 || steps[0].actionType !== rule.sequentialActionType
    || new URL(steps[0].url).origin !== target.origin || new URL(steps[0].url).pathname !== rule.expectedPath) {
    throw new Error('Same-page sequential continuation requires one matching configured step');
  }
  return steps[0];
}

export function samePageSequentialResult(result, target, config, step) {
  if (!step) return result;
  return bindSuccessEvidence({ ...result, actionType: target.actionType ?? 'checkin',
    ...(['signed', 'already_signed'].includes(result.status)
      ? { evidence: successEvidence('page_text', 'all_sequential_steps_confirmed') } : {}),
    requiredActionTypes: [step.actionType], actionResults: [{ ...result, actionType: step.actionType }],
    submissionTrackedPerAction: true }, target, config);
}

async function readSamePageUnsignedEvidence(page, target, config, step, readEvidence) {
  const url = assertBookmarkNavigation(page.url(), target.allowedOrigins ?? [target.origin]);
  if (!step.dailyCheckin || url !== step.url) return null;
  const before = await readEvidence(page, step, 'before');
  if (page.url() !== url || before.done || before.state?.status !== 'ready' || before.state.unresolvedChallenge) return null;
  const status = step.statusCheck ? await readSequentialStatus(page.request, step.statusCheck) : null;
  if (page.url() !== url || status && status.status !== 'not_signed') return null;
  if (!status && before.explicitDailyUnsigned !== true) return null;
  return dailyReadinessEvidence(target, config, { source: status ? 'status_endpoint' : 'page_text',
    observedOrigin: new URL(url).origin });
}

// Attaches to the logged-in document. This runner must never navigate, reload,
// close the page, or install an abort route over a site's pending captcha replay.
export async function continueNativeSamePage(page, target, config, { readOnly = false, continuationOnly = false,
  waitMs = 45_000, now = Date.now, delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  advanceChallenge, readEvidence = readConfiguredSequentialStepEvidence, readReady = readSamePageReadiness,
  clickAction = clickConfiguredSequentialAction, dismiss = dismissConfiguredPreCheckinOverlay } = {}) {
  const rawRule = getSamePageManualRule(target, config);
  if (rawRule?.browserMode !== 'native') throw new Error('Native same-page rule is required');
  const step = samePageSequentialStep(target, config, rawRule);
  if (!step) throw new Error('Native same-page continuation requires a sequential step');
  const rule = { ...rawRule, actionName: step.actionTexts[0], actionTextPattern: step.actionTextPattern };
  const readSubmissionReady = createSamePageReadinessReader(page, target, rule, { readReady, now });
  const actionTarget = { ...target, actionType: step.actionType };
  const scope = createSubmissionScope(config.submissionJournalPath, actionTarget, config);
  const calendarEnabled = !!piggoCalendarRule(actionTarget, config);
  const readCalendar = () => readPiggoCalendarState(page.context(), actionTarget, config, { retainedPage: page });
  let calendar = calendarEnabled ? await readCalendar() : null;
  const calendarResult = async observed => {
    await scope.observe(observed);
    return samePageSequentialResult(reconcileSubmissionResult(observed, await scope.allPending(), actionTarget, config), target, config, step);
  };
  if (calendarEnabled && calendar?.status !== 'not_signed') return calendarResult(calendar);
  let unsignedRecoveryReserved = false;
  if (calendarEnabled && !readOnly && !continuationOnly && unsignedRecoveryPolicy(actionTarget, config)) {
    const entries = await scope.pending();
    const documentStartedAt = await page.evaluate(() => performance.timeOrigin).catch(() => null);
    const ready = await readSubmissionReady();
    if (entries.length === 1 && entries[0].cycleId === calendar.evidence.binding.cycleId
      && entries[0].accountFingerprint === calendar.accountFingerprint
      && Number.isFinite(documentStartedAt) && documentStartedAt > Date.parse(entries[0].startedAt)
      && ready.buttonReady && !ready.widgetPresent && !ready.responseReady) {
      let lateRequest = false;
      const matches = url => url.origin === target.origin && url.pathname === '/v1/web/calendar/attendance';
      const freeze = async route => {
        if (route.request().method() === 'POST') { lateRequest = true; await route.abort('blockedbyclient'); }
        else await route.fallback();
      };
      await page.route(matches, freeze);
      try {
        await delay(2000);
        const freshReady = await readSubmissionReady();
        if (!lateRequest && freshReady.buttonReady && !freshReady.widgetPresent && !freshReady.responseReady
          && await page.evaluate(() => performance.timeOrigin) === documentStartedAt) {
          calendar = await readCalendar();
          const finalReady = await readSubmissionReady();
          if (!lateRequest && calendar?.status === 'not_signed' && finalReady.buttonReady
            && !finalReady.widgetPresent && !finalReady.responseReady
            && await page.evaluate(() => performance.timeOrigin) === documentStartedAt) {
            try { await scope.reserveUnsignedRecovery(calendar, { documentStartedAt }); unsignedRecoveryReserved = true; }
            catch { /* Preserve the original intent if the locked proof check fails. */ }
          }
        }
      } finally { await page.unroute(matches, freeze); }
      if (calendar?.status !== 'not_signed') return calendarResult(calendar);
    }
  }
  const pending = await scope.pending();
  let continuedCycle = false;
  if (!readOnly && pending.length && !partitionSubmissions(pending, actionTarget, config).current.length) {
    await dismiss(page, target, target.origin, config, { waitForAppearance: false });
    const unsigned = await readSamePageUnsignedEvidence(page, actionTarget, config, step, readEvidence);
    if (unsigned) {
      await scope.prepareNewCycleAfterVerifiedReadiness(unsigned);
      continuedCycle = true;
    }
  }
  const remaining = await scope.pending();
  const blocked = remaining.length > 0 && !unsignedRecoveryReserved;
  const currentPending = partitionSubmissions(remaining, actionTarget, config).current.length > 0;
  let watcher = watchConfiguredSequentialResponses(page, step, target.origin);
  const verification = watchVerificationDiagnostics(page, { now, watchdogMs: Number(rule.verificationTimeoutMs) || 0 });
  const deadline = now() + Math.max(500, Math.min(120_000, waitMs));
  let intentReserved = currentPending, progress = {}, challengeAttempted = false, actionDiagnostics = null;
  let challengeStartedAt = null, challengeProbes = 0;
  let challengeClick = null, retryPrepared = false, verificationRetried = false;
  let verificationRecoveryDiagnostics = null;
  const recoveryKey = sequentialVerificationRecoveryKey(actionTarget, config);
  // After a prior intent, observe only. Even a read-only abort route would
  // interrupt the site's delayed replay after successful verification.
  if (!blocked && !readOnly) await guardPageSubmissions(page, actionTarget, scope);
  try {
    let result = await continueCheckinOnSamePage({
      now, delay, rule, attentionAfterMs: rule.attentionAfterMs,
      initialSubmissionAttempted: currentPending && !unsignedRecoveryReserved,
      isClosed: () => page.isClosed(), shouldClose: async () => now() >= deadline,
      stopReason: '同页观察时限已到，保留原生项目窗口继续接续',
      readState: async () => {
        const url = assertBookmarkNavigation(page.url(), target.allowedOrigins ?? [target.origin]);
        if (new URL(url).origin !== target.origin || new URL(url).pathname !== rule.expectedPath) {
          return await readSamePageLocationState(page, target, rule) ?? { status: 'unconfirmed' };
        }
        await dismiss(page, target, target.origin, config, { waitForAppearance: false });
        const observation = await readEvidence(page, step, 'after', watcher.confirmed());
        if (page.url() !== url) return { status: 'unconfirmed' };
        return observation.done ? observation : observation.state;
      },
      readReady: async () => {
        const readiness = await readSubmissionReady();
        verification.observeReadiness(readiness);
        if (!readOnly && !continuationOnly && rule.nativeClickChallenge === true && readiness.widgetPresent
          && !readiness.responseReady && !challengeAttempted && advanceChallenge) {
          challengeStartedAt ??= now();
          const budget = Math.max(1000, Math.min(30_000, Number(rule.verificationTimeoutMs) || 12_000));
          if (now() - challengeStartedAt >= budget) {
            challengeAttempted = true;
            return { ...readiness, buttonReady: false };
          }
          challengeProbes++;
          const outcome = await advanceChallenge(page, target.origin);
          challengeClick = { clicked: outcome?.clicked === true,
            outcome: /^[a-z_]{1,80}$/.test(outcome?.outcome ?? '') ? outcome.outcome : 'unknown' };
          // A rendered host can precede its iframe. Reacquire transiently
          // missing/loading controls within one bounded attempt; click once.
          challengeAttempted = challengeClick.clicked || !new Set(['challenge_not_found', 'challenge_loading',
            'challenge_not_ready', 'challenge_frame_not_stable', 'challenge_frame_unreadable']).has(challengeClick.outcome);
        }
        return readOnly || blocked ? { ...readiness, buttonReady: false } : readiness;
      },
      submit: async () => {
        if (readOnly || !retryPrepared && !unsignedRecoveryReserved && (await scope.pending()).length) return { clicked: false, intentReserved: true };
        if (!samePageMaySubmit(await readSubmissionReady(), rule)) return false;
        const clicked = await clickAction(page, step, target.allowedOrigins ?? [target.origin], async () => {
          if (continuedCycle && !retryPrepared) {
            const unsigned = await readSamePageUnsignedEvidence(page, actionTarget, config, step, readEvidence);
            if (!unsigned) throw new Error('Current daily unsigned state changed before submission');
            await scope.prepareNewCycleAfterVerifiedReadiness(unsigned);
          }
          await scope.begin({ accountFingerprint: calendar?.accountFingerprint }); intentReserved = true;
        }, { onProgress: value => { actionDiagnostics = value; } });
        retryPrepared = false;
        unsignedRecoveryReserved = false;
        return { clicked: clicked.clicked, intentReserved };
      },
      recoverRejectedVerification: async readiness => {
        if (readOnly || blocked || !recoveryKey || verificationRetried || !readiness.buttonReady
          || readiness.widgetPresent || readiness.responseReady || !exactVerificationRejection(watcher.diagnostics())) return false;
        const documentStart = await page.evaluate(() => performance.timeOrigin).catch(() => null);
        if (!Number.isFinite(documentStart)) return false;
        const unsigned = await readSamePageUnsignedEvidence(page, actionTarget, config, step, readEvidence);
        if (!unsigned) return false;
        await delay(2000);
        const fresh = await readSubmissionReady();
        if (!fresh.buttonReady || fresh.widgetPresent || fresh.responseReady || !exactVerificationRejection(watcher.diagnostics())
          || await page.evaluate(() => performance.timeOrigin).catch(() => null) !== documentStart) return false;
        // Freeze only the exact action endpoint, after the widget has ended.
        // Any late replay invalidates recovery; never interrupt an active widget.
        const matches = url => url.origin === target.origin && step.rejectionEvidence.some(value => value.urlPath === url.pathname);
        let lateReplay = false;
        const freeze = async route => {
          if (step.rejectionEvidence.some(value => value.methods.includes(route.request().method()))) {
            lateReplay = true; await route.abort('blockedbyclient');
          }
          else await route.fallback();
        };
        await page.route(matches, freeze);
        try {
          await watcher.stop();
          verificationRecoveryDiagnostics = { ...watcher.diagnostics(), outcome: 'protected' };
          const rejection = frozenSequentialRejection(watcher.diagnostics());
          const proof = await readSamePageUnsignedEvidence(page, actionTarget, config, step, readEvidence);
          const final = await readSubmissionReady();
          if (lateReplay || !rejection || !proof || !final.buttonReady || final.widgetPresent || final.responseReady
            || await page.evaluate(() => performance.timeOrigin).catch(() => null) !== documentStart) return false;
          await scope.beginAfterRejectedSequentialVerification(proof, recoveryKey, rejection);
          verificationRecoveryDiagnostics.outcome = 'rejected_intent_released';
          verificationRetried = true; retryPrepared = true;
          return true;
        } finally {
          await page.unroute(matches, freeze);
          watcher = watchConfiguredSequentialResponses(page, step, target.origin);
        }
      },
      readSubmissionDiagnostics: async () => ({ ...watcher.diagnostics(),
        intentReserved: intentReserved || partitionSubmissions(await scope.pending(), actionTarget, config).current.length > 0,
        ...(actionDiagnostics ? { action: actionDiagnostics } : {}),
        verification: { ...verification.diagnostics(), probeCount: challengeProbes,
          ...(challengeClick ? { click: challengeClick } : {}) },
        verificationRetryCount: Number(verificationRetried) }),
      onStage: async value => { progress = value; },
    });
    if (calendarEnabled) {
      const finalCalendar = await readCalendar();
      if (['signed', 'already_signed'].includes(finalCalendar?.status)
        && finalCalendar.accountFingerprint === calendar?.accountFingerprint) result = { ...result, ...finalCalendar };
      else if (['signed', 'already_signed'].includes(result.status)) result = { ...result, status: 'unconfirmed',
        failureCode: 'piggo_calendar_unconfirmed', reason: '页面文字已变化，但当日日历接口尚未确认签到完成' };
    }
    const complete = ['signed', 'already_signed'].includes(result.status);
    if (!complete && progress.readiness?.pageStatus === 'login_required') result = { ...result,
      status: 'login_required', failureCode: 'same_page_login_required', reason: '原签到标签已返回登录表单，需要恢复登录' };
    else if (!complete && !result.failureCode) result = { ...result,
      failureCode: progress.readiness?.widgetPresent || samePageVerificationPending(result.submissionDiagnostics, rule) ? 'same_page_verification_unresolved'
        : progress.readiness?.pageStatus === 'login_required' ? 'same_page_login_required' : 'same_page_completion_unconfirmed' };
    const currentCycleSubmissionAttempted = intentReserved || result.submissionAttempted === true
      || partitionSubmissions(await scope.pending(), actionTarget, config).current.length > 0;
    result = bindSuccessEvidence({ ...result, origin: target.origin, url: safeLogUrl(page.url()), retryable: false,
      actionAttempted: currentCycleSubmissionAttempted, submissionAttempted: currentCycleSubmissionAttempted,
      currentCycleSubmissionAttempted, samePageStage: progress.stage, readiness: progress.readiness,
      ...(verificationRecoveryDiagnostics ? { verificationRecoveryDiagnostics } : {}),
      ...(calendar?.accountFingerprint ? { accountFingerprint: calendar.accountFingerprint } : {}),
      ...(complete ? { evidence: result.evidence ?? successEvidence('page_text', 'sequential_step_confirmed') } : {}) }, actionTarget, config);
    await scope.observe(result);
    result = reconcileSubmissionResult(result, await scope.allPending(), actionTarget, config);
    return samePageSequentialResult(result, target, config, step);
  } finally { verification.stop(); await watcher.stop(); }
}
