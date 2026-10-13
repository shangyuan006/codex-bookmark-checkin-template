import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { navigateConfiguredPreCheckinPage } from '../src/pre-checkin-navigation.mjs';
import { waitForNativeReadOnlyCompletion } from '../src/native-checkin-state.mjs';
import { bindNativeCompletion } from '../src/native-completion-evidence.mjs';
import { successEvidence } from '../src/checkin-evidence.mjs';
import { createSubmissionScope, readSubmissionJournal, reconcileSubmissionResult } from '../src/submission-guard.mjs';
import { requiresManualAttention } from '../src/attention-urls.mjs';

const origin = 'https://example.test';
const target = { origin, allowedOrigins: [origin] };
const navigationRule = { expectedPath: '/attendance.php', steps: [{ role: 'link', name: '签到入口' }],
  readOnlyFallbackToExpectedPath: true, waitMs: 500, afterClickWaitMs: 100 };
const config = { navigationTimeoutMs: 1000, checkinReadOnly: true,
  preCheckinNavigationRules: { [origin]: navigationRule } };

function linkFixture(href) {
  let url = `${origin}/`;
  const visits = [];
  const link = { count: async () => 1, nth() { return this; }, isVisible: async () => true,
    isEnabled: async () => true, getAttribute: async () => href,
    click: async () => assert.fail('read-only navigation must not click a control') };
  return { visits, page: { url: () => url, getByRole: () => link,
    waitForTimeout: async () => {}, goto: async destination => { url = destination; visits.push(destination); } } };
}

test('native read-only navigation uses a configured same-origin GET without clicking the link', async () => {
  const { page, visits } = linkFixture('/attendance.php');
  assert.equal(await navigateConfiguredPreCheckinPage(page, target, origin, config, { readOnlyLinksOnly: true }), true);
  assert.deepEqual(visits, [`${origin}/attendance.php`]);
});

test('read-only navigation rejects external, credential-bearing, scripted and unexpected destinations', async () => {
  for (const href of [null, 'javascript:void(0)', 'https://other.example/attendance.php',
    ['https://user:fixture@', 'example.test/attendance.php'].join(''), '/other.php', '/attendance.php?submit=1', '/attendance.php#submit']) {
    const { page, visits } = linkFixture(href);
    assert.equal(await navigateConfiguredPreCheckinPage(page, target, origin, config, { readOnlyLinksOnly: true }), false);
    assert.deepEqual(visits, []);
  }
});

test('read-only native navigation is opt-in and cannot use buttons, hidden controls or missing-entry terminal rules', async () => {
  for (const rule of [
    { ...navigationRule, readOnlyFallbackToExpectedPath: false },
    { ...navigationRule, steps: [{ role: 'button', name: '签到入口' }] },
    { ...navigationRule, steps: [{ role: 'link', name: '签到入口', allowHidden: true }] },
    { ...navigationRule, terminalWhenNavigationControlMissing: true },
    { ...navigationRule, steps: [...navigationRule.steps, ...navigationRule.steps] },
  ]) {
    const { page, visits } = linkFixture('/attendance.php');
    assert.equal(await navigateConfiguredPreCheckinPage(page, target, origin,
      { ...config, preCheckinNavigationRules: { [origin]: rule } }, { readOnlyLinksOnly: true }), false);
    assert.deepEqual(visits, []);
  }
  const { page, visits } = linkFixture('/attendance.php');
  assert.equal(await navigateConfiguredPreCheckinPage(page, target, origin,
    { ...config, checkinReadOnly: false }, { readOnlyLinksOnly: true }), false);
  assert.deepEqual(visits, []);
});

test('native read-only confirmation waits for a loaded authenticated page before any result-page navigation', async () => {
  for (const overrides of [{ pageLoaded: false }, { authenticated: false }, { siteBodyLoaded: false }]) {
    let time = 0;
    const { page, visits } = linkFixture('/attendance.php');
    page.waitForTimeout = async ms => { time += ms; };
    const result = await waitForNativeReadOnlyCompletion(page, origin, config, {
      timeoutMs: 1000, now: () => time,
      readState: async () => ({ state: { status: 'ready' }, siteBodyLoaded: true,
        pageLoaded: true, authenticated: true, ...overrides }),
    });
    assert.equal(result.state.status, 'ready');
    assert.deepEqual(visits, []);
    assert.equal(time, 1000);
  }
});

