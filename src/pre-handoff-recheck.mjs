import { checkinCycle, isCurrentCheckinCycle } from './checkin-cycle.mjs';
import { reconcileCheckinResult } from './checkin-evidence.mjs';
import { automationCleanupAllowsRecovery } from './automation-context-close.mjs';

const completed = new Set(['signed', 'already_signed']);
const bounded = (value, fallback, min, max) => Number.isFinite(value)
  ? Math.max(min, Math.min(max, value)) : fallback;

function eligibleRule(result, target, config, now) {
  const rule = config.preHandoffReadOnlyRecheckRules?.[target.origin];
  if (!rule || rule.enabled === false || completed.has(result.status)
    || result.failureCode !== 'submission_quarantined' || result.submissionAttempted !== true
    || result.preHandoffReadOnlyRecheck?.attempted
    || (target.accountKey ?? 'default') !== 'default' || result.accountResults?.length
    || (target.actionType ?? 'checkin') !== 'checkin'
    || (result.accountKey ?? 'default') !== 'default' || (result.actionType ?? 'checkin') !== 'checkin'
    || result.quarantine?.actionType !== 'checkin'
    || config.reauthCheckinRules?.[target.origin] || config.sequentialActionRules?.[target.origin]
    || (config.agentrouterAccounts ?? []).some(account => account.origin === target.origin)
    || !isCurrentCheckinCycle(target.origin, result.quarantine?.firstAttemptAt, config, now)) return null;
  return {
    delayMs: bounded(rule.delayMs, 15_000, 0, 30_000),
    timeoutMs: bounded(rule.timeoutMs, 30_000, 30_000, 60_000),
    cycleId: checkinCycle(target.origin, config, now).id,
  };
}

// This stage observes a pending submission; it never enters login recovery or
// the ordinary retry path. The journal wrapper remains responsible for locks.
export async function recheckBeforeManualHandoff(results, targets, config, {
  launchContext, processTarget, closeContext, wait,
  canLaunch = () => true, now = () => new Date(), onResult = async () => {},
}) {
  const updated = [...results];
  let cleanupFailed = false;
  for (let index = 0; index < updated.length; index += 1) {
    const original = updated[index];
    const target = targets.find(entry => entry.origin === original.origin);
    if (!target || cleanupFailed || !canLaunch()) continue;
    const rule = eligibleRule(original, target, config, now());
    if (!rule) continue;
    const diagnostics = { attempted: true, readOnly: true, delayMs: rule.delayMs, outcome: 'unconfirmed' };
    let context;
    let observation;
    const started = now().getTime();
    try {
      await wait(rule.delayMs);
      if (checkinCycle(target.origin, config, now()).id !== rule.cycleId) {
        diagnostics.outcome = 'cycle_changed';
      } else if (canLaunch()) {
        const readOnlyConfig = { ...config, checkinReadOnly: true, checkinObservationOnly: true,
          retryCount: 0, targetTimeoutMs: rule.timeoutMs,
          navigationTimeoutMs: Math.min(Number(config.navigationTimeoutMs) || 30_000, rule.timeoutMs),
          checkinStateWaitMs: 10_000, failureScreenshots: false };
        context = await launchContext(readOnlyConfig);
        observation = await processTarget(context, target, readOnlyConfig);
        const verified = reconcileCheckinResult(observation, observation?.evidence, now(),
          { target, config, requireBinding: true });
        if (completed.has(verified?.status) && verified.evidence?.authoritative === true
          && ['page_text', 'status_endpoint', 'reward_log'].includes(verified.evidence.source)
          && Date.parse(verified.evidence.confirmedAt) >= started
          && verified.evidence.binding.cycleId === rule.cycleId) {
          observation = { ...verified, observedAt: now().toISOString() };
          diagnostics.outcome = 'confirmed';
        }
      } else {
        diagnostics.outcome = 'cleanup_blocked';
      }
    } catch {
      // Never log an exception that could contain a private response or URL.
      diagnostics.outcome = 'error';
    } finally {
      if (context) {
        try { cleanupFailed = !automationCleanupAllowsRecovery(await closeContext(context)); }
        catch { cleanupFailed = true; }
      }
    }
    diagnostics.durationMs = Math.max(0, now().getTime() - started);
    if (cleanupFailed) diagnostics.cleanupFailed = true;
    updated[index] = diagnostics.outcome === 'confirmed'
      ? { origin: target.origin, title: original.title, folderNames: original.folderNames,
          ...(original.recovery ? { recovery: original.recovery } : {}),
          ...observation, preHandoffReadOnlyRecheck: diagnostics }
      : { ...original, preHandoffReadOnlyRecheck: diagnostics };
    await onResult(updated[index], index);
  }
  return updated;
}
