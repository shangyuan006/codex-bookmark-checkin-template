import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { continueCheckinOnSamePage, getSamePageManualRule, readSamePageReadiness } from '../src/same-page-checkin.mjs';
import { selectSamePageManualTarget, samePageSequentialStep, samePageSequentialResult } from '../src/live-checkin-session.mjs';
import { preferCandidateResult, readConfiguredSequentialStepEvidence, clickConfiguredSequentialAction, tryConfiguredSequentialActions,
  getConfiguredSequentialActionRule, watchConfiguredSequentialResponses } from '../src/browser.mjs';
import { applyPreferredCandidates } from '../src/site-state.mjs';
import { mergeAuthoritativeDailyResults } from '../src/logger.mjs';
import { reconcileManualDocument } from '../src/manual-result-reconciliation.mjs';
import { bindSuccessEvidence, successEvidence } from '../src/checkin-evidence.mjs';
import { clickVisibleNativeChallengeControl } from '../src/native-checkin-action.mjs';
import { readChallengeWidgetReadiness, challengePointIsUnobstructed } from '../src/challenge-widget-readiness.mjs';
import { continueCloudflareRecovery } from '../src/cloudflare-recovery.mjs';

const origin = 'https://daily.example', target = { origin, allowedOrigins: [origin], candidates: [`${origin}/calendar`] };
const step = { url: `${origin}/calendar`, actionType: 'daily_checkin', actionTexts: ['签到'], actionTags: ['BUTTON'],
  actionTextPattern: '^签到\\s*·\\s*\\+\\d+$', completedTexts: ['今日已签到'], acceptGenericCheckinState: false };
const rawRule = { expectedPath: '/calendar', widgetSelector: '.verification', responseSelector: 'input[name=response]',
  sequentialActionType: 'daily_checkin', preferSamePage: true, startActionBeforeChallenge: true, siteReplaysAfterChallenge: true };
const config = { samePageManualCheckinRules: { [origin]: rawRule }, sequentialActionRules: { [origin]: { steps: [step] } } };

test('dynamic sequential same-page continuation is explicit, single-step and origin/path bound', () => {
  const rule = getSamePageManualRule(target, config);
  assert.equal(samePageSequentialStep(target, config, rule).actionType, 'daily_checkin');
  const native = { ...target, manualBrowserMode: 'native' };
  assert.equal(selectSamePageManualTarget({ targets: [native] }, config), native);
  assert.equal(selectSamePageManualTarget({ targets: [native] }, { ...config,
    samePageManualCheckinRules: { [origin]: { ...rawRule, preferSamePage: false } } }), null);
  for (const steps of [[{ ...step, actionType: 'daily_draw' }], [step, step], [{ ...step, url: `${origin}/other` }]]) {
    assert.throws(() => samePageSequentialStep(target, { ...config, sequentialActionRules: { [origin]: { steps } } }, rule));
  }
});

test('post-click verification waits for the site replay and never clicks the action twice', async () => {
  let tick = 0, clicks = 0, widget = false;
  const stages = [];
  const result = await continueCheckinOnSamePage({ rule: rawRule,
    isClosed: () => false, shouldClose: async () => tick > 10,
    readState: async () => ({ status: tick >= 6 ? 'signed' : widget ? 'interactive_challenge' : 'ready' }),
    readReady: async () => ({ widgetPresent: widget, responseReady: tick > 2, buttonReady: true }),
    submit: async () => { clicks++; widget = true; return true; },
    delay: async () => { tick++; }, now: () => tick * 500, onStage: async s => stages.push(s.stage), attentionAfterMs: 1000 });
  assert.equal(result.status, 'signed'); assert.equal(clicks, 1);
  assert.ok(stages.includes('completion_wait_timeout'));
  assert.equal(stages.at(-1), 'completed');
});

