import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright-core';
import { submitImageCaptcha } from '../src/image-captcha-checkin.mjs';
import { continueControlledManualSession } from '../src/manual-native-continuation.mjs';
import { continueNativeSamePage } from '../src/same-page-sequential.mjs';
import { createSubmissionScope, readSubmissionJournal, guardPageSubmissions } from '../src/submission-guard.mjs';
import { dailyReadinessEvidence } from '../src/checkin-evidence.mjs';
import { sequentialVerificationRecoveryKey, exactVerificationRejection } from '../src/sequential-verification-recovery.mjs';
import { isBlockedDailyFormDocument, recoverBlockedDailyFormDocument } from '../src/daily-form-checkin.mjs';
import { navigateConfiguredPreCheckinPage, verifyMissingNavigationControl } from '../src/pre-checkin-navigation.mjs';
import { sanitizeSubmissionDiagnostics } from '../src/sequential-click-diagnostics.mjs';

const origin = 'https://daily.example', target = { origin, allowedOrigins: [origin] };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nov21-flow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  await fs.mkdir(path.join(root, 'tmp')); await fs.mkdir(path.join(root, 'config'));
  const config = { automationUserDataDir: path.join(root, 'profile'), submissionJournalPath: path.join(root, 'journal.json'),
    bookmarksPath: path.join(root, 'Bookmarks'), mobileFolderNames: ['Container'], targetFolderNames: ['Daily'],
    nativeChallengePreflight: [{ url: origin + '/', newApiCheckin: true }], newApiCheckinOrigins: [origin] };
  await fs.writeFile(config.bookmarksPath, JSON.stringify({ roots: { synced: { type: 'folder', name: 'Container', children: [
    { type: 'folder', name: 'Daily', children: [{ type: 'url', name: 'Fixture', url: origin + '/calendar' }] },
  ] } } }));
  await fs.writeFile(path.join(root, 'config/config.json'), JSON.stringify(config));
  const state = { mode: 'native', controlledCheckin: true, windowReady: true, profile: config.automationUserDataDir,
    nativeDebugPort: 23456, launchMarker: 'a'.repeat(32), targetCount: 1, targets: [{ origin }] };
  return { root, config, state };
}

for (const completed of [true, false]) test(`image captcha requires stable completion after OCR and HTTP success: ${completed}`, async () => {
  const page = new EventEmitter(); let reserved = 0, fills = 0;
  const request = { url: () => origin + '/plugin.php?private=PRIVATE_VALUE', method: () => 'POST' };
  const result = await submitImageCaptcha(page, { origin, responsePath: '/plugin.php', image: {},
    readImage: async () => Buffer.from('natural-sized-image'),
    recognize: async (bytes, options) => { assert.equal(bytes.toString(), 'natural-sized-image');
      assert.deepEqual(options, { minLength: 6, maxLength: 6 }); return { code: 'ABC123', confidence: 60 }; },
    input: { fill: async value => { assert.equal(value.length, 6); fills++; } }, reserve: async () => reserved++,
    submit: { click: async () => { page.emit('request', request); page.emit('response', {
      request: () => request, status: () => 200, json: async () => ({ state: 'success', privateNote: 'PRIVATE_VALUE' }),
    }); } }, wait: async () => {}, readCompletion: async () => completed ? { status: 'signed' } : { status: 'ready' } });
  assert.equal(result.status, completed ? 'signed' : 'interactive_challenge');
  assert.equal(reserved, 1); assert.equal(fills, 1); assert.equal(result.captchaDiagnostics.responseSuccessCount, 1);
  assert.doesNotMatch(JSON.stringify(result), /ABC123|PRIVATE_VALUE|natural-sized-image/);
  assert.equal(page.listenerCount('response'), 0);
});

