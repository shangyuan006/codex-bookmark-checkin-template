import { createHash } from "node:crypto";
import { normalizeText } from "./detector.mjs";

export function sequentialActionType(step) {
  const actionTexts = [...new Set((step.actionTexts ?? []).map(normalizeText).filter(Boolean))];
  return step.actionType ?? `sequence_${createHash("sha256").update(JSON.stringify({url:new URL(step.url).href,actionTexts})).digest("hex").slice(0,16)}`;
}

export function configuredSequentialActionTypes(origin, config = {}) {
  const steps = config.sequentialActionRules?.[origin]?.steps;
  return Array.isArray(steps) && steps.length ? steps.map(sequentialActionType) : null;
}

export function normalizeSequentialCompletedControl(raw) {
  if (raw == null) return null;
  const selector = String(raw.selector ?? '').trim();
  const textPattern = String(raw.textPattern ?? '');
  if (!selector || selector.length > 300 || !textPattern.startsWith('^') || !textPattern.endsWith('$')
    || textPattern.length > 200 || /[\r\n]/.test(textPattern)) {
    throw new Error('Sequential completed control requires a bounded selector and anchored text pattern');
  }
  try { new RegExp(textPattern, 'u'); }
  catch { throw new Error('Invalid sequential completed control text pattern'); }
  return { selector, textPattern };
}

export function sequentialCompletedControlMatches(observations, rule) {
  if (!rule || !Array.isArray(observations)) return false;
  const visible = observations.filter(control => control?.visible === true);
  if (visible.length !== 1 || visible[0].interactive !== true) return false;
  const text = normalizeText(visible[0].text);
  return text.length <= 120 && new RegExp(rule.textPattern, 'u').test(text);
}

export function readSequentialDailyQuota(text, step) {
  if (!step.dailyQuotaPattern) return { matched: false, eligible: false, empty: false };
  const matches = [...String(text ?? "").replace(/\s+/g, " ").matchAll(new RegExp(step.dailyQuotaPattern, "g"))];
  if (matches.length !== 1 || !/^\d+$/.test(matches[0][1] ?? "")) {
    return { matched: false, eligible: false, empty: false };
  }
  const count = Number(matches[0][1]);
  if (!Number.isSafeInteger(count)) return { matched: false, eligible: false, empty: false };
  return { matched: true, eligible: count >= step.dailyQuotaMinimum, empty: count === 0 };
}

export function sequentialCompletionKind(evidence, step, phase, responseConfirmed = false) {
  if (phase === "after" && responseConfirmed) return "response";
  if (["login_required", "interactive_challenge", "managed_challenge", "managed_challenge_timeout", "deferred", "needs_attention"].includes(evidence.stateStatus)) return null;
  if (step.acceptGenericCheckinState && ["signed", "already_signed"].includes(evidence.stateStatus)) return "generic";
  if (evidence.completedTextPresent) return "completed_text";
  if (phase === "after" && evidence.successTextPresent) return "success_text";
  if (step.dailyQuotaZeroIsComplete && evidence.loaded && !evidence.busy && evidence.quota?.matched && evidence.quota.empty) return "daily_quota_zero";
  // Disabled-after-click is usually a loading state, not a success signal.
  // Legacy explicit disabled-button rules remain stop-only before submission.
  if (phase === "before" && step.disabledActionIsComplete && !evidence.busy && evidence.disabledActionPresent) return "disabled_user_rule";
  return null;
}
