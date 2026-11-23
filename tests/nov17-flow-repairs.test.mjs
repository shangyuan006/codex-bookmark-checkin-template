import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright-core';
import { clickConfiguredSequentialAction } from '../src/browser.mjs';
import { continueNativeSamePage } from '../src/same-page-sequential.mjs';
import { readSamePageLocationState, readSamePageReadiness } from '../src/same-page-checkin.mjs';
import { readSubmissionJournal } from '../src/submission-guard.mjs';
import { controlledManualTargets, controlledManualRule, continueControlledManualSession } from '../src/manual-native-continuation.mjs';
import { configuredNativeVisitRule, verifyNativeVisitCheckin } from '../src/native-visit-checkin.mjs';
import { validManualCompletion } from '../src/manual-result-reconciliation.mjs';
import { localRunDate } from '../src/retry-policy.mjs';

const origin = 'https://retained.example', target = { origin, allowedOrigins: [origin] };
const step = { url: origin + '/calendar', actionType: 'daily_checkin', actionTexts: ['签到'], actionTags: ['BUTTON'],
  completedTexts: ['今日已签到'], acceptGenericCheckinState: false, dailyCheckin: true, waitMs: 500 };
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nov17-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  await fs.mkdir(path.join(dir, 'tmp')); await fs.mkdir(path.join(dir, 'config'));
  return dir;
}
function actionPage({ trialFails = 0, actualFails = false } = {}) {
  const page = new EventEmitter(), calls = { trial: 0, actual: 0 };
  const control = { tagName: 'BUTTON', text: '签到', visible: true, disabled: false, href: null, formAction: null };
  const handle = { evaluate: async () => control, dispose: async () => {}, click: async options => {
    if (options.trial) { if (++calls.trial <= trialFails) throw new Error('Timeout PRIVATE_URL token=PRIVATE_VALUE'); }
    else { calls.actual++; if (actualFails) throw new Error('Execution context was destroyed PRIVATE_VALUE'); }
  } };
  page.url = () => origin + '/calendar'; page.isClosed = () => false; page.route = async () => {};
  page.locator = () => ({ elementHandles: async () => [handle] });
  return { page, calls };
}
function samePageConfig(dir) {
  return { automationUserDataDir: path.join(dir, 'profile'), submissionJournalPath: path.join(dir, 'journal.json'),
    samePageManualCheckinRules: { [origin]: { browserMode: 'native', expectedPath: '/calendar',
      widgetSelector: '.verification', responseSelector: 'input[name=response]', sequentialActionType: 'daily_checkin',
      startActionBeforeChallenge: true, siteReplaysAfterChallenge: true } },
    sequentialActionRules: { [origin]: { steps: [step] } } };
}
function samePageOptions(calls, overrides = {}) {
  let clock = 0;
  return { now: () => clock, delay: async ms => { clock += ms; }, waitMs: 1500, dismiss: async () => {},
    readEvidence: async () => calls.actual ? { done: true, status: 'signed' } : { done: false, state: { status: 'ready' } },
    readReady: async () => ({ buttonReady: true, widgetPresent: false, pageStatus: 'ready' }), ...overrides };
}

for (const phase of ['trial_click', 'reserve_intent', 'dispatch_click']) test(`click failure diagnostics identify ${phase} without private text`, async () => {
  const f = actionPage({ trialFails: phase === 'trial_click' ? 1 : 0, actualFails: phase === 'dispatch_click' });
  const events = [];
  await assert.rejects(clickConfiguredSequentialAction(f.page, step, [origin], async () => {
    if (phase === 'reserve_intent') throw new Error('PRIVATE_VALUE');
  }, { onProgress: value => events.push(value) }), error => {
    assert.equal(error.actionDiagnostics.phase, phase);
    assert.equal(error.actionDiagnostics.dispatchInvoked, phase === 'dispatch_click');
    assert.equal(error.actionDiagnostics.outcome, 'failed');
    assert.doesNotMatch(JSON.stringify({ error, events }), /PRIVATE|token|https/);
    return true;
  });
  assert.equal(f.calls.actual, phase === 'dispatch_click' ? 1 : 0);
});

