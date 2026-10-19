import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNativeSafeLineReader } from '../src/native-safeline-recovery.mjs';
import { waitForNativeReadOnlyCompletion } from '../src/native-checkin-state.mjs';
import { bindNativeCompletion } from '../src/native-completion-evidence.mjs';
import { successEvidence } from '../src/checkin-evidence.mjs';
import { createSubmissionScope, guardPageSubmissions, readSubmissionJournal, reconcileSubmissionResult } from '../src/submission-guard.mjs';

const origin = 'https://checkin.example';
const challenge = () => ({ state: { status: 'interactive_challenge', failureCode: 'safeline_client_challenge' } });

function fixture(overrides = {}) {
  let time = 0, current = challenge(), clicks = 0;
  const page = { url: () => origin + '/', waitForTimeout: async ms => { time += ms; } };
  const reader = createNativeSafeLineReader(origin, {
    enabled: true, deadline: () => 10_000, now: () => time,
    submissionBlocked: () => true, readState: async () => current,
    recover: async () => {
      clicks++;
      current = { state: { status: 'ready' } };
      return { attempted: true, resolved: true, outcome: 'safeline_resolved' };
    },
    ...overrides,
  });
  return { page, reader, setState: value => { current = value; }, clicks: () => clicks, time: () => time };
}

test('SafeLine confirmation proceeds with submissions blocked and never invents completion', async () => {
  const { page, reader, clicks } = fixture();
  assert.equal((await reader.read(page)).state.status, 'ready');
  assert.equal((await reader.read(page)).state.status, 'ready');
  assert.equal(clicks(), 1);
  assert.deepEqual(reader.diagnostics(), {
    observed: true, submissionBlocked: true, attempted: true, probeCount: 1,
    clickCount: 1, outcome: 'safeline_resolved', elapsedMs: 0, finalStatus: 'ready',
  });
});

test('a late SafeLine control is probed boundedly and clicked only once', async () => {
  let probes = 0;
  const active = fixture({ recover: async () => ++probes < 3
    ? { attempted: false, outcome: 'safeline_not_found' }
    : { attempted: true, resolved: false, outcome: 'safeline_rejected' } });
  assert.equal((await active.reader.read(active.page)).state.status, 'interactive_challenge');
  await active.reader.read(active.page);
  assert.equal(probes, 3);
  assert.equal(active.time(), 500);
  assert.equal(active.reader.diagnostics().clickCount, 1);
  assert.equal(active.reader.diagnostics().outcome, 'safeline_rejected');
});

test('missing controls, expired budgets and disabled interaction cannot create retry loops', async () => {
  for (const [options, expected, elapsed] of [
    [{ recover: async () => ({ attempted: false, outcome: 'safeline_not_visible' }) }, 'safeline_not_visible', 5000],
    [{ deadline: () => 0 }, 'safeline_deadline_expired', 0],
    [{ enabled: false }, 'safeline_not_enabled', 0],
  ]) {
    const active = fixture(options);
    await active.reader.read(active.page);
    const before = active.reader.diagnostics();
    await active.reader.read(active.page);
    assert.deepEqual(active.reader.diagnostics(), before);
    assert.equal(before.outcome, expected);
    assert.equal(before.clickCount, 0);
    assert.equal(active.time(), elapsed);
  }
});

test('ordinary challenges, login pages and completed pages do not invoke SafeLine recovery', async () => {
  for (const state of [{ status: 'interactive_challenge' }, { status: 'login_required' }, { status: 'already_signed' }]) {
    const active = fixture();
    active.setState({ state });
    assert.deepEqual((await active.reader.read(active.page)).state, state);
    assert.equal(active.clicks(), 0);
    assert.equal(active.reader.diagnostics(), null);
  }
});

test('a failed SafeLine click is not retried and outside-origin navigation fails closed', async () => {
  let attempts = 0;
  const active = fixture({ recover: async () => {
    attempts++;
    return { attempted: true, resolved: false, outcome: 'safeline_click_failed' };
  } });
  await active.reader.read(active.page);
  await active.reader.read(active.page);
  assert.equal(attempts, 1);
  const external = fixture();
  external.page.url = () => 'https://outside.example/';
  await assert.rejects(external.reader.read(external.page));
  assert.equal(external.clicks(), 0);
});