for (const confidence of [59, 59.9, NaN]) test(`low-confidence OCR never fills or submits the captcha: ${confidence}`, async () => {
  const result = await submitImageCaptcha(new EventEmitter(), { readImage: async () => Buffer.from('fixture'),
    recognize: async () => ({ code: 'ABC123', confidence }), input: { fill: () => assert.fail() },
    reserve: () => assert.fail(), submit: { click: () => assert.fail() } });
  assert.equal(result.status, 'interactive_challenge'); assert.equal(result.captchaDiagnostics.requestCount, 0);
});

for (const valid of [true, false]) test(`manual session counts only authoritative disabled results as terminal: ${valid}`, async t => {
  const f = await fixture(t); let inspections = 0;
  const inspect = async () => { inspections++; return { status: 'not_available', availabilityKind: 'feature_disabled',
    evidence: { source: 'new_api_checkin_status', outcome: 'enabled_false', authoritative: valid, confirmedAt: new Date().toISOString() } }; };
  const first = await continueControlledManualSession(f.root, f.config, f.state, { inspect });
  const second = await continueControlledManualSession(f.root, f.config, f.state, { inspect, readyOnly: true });
  assert.equal(first.completedCount, Number(valid)); assert.equal(first.unresolvedCount, Number(!valid));
  assert.equal(second.unresolvedCount, Number(!valid)); assert.equal(inspections, valid ? 1 : 2);
});

for (const old of [true, false]) test(`outer manual continuation scopes attempt flags to their cycle: old=${old}`, async t => {
  const f = await fixture(t), now = new Date();
  f.config.nativeChallengePreflight = [{ url: origin + '/', action: { actionTexts: ['Check in'], completedTexts: ['Done'] } }];
  await continueControlledManualSession(f.root, f.config, f.state, { now: new Date(now.getTime() - (old ? 86400000 : 1000)),
    inspect: async () => ({ status: 'needs_attention', actionAttempted: true, submissionAttempted: true }) });
  await continueControlledManualSession(f.root, f.config, f.state, { now, readyOnly: true, inspect: async (target, rule) => {
    assert.equal(rule.mode, old ? 'execute-checkin' : 'verify-checkin'); return { status: 'needs_attention' };
  } });
  const saved = JSON.parse(await fs.readFile(path.join(f.root, 'tmp/manual-continuation-progress.json'), 'utf8'));
  assert.equal(saved.results[0].actionAttempted, !old); assert.equal(saved.results[0].submissionAttempted, !old);
});

function sequentialConfig(config) {
  return { ...config, sequentialActionRules: { [origin]: { steps: [{ url: origin + '/calendar', actionType: 'daily_checkin',
    actionTexts: ['Check in'], actionTextPattern: '^Check in \\+\\d+$', actionTags: ['BUTTON'], dailyCheckin: true,
    acceptGenericCheckinState: false, dailyUnsignedControl: { selector: 'button.daily', textPattern: '^Check in \\+\\d+$', matchByText: true },
    completedControl: { selector: 'button.daily', textPattern: '^Checked in today$' },
    rejectionEvidence: [{ urlPath: '/api/attendance', methods: ['POST'], statuses: [422], verificationRequired: true,
      rejectedAny: [{ path: 'msg', equals: 'Verification required' }] }], waitMs: 1000 }] } },
    samePageManualCheckinRules: { [origin]: { expectedPath: '/calendar', widgetSelector: '.verification',
      responseSelector: 'input[name=response]', sequentialActionType: 'daily_checkin', browserMode: 'native',
      startActionBeforeChallenge: true, siteReplaysAfterChallenge: true, retryRejectedVerification: true } } };
}
const rejected = { submissionsFrozen: true, allRejected: true, requestFailed: false, requestCount: 1,
  rejectionCount: 1, verificationRejectionCount: 1, pendingResponseCount: 0 };

