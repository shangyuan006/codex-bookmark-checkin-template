import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { continueNativeSamePage } from '../src/same-page-sequential.mjs';
import { samePageSubmissionFailure, continueCheckinOnSamePage } from '../src/same-page-checkin.mjs';
import { controlledManualTargets, continuationInspectionRule } from '../src/manual-native-continuation.mjs';
import { selectSamePageManualTarget } from '../src/live-checkin-session.mjs';
import { getConfiguredSequentialActionRule, watchConfiguredSequentialResponses, processTarget } from '../src/browser.mjs';
import { watchVerificationDiagnostics } from '../src/verification-diagnostics.mjs';
import { newerUnresolvedObservation } from '../src/result-observation.mjs';
import { createSubmissionScope, readSubmissionJournal } from '../src/submission-guard.mjs';
import { bindSuccessEvidence, successEvidence } from '../src/checkin-evidence.mjs';
import { resolveHealthPowerShell } from '../src/health-cli.mjs';

const origin = 'https://retained.example', target = { origin, allowedOrigins: [origin] };
const exec = promisify(execFile);
function configFor(file) {
  return { automationUserDataDir: 'data/test-profile', submissionJournalPath: file,
    samePageManualCheckinRules: { [origin]: { browserMode: 'native', expectedPath: '/calendar',
      widgetSelector: '.verification', responseSelector: 'input[name=response]', sequentialActionType: 'daily_checkin',
      startActionBeforeChallenge: true, siteReplaysAfterChallenge: true, verificationTimeoutMs: 12000 } },
    sequentialActionRules: { [origin]: { steps: [{ url: origin + '/calendar', actionType: 'daily_checkin',
      actionTexts: ['签到'], actionTextPattern: '^签到\\s*·\\s*\\+\\d+$', actionTags: ['BUTTON'],
      completedControl: { selector: '.completed', textPattern: '^已签到$', allowNonInteractive: true },
      acceptGenericCheckinState: false, dailyCheckin: true,
      rejectionEvidence: [{ urlPath: '/attendance', methods: ['POST'], statuses: [422], verificationRequired: true,
        rejectedAny: [{ path: 'msg', equals: 'verification required' }] }] }] } } };
}
async function journalFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nov13-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  return configFor(path.join(directory, 'journal.json'));
}
function response(page, status, json, pathname = '/attendance') {
  const request = { url: () => origin + pathname, method: () => 'POST' };
  page.emit('request', request);
  page.emit('response', { request: () => request, url: request.url, status: () => status, json: async () => json });
}
const handshake = { submissionResponseStatus: 422, submissionResponseCount: 1, submissionRejectedCount: 1,
  submissionVerificationRequiredCount: 1 };

test('native same-page dispatch bypasses automation navigation and selects the controlled native queue', async () => {
  const config = configFor(undefined), queue = { targets: [target] };
  assert.deepEqual(controlledManualTargets(queue, config), [target]);
  assert.equal(selectSamePageManualTarget(queue, config), null);
  assert.equal(continuationInspectionRule({ mode: 'execute-same-page' }, { submissionAttempted: true }, true).mode, 'verify-same-page');
  assert.equal(continuationInspectionRule({ mode: 'execute-same-page' }, {}, true).mode, 'execute-same-page');
  const result = await processTarget({ newPage: () => assert.fail('must not create an automated page') }, target, config, {}, '');
  assert.equal(result.failureCode, 'native_same_page_required');
  assert.equal(result.manualBrowserMode, 'native');
});

