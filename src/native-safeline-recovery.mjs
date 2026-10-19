import { clickVisibleNativeSafeLineControl } from './native-checkin-action.mjs';
import { assertBookmarkNavigation } from './security.mjs';

const isSafeLine = current => current?.state?.failureCode === 'safeline_client_challenge';
const waitingForControl = new Set(['safeline_not_found', 'safeline_not_visible', 'safeline_not_active']);

// Challenge confirmation is independent of permission to submit check-in.
// In read-only mode the existing request guard continues to block submissions.
export function createNativeSafeLineReader(expectedOrigin, {
  readState, enabled = false, submissionBlocked = () => true,
  deadline, now = Date.now, recover = clickVisibleNativeSafeLineControl,
} = {}) {
  let diagnostics = null;
  let handled = false;

  async function read(page) {
    let current = await readState(page);
    if (diagnostics) diagnostics.finalStatus = current.state.status;
    if (!isSafeLine(current) || handled) return current;
    handled = true;
    const startedAt = now();
    diagnostics = {
      observed: true,
      submissionBlocked: submissionBlocked() === true,
      attempted: false,
      probeCount: 0,
      clickCount: 0,
      outcome: enabled ? 'safeline_not_found' : 'safeline_not_enabled',
      elapsedMs: 0,
      finalStatus: current.state.status,
    };
    if (!enabled) return current;

    // A prompt may precede its button. Allow five seconds for the unique
    // visible control, but never repeat a click after rejection or timeout.
    const controlDeadline = Math.min(deadline(), startedAt + 5000);
    while (now() < deadline()) {
      assertBookmarkNavigation(page.url(), [expectedOrigin]);
      diagnostics.probeCount++;
      const recovery = await recover(page, expectedOrigin, {
        waitMs: Math.min(30_000, deadline() - now()),
      });
      diagnostics.attempted = recovery.attempted === true;
      diagnostics.clickCount = recovery.attempted === true ? 1 : 0;
      diagnostics.outcome = recovery.outcome;
      current = await readState(page);
      if (!isSafeLine(current) || recovery.attempted || !waitingForControl.has(recovery.outcome)) break;
      if (now() >= controlDeadline) break;
      await page.waitForTimeout(Math.min(250, controlDeadline - now()));
    }
    if (diagnostics.probeCount === 0) diagnostics.outcome = 'safeline_deadline_expired';
    // Disappearance of the verification prompt is never check-in evidence.
    // The caller must still read the completion page or authoritative endpoint.
    assertBookmarkNavigation(page.url(), [expectedOrigin]);
    diagnostics.elapsedMs = Math.max(0, now() - startedAt);
    diagnostics.finalStatus = current.state.status;
    return current;
  }

  return { read, diagnostics: () => diagnostics ? { ...diagnostics } : null };
}