test('offline Edge reads configured completion pages while retaining historical uncertainty', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 120000,
}, async t => {
  const require = createRequire(import.meta.url);
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-read-only-navigation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const cases = [
    { name: 'visible result link', link: true, signed: true, expected: 'already_signed', visits: 2 },
    { name: 'missing result link uses the configured fallback', link: false, signed: true, expected: 'already_signed', visits: 2 },
    { name: 'result without completion text stays unresolved', link: true, signed: false, expected: 'ready', visits: 2 },
    { name: 'an expired session is handed off', link: true, password: true, expected: 'login_required', visits: 1 },
    { name: 'an interactive challenge is handed off', link: true, challenge: true, expected: 'interactive_challenge', visits: 1 },
    { name: 'no opt-in keeps the original page', link: true, optIn: false, expected: 'ready', visits: 1 },
    { name: 'a success on the original page does not reopen the result page', homeSigned: true, expected: 'already_signed', visits: 1 },
  ];
  for (const [index, fixture] of cases.entries()) {
    await t.test(fixture.name, async () => {
      const context = await browser.newContext();
      try {
        const requests = [];
        await context.route('**/*', async route => {
          const request = route.request(), url = new URL(request.url());
          assert.equal(url.origin, origin, 'all fixture requests must stay offline');
          assert.equal(request.method(), 'GET', 'no fixture may submit a check-in action');
          if (request.resourceType() === 'document') requests.push(url.pathname);
          const resultPage = url.pathname === '/attendance.php';
          const markup = resultPage
            ? fixture.signed ? '<p>[签到已得1000]</p>' : '<p>今日未签到</p>'
            : `${fixture.password ? '<input type="password">' : ''}${fixture.challenge ? '<div class="cf-turnstile">Verify</div>' : ''}
              ${fixture.link ? '<a href="/attendance.php" onclick="fetch(\'/unexpected-action\',{method:\'POST\'})">签到入口</a>' : ''}
              ${fixture.homeSigned ? '<p>今日已签到</p>' : '<p>首页</p>'}`;
          await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
            body: `<a href="/logout.php">退出</a><main>${markup}<p>${'.'.repeat(150)}</p></main>` });
        });
        const page = await context.newPage();
        await page.goto(`${origin}/`);
        const activeConfig = { ...config, preCheckinNavigationRules: { [origin]: {
          ...navigationRule, readOnlyFallbackToExpectedPath: fixture.optIn !== false,
        } } };
        const journalFile = path.join(directory, `journal-${index}.json`);
        const yesterday = new Date(Date.now() - 86400_000);
        await createSubmissionScope(journalFile, target, activeConfig, { now: () => yesterday }).begin();
        const prior = (await readSubmissionJournal(journalFile)).entries[0];
        const scope = createSubmissionScope(journalFile, target, activeConfig);
        const current = await waitForNativeReadOnlyCompletion(page, origin, activeConfig, { timeoutMs: 1500, pollMs: 100 });
        assert.equal(current.state.status, fixture.expected);
        assert.equal(requests.length, fixture.visits);
        if (fixture.visits === 2) assert.deepEqual(requests, ['/', '/attendance.php']);
        const observation = await bindNativeCompletion({ ...current.state, origin,
          ...(['signed', 'already_signed'].includes(current.state.status)
            ? { evidence: successEvidence('page_text', 'native_confirmed_completion') } : {}),
        }, target, activeConfig);
        await scope.observe(observation);
        const result = reconcileSubmissionResult(observation, await scope.allPending(), target, activeConfig);
        assert.equal(requiresManualAttention(result), fixture.expected !== 'already_signed');
        if (fixture.expected === 'already_signed') {
          assert.equal(result.status, 'already_signed');
          assert.equal(result.evidence.authoritative, true);
          assert.equal(result.historicalSubmissionWarning.pendingCount, 1);
          assert.equal(result.quarantine, undefined);
        } else assert.equal(result.evidence, undefined);
        const journal = await readSubmissionJournal(journalFile);
        assert.equal(journal.entries.length, 1);
        assert.equal(journal.entries[0].id, prior.id);
        assert.equal(journal.entries[0].cycleId, prior.cycleId);
        assert.equal(journal.entries[0].state, 'uncertain');
        assert.deepEqual(journal.entries[0].history[0], prior.history[0]);
      } finally { await context.close(); }
    });
  }
});
