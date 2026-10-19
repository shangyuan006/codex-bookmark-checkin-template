import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dismissConfiguredPreCheckinOverlay } from '../src/browser.mjs';
import { readNativeCheckinState, waitForNativeReadOnlyCompletion } from '../src/native-checkin-state.mjs';
import { sanitizeOAuthPageObservation } from '../src/oauth-target-state.mjs';

const origin = 'https://fixture.example';
const target = { origin, allowedOrigins: [origin] };
const config = { actionWaitMs: 1500, preCheckinDismissRules: {
  [origin]: { selectors: ['.close'], waitMs: 1, maxDismissals: 3 },
} };

test('an ineffective announcement close is not clicked repeatedly and diagnostics contain no page content', async () => {
  let time = 0, clicks = 0;
  const candidate = { isVisible: async () => true, isEnabled: async () => true,
    evaluate: async () => 'same', click: async () => { clicks++; } };
  const page = { locator: () => ({ count: async () => 1, nth: () => candidate }) };
  await assert.rejects(dismissConfiguredPreCheckinOverlay(page, target, origin, config, {
    now: () => time, wait: async ms => { time += ms; },
  }), error => {
    assert.deepEqual(error.noticeDismissDiagnostics, { outcome: 'no_progress', clicks: 1, transitions: 0, elapsedMs: 1500 });
    return true;
  });
  assert.equal(clicks, 1);
  assert.deepEqual(sanitizeOAuthPageObservation({ noticeDismissDiagnostics: {
    outcome: 'no_progress', clicks: 1, transitions: 0, elapsedMs: 1500, body: 'private' }, body: 'private' }),
  { noticeDismissDiagnostics: { outcome: 'no_progress', clicks: 1, transitions: 0, elapsedMs: 1500 } });
});

test('SafeLine state exposes loading separately from a visible interactive confirmation', async () => {
  for (const enabled of [false, true]) {
    const page = { url: () => `${origin}/result`, title: async () => 'SafeLine', evaluate: async () => ({
      bodyText: '雷池 客户端异常，请确认您是合法用户', loaded: true, authenticated: false, hasPassword: false,
      challengeEvidence: [], controlTexts: [], safeLinePrompt: true,
      safeLineControlVisible: enabled, safeLineControlEnabled: enabled,
    }) };
    const current = await readNativeCheckinState(page, origin, {}, { readFrames: async () => [] });
    assert.equal(current.state.status, 'interactive_challenge');
    assert.equal(current.challengeLoading, !enabled);
    assert.equal(current.challengeRequiresInteraction, enabled);
  }
});

for (const scenario of ['resolves', 'interactive', 'times_out']) test(`read-only SafeLine passive wait ${scenario}`, async () => {
  let time = 0, observation;
  const page = { url: () => `${origin}/result`, waitForTimeout: async ms => { time += ms; } };
  const result = await waitForNativeReadOnlyCompletion(page, origin, {}, {
    timeoutMs: 4000, now: () => time, onObservation: value => { observation = value; },
    readState: async () => time >= 2000 && scenario === 'resolves'
      ? { state: { status: 'already_signed' } }
      : { state: { status: 'interactive_challenge', failureCode: 'safeline_client_challenge' },
        challengeLoading: !(time >= 2000 && scenario === 'interactive'),
        challengeRequiresInteraction: time >= 2000 && scenario === 'interactive' },
  });
  assert.equal(time, scenario === 'times_out' ? 4000 : 2000);
  assert.equal(result.state.status, scenario === 'resolves' ? 'already_signed' : 'interactive_challenge');
  assert.equal(observation.outcome, scenario === 'resolves' ? 'completed' : scenario === 'interactive' ? 'blocked' : 'timed_out');
  assert.ok(observation.challengeWaitPolls >= 2);
});

test('offline Edge confirms announcement removal, replacement and stalled close without extra clicks', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 20000,
}, async t => {
  const { chromium } = createRequire(import.meta.url)('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let html = '';
  await page.route(`${origin}/**`, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  const run = async (markup, expectedClicks, expectedOutcome) => {
    html = `<div role="dialog"><span id="notice">Announcement one</span><button class="close" onclick="window.clicks=(window.clicks||0)+1;${markup}">Close</button></div>`;
    await page.goto(origin);
    let final;
    const promise = dismissConfiguredPreCheckinOverlay(page, target, origin, config, { onObservation: value => { final = value; } });
    if (expectedOutcome === 'no_progress') await assert.rejects(promise, /公告关闭未取得页面确认/);
    else assert.equal(await promise, true);
    assert.equal(await page.evaluate(() => window.clicks), expectedClicks);
    assert.equal(final.outcome, expectedOutcome);
  };
  await run("setTimeout(()=>this.parentElement.remove(),1100)", 1, 'dismissed');
  await run("this.style.display='none';setTimeout(()=>this.parentElement.remove(),1100)", 1, 'dismissed');
  await run("if(window.clicks===1){document.querySelector('#notice').textContent='Announcement two'}else{this.parentElement.remove()}", 2, 'dismissed');
  await run('', 1, 'no_progress');
});