test('offline Edge confirms the result after SafeLine while retaining pending submission protection', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 90_000,
}, async t => {
  const require = createRequire(import.meta.url);
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'safeline-read-only-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  for (const completed of [true, false]) await t.test(completed ? 'explicit completion' : 'verification without completion', async () => {
    const context = await browser.newContext();
    try {
      let verified = false, verifications = 0, submissions = 0, blocked = 0;
      const visits = [];
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        assert.equal(url.origin, origin, 'fixtures must never access a real site');
        if (url.pathname === '/waf/confirm' && request.method() === 'POST') {
          verified = true; verifications++;
          return route.fulfill({ status: 200, body: 'ok' });
        }
        if (request.method() === 'POST') submissions++;
        if (request.resourceType() === 'document') visits.push(url.pathname);
        const markup = !verified
          ? `<h1>雷池 WAF</h1><p id="sl-text">客户端异常，请确认您是合法用户</p>
            <button id="sl-check" onclick="this.disabled=true; fetch('/attendance.php',{method:'POST'}).catch(()=>{});
              fetch('/waf/confirm',{method:'POST'}).then(()=>location.href='/')">确认</button>`
          : `<a href="/logout.php">退出</a>${url.pathname === '/attendance.php'
            ? completed ? '<p>今日已签到</p>' : '<p>签到记录待确认</p>'
            : '<a href="/attendance.php">签到入口</a>'}<p>${'.'.repeat(150)}</p>`;
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: markup });
      });
      const config = { preCheckinNavigationRules: { [origin]: { expectedPath: '/attendance.php',
        steps: [{ role: 'link', name: '签到入口' }], readOnlyFallbackToExpectedPath: true,
        waitMs: 500, afterClickWaitMs: 100 } } };
      const target = { origin, allowedOrigins: [origin] };
      const journalPath = path.join(directory, `${completed}.json`);
      await createSubmissionScope(journalPath, target, config, { now: () => new Date(Date.now() - 86400_000) }).begin();
      const previous = (await readSubmissionJournal(journalPath)).entries[0];
      const scope = createSubmissionScope(journalPath, target, config);
      const page = await context.newPage();
      page.on('requestfailed', request => { if (request.url() === origin + '/attendance.php') blocked++; });
      // Continue through the lower-priority fixture route instead of issuing
      // real network requests when the production guard allows a read.
      await guardPageSubmissions({ route: (match, handler) => page.route(match, route => handler({
        request: () => route.request(), abort: code => route.abort(code), continue: () => route.fallback(),
      })) }, target, scope, { readOnly: true });
      await page.goto(origin + '/');
      const deadline = Date.now() + 8000;
      const { readNativeCheckinState } = await import('../src/native-checkin-state.mjs');
      const recovery = createNativeSafeLineReader(origin, {
        enabled: true, deadline: () => deadline, submissionBlocked: () => true,
        readState: activePage => readNativeCheckinState(activePage, origin, config),
      });
      const current = await waitForNativeReadOnlyCompletion(page, origin, config, {
        timeoutMs: 8000, pollMs: 100, readState: recovery.read,
      });
      const observation = await bindNativeCompletion({ ...current.state, origin,
        ...(['signed', 'already_signed'].includes(current.state.status)
          ? { evidence: successEvidence('page_text', 'native_confirmed_completion') } : {}),
      }, target, config);
      await scope.observe(observation);
      const result = reconcileSubmissionResult(observation, await scope.allPending(), target, config);
      assert.equal(verifications, 1);
      assert.equal(submissions, 0);
      assert.equal(blocked, 1);
      assert.deepEqual(visits, ['/', '/', '/attendance.php']);
      assert.equal(recovery.diagnostics().submissionBlocked, true);
      assert.equal(recovery.diagnostics().clickCount, 1);
      if (completed) {
        assert.equal(result.status, 'already_signed');
        assert.equal(result.evidence.authoritative, true);
      } else {
        assert.equal(result.status, 'needs_attention');
        assert.equal(result.failureCode, 'submission_quarantined');
        assert.equal(result.evidence, undefined);
      }
      const journal = await readSubmissionJournal(journalPath);
      assert.equal(journal.entries.length, 1);
      assert.equal(journal.entries[0].id, previous.id);
      assert.equal(journal.entries[0].cycleId, previous.cycleId);
      assert.equal(journal.entries[0].state, 'uncertain');
    } finally { await context.close(); }
  });
});
