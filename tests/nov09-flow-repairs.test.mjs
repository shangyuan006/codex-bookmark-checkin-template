import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright-core';
import { continueCheckinOnSamePage, readSamePageReadiness } from '../src/same-page-checkin.mjs';
import { clickConfiguredSequentialAction, watchConfiguredSequentialResponses } from '../src/browser.mjs';
import { createSubmissionScope, readSubmissionJournal, guardPageSubmissions, attachSubmissionScope } from '../src/submission-guard.mjs';
import { dailyReadinessEvidence, bindSuccessEvidence, successEvidence } from '../src/checkin-evidence.mjs';
import { watchNativeCheckinSubmissions, settleNativeVerificationRecovery,
  recoverRecordedNativeVerification, nativeVerificationRuleKey } from '../src/native-checkin-recovery.mjs';

const origin = 'https://submission.example', target = { origin };
const rule = { refreshPath: '/api/auth/refresh', selfPath: '/api/self',
  checkinPath: '/api/checkin', rejectionMessageIncludes: 'Turnstile' };
function session(overrides = {}) {
  let tick = 0;
  const stages = [];
  return { stages, options: {
    readState: async () => ({ status: 'ready' }),
    readReady: async () => ({ widgetPresent: false, responseReady: false, buttonReady: true }),
    submit: async () => true, isClosed: () => false, shouldClose: async () => tick >= 8,
    onStage: async state => stages.push(state), delay: async () => { tick++; }, now: () => tick * 500,
    attentionAfterMs: 1000, rule: { startActionBeforeChallenge: true, siteReplaysAfterChallenge: true }, ...overrides,
  } };
}

test('a failed click without reserved intent stays visible and never claims a dispatched submission', async () => {
  let clicks = 0, reads = 0;
  const s = session({ submit: async () => { clicks++; throw Error('Timeout PRIVATE personal details'); },
    readReady: async () => ({ widgetPresent: ++reads > 2, responseReady: false, buttonReady: reads <= 2 }),
    readSubmissionDiagnostics: async () => ({ intentReserved: false, submissionRequestObserved: false }) });
  const result = await continueCheckinOnSamePage(s.options);
  assert.equal(clicks, 1); assert.ok(reads > 2, 'controls must still be inspected after the exception');
  assert.equal(result.submissionAttempted, false);
  assert.equal(result.failureCode, 'same_page_submission_timeout');
  assert.equal(s.stages[0].submissionAttempted, false, 'entering submit is not dispatch evidence');
  assert.equal(s.stages.at(-1).stage, 'needs_attention');
  assert.equal(s.stages.at(-1).readiness.widgetPresent, true);
  assert.equal(s.stages.at(-1).waitTimedOut, true);
  assert.doesNotMatch(JSON.stringify({ result, stages: s.stages }), /PRIVATE|personal details/);
});

test('a reserved intent with an uncertain click remains blocked while its request diagnostics update', async () => {
  let intentReserved = false, observations = 0, clicks = 0;
  const s = session({
    submit: async () => { clicks++; intentReserved = true; throw Error('detached before click returned'); },
    readSubmissionDiagnostics: async () => ({ intentReserved, submissionRequestObserved: ++observations > 3,
      submissionRequestCount: observations > 3 ? 1 : 0, submissionResponseCount: observations > 4 ? 1 : 0 }),
  });
  const result = await continueCheckinOnSamePage(s.options);
  assert.equal(clicks, 1); assert.equal(result.submissionAttempted, true);
  assert.equal(result.submissionDiagnostics.clickOutcome, 'click_failed_or_uncertain');
  assert.equal(result.submissionDiagnostics.submissionResponseCount, 1);
  assert.equal(result.failureCode, 'same_page_submission_context_unavailable');
  assert.ok(s.stages.filter(state => state.stage === 'needs_attention').length > 1);
});

test('a returned click is distinguished from a request and never becomes completion on its own', async () => {
  const s = session({ submit: async () => ({ clicked: true, intentReserved: true }),
    readSubmissionDiagnostics: async () => ({ intentReserved: true, submissionRequestObserved: false }) });
  const result = await continueCheckinOnSamePage(s.options);
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.submissionDiagnostics.clickOutcome, 'click_returned');
  assert.equal(result.submissionDiagnostics.submissionRequestObserved, false);
});

