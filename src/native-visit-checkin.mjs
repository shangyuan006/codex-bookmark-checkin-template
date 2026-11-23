import { assertBookmarkNavigation, safeLogUrl } from './security.mjs';
import { bindSuccessEvidence, verifyVisitCheckin } from './checkin-evidence.mjs';
import { readNativeCheckinState } from './native-checkin-state.mjs';
import { verifyConfiguredSavedLoginSession } from './saved-login-session.mjs';

export function configuredNativeVisitRule(target, config) {
  const rule = config.visitCheckinRules?.[target.origin];
  if (!rule || rule.enabled === false || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(rule.after ?? '')
    || (target.accountKey ?? 'default') !== 'default' || (target.actionType ?? 'checkin') !== 'checkin'
    || config.sequentialActionRules?.[target.origin] || config.reauthCheckinRules?.[target.origin]
    || (config.agentrouterAccounts ?? []).some(account => account.origin === target.origin)
    || (config.knownNoCheckinFeatureOrigins ?? []).includes(target.origin)) return null;
  return rule;
}

// Inspect the retained document only. Login and challenge pages never satisfy
// an authenticated-visit rule, and this helper cannot click or navigate.
export async function verifyNativeVisitCheckin(page, target, config, {
  readState = readNativeCheckinState, verifySession = verifyConfiguredSavedLoginSession, now = () => new Date(),
} = {}) {
  const rule = configuredNativeVisitRule(target, config);
  if (!rule) throw new Error('Native visit continuation requires an explicit visit rule');
  const url = assertBookmarkNavigation(page.url(), [target.origin]);
  const unchanged = () => assertBookmarkNavigation(page.url(), [target.origin]) === url;
  const result = await verifyVisitCheckin(rule, {
    url, now: now(),
    readState: async () => {
      const observed = await readState(page, target.origin, config);
      if (!unchanged() || observed.siteBodyLoaded !== true) return { status: 'unconfirmed' };
      if (observed.cloudflareUnresolved === true || observed.state?.unresolvedChallenge === true) {
        return { status: 'interactive_challenge', failureCode: 'visit_verification_unresolved', reason: '访问签到页面仍有未完成的验证' };
      }
      return { ...observed.state, unresolvedChallenge: observed.cloudflareUnresolved === true || observed.state?.unresolvedChallenge === true };
    },
    verifySession: async () => {
      const session = await verifySession(page, target.origin, config);
      return unchanged() ? session : { status: 'unknown' };
    },
  });
  if (!unchanged()) return { status: 'unconfirmed', failureCode: 'visit_document_changed',
    reason: '访问签到核验期间页面已变化，保留原标签继续观察', url: safeLogUrl(page.url()) };
  return bindSuccessEvidence({ ...result, actionAttempted: false, submissionAttempted: false }, target, config, now());
}