test('an existing post-click widget or pending intent cannot cause another action submission', async () => {
  for (const initialSubmissionAttempted of [false, true]) {
    let tick = 0;
    const result = await continueCheckinOnSamePage({ rule: rawRule, initialSubmissionAttempted,
      isClosed: () => false, shouldClose: async () => tick >= 5,
      readState: async () => ({ status: 'interactive_challenge' }),
      readReady: async () => ({ widgetPresent: true, responseReady: true, buttonReady: true }),
      submit: async () => assert.fail('the site owns the replay'),
      delay: async () => { tick++; }, now: () => tick * 500, onStage: async () => {}, attentionAfterMs: 1000 });
    assert.equal(result.status, 'unconfirmed'); assert.equal(tick, 5);
  }
});

test('same-page completion preserves the daily step identity and separately binds the whole task', () => {
  const action = bindSuccessEvidence({ status: 'signed', evidence: successEvidence('page_text', 'sequential_step_confirmed') },
    { ...target, actionType: step.actionType }, config);
  const result = samePageSequentialResult(action, target, config, step);
  assert.equal(result.status, 'signed'); assert.equal(result.actionType, 'checkin');
  assert.equal(result.evidence.binding.actionType, 'checkin');
  assert.equal(result.actionResults[0].evidence.binding.actionType, 'daily_checkin');
});

test('loaded bookmark page survives an auxiliary 404 in either candidate order', () => {
  const missing = { status: 'deferred', documentStatus: 404, retryCause: 'upstream_unavailable', url: `${origin}/` };
  const loaded = { status: 'no_action', documentStatus: 200, url: `${origin}/calendar` };
  assert.equal(preferCandidateResult(missing, loaded), loaded);
  assert.equal(preferCandidateResult(loaded, missing), loaded);
  assert.equal(preferCandidateResult({ ...missing, documentStatus: 500 }, loaded).documentStatus, 500);
  assert.equal(preferCandidateResult(missing, { ...loaded, url: 'https://other.example/' }), missing);
  assert.equal(preferCandidateResult(missing, { status: 'no_action' }), missing);
});

test('configured sequential or same-page entry never gains an obsolete preferred root', () => {
  const state = { sites: { [origin]: { preferredUrl: `${origin}/` } } };
  for (const rules of [config, { samePageManualCheckinRules: config.samePageManualCheckinRules }]) {
    assert.deepEqual(applyPreferredCandidates([target], state, rules)[0].candidates, target.candidates);
  }
});

const now = new Date('2026-11-03T06:00:00Z');
const earlier = '2026-11-03T04:00:00Z', later = '2026-11-03T05:00:00Z';
const failure = { origin, status: 'needs_attention', reason: 'action not found', failureCode: 'action_not_found', observedAt: earlier };
const latest = result => ({ runId: '20261103-120000', runState: 'final', isComplete: true, plannedTotal: 1, processedTotal: 1, finishedAt: earlier, results: [result] });
const report = result => ({ runId: '20261103-130000', runState: 'final', isComplete: true, finishedAt: later, results: [result] });
const failedWidget = { origin, status: 'interactive_challenge', reason: 'verification failed; window retained', failureCode: 'cloudflare_verification_unresolved', observedAt: later };

test('newer scoped failures update the cumulative result and preserve previous observations', () => {
  const merged = mergeAuthoritativeDailyResults(latest(failure), report(failedWidget), now);
  assert.equal(merged.results[0].status, 'interactive_challenge');
  assert.equal(merged.results[0].failureCode, failedWidget.failureCode);
  assert.equal(merged.results[0].observationHistory[0].failureCode, 'action_not_found');
  assert.deepEqual(merged.summary, { interactive_challenge: 1 });
});

test('failure supplements reject stale, future, cross-account, cross-action and cross-cycle observations', () => {
  for (const incoming of [{ ...failedWidget, observedAt: earlier }, { ...failedWidget, observedAt: '2026-11-03T07:00Z' },
    { ...failedWidget, accountKey: 'other' }, { ...failedWidget, actionType: 'daily_draw' }]) {
    assert.equal(mergeAuthoritativeDailyResults(latest(failure), report(incoming), now), null);
  }
  assert.equal(mergeAuthoritativeDailyResults(latest({ ...failure, cycle: { id: 'one' } }), report({ ...failedWidget, cycle: { id: 'two' } }), now), null);
  const completed = bindSuccessEvidence({ status: 'signed', evidence: successEvidence('page_text', 'completed', new Date(earlier)) }, target, {}, now);
  assert.equal(mergeAuthoritativeDailyResults(latest(completed), report(failedWidget), now), null);
});