test('422 handshake classification requires explicit matched evidence and site replay opt-in', async () => {
  assert.equal(samePageSubmissionFailure(handshake, { siteReplaysAfterChallenge: true }), null);
  assert.equal(samePageSubmissionFailure(handshake).failureCode, 'same_page_http_422_rejected');
  assert.equal(samePageSubmissionFailure({ ...handshake, submissionVerificationRequiredCount: 0 },
    { siteReplaysAfterChallenge: true }).failureCode, 'same_page_http_422_rejected');
  assert.equal(samePageSubmissionFailure({ ...handshake, submissionRequestFailed: true },
    { siteReplaysAfterChallenge: true }).failureCode, 'same_page_submission_network_failed');
  const page = new EventEmitter(), step = getConfiguredSequentialActionRule(target, configFor()).steps[0];
  const watcher = watchConfiguredSequentialResponses(page, step, origin);
  response(page, 422, { msg: 'verification required', token: 'PRIVATE' });
  await watcher.stop();
  assert.equal(watcher.diagnostics().submissionVerificationRequiredCount, 1);
  assert.doesNotMatch(JSON.stringify(watcher.diagnostics()), /PRIVATE|verification required/);
});

test('a replay handshake waits without a second click and completion clears the pending failure', async () => {
  let tick = 0, clicks = 0; const stages = [];
  const result = await continueCheckinOnSamePage({
    readState: async () => ({ status: tick >= 4 ? 'signed' : 'ready' }),
    readReady: async () => ({ buttonReady: true, widgetPresent: clicks > 0, responseReady: false }),
    submit: async () => { clicks++; return { clicked: true, intentReserved: true }; },
    readSubmissionDiagnostics: async () => clicks ? { ...handshake, intentReserved: true } : {},
    rule: { siteReplaysAfterChallenge: true, startActionBeforeChallenge: true },
    onStage: async value => stages.push(value), isClosed: () => false, shouldClose: async () => tick > 6,
    delay: async () => { tick++; }, now: () => tick * 500, attentionAfterMs: 1000 });
  assert.equal(clicks, 1); assert.equal(result.status, 'signed');
  assert.ok(stages.some(value => value.stage === 'waiting_for_verification'));
  assert.equal(stages.some(value => value.stage === 'submission_rejected'), false);
  assert.equal(result.failureCode, undefined);
});

test('verification telemetry reports bounded counters and public codes without raw console or URL data', () => {
  let time = 0; const page = new EventEmitter();
  const watcher = watchVerificationDiagnostics(page, { now: () => time, watchdogMs: 12000 });
  const first = { url: () => 'https://challenges.cloudflare.com/widget?secret=PRIVATE' };
  const second = { url: first.url };
  page.emit('framenavigated', first); page.emit('frameattached', first); page.emit('framedetached', first);
  page.emit('framenavigated', second);
  page.emit('console', { text: () => '[Cloudflare Turnstile] Error: 600010 PRIVATE' });
  page.emit('requestfailed', { url: first.url });
  watcher.observeReadiness({ widgetPresent: true }); time = 12500;
  const result = watcher.diagnostics(); watcher.stop();
  assert.equal(result.challengeFrameCount, 2); assert.equal(result.challengeFrameReplacementCount, 1);
  assert.deepEqual(result.publicErrorCodes, [600010]); assert.equal(result.siteWatchdogElapsed, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret|https/);
  assert.equal(page.listenerCount('console'), 0);
});

test('native same-page retains the tab and an ambiguous intent across later read-only observations', async t => {
  const config = await journalFixture(t), page = new EventEmitter();
  page.isClosed = () => false; page.route = async () => {}; page.url = () => origin + '/calendar';
  let time = 0, clicks = 0;
  const options = { now: () => time, delay: async ms => { time += ms; }, waitMs: 1500,
    dismiss: async () => {}, readEvidence: async () => ({ done: false, state: { status: 'ready' } }),
    readReady: async () => ({ buttonReady: true, widgetPresent: false, pageStatus: 'ready' }),
    clickAction: async (p, step, origins, before) => { await before(); clicks++; return { clicked: true }; } };
  const first = await continueNativeSamePage(page, target, config, options);
  assert.equal(clicks, 1); assert.equal(first.submissionAttempted, true);
  page.route = async () => assert.fail('observer must not abort the site replay');
  const second = await continueNativeSamePage(page, target, config, { ...options, readOnly: true });
  assert.equal(clicks, 1); assert.equal(second.submissionAttempted, true);
  assert.equal((await readSubmissionJournal(config.submissionJournalPath)).entries.length, 1);
  const completed = await continueNativeSamePage(page, target, config, { ...options, readOnly: true,
    readEvidence: async () => ({ done: true, status: 'signed' }) });
  assert.equal(completed.status, 'signed'); assert.equal(completed.actionResults[0].status, 'signed');
  assert.equal((await readSubmissionJournal(config.submissionJournalPath)).entries[0].state, 'confirmed');
});

