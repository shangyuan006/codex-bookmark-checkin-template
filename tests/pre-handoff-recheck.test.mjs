import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recheckBeforeManualHandoff } from '../src/pre-handoff-recheck.mjs';
import { bindSuccessEvidence, successEvidence } from '../src/checkin-evidence.mjs';
import { createSubmissionScope, readSubmissionJournal, runWithSubmissionJournal } from '../src/submission-guard.mjs';

const origin = 'https://pending.example';
const target = { origin, candidates: [`${origin}/profile`] };
const at = new Date('2026-10-22T04:00:00Z');
const config = { preHandoffReadOnlyRecheckRules: { [origin]: { delayMs: 15_000, timeoutMs: 30_000 } } };
const pending = (site = origin, time = at) => ({ origin: site, status: 'needs_attention',
  submissionAttempted: true, failureCode: 'submission_quarantined', retryable: false,
  unresolvedChallenge: true, quarantine: { pendingCount: 1, actionType: 'checkin', firstAttemptAt: time.toISOString() } });
const completion = (identity = target, time = at, source = 'page_text') => bindSuccessEvidence({
  status: 'already_signed', url: `${identity.origin}/profile`,
  evidence: successEvidence(source, 'page_completion_text', time),
}, identity, {}, time);
const dependencies = (overrides = {}) => ({
  now: () => at, wait: async ms => assert.equal(ms, 15_000),
  launchContext: async () => ({}), closeContext: async () => ({ closed: true }),
  processTarget: async () => completion(), ...overrides,
});
async function journalFixture(t, activeConfig = config, time = at) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-recheck-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = { ...activeConfig, submissionJournalPath: path.join(root, 'journal.json'),
    automationUserDataDir: path.join(root, 'isolated') };
  await createSubmissionScope(runtime.submissionJournalPath, target, runtime, { now: () => time }).begin();
  return { root, runtime };
}

test('delayed completion confirms the existing journal entry without another submission', async t => {
  const { runtime } = await journalFixture(t);
  let reads = 0, closed = 0, published = 0;
  const before = await readSubmissionJournal(runtime.submissionJournalPath);
  const [result] = await recheckBeforeManualHandoff([pending()], [target], runtime, dependencies({
    processTarget: async (_context, identity, readOnlyConfig) => {
      reads++;
      assert.equal(readOnlyConfig.checkinReadOnly, true);
      assert.equal(readOnlyConfig.checkinObservationOnly, true);
      assert.equal(readOnlyConfig.retryCount, 0);
      assert.equal(readOnlyConfig.targetTimeoutMs, 30_000);
      assert.equal(readOnlyConfig.failureScreenshots, false);
      return runWithSubmissionJournal(runtime.submissionJournalPath, identity, readOnlyConfig,
        async active => { assert.equal(active.checkinReadOnly, true); return completion(); }, { now: () => at });
    },
    closeContext: async () => { closed++; return { closed: true }; },
    onResult: async result => { published++; assert.equal(closed, 1); assert.equal(result.status, 'already_signed'); },
  }));
  assert.equal(result.status, 'already_signed');
  assert.equal(result.preHandoffReadOnlyRecheck.outcome, 'confirmed');
  assert.equal(result.failureCode, undefined);
  assert.equal(result.unresolvedChallenge, undefined);
  assert.deepEqual([reads, closed, published], [1, 1, 1]);
  const after = await readSubmissionJournal(runtime.submissionJournalPath);
  assert.equal(after.entries.length, 1);
  assert.equal(after.entries[0].id, before.entries[0].id);
  assert.equal(after.entries[0].state, 'confirmed');
});

test('uncertainty, timeout and thrown errors retain the pending result and journal lock', async t => {
  for (const outcome of ['interactive_challenge', 'target_timeout', 'throw']) {
    const { runtime } = await journalFixture(t);
    const original = pending();
    let closed = 0;
    const [result] = await recheckBeforeManualHandoff([original], [target], runtime, dependencies({
      processTarget: async (_context, identity, readOnlyConfig) => {
        if (outcome === 'throw') throw new Error('private-response-must-not-be-recorded');
        return runWithSubmissionJournal(runtime.submissionJournalPath, identity, readOnlyConfig,
          async () => ({ status: outcome === 'target_timeout' ? 'error' : outcome, failureCode: outcome }), { now: () => at });
      },
      closeContext: async () => { closed++; return { closed: true }; },
    }));
    assert.equal(closed, 1);
    assert.equal(result.status, original.status);
    assert.equal(result.failureCode, original.failureCode);
    assert.deepEqual(result.quarantine, original.quarantine);
    assert.equal(result.retryable, false);
    assert.doesNotMatch(JSON.stringify(result), /private-response/);
    const journal = await readSubmissionJournal(runtime.submissionJournalPath);
    assert.equal(journal.entries.length, 1);
    assert.ok(['intent', 'uncertain'].includes(journal.entries[0].state));
  }
});

test('other site, account, action, cycle, stale and rule-only completions are rejected', async () => {
  const good = completion();
  for (const candidate of [
    { status: 'already_signed' },
    completion({ ...target, origin: 'https://other.example' }),
    completion({ ...target, accountKey: 'other' }),
    completion({ ...target, actionType: 'reauth' }),
    completion(target, new Date(at.getTime() - 86_400_000)),
    completion(target, new Date(at.getTime() - 1)),
    { ...good, evidence: { ...good.evidence, binding: { ...good.evidence.binding, observedOrigin: 'https://other.example' } } },
    completion(target, at, 'user_rule'),
    { ...completion(target, at, 'user_rule'), evidence: { ...completion(target, at, 'user_rule').evidence, authoritative: true } },
  ]) {
    const [result] = await recheckBeforeManualHandoff([pending()], [target], config,
      dependencies({ processTarget: async () => candidate }));
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.preHandoffReadOnlyRecheck.outcome, 'unconfirmed');
    assert.equal(result.failureCode, 'submission_quarantined');
  }
});

