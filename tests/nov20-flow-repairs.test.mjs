import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { continueNativeSamePage } from '../src/same-page-sequential.mjs';
import { resumeNativeCycleFromStatus } from '../src/native-checkin-recovery.mjs';
import { createSubmissionScope, readSubmissionJournal } from '../src/submission-guard.mjs';
import { bindSuccessEvidence, dailyReadinessEvidence, reconcileCheckinResult, successEvidence } from '../src/checkin-evidence.mjs';
import { recoveryProgressSignature } from '../src/retry-policy.mjs';
import { sameResultIdentity, newerUnresolvedObservation } from '../src/result-observation.mjs';
import { sanitizeForPersistence } from '../src/logger.mjs';
import { freshNativePreflightResults, nativePreflightProgress } from '../src/native-preflight-state.mjs';
import { getConfiguredSequentialActionRule, readConfiguredSequentialStepEvidence } from '../src/browser.mjs';

const exec = promisify(execFile);
const origin = 'https://daily-state.example', target = { origin, allowedOrigins: [origin] };
const step = { url: origin + '/calendar', actionType: 'daily_checkin', actionTexts: ['Check in'], actionTags: ['BUTTON'],
  actionTextPattern: '^Check in \\+\\d+$',
  dailyCheckin: true, acceptGenericCheckinState: false, completedTexts: ['Checked in today'],
  dailyUnsignedControl: { selector: 'button.daily-state', textPattern: '^Check in \\+\\d+$', matchByText: true } };