test('native same-page never confirms a matching control on a different path or clicks repeated verification frames', async t => {
  const config = await journalFixture(t), page = new EventEmitter();
  page.isClosed = () => false; page.route = async () => {}; page.url = () => origin + '/other';
  page.evaluate = async () => false;
  let time = 0, challenges = 0;
  const options = { now: () => time, delay: async ms => { time += ms; }, waitMs: 1500,
    dismiss: async () => {}, readEvidence: async () => assert.fail('must check the retained URL first'),
    readReady: async () => ({ buttonReady: false, pageStatus: 'unexpected_page' }) };
  const wrong = await continueNativeSamePage(page, target, config, options);
  assert.equal(wrong.status, 'unconfirmed');
  page.url = () => origin + '/calendar';
  config.samePageManualCheckinRules[origin].nativeClickChallenge = true;
  const waiting = { ...options, readEvidence: async () => ({ done: false, state: { status: 'ready' } }),
    readReady: async () => ({ buttonReady: false, widgetPresent: true, responseReady: false }),
    advanceChallenge: async () => { challenges++; } };
  await continueNativeSamePage(page, target, config, waiting);
  assert.equal(challenges, 1);
  await continueNativeSamePage(page, target, config, { ...waiting, continuationOnly: true });
  assert.equal(challenges, 1);
  assert.equal((await readSubmissionJournal(config.submissionJournalPath)).entries.length, 0);
});

const now = new Date('2026-11-13T08:00Z'), currentAt = '2026-11-13T02:00Z', incomingAt = '2026-11-13T03:00Z';
const early = { origin, status: 'needs_attention', failureCode: 'login_recovery_requires_manual' };
const later = { ...early, status: 'unconfirmed', failureCode: 'same_page_verification_unresolved',
  requiredActionTypes: ['daily_checkin'], actionResults: [{ actionType: 'daily_checkin', status: 'unconfirmed' }] };
const merge = (a = early, b = later) => newerUnresolvedObservation(a, b, { currentAt, incomingAt, now });
test('daily observation accepts newly discovered configured steps after an early login failure', () => {
  const result = merge(); assert.equal(result.failureCode, later.failureCode);
  assert.equal(result.actionResults.length, 1); assert.equal(result.observationHistory[0].failureCode, early.failureCode);
});
test('daily observation rejects cross-identity, changed declarations and unbound new completion', () => {
  for (const change of [{ origin: 'https://other.example' }, { accountKey: 'other' }, { actionType: 'other' },
    { actionResults: [{ actionType: 'other', status: 'unconfirmed' }] },
    { actionResults: [{ origin: 'https://other.example', actionType: 'daily_checkin', status: 'unconfirmed' }] },
    { actionResults: [{ actionType: 'daily_checkin', status: 'signed' }] }]) assert.equal(merge(early, { ...later, ...change }), null);
  assert.equal(merge({ ...early, cycle: { id: 'old' } }, { ...later, cycle: { id: 'new' } }), null);
  assert.equal(merge(later, { ...later, requiredActionTypes: ['other'] }), null);
  assert.equal(merge({ ...early, status: 'signed' }), null);
});
test('new observations preserve completed children while adding declared missing steps', () => {
  const done = bindSuccessEvidence({ status: 'signed', evidence: successEvidence('page_text', 'confirmed', new Date(currentAt)) },
    { ...target, actionType: 'daily_checkin' }, {}, new Date(currentAt));
  const current = { ...early, requiredActionTypes: ['daily_checkin', 'draw'], actionResults: [done] };
  const incoming = { ...later, requiredActionTypes: current.requiredActionTypes,
    actionResults: [{ ...done, status: 'unconfirmed' }, { actionType: 'draw', status: 'unconfirmed' }] };
  const result = merge(current, incoming);
  assert.equal(result.actionResults[0], done); assert.equal(result.actionResults[1].actionType, 'draw');
  assert.equal(merge(current, { ...incoming, actionResults: incoming.actionResults.slice(1) }), null);
});