test('failure supplements preserve a completed sibling action', () => {
  const completed = bindSuccessEvidence({ status: 'signed', evidence: successEvidence('page_text', 'completed', new Date(earlier)) },
    { ...target, actionType: 'daily_checkin' }, {}, now);
  const current = { ...failure, requiredActionTypes: ['daily_checkin', 'daily_draw'],
    actionResults: [completed, { ...failure, actionType: 'daily_draw' }] };
  const incoming = { ...failedWidget, requiredActionTypes: current.requiredActionTypes,
    actionResults: [{ ...failedWidget, actionType: 'daily_checkin' }, { ...failedWidget, actionType: 'daily_draw' }] };
  const merged = mergeAuthoritativeDailyResults(latest(current), report(incoming), now);
  assert.equal(merged.results[0].actionResults[0].status, 'signed');
  assert.equal(merged.results[0].actionResults[1].status, 'interactive_challenge');
});

test('manual verification and handoff records track a newer failure without completing or removing it', () => {
  for (const kind of ['verification', 'handoff']) {
    const doc = { state: kind === 'verification' ? 'pending_verification' : 'awaiting_manual_handoff',
      sourceRunId: '20261103-120000', createdAt: earlier, authoritativeEvidenceRequired: true,
      targets: [{ origin, verificationStatus: 'needs_attention', failureCode: 'action_not_found' }] };
    const update = reconcileManualDocument(doc, report(failedWidget), kind, { now });
    assert.equal(update.changed, true); assert.equal(update.document.state, doc.state);
    assert.equal(update.document.targets.length, 1);
    assert.equal(update.document.targets[0].lastObservation.status, 'interactive_challenge');
    assert.equal(update.document.targets[0].failureCode, failedWidget.failureCode);
    assert.equal(reconcileManualDocument(update.document, report(failedWidget), kind, { now }).changed, false);
    assert.equal(reconcileManualDocument(doc, report({ ...failedWidget, accountKey: 'other' }), kind, { now }).changed, false);
  }
});

test('explicit widget failure stops the recovery loop without another click', async () => {
  let tick = 0, clicks = 0;
  const result = await continueCloudflareRecovery({ readState: async () => ({ status: 'interactive_challenge' }),
    clickChallenge: async () => { clicks++; return { clicked: false, outcome: 'challenge_verification_failed' }; },
    now: () => tick, wait: async ms => { tick += ms; }, waitMs: 10000 });
  assert.equal(clicks, 1); assert.equal(result.status, 'interactive_challenge');
});

test('manual failure updates use the selected account observation rather than another account aggregate reason', () => {
  const doc = { state: 'pending_verification', sourceRunId: '20261103-120000', createdAt: earlier,
    targets: [{ origin, accountKey: 'first', actionType: 'reauth', verificationStatus: 'needs_attention' }] };
  const incoming = { ...failedWidget, reason: 'other account failure', accountResults: [
    { ...failedWidget, accountKey: 'first', actionType: 'reauth', reason: 'selected account failure' },
    { ...failedWidget, accountKey: 'second', actionType: 'reauth' }] };
  const updated = reconcileManualDocument(doc, report(incoming), 'verification', { now });
  assert.equal(updated.changed, true);
  assert.equal(updated.document.targets[0].verificationReason, 'selected account failure');
});