test('a proven pre-dispatch failure retries once, creates only one intent, and waits for completion', async t => {
  const dir = await fixture(t), config = samePageConfig(dir), f = actionPage({ trialFails: 1 });
  const result = await continueNativeSamePage(f.page, target, config, samePageOptions(f.calls));
  assert.equal(result.status, 'signed'); assert.equal(f.calls.trial, 2); assert.equal(f.calls.actual, 1);
  assert.equal(result.firstSubmissionFailure.action.phase, 'trial_click');
  assert.equal(result.firstSubmissionFailure.action.dispatchInvoked, false);
  const journal = await readSubmissionJournal(config.submissionJournalPath);
  assert.equal(journal.entries.length, 1); assert.equal(journal.entries[0].state, 'confirmed');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test('a dispatched uncertain click stays protected even with zero matched requests', async t => {
  const dir = await fixture(t), config = samePageConfig(dir), f = actionPage({ actualFails: true });
  const options = samePageOptions(f.calls, { readEvidence: async () => ({ done: false, state: { status: 'ready' } }) });
  const result = await continueNativeSamePage(f.page, target, config, options);
  assert.equal(result.failureCode, 'submission_quarantined'); assert.equal(f.calls.actual, 1);
  assert.equal(result.firstSubmissionFailure.action.phase, 'dispatch_click');
  assert.equal(result.firstSubmissionFailure.action.dispatchInvoked, true);
  assert.equal(result.submissionDiagnostics.submissionRequestCount, 0);
  await continueNativeSamePage(f.page, target, config, { ...options, readOnly: true });
  assert.equal(f.calls.actual, 1); assert.equal((await readSubmissionJournal(config.submissionJournalPath)).entries.length, 1);
});

test('a reservation failure after durable intent cannot use the pre-dispatch retry', async t => {
  const dir = await fixture(t), config = samePageConfig(dir), f = actionPage(); let attempts = 0;
  const result = await continueNativeSamePage(f.page, target, config, samePageOptions(f.calls, {
    clickAction: async (page, step, origins, reserve) => {
      attempts++; await reserve();
      const error = new Error('PRIVATE');
      error.actionDiagnostics = { phase: 'reserve_intent', outcome: 'failed', dispatchInvoked: false, elapsedMs: 5, errorKind: 'failed' };
      throw error;
    },
  }));
  assert.equal(attempts, 1); assert.equal(result.failureCode, 'submission_quarantined');
  assert.equal((await readSubmissionJournal(config.submissionJournalPath)).entries.length, 1);
});

test('login form is distinguished from another page and never permits a check-in click', async t => {
  const dir = await fixture(t), config = samePageConfig(dir), f = actionPage();
  f.page.url = () => origin + '/login'; f.page.evaluate = async () => true;
  const rule = config.samePageManualCheckinRules[origin];
  assert.equal((await readSamePageLocationState(f.page, target, rule)).status, 'login_required');
  assert.equal((await readSamePageReadiness(f.page, target, rule)).pageStatus, 'login_required');
  const waiting = await continueNativeSamePage(f.page, target, config, samePageOptions(f.calls, {
    readReady: undefined, readEvidence: async () => assert.fail('must not read completion on a login page'),
  }));
  assert.equal(waiting.status, 'login_required'); assert.equal(waiting.samePageStage, 'waiting_for_login');
  assert.equal(waiting.failureCode, 'same_page_login_required'); assert.equal(f.calls.actual, 0);
  f.page.url = () => origin + '/welcome'; f.page.evaluate = async () => false;
  assert.equal((await readSamePageReadiness(f.page, target, rule)).pageStatus, 'unexpected_page');
  f.page.url = () => origin + '/calendar';
  const completed = await continueNativeSamePage(f.page, target, config, samePageOptions(f.calls));
  assert.equal(completed.status, 'signed'); assert.equal(f.calls.actual, 1);
});

const visitConfig = { visitCheckinRules: { [origin]: { after: '08:00', assumeSignedAfterVisit: true } } };
const at = new Date('2026-11-17T03:00:00Z');
const visitOptions = { now: () => at, readState: async () => ({ siteBodyLoaded: true, state: { status: 'ready' } }),
  verifySession: async () => ({ status: 'valid' }) };
test('native visit routing accepts an explicit visit rule, including a passive preflight', () => {
  const config = { ...visitConfig, nativeChallengePreflight: [{ url: origin + '/', passiveOnly: true }] };
  assert.equal(controlledManualRule(target, config).mode, 'verify-visit');
  assert.deepEqual(controlledManualTargets({ targets: [target] }, config), [target]);
  for (const change of [{ visitCheckinRules: { [origin]: { after: '99:00' } } },
    { sequentialActionRules: { [origin]: { steps: [step] } } }, { reauthCheckinRules: { [origin]: {} } },
    { knownNoCheckinFeatureOrigins: [origin] }, { agentrouterAccounts: [{ origin }] }]) {
    assert.equal(configuredNativeVisitRule(target, { ...config, ...change }), null);
  }
});

test('native authenticated visit completion remains a bound user rule, not authoritative site evidence', async () => {
  const result = await verifyNativeVisitCheckin({ url: () => origin + '/console' }, target, visitConfig, visitOptions);
  assert.equal(result.status, 'signed'); assert.equal(result.evidence.source, 'user_rule');
  assert.equal(result.evidence.authoritative, false); assert.equal(validManualCompletion(result, at, visitConfig), true);
  assert.equal(result.actionAttempted, false); assert.equal(result.submissionAttempted, false);
});

for (const scenario of ['too_early', 'login', 'unknown_session', 'loading', 'verification', 'changed_page']) {
  test(`native visit does not claim completion: ${scenario}`, async () => {
    let url = origin + '/console';
    const options = { ...visitOptions };
    if (scenario === 'too_early') options.now = () => new Date('2026-11-16T23:59:00Z');
    if (scenario === 'login') options.verifySession = async () => ({ status: 'invalid' });
    if (scenario === 'unknown_session') options.verifySession = async () => ({ status: 'unknown' });
    if (scenario === 'loading') options.readState = async () => ({ siteBodyLoaded: false, state: { status: 'ready' } });
    if (scenario === 'verification') options.readState = async () => ({ siteBodyLoaded: true, cloudflareUnresolved: true, state: { status: 'signed' } });
    if (scenario === 'changed_page') options.verifySession = async () => { url = origin + '/login'; return { status: 'valid' }; };
    const result = await verifyNativeVisitCheckin({ url: () => url }, target, visitConfig, options);
    assert.equal(['signed', 'already_signed'].includes(result.status), false); assert.equal(result.evidence, undefined);
  });
}

async function controlledFixture(t, config = visitConfig) {
  const dir = await fixture(t), bookmarksPath = path.join(dir, 'Bookmarks');
  await fs.writeFile(bookmarksPath, JSON.stringify({ roots: { synced: { type: 'folder', name: 'Container', children: [
    { type: 'folder', name: 'Daily', children: [{ type: 'url', name: 'Fixture', url: origin + '/console' }] },
  ] } } }));
  config = { ...config, bookmarksPath, mobileFolderNames: ['Container'], targetFolderNames: ['Daily'], automationUserDataDir: path.join(dir, 'profile') };
  await fs.writeFile(path.join(dir, 'config/config.json'), JSON.stringify(config));
  const state = { mode: 'native', controlledCheckin: true, windowReady: true, profile: config.automationUserDataDir,
    nativeDebugPort: 23456, launchMarker: 'a'.repeat(32), targetCount: 1, targets: [{ origin }] };
  return { dir, config, state };
}

test('controlled visit continuation reconciles the daily result and manual queue without another click', async t => {
  const { dir, config, state } = await controlledFixture(t), runId = localRunDate() + '-000001';
  const pending = { runId, finishedAt: new Date().toISOString(), runState: 'final', isComplete: true, plannedTotal: 1,
    processedTotal: 1, results: [{ origin, status: 'error' }] };
  await fs.mkdir(path.join(dir, 'logs')); await fs.writeFile(path.join(dir, 'logs/latest.json'), JSON.stringify(pending));
  await fs.writeFile(path.join(dir, 'tmp/manual-handoff.json'), JSON.stringify({ state: 'awaiting_manual_handoff',
    sourceRunId: runId, createdAt: new Date().toISOString(), targets: [{ origin }] }));
  const outcome = await continueControlledManualSession(dir, config, state, { readyOnly: true, inspect: async (target, rule) => {
    assert.equal(rule.mode, 'verify-visit');
    return verifyNativeVisitCheckin({ url: () => origin + '/console' }, target, config, { ...visitOptions, now: () => new Date() });
  } });
  assert.equal(outcome.completedCount, 1); assert.equal(outcome.unresolvedCount, 0);
  const latest = JSON.parse(await fs.readFile(path.join(dir, 'logs/latest.json')));
  const handoff = JSON.parse(await fs.readFile(path.join(dir, 'tmp/manual-handoff.json')));
  assert.equal(latest.results[0].status, 'signed'); assert.equal(handoff.state, 'handoff_complete');
  assert.equal(handoff.targets.length, 0);
});

test('later same-page observations preserve the first click failure category', async t => {
  const initial = { ...samePageConfig('fixture'), nativeChallengePreflight: [] };
  const { dir, config, state } = await controlledFixture(t, initial);
  const first = { failureCode: 'same_page_action_dispatch_click_timeout',
    action: { phase: 'dispatch_click', outcome: 'failed', dispatchInvoked: true, elapsedMs: 5 } };
  await continueControlledManualSession(dir, config, state, { inspect: async () => ({ status: 'needs_attention',
    firstSubmissionFailure: first, actionAttempted: true, submissionAttempted: true }) });
  await continueControlledManualSession(dir, config, state, { readyOnly: true, inspect: async (target, rule) => {
    assert.equal(rule.mode, 'verify-same-page'); return { status: 'login_required', failureCode: 'same_page_login_required' };
  } });
  const progress = JSON.parse(await fs.readFile(path.join(dir, 'tmp/manual-continuation-progress.json')));
  assert.deepEqual(progress.results[0].firstSubmissionFailure, first);
  assert.equal(progress.results[0].failureCode, 'same_page_login_required');
});

test('offline Edge handles a late password page then resumes the same retained tab once', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 30000,
}, async t => {
  const dir = await fixture(t), config = samePageConfig(dir);
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); let submits = 0;
  await page.exposeFunction('recordSubmission', () => submits++);
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
    `<input type="password"><script>window.unlock=()=>{history.replaceState({},'', '/calendar');
      document.body.innerHTML='<button>签到</button>';document.querySelector('button').onclick=function(){recordSubmission();this.textContent='今日已签到'}}</script>` }));
  await page.goto(origin + '/login');
  const waiting = await continueNativeSamePage(page, target, config, { waitMs: 500 });
  assert.equal(waiting.status, 'login_required'); assert.equal(waiting.samePageStage, 'waiting_for_login');
  await page.evaluate(() => window.unlock());
  const done = await continueNativeSamePage(page, target, config, { waitMs: 2000 });
  assert.equal(done.status, 'signed'); assert.equal(submits, 1);
});

test('offline Edge verifies the actual saved-login endpoint for a native visit without submitting', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 30000,
}, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); let posts = 0, selfReads = 0, documents = 0;
  await page.route('**/*', async route => {
    const request = route.request(); if (request.method() === 'POST') posts++;
    if (new URL(request.url()).pathname === '/api/user/self') {
      selfReads++;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { id: 7 } }) });
    }
    documents++;
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body:
      '<main>Welcome to the daily control panel. This authenticated document is ready for a visit check-in during the configured opening window.</main><button>退出登录</button><script>localStorage.setItem("user",JSON.stringify({id:7}))</script>' });
  });
  await page.goto(origin + '/console');
  const config = { ...visitConfig, savedLoginSessionRules: { [origin]: { type: 'new_api' } } };
  const result = await verifyNativeVisitCheckin(page, target, config, { now: () => at });
  assert.equal(result.status, 'signed'); assert.equal(result.evidence.source, 'user_rule');
  assert.equal(result.evidence.authoritative, false); assert.ok(selfReads >= 1);
  assert.equal(posts, 0); assert.equal(documents, 1); assert.equal(page.url(), origin + '/console');
});