test('exact verification recovery reserves one retry atomically and preserves rejection history', async t => {
  const f = await fixture(t), config = sequentialConfig(f.config), actionTarget = { ...target, actionType: 'daily_checkin' };
  const scope = createSubmissionScope(config.submissionJournalPath, actionTarget, config);
  await scope.begin();
  const proof = dailyReadinessEvidence(actionTarget, config), key = sequentialVerificationRecoveryKey(actionTarget, config);
  await scope.beginAfterRejectedSequentialVerification(proof, key, rejected);
  let entries = (await readSubmissionJournal(config.submissionJournalPath)).entries;
  assert.deepEqual(entries.map(entry => entry.state), ['rejected', 'intent']);
  assert.equal(entries[1].history[1].event, 'verified_verification_retry');
  await assert.rejects(scope.beginAfterRejectedSequentialVerification(dailyReadinessEvidence(actionTarget, config), key, rejected));
  entries = (await readSubmissionJournal(config.submissionJournalPath)).entries;
  assert.equal(entries.length, 2); assert.equal((await scope.pending()).length, 1);
});

for (const scenario of ['stale', 'wrong_account', 'wrong_cycle', 'wrong_profile', 'generic_button', 'not_frozen', 'request_failed', 'pending', 'unknown_422']) {
  test(`verification retry remains blocked for ${scenario}`, async t => {
    const f = await fixture(t), config = sequentialConfig(f.config), actionTarget = { ...target, actionType: 'daily_checkin' };
    const scope = createSubmissionScope(config.submissionJournalPath, actionTarget, config);
    await scope.begin(); const proof = dailyReadinessEvidence(actionTarget, config), rejection = { ...rejected };
    const key = sequentialVerificationRecoveryKey(actionTarget, config);
    if (scenario === 'stale') proof.evidence.confirmedAt = new Date(Date.now() - 31000).toISOString();
    if (scenario === 'wrong_account') proof.evidence.binding.accountKey = 'other';
    if (scenario === 'wrong_cycle') proof.evidence.binding.cycleId = 'old';
    if (scenario === 'wrong_profile') config.automationUserDataDir += '-other';
    if (scenario === 'generic_button') delete config.sequentialActionRules[origin].steps[0].dailyUnsignedControl;
    if (scenario === 'not_frozen') rejection.submissionsFrozen = false;
    if (scenario === 'request_failed') rejection.requestFailed = true;
    if (scenario === 'pending') rejection.pendingResponseCount = 1;
    if (scenario === 'unknown_422') rejection.verificationRejectionCount = 0;
    const active = scenario === 'wrong_profile' ? createSubmissionScope(config.submissionJournalPath, actionTarget, config) : scope;
    await assert.rejects(active.beginAfterRejectedSequentialVerification(proof, key, rejection));
    assert.equal((await readSubmissionJournal(config.submissionJournalPath)).entries.length, 1);
    assert.equal((await scope.pending()).length, 1);
  });
}

test('verification diagnostics retain the actual click outcome without raw errors', () => {
  const result = sanitizeSubmissionDiagnostics({ verificationRetryCount: 1,
    verification: { click: { clicked: false, outcome: 'challenge_frame_not_unique', message: 'PRIVATE_VALUE' } } });
  assert.equal(result.verificationRetryCount, 1); assert.equal(result.verification.click.clicked, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_VALUE/);
  assert.equal(exactVerificationRejection({ submissionRequestCount: 1, submissionResponseCount: 0 }), false);
});

test('submission guard diagnoses blocked document POSTs and removes only its own route', async () => {
  let matcher, handler, aborted = 0;
  const page = { route: async (m, h) => { matcher = m; handler = h; },
    unroute: async (m, h) => { assert.equal(m, matcher); assert.equal(h, handler); } };
  const guard = await guardPageSubmissions(page, target, null, { readOnly: true });
  await handler({ request: () => ({ url: () => origin + '/bakatestfinal.php?private=PRIVATE_VALUE',
    method: () => 'POST', isNavigationRequest: () => true }), abort: async () => aborted++, continue: () => assert.fail() });
  assert.equal(aborted, 1); assert.equal(guard.diagnostics().readOnlyBlockedCount, 1);
  assert.equal(guard.diagnostics().documentBlockedCount, 1);
  assert.doesNotMatch(JSON.stringify(guard.diagnostics()), /PRIVATE_VALUE|bakatest/); await guard.stop();
});

