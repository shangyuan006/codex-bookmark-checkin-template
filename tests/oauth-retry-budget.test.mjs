import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { oauthRetryBudgetBinding, inspectOAuthRetryBudget, updateOAuthRetryBudget, isStalledOAuthCallback } from '../src/oauth-retry-budget.mjs';
import { runTargetFirstLinuxDoOAuthWithRetry, reauthLoginFailureResult } from '../src/reauth-checkin.mjs';
import { localRunDate } from '../src/retry-policy.mjs';

const callbackFailure = { status: 'needs_attention', succeeded: false, oauthStage: 'target_callback',
  authorizationOutcome: 'authorization_departed', providerAuthorizationChallengeOutcome: 'departed_unconfirmed',
  providerAuthorizationChallengeClicks: 1, terminationReason: 'wait_timeout', timeoutPhase: 'callback',
  callbackWaitDiagnostics: { outcome: 'target_not_returned', polls: 361, elapsedMs: 90_000, budgetMs: 90_000 } };

test('a departed LinuxDO authorization without a callback stops identical automatic attempts', async () => {
  let calls = 0;
  const result = await runTargetFirstLinuxDoOAuthWithRetry({ provider: 'LinuxDO', linuxDoSessionStrategy: 'target_oauth' }, {},
    { oauthAttempts: 3 }, { runHelper: async () => { calls++; return callbackFailure; } });
  assert.equal(calls, 1);
  assert.equal(result, callbackFailure);
  const failure = reauthLoginFailureResult('LinuxDO', result.oauthStage, { diagnostics: result });
  assert.equal(failure.retryable, false);
  assert.equal(failure.timeoutPhase, 'callback');
  assert.deepEqual(failure.callbackWaitDiagnostics, callbackFailure.callbackWaitDiagnostics);
  assert.notEqual(reauthLoginFailureResult('GitHub', result.oauthStage, { diagnostics: result }).retryable, false);
  for (const changed of [{ authorizationOutcome: 'authorization_not_found' },
    { callbackWaitDiagnostics: { outcome: 'target_returned' } }, { status: 'logged_in' }, { succeeded: true }]) {
    assert.equal(isStalledOAuthCallback({ ...callbackFailure, ...changed }), false);
  }
});

test('callback stalls persist across helper invocations but leave one native continuation available', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-callback-budget-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const binding = { file: path.join(dir, 'budget.json'), key: 'test', cycle: 'cycle', limit: 3 };
  // An older budget without the new marker must remain readable.
  await fs.writeFile(binding.file, JSON.stringify({ entries: { test: {
    cycle: 'cycle', automatic: 0, native: 0, challengeBlocked: false,
  } } }));
  assert.equal((await updateOAuthRetryBudget(binding, 'automatic')).allowed, true);
  await updateOAuthRetryBudget(binding, 'automatic', { ...callbackFailure, privateUrl: 'private-fixture' });
  assert.deepEqual(await inspectOAuthRetryBudget(binding), { automaticAllowed: false, nativeAllowed: true });
  assert.equal((await updateOAuthRetryBudget(binding, 'automatic')).allowed, false);
  assert.equal((await updateOAuthRetryBudget(binding, 'native')).allowed, true);
  assert.equal((await updateOAuthRetryBudget(binding, 'native')).allowed, false);
  assert.deepEqual(await inspectOAuthRetryBudget({ ...binding, cycle: 'new-logout' }), {
    automaticAllowed: true, nativeAllowed: true,
  });
  assert.doesNotMatch(await fs.readFile(binding.file, 'utf8'), /private-fixture|authorization_departed/);
});

test('an unresolved provider challenge stops automatic retries immediately and retains manual eligibility', async () => {
  let calls = 0;
  const failure = { succeeded: false, oauthStage: 'provider_authorization', authorizationOutcome: 'provider_challenge_unresolved' };
  const result = await runTargetFirstLinuxDoOAuthWithRetry({ provider: 'LinuxDO', linuxDoSessionStrategy: 'target_oauth' }, {},
    { oauthAttempts: 3 }, { runHelper: async () => { calls++; return failure; } });
  assert.equal(calls, 1);
  assert.equal(result, failure);
  assert.equal(reauthLoginFailureResult('LinuxDO', result.oauthStage, { diagnostics: result }).retryable, false);
});

test('automatic and native helpers share a durable account and logout scoped budget', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-budget-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const now = new Date();
  const account = { provider: 'LinuxDO', origin: 'https://budget.example', accountKey: 'first',
    statePath: path.join(dir, 'state.json'), oauthAttempts: 3 };
  const previous = { date: localRunDate(now), status: 'logged_out', updatedAt: now.toISOString(),
    loginEvidenceReset: true, logoutConfirmed: true };
  const binding = oauthRetryBudgetBinding(account, previous, now);
  assert.equal((await updateOAuthRetryBudget(binding, 'automatic')).allowed, true);
  await updateOAuthRetryBudget(binding, 'automatic', { authorizationOutcome: 'provider_challenge_unresolved', privateToken: 'must-not-persist' });
  assert.deepEqual(await inspectOAuthRetryBudget(binding), { automaticAllowed: false, nativeAllowed: true });
  assert.equal((await updateOAuthRetryBudget(binding, 'automatic')).allowed, false);
  assert.equal((await updateOAuthRetryBudget(binding, 'native')).allowed, true);
  assert.equal((await updateOAuthRetryBudget(binding, 'native')).allowed, false);
  assert.deepEqual(await inspectOAuthRetryBudget(binding), { automaticAllowed: false, nativeAllowed: false });
  const other = oauthRetryBudgetBinding({ ...account, accountKey: 'second' }, previous, now);
  assert.deepEqual(await inspectOAuthRetryBudget(other), { automaticAllowed: true, nativeAllowed: true });
  const fresh = oauthRetryBudgetBinding(account, { ...previous, updatedAt: new Date(now.getTime() - 1).toISOString() }, now);
  assert.deepEqual(await inspectOAuthRetryBudget(fresh), { automaticAllowed: true, nativeAllowed: true });
  assert.equal(oauthRetryBudgetBinding({ ...account, provider: 'GitHub' }, previous, now), null);
  assert.equal(oauthRetryBudgetBinding(account, { ...previous, date: '20000101' }, now), null);
  assert.doesNotMatch(await fs.readFile(binding.file, 'utf8'), /must-not-persist|budget\.example|first/);
});

test('transient OAuth failures retain a finite budget across helper invocations', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-budget-limit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const binding = { file: path.join(dir, 'budget.json'), key: 'test', cycle: 'cycle', limit: 2 };
  for (let i = 0; i < 2; i++) {
    assert.equal((await updateOAuthRetryBudget(binding, 'automatic')).allowed, true);
    await updateOAuthRetryBudget(binding, 'automatic', { oauthStage: 'timeout' });
  }
  assert.equal((await updateOAuthRetryBudget(binding, 'automatic')).allowed, false);
  assert.equal((await inspectOAuthRetryBudget(binding)).nativeAllowed, true);
});