test('only exact configured server rejections can release intent; unknown responses and replay success cannot', async () => {
  const rejection = { urlPath: '/api/attendance', methods: ['POST'], statuses: [422],
    rejectedAny: [{ path: 'message', equals: 'Verification required' }] };
  const normalized = getConfiguredSequentialActionRule(target, { sequentialActionRules: { [origin]: { steps: [{ ...step, rejectionEvidence: [rejection] }] } } }).steps[0];
  for (const scenario of ['rejected', 'unknown', 'replay', 'failed', 'wrong_path']) {
    const page = new EventEmitter(), watcher = watchConfiguredSequentialResponses(page, normalized, origin);
    const path = scenario === 'wrong_path' ? '/api/attendance/history' : '/api/attendance';
    const request = { url: () => origin + path, method: () => 'POST' };
    page.emit('request', request);
    page.emit('response', { request: () => request, url: request.url, status: () => 422,
      json: async () => ({ message: scenario === 'unknown' ? 'Unspecified error' : 'Verification required' }) });
    if (scenario === 'replay') {
      const replay = { ...request }; page.emit('request', replay);
      page.emit('response', { request: () => replay, url: request.url, status: () => 200, json: async () => ({ success: true }) });
    }
    if (scenario === 'failed') page.emit('requestfailed', request);
    await watcher.stop();
    assert.equal(watcher.allSubmissionsRejected(), scenario === 'rejected', scenario);
  }
  for (const malformed of [{ ...rejection, statuses: [200] }, { ...rejection, statuses: [429] }, { ...rejection, methods: ['GET'] }, { ...rejection, urlPath: '//outside.example/' }]) {
    assert.throws(() => getConfiguredSequentialActionRule(target, { sequentialActionRules: { [origin]: { steps: [{ ...step, rejectionEvidence: [malformed] }] } } }));
  }
});

test('offline Edge continues a dynamic post-click action on its original document through delayed site replay', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 15000,
}, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); let clicks = 0;
  await page.exposeFunction('recordClick', () => clicks++);
  await page.route(`${origin}/**`, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
    `<button onclick="recordClick();document.querySelector('.verification').style.display='block';setTimeout(()=>this.textContent='今日已签到',1200)">签到 · +12</button>
    <div class="verification" style="display:none">请验证您是真人<input name="response" value=""></div>` }));
  await page.goto(step.url);
  const normalized = samePageSequentialStep(target, config, rawRule), rule = { ...rawRule, actionName: '签到', actionTextPattern: step.actionTextPattern };
  const result = await continueCheckinOnSamePage({ rule, isClosed: () => page.isClosed(), shouldClose: async () => false,
    readState: async () => { const e = await readConfiguredSequentialStepEvidence(page, normalized, 'after'); return e.done ? e : e.state; },
    readReady: () => readSamePageReadiness(page, target, rule),
    submit: async () => (await clickConfiguredSequentialAction(page, normalized, [origin], async () => {})).clicked,
    delay: ms => page.waitForTimeout(ms), onStage: async () => {} });
  assert.equal(result.status, 'signed'); assert.equal(clicks, 1); assert.equal(page.url(), step.url);
});

test('offline Edge waits for a real checkbox, rejects loading/failure/overlays and supports closed-shadow frames', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 30000,
}, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route(`${origin}/**`, route => route.fulfill({ contentType: 'text/html', body: '<main></main>' }));
  await page.route('https://challenges.cloudflare.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
    `<style>body{margin:0}label{display:block;width:300px;height:65px}input{margin:22px}</style>
    <div id="loading">Verifying</div><label style="display:none"><input type="checkbox">请验证您是真人</label>
    <script>setTimeout(()=>{document.querySelector('#loading').remove();document.querySelector('label').style.display='block'},700)</script>` }));
  await page.goto(`${origin}/calendar`);
  await page.evaluate(() => {
    const host = document.createElement('div'); document.body.append(host);
    host.attachShadow({ mode: 'closed' }).innerHTML = '<iframe style="border:0;width:300px;height:65px" src="https://challenges.cloudflare.com/widget"></iframe>';
  });
  await page.waitForFunction(() => document.querySelector('div'));
  let frame; for (let i = 0; i < 30; i++) { frame = page.frames().find(f => f.url().includes('challenges.cloudflare.com')); if (frame) break; await page.waitForTimeout(50); }
  assert.ok(frame);
  const before = await readChallengeWidgetReadiness(frame);
  assert.equal(before.checkboxReady, false);
  const started = Date.now();
  const clicked = await clickVisibleNativeChallengeControl(page, origin, { actionTexts: ['签到'], clickChallenge: true, challengeFrameStableMs: 3000 });
  assert.equal(clicked.clicked, true); assert.ok(Date.now() - started >= 3400);
  assert.equal(await frame.locator('input').isChecked(), true);
  const element = await frame.frameElement(), box = await element.boundingBox();
  await page.evaluate(() => { const overlay = document.createElement('div'); overlay.id = 'guide'; overlay.style = 'position:fixed;inset:0;background:white;z-index:999'; document.body.append(overlay); });
  assert.equal(await challengePointIsUnobstructed(page, box, element), false);
  await page.locator('#guide').evaluate(e => e.remove());
  assert.equal(await challengePointIsUnobstructed(page, box, element), true);
  await frame.evaluate(() => { document.body.innerHTML = '<p>验证失败</p><input type="checkbox">'; });
  assert.equal((await readChallengeWidgetReadiness(frame)).failed, true);
  const failed = await clickVisibleNativeChallengeControl(page, origin, { actionTexts: ['签到'], clickChallenge: true });
  assert.equal(failed.clicked, false); assert.equal(failed.outcome, 'challenge_verification_failed');
});

