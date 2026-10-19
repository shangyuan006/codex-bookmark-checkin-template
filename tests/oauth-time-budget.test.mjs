import test from 'node:test';
import assert from 'node:assert/strict';
import { createOAuthTimeBudget, OAuthTimeBudgetError, OAUTH_HELPER_TIMEOUT_MS } from '../src/oauth-time-budget.mjs';
import { waitForOAuthTargetReturn } from '../src/oauth-target-completion.mjs';

const origin = 'https://target.example';
const config = { reauthCheckinRules: { [origin]: { accountMenuSelector: '#account' } } };

test('a callback arriving near its deadline still gets reserved session verification time', async () => {
  let time = 0;
  const now = () => time, wait = async ms => { time += ms; };
  const budget = createOAuthTimeBudget({ now });
  time = 134_000;
  assert.equal(budget.timeoutMs('provider', 90_000), 1000);
  const page = { url: () => time < 149_000 ? 'https://provider.example/authorize'
    : time < 150_000 ? origin + '/oauth/callback' : origin + '/console' };
  const context = { pages: () => [page] };
  let callbackWait, sessionStartedAt;
  const completion = await waitForOAuthTargetReturn(context, origin, config, {
    timeBudget: budget, waitMs: 90_000, now, wait,
    onCallbackProgress: value => { callbackWait = value; },
    onPhase: () => { sessionStartedAt = time; },
    readSurface: async () => ({ kind: 'authenticated_target', ready: true, authenticatedControl: true }),
  });
  assert.equal(completion.loggedIn, true);
  assert.equal(callbackWait.outcome, 'target_returned');
  assert.equal(sessionStartedAt, 149_000);
  assert.equal(completion.elapsedMs, 1500);
  assert.ok(time <= OAUTH_HELPER_TIMEOUT_MS - 15_000);
});

test('a callback that never returns stays unconfirmed and retains the cleanup reserve', async () => {
  let time = 0;
  const now = () => time, wait = async ms => { time += ms; };
  const budget = createOAuthTimeBudget({ now });
  time = 135_000;
  assert.throws(() => budget.timeoutMs('provider', 1), OAuthTimeBudgetError);
  const context = { pages: () => [{ url: () => 'https://provider.example/authorize' }] };
  const completion = await waitForOAuthTargetReturn(context, origin, config, {
    timeBudget: budget, waitMs: 90_000, now, wait,
    onPhase: () => assert.fail('No session phase without a target callback'),
  });
  assert.equal(completion.loggedIn, false);
  assert.equal(completion.timeoutPhase, 'callback');
  assert.equal(completion.terminationReason, 'wait_timeout');
  assert.equal(time, 150_000);
  assert.equal(budget.remainingMs('session'), 15_000);
});

test('the helper soft deadline stops stalled work before the parent watchdog and blocks late actions', async () => {
  const budget = createOAuthTimeBudget({ helperTimeoutMs: 100, cleanupReserveMs: 20,
    callbackReserveMs: 10, sessionReserveMs: 10 });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let acted = false;
  const operation = async () => { await blocked; budget.assertActive(); acted = true; };
  await assert.rejects(budget.run(operation), error => error.code === 'OAUTH_TIME_BUDGET_EXHAUSTED');
  release();
  await Promise.resolve();
  assert.equal(acted, false);
  assert.throws(() => budget.assertActive(), OAuthTimeBudgetError);
});

test('explicit interactive waiting retains its own existing wait instead of the automatic deadline', async () => {
  const budget = createOAuthTimeBudget({ helperTimeoutMs: 100, cleanupReserveMs: 20,
    callbackReserveMs: 10, sessionReserveMs: 10 });
  const result = await budget.run(async () => {
    budget.beginInteractiveWait();
    await new Promise(resolve => setTimeout(resolve, 100));
    budget.assertActive();
    return 'interactive_result';
  });
  assert.equal(result, 'interactive_result');
});