async function fixture(t, { sameDay = false, sequential = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nov20-repairs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const file = path.join(root, 'journal.json');
  const config = { submissionJournalPath: file, automationUserDataDir: path.join(root, 'profile'),
    sequentialActionRules: { [origin]: { steps: [step] } },
    samePageManualCheckinRules: { [origin]: { browserMode: 'native', expectedPath: '/calendar',
      widgetSelector: '.verification', responseSelector: 'input[name=response]', sequentialActionType: 'daily_checkin',
      startActionBeforeChallenge: true, siteReplaysAfterChallenge: true } } };
  const identity = sequential ? { ...target, actionType: step.actionType } : target;
  const at = new Date(Date.now() - (sameDay ? 1000 : 86400000));
  const oldScope = createSubmissionScope(file, identity, config, { now: () => at });
  await oldScope.begin(); await oldScope.observe({ status: 'unconfirmed' });
  const old = structuredClone((await readSubmissionJournal(file)).entries[0]);
  return { root, file, config, old, scope: createSubmissionScope(file, identity, config) };
}

function retainedPage() {
  const page = new EventEmitter();
  page.url = () => step.url; page.isClosed = () => false; page.route = async () => {};
  page.goto = page.reload = async () => assert.fail('retained page must not navigate');
  return page;
}

for (const mode of ['automatic', 'continuation']) test(`native same-page ${mode} continues a new day and preserves yesterday's uncertainty`, async t => {
  const f = await fixture(t); let clock = 0, clicks = 0;
  const result = await continueNativeSamePage(retainedPage(), target, f.config, {
    continuationOnly: mode === 'continuation', now: () => clock, delay: async ms => { clock += ms; }, waitMs: 1500,
    dismiss: async () => {}, readReady: async () => ({ buttonReady: true, widgetPresent: false }),
    readEvidence: async () => clicks ? { done: true, status: 'signed' }
      : { done: false, state: { status: 'ready' }, explicitDailyUnsigned: true },
    clickAction: async (page, step, origins, reserve) => { await reserve(); clicks++; return { clicked: true }; },
  });
  assert.equal(result.status, 'signed'); assert.equal(clicks, 1);
  const entries = (await readSubmissionJournal(f.file)).entries;
  assert.equal(entries.length, 2); assert.deepEqual(entries[0], f.old); assert.equal(entries[1].state, 'confirmed');
  assert.ok(entries[1].history.some(event => event.event === 'verified_daily_cycle_continuation'));
});

for (const scenario of ['same_day', 'read_only', 'button_only', 'login', 'changed_before_click']) {
  test(`native same-page keeps the submission blocked for ${scenario}`, async t => {
    const f = await fixture(t, { sameDay: scenario === 'same_day' }); let clock = 0, clicks = 0, beforeReads = 0;
    const result = await continueNativeSamePage(retainedPage(), target, f.config, {
      readOnly: scenario === 'read_only', now: () => clock, delay: async ms => { clock += ms; }, waitMs: 1000,
      dismiss: async () => {}, readReady: async () => ({ buttonReady: true, widgetPresent: false }),
      readEvidence: async (page, step, phase) => ({ done: false,
        state: { status: scenario === 'login' ? 'login_required' : 'ready' },
        explicitDailyUnsigned: scenario !== 'button_only' && (phase !== 'before' || ++beforeReads === 1 || scenario !== 'changed_before_click') }),
      clickAction: async (page, step, origins, reserve) => { await reserve(); clicks++; return { clicked: true }; },
    });
    assert.equal(clicks, 0); assert.equal((await readSubmissionJournal(f.file)).entries.length, 1);
    assert.ok(!['signed', 'already_signed'].includes(result.status));
  });
}

const recoveryRule = { refreshPath: '/api/auth/refresh', selfPath: '/api/self',
  checkinPath: '/api/checkin', rejectionMessageIncludes: 'Verification' };
test('native status recovery handles a prior-day uncertain submission without a rejection receipt', async t => {
  const f = await fixture(t, { sequential: false });
  const options = { page: {}, origin, rule: recoveryRule, config: f.config, scope: f.scope,
    readStatus: async () => dailyReadinessEvidence(target, f.config, { source: 'status_endpoint' }) };
  assert.equal(await resumeNativeCycleFromStatus(options), true);
  assert.equal((await f.scope.pending()).length, 0); await f.scope.begin();
  const entries = (await readSubmissionJournal(f.file)).entries;
  assert.deepEqual(entries[0], f.old); assert.equal(entries.length, 2);
  const restarted = createSubmissionScope(f.file, target, f.config);
  assert.equal(await resumeNativeCycleFromStatus({ ...options, scope: restarted }), false);
  await assert.rejects(restarted.begin());
});

for (const scenario of ['same_day', 'stale', 'different_account', 'assumed', 'already_signed', 'unknown']) {
  test(`native status recovery rejects ${scenario} evidence`, async t => {
    const f = await fixture(t, { sequential: false, sameDay: scenario === 'same_day' }); let reads = 0;
    const proof = dailyReadinessEvidence(target, f.config, { source: 'status_endpoint' });
    if (scenario === 'stale') proof.evidence.confirmedAt = new Date(Date.now() - 31000).toISOString();
    if (scenario === 'different_account') proof.evidence.binding.accountKey = 'other';
    if (scenario === 'assumed') proof.evidence.authoritative = false;
    if (scenario === 'already_signed') proof.status = 'already_signed';
    const result = await resumeNativeCycleFromStatus({ page: {}, origin, rule: recoveryRule, config: f.config, scope: f.scope,
      readStatus: async () => { reads++; return scenario === 'unknown' ? null : proof; } });
    assert.equal(result, false); if (scenario === 'same_day') assert.equal(reads, 0);
    assert.deepEqual((await readSubmissionJournal(f.file)).entries, [f.old]);
  });
}

test('legacy null action entries neither crash comparisons nor supply missing completion evidence', () => {
  const now = new Date(), legacy = bindSuccessEvidence({ ...target, status: 'signed', actionResults: [null],
    evidence: successEvidence('page_text', 'page_completion_text') }, target);
  assert.doesNotThrow(() => recoveryProgressSignature(legacy)); assert.equal(sameResultIdentity(legacy, legacy), true);
  assert.deepEqual(sanitizeForPersistence(legacy).actionResults, []);
  const pending = { ...target, status: 'needs_attention', actionResults: [null], observedAt: new Date(now.getTime() - 1000).toISOString() };
  assert.equal(newerUnresolvedObservation(pending, { ...pending, status: 'login_required', observedAt: now.toISOString() }, { now }).status, 'login_required');
  const missing = reconcileCheckinResult({ ...legacy, requiredActionTypes: ['daily_checkin'], actionResults: [null] }, legacy.evidence, now);
  assert.equal(missing.status, 'unconfirmed'); assert.equal(missing.failureCode, 'incomplete_sequential_evidence');
  const report = { generatedAt: now.toISOString(), results: [{ ...legacy, actionResults: [null] }] };
  const confirmations = freshNativePreflightResults(report, new Set([origin]), now);
  assert.deepEqual(nativePreflightProgress([target], confirmations)[0].actionResults, []);
});

test('PowerShell checkpoints normalize legacy placeholders and emit an empty action array', async t => {
  const f = await fixture(t), file = path.join(f.root, 'preflight.json'), escaped = file.replaceAll("'", "''");
  await exec('pwsh', ['-NoProfile', '-Command', `
    . ./scripts/NativePreflightCheckpoint.ps1
    $result=[pscustomobject]@{origin='${origin}';status='signed';actionResults=@($null)}
    Write-NativePreflightCheckpoint '${escaped}' @($result)
    $loaded=@(Read-NativePreflightConfirmations '${escaped}')
    if (@($loaded[0].actionResults).Count -ne 0) { throw 'null entry survived' }
  `], { windowsHide: true });
  const report = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(report.results[0].actionResults, []);
});

test('offline browser recognizes reviewed daily state, excludes makeup, and continues exactly once', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 30000,
}, async t => {
  const f = await fixture(t), browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close()); const page = await browser.newPage(); let submits = 0;
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body:
    '<button class="daily-state">Make up +8</button><script>document.querySelector("button").onclick=function(){this.textContent="Checked in today"}</script>' }));
  await page.goto(step.url);
  const normalized = getConfiguredSequentialActionRule(target, f.config).steps[0];
  assert.equal((await readConfiguredSequentialStepEvidence(page, normalized, 'before')).explicitDailyUnsigned, false);
  await page.evaluate(() => { document.querySelector('button').textContent = 'Check in +8'; });
  assert.equal((await readConfiguredSequentialStepEvidence(page, normalized, 'before')).explicitDailyUnsigned, true);
  page.on('request', request => { if (request.method() === 'POST') submits++; });
  let clicks = 0;
  const result = await continueNativeSamePage(page, target, f.config, { waitMs: 6000,
    clickAction: async (page, step, origins, reserve) => { await reserve(); clicks++; await page.locator('button').click(); return { clicked: true }; } });
  assert.equal(result.status, 'signed'); assert.equal(clicks, 1); assert.equal(submits, 0);
  const entries = (await readSubmissionJournal(f.file)).entries;
  assert.deepEqual(entries[0], f.old); assert.equal(entries[1].state, 'confirmed');
});