test('regular sequential workflow clicks the post-action widget and observes site completion without another check-in', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 25000,
}, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); let clicks = 0;
  await page.exposeFunction('recordClick', () => clicks++);
  await page.route(`${origin}/**`, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
    `<button>签到 · +12</button><main></main>
    <script>document.querySelector('button').onclick=()=>{recordClick();const frame=document.createElement('iframe');frame.style='border:0;width:300px;height:65px';frame.src='https://challenges.cloudflare.com/widget';document.querySelector('main').append(frame)};
    addEventListener('message',e=>{if(e.origin==='https://challenges.cloudflare.com'&&e.data==='verified')setTimeout(()=>{document.querySelector('main').remove();document.querySelector('button').textContent='今日已签到'},300)})</script>` }));
  await page.route('https://challenges.cloudflare.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
    `<style>body{margin:0}label{display:block;width:300px;height:65px}input{margin:22px}</style>
    <label><input type="checkbox" onclick="parent.postMessage('verified','${origin}')">请验证您是真人</label>` }));
  const result = await tryConfiguredSequentialActions(page, target, { ...config, navigationTimeoutMs: 3000,
    cloudflareRecoveryRules: { [origin]: { maxClicks: 1 } },
    challengeInteractionRules: { [origin]: { type: 'click', phase: 'after', waitMs: 12000, optional: true, frameStableMs: 3000, retryAction: false } } });
  assert.equal(result.status, 'signed', JSON.stringify(result)); assert.equal(clicks, 1);
  assert.equal(result.actionResults[0].actionType, 'daily_checkin');
});

test('regular workflow releases only an explicitly rejected intent and keeps an unknown server outcome isolated', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 25000,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-rejection-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  for (const status of [422, 500]) {
    const page = await browser.newPage();
    await page.route(`${origin}/**`, route => new URL(route.request().url()).pathname === '/api/attendance'
      ? route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ message: 'Verification required' }) })
      : route.fulfill({ contentType: 'text/html; charset=utf-8', body:
        `<button>签到 · +12</button><main></main><script>document.querySelector('button').onclick=async()=>{await fetch('/api/attendance',{method:'POST'});document.querySelector('main').innerHTML='<div class="cf-turnstile"><input type="checkbox"></div>'}</script>` }));
    const journal = path.join(root, `${status}.json`);
    const local = { ...config, navigationTimeoutMs: 3000, submissionJournalPath: journal,
      sequentialActionRules: { [origin]: { steps: [{ ...step, waitMs: 1000, rejectionEvidence: [{ urlPath: '/api/attendance',
        methods: ['POST'], statuses: [422], rejectedAny: [{ path: 'message', equals: 'Verification required' }] }] }] } },
      challengeInteractionRules: { [origin]: { type: 'wait', phase: 'after', waitMs: 1000, settleMs: 500 } } };
    const result = await tryConfiguredSequentialActions(page, target, local);
    assert.equal(result.status, 'interactive_challenge', JSON.stringify(result));
    const entries = JSON.parse(await fs.readFile(journal, 'utf8')).entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].state, status === 422 ? 'rejected' : 'uncertain');
    await page.close();
  }
});