test('a different isolated profile cannot confirm the existing pending submission', async t => {
  const { runtime, root } = await journalFixture(t);
  const changedProfile = { ...runtime, automationUserDataDir: path.join(root, 'other-profile') };
  const [result] = await recheckBeforeManualHandoff([pending()], [target], changedProfile, dependencies({
    processTarget: (_context, identity, activeConfig) => runWithSubmissionJournal(runtime.submissionJournalPath,
      identity, activeConfig, async () => completion(), { now: () => at }),
  }));
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.preHandoffReadOnlyRecheck.outcome, 'unconfirmed');
  const journal = await readSubmissionJournal(runtime.submissionJournalPath);
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0].state, 'uncertain');
});

test('no opt-in, completed results, other scopes and historical locks do not open a browser', async () => {
  const cases = [
    [pending(), [target], {}],
    [{ ...pending(), status: 'already_signed' }, [target], config],
    [{ ...pending(), failureCode: 'login_required', submissionAttempted: false }, [target], config],
    [pending(), [], config],
    [pending(origin, new Date(at.getTime() - 86_400_000)), [target], config],
    [pending(origin, new Date(at.getTime() + 1)), [target], config],
    [pending(), [{ ...target, accountKey: 'other' }], config],
    [pending(), [target], { ...config, reauthCheckinRules: { [origin]: {} } }],
    [pending(), [target], { ...config, sequentialActionRules: { [origin]: {} } }],
    [{ ...pending(), preHandoffReadOnlyRecheck: { attempted: true } }, [target], config],
  ];
  for (const [result, targets, activeConfig] of cases) {
    const actual = await recheckBeforeManualHandoff([result], targets, activeConfig,
      dependencies({ wait: async () => assert.fail('must not wait'), launchContext: async () => assert.fail('must not launch') }));
    assert.equal(actual[0], result);
  }
});

test('cycle rollover during the delay prevents navigation', async () => {
  let current = at;
  const [result] = await recheckBeforeManualHandoff([pending()], [target], config, dependencies({
    now: () => current,
    wait: async () => { current = new Date(at.getTime() + 86_400_000); },
    launchContext: async () => assert.fail('must not launch in another cycle'),
  }));
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.preHandoffReadOnlyRecheck.outcome, 'cycle_changed');
});

test('failed cleanup or a previously blocked browser prevents further launches', async () => {
  const secondOrigin = 'https://second.example';
  const second = { origin: secondOrigin, candidates: [`${secondOrigin}/profile`] };
  const activeConfig = { preHandoffReadOnlyRecheckRules: { ...config.preHandoffReadOnlyRecheckRules, [secondOrigin]: {} } };
  let launches = 0;
  const results = await recheckBeforeManualHandoff([pending(), pending(secondOrigin)], [target, second], activeConfig, dependencies({
    launchContext: async () => { launches++; return {}; },
    processTarget: async () => ({ status: 'interactive_challenge' }),
    closeContext: async () => ({ closed: false, fallbackAttempted: true, fallbackSucceeded: false }),
  }));
  assert.equal(launches, 1);
  assert.equal(results[0].preHandoffReadOnlyRecheck.cleanupFailed, true);
  assert.equal(results[1].preHandoffReadOnlyRecheck, undefined);
  await recheckBeforeManualHandoff([pending()], [target], config,
    dependencies({ canLaunch: () => false, launchContext: async () => assert.fail('cleanup is blocked') }));
});

test('offline Edge observes a delayed completed page without clicking or posting', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 40_000,
}, async t => {
  const { chromium } = await import('playwright-core');
  const { processTarget } = await import('../src/browser.mjs');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const actual = new Date();
  const { root, runtime } = await journalFixture(t, config, actual);
  let posts = 0, clicks = 0, navigations = 0, closed = 0;
  const [result] = await recheckBeforeManualHandoff([pending(origin, actual)], [target], runtime, dependencies({
    now: () => new Date(),
    launchContext: async () => {
      const context = await browser.newContext();
      await context.exposeBinding('recordClick', () => { clicks++; });
      await context.route(`${origin}/**`, async route => {
        if (route.request().method() === 'POST') posts++;
        if (route.request().isNavigationRequest()) navigations++;
        await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
          <div id="notice"><button>关闭公告</button></div><a href="/details">个人资料</a>
          <form action="/api/user/checkin" method="post"><button>立即签到</button></form>
          <p id="status">正在加载</p><script>
          document.addEventListener('click', () => window.recordClick());
          fetch('/api/user/checkin', {method:'POST'}).catch(() => {});
          setTimeout(() => document.querySelector('#status').textContent = '今日已签到', 100);
          </script>` });
      });
      return context;
    },
    processTarget: (context, identity, readOnlyConfig) => processTarget(context, identity, readOnlyConfig, [], root),
    closeContext: async context => { await context.close(); closed++; return { closed: true }; },
  }));
  assert.equal(result.status, 'already_signed');
  assert.equal(result.evidence.authoritative, true);
  assert.deepEqual([clicks, posts, navigations, closed], [0, 0, 1, 1]);
  const journal = await readSubmissionJournal(runtime.submissionJournalPath);
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0].state, 'confirmed');
});
