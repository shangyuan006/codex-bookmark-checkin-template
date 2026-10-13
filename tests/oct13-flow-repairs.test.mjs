import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLoginRecoveryHandoff, loginRecoveryRequiresManualHandoff,
  loginHelperOutcomeFromStreams,
} from '../src/login-recovery.mjs';
import {
  recoveryEntriesForResults, deferUnresolvedLogin, filterAutomaticRetryOrigins,
} from '../src/retry-policy.mjs';
import { oauthTargetPageObservation } from '../src/oauth-target-state.mjs';
import { sanitizeOAuthFlowDiagnostic } from '../src/oauth-flow-diagnostics.mjs';

const target = { origin: 'https://example.test', title: 'Fixture', folderNames: ['Daily'] };
const fallbackAttempts = [
  { method: 'saved_password', status: 'failed', succeeded: false },
  { method: 'native_saved_password', status: 'unsupported', loginStage: 'navigation', succeeded: false },
];

test('a confirmed unavailable native fallback stops repeated recovery only while the page still requires login', () => {
  const initial = { ...target, status: 'login_required' };
  const outcome = { succeeded: false, attempts: fallbackAttempts };
  const handoff = applyLoginRecoveryHandoff(initial, outcome);
  assert.equal(handoff.status, 'needs_attention');
  assert.equal(handoff.failureCode, 'login_recovery_requires_manual');
  assert.equal(handoff.retryable, false);
  assert.equal(deferUnresolvedLogin(handoff), handoff);
  assert.deepEqual(recoveryEntriesForResults([handoff], [target]), []);
  assert.equal(filterAutomaticRetryOrigins(new Set([target.origin]), [handoff]).size, 0);
  // A new directed run after the human login produces a fresh page result;
  // the previous round's marker is not copied into that result.
  const fresh = { ...target, status: 'already_signed' };
  assert.equal(applyLoginRecoveryHandoff(fresh, outcome), fresh);
  assert.equal(fresh.retryable, undefined);
});

for (const status of ['failed', 'timeout']) {
  test(`a ${status} probe without conclusive fallback evidence remains retryable`, () => {
    for (const attempts of [
      [{ method: 'saved_password', status }],
      [{ method: 'saved_password', status: 'timeout' }, fallbackAttempts[1]],
      [...fallbackAttempts, { method: 'oauth', status }],
      [...fallbackAttempts, { method: 'protected_credential', status }],
    ]) {
      assert.equal(loginRecoveryRequiresManualHandoff(attempts), false);
      const result = { ...target, status: 'login_required' };
      assert.equal(applyLoginRecoveryHandoff(result, { attempts }), result);
      assert.equal(recoveryEntriesForResults([result], [target]).length, 1);
    }
  });
}

test('missing credentials and bounded interactive verification hand off after all available methods fail', () => {
  for (const status of ['credential_missing', 'invalid_credential', 'no_saved_credential', 'needs_attention', 'unsupported']) {
    assert.equal(loginRecoveryRequiresManualHandoff([
      { method: 'protected_credential', status }, ...fallbackAttempts,
    ]), true);
  }
  assert.equal(loginRecoveryRequiresManualHandoff([]), false);
  assert.equal(loginRecoveryRequiresManualHandoff(null), false);
  assert.equal(loginRecoveryRequiresManualHandoff([{ method: 'unknown', status: 'unsupported' }]), false);
});

test('successful recovery and changed page evidence take precedence over unavailable fallback attempts', () => {
  assert.equal(loginRecoveryRequiresManualHandoff([
    ...fallbackAttempts, { method: 'oauth', status: 'logged_in', succeeded: true },
  ]), false);
  const outcome = { succeeded: false, attempts: fallbackAttempts };
  for (const status of ['signed', 'already_signed', 'error', 'deferred', 'interactive_challenge', 'unconfirmed']) {
    const result = { ...target, status };
    assert.equal(applyLoginRecoveryHandoff(result, outcome), result);
  }
  const login = { ...target, status: 'login_required' };
  assert.equal(applyLoginRecoveryHandoff(login, { ...outcome, succeeded: true }), login);
});

test('a late announcement actually dismissed by the configured helper is recorded as observed', () => {
  for (const noticeVisible of [false, true, undefined]) {
    const observation = oauthTargetPageObservation({ kind: 'target_login', noticeVisible }, true);
    assert.deepEqual(observation, { targetSurface: 'target_login', noticeObserved: true, noticeDismissed: true });
    const diagnostic = sanitizeOAuthFlowDiagnostic({ flow: 'automatic_logout', status: 'logged_out', provider: 'GitHub',
      logoutConfirmed: true, ...observation });
    assert.equal(diagnostic.noticeObserved, true);
    assert.equal(diagnostic.noticeDismissed, true);
  }
  assert.deepEqual(oauthTargetPageObservation({ kind: 'target_login', noticeVisible: false }, false),
    { targetSurface: 'target_login', noticeObserved: false, noticeDismissed: false });
  assert.deepEqual(oauthTargetPageObservation({ kind: 'blocking_overlay', noticeVisible: true }, false),
    { targetSurface: 'blocking_overlay', noticeObserved: true, noticeDismissed: false });
});

test('observation normalization accepts no private values and does not change stream precedence', () => {
  assert.deepEqual(oauthTargetPageObservation({ kind: 'private-page-text', noticeVisible: 'true' }, 'true'),
    { noticeObserved: false, noticeDismissed: false });
  const merged = loginHelperOutcomeFromStreams('{"status":"needs_attention","noticeObserved":false}',
    '{"noticeObserved":true,"targetSurface":"target_login"}');
  assert.equal(merged.noticeObserved, false);
  assert.equal(merged.targetSurface, 'target_login');
});
