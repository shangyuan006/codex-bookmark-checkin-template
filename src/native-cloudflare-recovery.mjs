import { continueCloudflareRecovery } from './cloudflare-recovery.mjs';
import { clickVisibleNativeChallengeControl } from './native-checkin-action.mjs';
import { assertBookmarkNavigation } from './security.mjs';

const detailKeys = ['allowedFrameCount', 'allowedParentFrameCount', 'closedShadowFrameCount',
  'directCandidateCount', 'labelCandidateCount', 'frameClickCandidateCount', 'frameStableMs',
  'readyFrameCount', 'failedFrameCount', 'loadingFrameCount', 'unreadableFrameCount', 'notReadyFrameCount',
  'loadedFrameCount', 'emptyFrameCount', 'missingCheckboxFrameCount', 'resolvedFrameCount',
  'expiredFrameCount', 'frameReplacementCount'];

// This reader only advances an observed CF widget. The caller owns the sign-in
// action and its submission guard; a passed widget is never completion evidence.
export function createNativeCloudflareReader(expectedOrigin, {
  readState, rule, enabled = false, deadline, now = Date.now,
  resolvePage = async page => page,
  recover = clickVisibleNativeChallengeControl,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  let diagnostics = null;
  let stopped = null;
  let startedAt;

  async function read(page) {
    let activePage = page, current;
    const observe = async () => {
      activePage = await resolvePage(activePage);
      assertBookmarkNavigation(activePage.url(), [expectedOrigin]);
      current = await readState(activePage);
      if (diagnostics) diagnostics.finalStatus = current.state.status;
      return { ...current.state, unresolvedChallenge: current.cloudflareUnresolved === true };
    };
    await observe();
    if (!current.cloudflareUnresolved) return current;

    const mayRecover = typeof enabled === 'function' ? enabled() === true : enabled === true;
    startedAt ??= now();
    diagnostics ??= { observed: true, probeCount: 0, clickCount: 0, elapsedMs: 0,
      outcome: 'pending', finalStatus: current.state.status, details: null };
    if (!mayRecover) {
      diagnostics.outcome = 'verification_read_only';
      return current;
    }
    if (stopped) return { ...current, state: stopped };

    const state = await continueCloudflareRecovery({
      readState: observe, now, wait, waitMs: Math.max(0, deadline() - now()),
      maxClicks: 3, settleMs: 5000, initialAttempts: diagnostics.clickCount,
      clickChallenge: async () => {
        activePage = await resolvePage(activePage);
        assertBookmarkNavigation(activePage.url(), [expectedOrigin]);
        diagnostics.probeCount++;
        const result = await recover(activePage, expectedOrigin, rule);
        if (result.clicked) diagnostics.clickCount++;
        diagnostics.outcome = result.outcome;
        diagnostics.details = result.details ? Object.fromEntries(detailKeys
          .filter(key => Number.isFinite(result.details[key]))
          .map(key => [key, result.details[key]])) : null;
        return result;
      },
    });
    if (state.failureCode === 'cloudflare_verification_unresolved') stopped = state;
    diagnostics.elapsedMs = Math.max(0, now() - startedAt);
    diagnostics.finalStatus = state.status;
    return { ...current, state };
  }

  return { read, diagnostics: () => diagnostics ? structuredClone(diagnostics) : null };
}