test('offline Edge recovers a blocked form through home and its visible entry', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 30000,
}, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const context = await browser.newContext(), page = await context.newPage(); const visits = [];
  await context.route('**/*', route => {
    visits.push(new URL(route.request().url()).pathname);
    return route.fulfill({ contentType: 'text/html', body: '<a href="/logout.php">Logout</a><a href="/bakatestfinal.php">Daily</a>'
      + '<form method="post" action="/bakatestfinal.php"><button>POST fixture</button></form>' });
  });
  await page.goto(origin + '/');
  const guard = await guardPageSubmissions(page, target, null, { readOnly: true });
  await page.locator('button').click(); await page.waitForTimeout(500);
  assert.equal(await isBlockedDailyFormDocument(page), true);
  assert.equal(guard.diagnostics().documentBlockedCount, 1);
  await guard.stop();
  const rule = { expectedPath: '/bakatestfinal.php', steps: [{ role: 'link', name: 'Daily' }],
    terminalRequireAuthenticatedPage: true, terminalWhenNavigationControlMissing: true,
    terminalPaths: ['/retired.php'], waitMs: 500, afterClickWaitMs: 100 };
  const config = { nativeChallengePreflight: [{ url: origin + '/' }], preCheckinNavigationRules: { [origin]: rule } };
  assert.equal((await verifyMissingNavigationControl(page, target, origin, config)).terminalNoAction, undefined);
  assert.deepEqual(await recoverBlockedDailyFormDocument(page, target, { ...config, checkinReadOnly: true }, rule), { blocked: true, recovered: false });
  assert.deepEqual(await recoverBlockedDailyFormDocument(page, target, config, rule), { blocked: true, recovered: true });
  assert.equal(await navigateConfiguredPreCheckinPage(page, target, origin, config), true);
  assert.deepEqual(visits, ['/', '/', '/bakatestfinal.php']);
});

for (const scenario of ['success', 'active_widget', 'unknown_422', 'second_rejection']) test(`offline same-page verification recovery: ${scenario}`, {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 30000,
}, async t => {
  const f = await fixture(t), config = sequentialConfig(f.config);
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); let requests = 0, routed = false;
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<button class="daily">Check in +8</button><script>
    document.querySelector('button').onclick=async function(){this.disabled=true;
      const r=await fetch('/api/attendance',{method:'POST'});if(r.ok){this.textContent='Checked in today';this.disabled=false;return}
      const w=document.createElement('div');w.className='verification';w.textContent='Fixture verification';document.body.append(w);
      ${scenario === 'active_widget' ? '' : 'setTimeout(()=>{w.remove();this.disabled=false},100);'}
    }</script>` }));
  await page.goto(origin + '/calendar');
  const result = await continueNativeSamePage(page, target, config, { waitMs: scenario === 'success' ? 12000 : 6500,
    dismiss: async () => {}, readReady: async (page, target, rule) => {
      if (!routed) { routed = true; await page.route(origin + '/api/attendance', route => {
        requests++; const ok = requests > 1 && scenario === 'success';
        return route.fulfill({ status: ok ? 200 : 422, contentType: 'application/json',
          body: JSON.stringify({ msg: scenario === 'unknown_422' ? 'Unknown rejection' : 'Verification required' }) });
      }); }
      const { readSamePageReadiness } = await import('../src/same-page-checkin.mjs');
      return readSamePageReadiness(page, target, rule);
    } });
  assert.equal(requests, ['success', 'second_rejection'].includes(scenario) ? 2 : 1);
  assert.equal(result.status === 'signed', scenario === 'success');
  const entries = (await readSubmissionJournal(config.submissionJournalPath)).entries;
  assert.equal(entries.length, requests); if (requests === 2) assert.equal(entries[0].state, 'rejected');
  if (requests === 2) assert.equal(result.actionResults[0].verificationRecoveryDiagnostics.submissionRejectedCount, 1);
});