test('real completion supersedes a prior click error without another submission', async () => {
  let reads = 0, clicks = 0;
  const s = session({ readState: async () => ({ status: ++reads >= 4 ? 'already_signed' : 'ready' }),
    submit: async () => { clicks++; throw Error('Timeout'); } });
  const result = await continueCheckinOnSamePage(s.options);
  assert.equal(clicks, 1); assert.equal(result.status, 'already_signed');
  assert.equal(result.failureCode, undefined); assert.equal(s.stages.at(-1).failureCode, null);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'submission-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'journal.json'), config = { automationUserDataDir: path.join(root, 'profile'), browser: 'edge' };
  const clock = { value: Date.now() - 5000 };
  const scope = createSubmissionScope(file, target, config, { now: () => new Date(clock.value) });
  const freshScope = (changes = {}, identity = target) => createSubmissionScope(file, identity,
    { ...config, ...changes }, { now: () => new Date(clock.value) });
  const proof = () => dailyReadinessEvidence(target, config, { source: 'status_endpoint', now: new Date(clock.value) });
  return { root, file, config, scope, clock, freshScope, proof };
}
function response(page, status = 200, body = { success: false, message: 'Turnstile PRIVATE' }) {
  const request = { method: () => 'POST', url: () => origin + rule.checkinPath };
  page.emit('request', request);
  page.emit('response', { request: () => request, status: () => status, json: async () => body });
  return request;
}
async function checkpoint(f, extra) {
  await f.scope.begin();
  const page = new EventEmitter(), watcher = watchNativeCheckinSubmissions(page, origin, rule);
  response(page);
  extra?.(page);
  await settleNativeVerificationRecovery({ page, origin, rule, config: f.config, scope: f.scope, watcher,
    result: { status: 'interactive_challenge' }, freeze: async () => {}, readStatus: async () => null });
}

test('frozen explicit rejection survives a lost status probe and can safely recover in a reopened document', async t => {
  const f = await fixture(t); await checkpoint(f);
  const before = (await readSubmissionJournal(f.file)).entries[0];
  assert.equal(before.state, 'intent'); assert.equal(before.verificationRejection.allRejected, true);
  assert.doesNotMatch(JSON.stringify(before), /PRIVATE|Turnstile|message|token/i);
  f.clock.value += 2000;
  const restarted = f.freshScope();
  const recovered = await recoverRecordedNativeVerification({ page: { evaluate: async () => f.clock.value - 1000 },
    origin, rule, config: f.config, scope: restarted, readStatus: async () => f.proof() });
  assert.equal(recovered, true);
  const after = (await readSubmissionJournal(f.file)).entries[0];
  assert.equal(after.state, 'rejected'); assert.deepEqual(after.history.slice(0, -1), before.history);
  assert.equal(after.history.at(-1).reasonCode, 'recorded_verification_required');
  await restarted.begin();
  assert.equal((await readSubmissionJournal(f.file)).entries.length, 2);
});

for (const scenario of ['unknown_response', 'success_replay', 'network_failure', 'pending_request']) {
  test(`recovery never records a releasable receipt for ${scenario}`, async t => {
    const f = await fixture(t);
    await checkpoint(f, page => {
      if (scenario === 'unknown_response') response(page, 500, { message: 'PRIVATE' });
      if (scenario === 'success_replay') response(page, 200, { success: true });
      if (scenario === 'network_failure' || scenario === 'pending_request') {
        const req = { method: () => 'POST', url: () => origin + rule.checkinPath };
        page.emit('request', req);
        if (scenario === 'network_failure') page.emit('requestfailed', req);
      }
    });
    const entry = (await readSubmissionJournal(f.file)).entries[0];
    assert.equal(entry.state, 'intent'); assert.equal(entry.verificationRejection, undefined);
  });
}

for (const scenario of ['old_document', 'stale_status', 'different_rule', 'different_profile', 'different_account', 'legacy_intent', 'unknown_status']) {
  test(`a reopened scope preserves the lock for ${scenario}`, async t => {
    const f = await fixture(t);
    if (scenario === 'legacy_intent') await f.scope.begin(); else await checkpoint(f);
    const before = (await readSubmissionJournal(f.file)).entries[0];
    f.clock.value += 2000;
    const scope = f.freshScope(scenario === 'different_profile' ? { automationUserDataDir: f.root + '/other' } : {},
      scenario === 'different_account' ? { ...target, accountKey: 'other' } : target);
    const proof = f.proof();
    if (scenario === 'stale_status') proof.evidence.confirmedAt = new Date(f.clock.value - 60000).toISOString();
    const recovered = await recoverRecordedNativeVerification({
      page: { evaluate: async () => scenario === 'old_document' ? f.clock.value - 3000 : f.clock.value - 1000 },
      origin, rule: scenario === 'different_rule' ? { ...rule, checkinPath: '/api/other-checkin' } : rule,
      config: f.config, scope, readStatus: async () => scenario === 'unknown_status' ? null : proof,
    });
    assert.equal(recovered, false);
    assert.deepEqual((await readSubmissionJournal(f.file)).entries[0], before);
  });
}

test('receipt validation rejects inconsistent counts even with fresh negative status', async t => {
  const f = await fixture(t); await f.scope.begin();
  const rejected = { allRejected: true, submissionsFrozen: true, requestFailed: false,
    requestCount: 2, rejectionCount: 1, verificationRejectionCount: 1, pendingResponseCount: 0 };
  await assert.rejects(f.scope.recordVerificationRejection(nativeVerificationRuleKey(rule), rejected), /Frozen bound/);
  assert.equal((await readSubmissionJournal(f.file)).entries[0].verificationRejection, undefined);
});

test('offline Edge reports the actual sequential click, request and delayed response independently', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 30000,
}, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); let posts = 0;
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).pathname === '/attendance') {
      posts++; await new Promise(resolve => setTimeout(resolve, 600));
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ msg: '请完成人机验证', detail: 'PRIVATE' }), status: 422 });
    }
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<button onclick="fetch('/attendance',{method:'POST'})">签到 · +5</button>` });
  });
  await page.goto(origin + '/calendar');
  const step = { actionTexts: ['签到'], actionTextPattern: '^签到\\s*·\\s*\\+\\d+$', actionTags: ['BUTTON'],
    responseEvidence: [], rejectionEvidence: [{ urlPath: '/attendance', urlIncludes: '/attendance', methods: ['POST'],
      statuses: [422], successAny: [{ path: 'msg', equals: '请完成人机验证' }] }] };
  const watcher = watchConfiguredSequentialResponses(page, step, origin); t.after(() => watcher.stop());
  let reserved = false, stages = [];
  const started = Date.now();
  const result = await continueCheckinOnSamePage({ readState: async () => ({ status: 'ready' }),
    readReady: () => readSamePageReadiness(page, target, { expectedPath: '/calendar', widgetSelector: '.verification',
      responseSelector: 'input[name=response]', actionTextPattern: step.actionTextPattern }),
    readSubmissionDiagnostics: async () => ({ ...watcher.diagnostics(), intentReserved: reserved }),
    submit: async () => { const result = await clickConfiguredSequentialAction(page, step, [origin], async () => { reserved = true; });
      return { ...result, intentReserved: reserved }; },
    isClosed: () => false, shouldClose: async () => Date.now() - started >= 2000,
    onStage: async state => stages.push(state), delay: ms => page.waitForTimeout(ms),
    attentionAfterMs: 1000, rule: { startActionBeforeChallenge: true, siteReplaysAfterChallenge: true } });
  assert.equal(posts, 1); assert.equal(result.status, 'unconfirmed');
  assert.equal(result.submissionDiagnostics.clickOutcome, 'click_returned');
  assert.equal(result.submissionDiagnostics.submissionRequestCount, 1);
  assert.equal(result.submissionDiagnostics.submissionResponseStatus, 422);
  assert.equal(result.submissionDiagnostics.submissionRejectedCount, 1);
  assert.doesNotMatch(JSON.stringify(stages), /PRIVATE/);
});

test('offline Edge recovers a rejected submission after reopening and reserves a new intent before the retry', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 30000,
}, async t => {
  const f = await fixture(t), browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(); let posts = 0, frozen = false, signed = false;
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/state') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ signed }) });
    if (pathname === rule.checkinPath) {
      posts++;
      const entries = (await readSubmissionJournal(f.file)).entries;
      assert.equal(entries.at(-1).state, 'intent', 'the POST must have a durable intent');
      signed = posts > 1;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(signed
        ? { success: true } : { success: false, message: 'Turnstile required' }) });
    }
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<button onclick="fetch('/api/checkin',{method:'POST'}).then(r=>r.json()).then(b=>{if(b.success){this.textContent='已签到';this.disabled=true}})">签到</button>` });
  });
  const guarded = { route: (match, handler) => page.route(match, route => handler({
    request: () => route.request(), abort: code => route.abort(code), continue: () => route.fallback(),
  })) };
  await guardPageSubmissions(guarded, target, f.scope, { readOnly: () => frozen });
  await page.goto(origin + '/profile');
  f.clock.value = Date.now();
  const watcher = watchNativeCheckinSubmissions(page, origin, rule);
  await page.evaluate(() => fetch('/api/checkin', { method: 'POST' }).then(r => r.json()));
  f.clock.value = Date.now();
  await settleNativeVerificationRecovery({ page, origin, rule, config: f.config, scope: f.scope, watcher,
    result: { status: 'interactive_challenge' }, freeze: async () => { frozen = true; }, readStatus: async () => null });
  await page.waitForTimeout(20);
  await page.goto(origin + '/profile');
  const restarted = f.freshScope(); attachSubmissionScope(guarded, restarted);
  const recovered = await recoverRecordedNativeVerification({ page, origin, rule, config: f.config, scope: restarted,
    readStatus: async () => {
      const state = await page.evaluate(() => fetch('/state').then(r => r.json()));
      f.clock.value = Date.now(); return state.signed === false ? f.proof() : null;
    } });
  assert.equal(recovered, true); assert.equal(posts, 1, 'recovery itself cannot submit');
  frozen = false;
  await page.getByRole('button', { name: '签到', exact: true }).click();
  await page.getByRole('button', { name: '已签到', exact: true }).waitFor();
  f.clock.value = Date.now();
  await restarted.observe(bindSuccessEvidence({ status: 'signed',
    evidence: successEvidence('page_text', 'page_completion_text', new Date(f.clock.value)) }, target, f.config, new Date(f.clock.value)));
  const entries = (await readSubmissionJournal(f.file)).entries;
  assert.equal(posts, 2); assert.deepEqual(entries.map(entry => entry.state), ['rejected', 'confirmed']);
  assert.equal(entries[0].history[0].event, 'intent');
});