test('health runtime chooses configured executable, then PowerShell 7, then Windows PowerShell', () => {
  const directory = path.resolve('runtime-fixture'), pwsh = path.join(directory, 'pwsh.exe'),
    old = path.join(directory, 'powershell.exe'), custom = path.join(directory, 'custom.exe');
  const options = { platform: 'win32', env: { Path: directory }, exists: file => [pwsh, old, custom].includes(file) };
  assert.equal(resolveHealthPowerShell({ powershellExecutable: custom }, options), custom);
  assert.equal(resolveHealthPowerShell({}, options), pwsh);
  assert.equal(resolveHealthPowerShell({}, { ...options, exists: file => file === old }), old);
  assert.equal(resolveHealthPowerShell({}, { ...options, exists: () => false }), null);
});

test('Windows PowerShell 5 parses and loads the shared runtime resolver', { skip: process.platform !== 'win32' }, async () => {
  const old = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const source = path.resolve(import.meta.dirname, '../scripts/Resolve-Runtime.ps1').replaceAll("'", "''");
  const command = `$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('${source}',[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){exit 1};. '${source}';if(-not(Get-Command Resolve-CheckinNode)){exit 2};$PSVersionTable.PSVersion.Major`;
  const result = await exec(old, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true });
  assert.equal(result.stdout.trim(), '5');
});

test('offline Edge completes a delayed captcha replay on the retained tab with only one button click', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 30000,
}, async t => {
  const config = await journalFixture(t), browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(); let posts = 0, documents = 0;
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).pathname === '/attendance') {
      posts++;
      return route.fulfill({ status: posts === 1 ? 422 : 200, contentType: 'application/json',
        body: JSON.stringify(posts === 1 ? { msg: 'verification required' } : { ok: true }) });
    }
    documents++;
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<h1>日历</h1><p>已登录</p>
      <button onclick="window.clicks=(window.clicks||0)+1;fetch('/attendance',{method:'POST'}).then(()=>{
        const box=document.createElement('div');box.className='verification';box.textContent='waiting';document.body.append(box);
        setTimeout(()=>fetch('/attendance',{method:'POST'}).then(()=>{box.remove();this.className='completed';this.textContent='已签到'}),800)
      })">签到 · +5</button>` });
  });
  await page.goto(origin + '/calendar');
  const retained = new Proxy(page, { get(object, key) {
    if (key === 'route') return (match, handler) => page.route(match, route => handler({
      request: () => route.request(), abort: value => route.abort(value), continue: () => route.fallback() }));
    if (['goto', 'reload', 'close'].includes(key)) return () => assert.fail('retained page must stay intact');
    const value = Reflect.get(object, key); return typeof value === 'function' ? value.bind(object) : value;
  } });
  const result = await continueNativeSamePage(retained, target, config, { waitMs: 6000 });
  assert.equal(result.status, 'signed'); assert.equal(posts, 2); assert.equal(documents, 1);
  assert.equal(await page.evaluate(() => window.clicks), 1);
  assert.equal(result.submissionDiagnostics.submissionVerificationRequiredCount, 1);
  assert.equal(result.evidence.authoritative, true); assert.equal(result.actionResults[0].evidence.binding.actionType, 'daily_checkin');
});
