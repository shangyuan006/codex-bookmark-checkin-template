import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { powershellExecutable } from './helpers/powershell.mjs';
import { continueNativeSamePage } from '../src/same-page-sequential.mjs';
import { createSubmissionScope, readSubmissionJournal, guardPageSubmissions } from '../src/submission-guard.mjs';
import { continuationInspectionRule, continueControlledManualSession } from '../src/manual-native-continuation.mjs';
import { recoverNativeErrorPage, selectNativeErrorPage } from '../src/native-error-recovery.mjs';
import { readCheckinFeatureStatus } from '../src/checkin-feature-status.mjs';
import { freshNativePreflightResults, nativePreflightProgress } from '../src/native-preflight-state.mjs';
import { recordManualSessionClosure } from '../src/manual-session-lifecycle.mjs';
import { buildAttentionHandoff } from '../src/attention-urls.mjs';
import { applyLoginRecoveryHandoff } from '../src/login-recovery.mjs';

const exec = promisify(execFile), project = path.resolve(import.meta.dirname, '..');
const origin = 'https://daily.example', target = { origin, allowedOrigins: [origin] };
const step = { url: origin + '/calendar', actionType: 'daily_checkin', actionTexts: ['Check in'], actionTags: ['BUTTON'],
  dailyCheckin: true, acceptGenericCheckinState: false,
  dailyUnsignedControl: { selector: 'button.daily', textPattern: '^Check in$', matchByText: true } };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nov22-repairs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  await fs.mkdir(path.join(root, 'tmp')); await fs.mkdir(path.join(root, 'config'));
  const config = { automationUserDataDir: path.join(root, 'profile'), submissionJournalPath: path.join(root, 'journal.json'),
    bookmarksPath: path.join(root, 'Bookmarks'), mobileFolderNames: ['Container'], targetFolderNames: ['Daily'],
    sequentialActionRules: { [origin]: { steps: [step] } },
    samePageManualCheckinRules: { [origin]: { browserMode: 'native', expectedPath: '/calendar',
      sequentialActionType: 'daily_checkin', widgetSelector: '.verification', responseSelector: 'input[name=response]',
      startActionBeforeChallenge: true, siteReplaysAfterChallenge: true, nativeClickChallenge: true, verificationTimeoutMs: 2000 } } };
  await fs.writeFile(config.bookmarksPath, JSON.stringify({ roots: { synced: { type: 'folder', name: 'Container', children: [
    { type: 'folder', name: 'Daily', children: [{ type: 'url', name: 'Daily', url: step.url }] },
  ] } } }));
  const state = { mode: 'native', controlledCheckin: true, windowReady: true, profile: config.automationUserDataDir,
    nativeDebugPort: 23456, launchMarker: 'a'.repeat(32), targetCount: 1, targets: [{ origin }] };
  return { root, config, state };
}
function pageStub() {
  const page = new EventEmitter(); page.url = () => step.url; page.isClosed = () => false; page.route = async () => {};
  page.goto = page.reload = () => assert.fail('retained form must not navigate');
  return page;
}

for (const current of [false, true]) test(`locked retained page scopes intent flags to the current cycle: ${current}`, async t => {
  const f = await fixture(t), action = { ...target, actionType: step.actionType };
  const at = new Date(Date.now() - (current ? 1000 : 86400000));
  await createSubmissionScope(f.config.submissionJournalPath, action, f.config, { now: () => at }).begin();
  const old = structuredClone((await readSubmissionJournal(f.config.submissionJournalPath)).entries[0]);
  let clock = 0, clicks = 0;
  const options = { now: () => clock, delay: async ms => { clock += ms; }, waitMs: 1000,
    dismiss: async () => {}, readReady: async () => ({ buttonReady: false, pageStatus: 'login_required' }),
    readEvidence: async () => ({ done: false, state: { status: 'login_required' } }),
    clickAction: async (page, step, allowed, reserve) => { await reserve(); clicks++; return { clicked: true }; } };
  const result = await continueNativeSamePage(pageStub(), target, f.config, options);
  assert.equal(result.currentCycleSubmissionAttempted, current); assert.equal(result.submissionAttempted, current);
  assert.equal(result.submissionDiagnostics.intentReserved, current); assert.equal(clicks, 0);
  const next = await continueNativeSamePage(pageStub(), target, f.config, { ...options,
    readReady: async () => ({ buttonReady: true, widgetPresent: false }),
    readEvidence: async () => clicks ? { done: true, status: 'signed' }
      : { done: false, state: { status: 'ready' }, explicitDailyUnsigned: true } });
  assert.equal(clicks, Number(!current)); assert.equal(next.status === 'signed', !current);
  const preserved = (await readSubmissionJournal(f.config.submissionJournalPath)).entries[0];
  assert.equal(preserved.id, old.id); assert.equal(preserved.cycleId, old.cycleId);
  assert.deepEqual(preserved.history[0], old.history[0]); assert.equal(preserved.state, 'uncertain');
});

test('outer observer clears inherited false attempt flags and can resume after login', async t => {
  const f = await fixture(t);
  await continueControlledManualSession(f.root, f.config, f.state, { inspect: async () => ({ status: 'needs_attention',
    actionAttempted: true, submissionAttempted: true }) });
  await continueControlledManualSession(f.root, f.config, f.state, { readyOnly: true, inspect: async (target, rule) => {
    assert.equal(rule.mode, 'verify-same-page');
    return { status: 'login_required', currentCycleSubmissionAttempted: false, actionAttempted: false, submissionAttempted: false };
  } });
  await continueControlledManualSession(f.root, f.config, f.state, { readyOnly: true, inspect: async (target, rule) => {
    assert.equal(rule.mode, 'execute-same-page'); return { status: 'needs_attention', currentCycleSubmissionAttempted: false };
  } });
  const saved = JSON.parse(await fs.readFile(path.join(f.root, 'tmp/manual-continuation-progress.json')));
  assert.equal(saved.results[0].submissionAttempted, false);
  assert.equal(continuationInspectionRule({ mode: 'execute-same-page' }, { submissionAttempted: true }, true).mode, 'verify-same-page');
});

for (const scenario of ['delayed', 'loading_forever', 'failed', 'observer']) test(`bounded challenge probing: ${scenario}`, async t => {
  const f = await fixture(t); let clock = 0, probes = 0, clicks = 0;
  const result = await continueNativeSamePage(pageStub(), target, f.config, {
    continuationOnly: scenario === 'observer', now: () => clock, delay: async ms => { clock += ms; }, waitMs: 4000,
    dismiss: async () => {}, readEvidence: async () => ({ done: false, state: { status: 'ready', unresolvedChallenge: true } }),
    readReady: async () => ({ buttonReady: false, widgetPresent: true, responseReady: false }),
    advanceChallenge: async () => { probes++;
      if (scenario === 'failed') return { clicked: false, outcome: 'challenge_failed' };
      if (scenario === 'loading_forever' || probes < 3) return { clicked: false, outcome: 'challenge_not_found' };
      clicks++; return { clicked: true, outcome: 'clicked' };
    }, clickAction: () => assert.fail('no ordinary action is ready'),
  });
  assert.equal(clicks, Number(scenario === 'delayed'));
  assert.equal(probes, { delayed: 3, loading_forever: 4, failed: 1, observer: 0 }[scenario]);
  assert.equal(result.submissionDiagnostics.verification.probeCount, probes);
});

function errorPage({ code = 'ERR_BLOCKED_BY_CLIENT', bound = step.url, mismatch = false } = {}) {
  let error = code, url = 'chrome-error://chromewebdata/', visits = [];
  const page = { url: () => url, evaluate: async () => error, visits,
    context: () => ({ newCDPSession: async () => ({ detach: async () => {}, send: async name => name === 'Page.getNavigationHistory'
      ? { currentIndex: 0, entries: [{ url: bound }] } : { targetInfo: { url: mismatch ? origin + '/other' : bound } } }) }),
    goto: async value => { visits.push(value); url = value; error = null; } };
  return page;
}
for (const scenario of ['ready', 'current_intent', 'previous_attempt', 'certificate', 'mismatch', 'normal_form', 'wrong_path']) {
  test(`browser error recovery: ${scenario}`, async t => {
    const f = await fixture(t), page = errorPage({ code: scenario === 'certificate' ? 'ERR_CERT_DATE_INVALID'
      : scenario === 'normal_form' ? null : undefined, mismatch: scenario === 'mismatch',
      bound: scenario === 'wrong_path' ? origin + '/other' : step.url });
    const result = await recoverNativeErrorPage(page, target, f.config, {
      currentPending: scenario === 'current_intent', attempted: scenario === 'previous_attempt' });
    assert.equal(page.visits.length, Number(scenario === 'ready'));
    if (scenario === 'ready') { assert.equal(result.attempted, true); assert.equal(result.recovered, true); }
    if (scenario === 'previous_attempt') assert.equal(result.attempted, true);
  });
}
test('ambiguous browser error pages cannot be selected', async t => {
  const f = await fixture(t);
  const pages = [errorPage(), errorPage()];
  assert.equal(await selectNativeErrorPage(pages, target, f.config), null);
  assert.equal((await recoverNativeErrorPage(pages[0], target, f.config, { pages })).attempted, false);
  assert.equal(pages[0].visits.length, 0);
});

function statusRequest(value, { ok = true, type = 'application/json', redirected = false } = {}) {
  let reads = 0;
  return { get reads() { return reads; }, get: async (url, options) => { reads++;
    assert.equal(url, origin + '/api/status'); assert.equal(options.maxRedirects, 0);
    return { ok: () => ok, url: () => redirected ? 'https://other.example/api/status' : url,
      headers: () => ({ 'content-type': type }), json: async () => value }; } };
}
for (const scenario of ['disabled', 'enabled', 'missing', 'string_false', 'failed', 'html', 'redirected', 'not_configured']) {
  test(`feature status requires explicit JSON boolean false: ${scenario}`, async () => {
    const request = statusRequest({ success: scenario !== 'failed', data: { checkin_enabled:
      scenario === 'enabled' ? true : scenario === 'missing' ? undefined : scenario === 'string_false' ? 'false' : false } },
    { type: scenario === 'html' ? 'text/html' : undefined, redirected: scenario === 'redirected' });
    const config = { newApiFeatureStatusOrigins: scenario === 'not_configured' ? [] : [origin] };
    const result = await readCheckinFeatureStatus(request, target, config);
    assert.equal(result?.status === 'not_available', scenario === 'disabled');
    assert.equal(request.reads, Number(scenario !== 'not_configured'));
    if (result) assert.equal(result.evidence.binding.siteOrigin, origin);
  });
}

test('disabled preflight survives persistence and closes the session without being signed', async t => {
  const f = await fixture(t), now = new Date();
  const disabled = await readCheckinFeatureStatus(statusRequest({ success: true, data: { checkin_enabled: false } }),
    target, { newApiFeatureStatusOrigins: [origin] }, now);
  const report = { generatedAt: now.toISOString(), results: [disabled] };
  const progress = nativePreflightProgress([target], freshNativePreflightResults(report, new Set([origin]), now));
  assert.equal(progress[0].status, 'not_available'); assert.equal(progress[0].availabilityKind, 'feature_disabled');
  const closed = await recordManualSessionClosure(f.root, f.state, { results: progress }, f.config, { reason: 'user_requested', now });
  assert.equal(closed.completionConfirmed, true); assert.equal(closed.handledConfirmed, true); assert.equal(closed.closeReason, 'completed');
  assert.equal(closed.targets[0].status, 'not_available');
  const tomorrow = new Date(now.getTime() + 86400000);
  assert.equal(freshNativePreflightResults({ ...report, generatedAt: tomorrow.toISOString(),
    results: [{ ...disabled, observedAt: tomorrow.toISOString() }] }, new Set([origin]), tomorrow).size, 0);
  disabled.evidence.authoritative = false;
  assert.equal(freshNativePreflightResults(report, new Set([origin]), now).size, 0);
  const invalid = await recordManualSessionClosure(f.root, f.state, report, f.config, { reason: 'user_requested', now });
  assert.equal(invalid.handledConfirmed, false); assert.equal(invalid.targets[0].status, 'unconfirmed');
});

test('explicit login recovery metadata reaches the manual queue and PowerShell scope guard', async () => {
  const recovered = applyLoginRecoveryHandoff({ origin, status: 'login_required' }, { attempts: [{ method: 'native_saved_password', status: 'unsupported' }] });
  assert.equal(recovered.loginRecoveryRequired, true);
  // Test a previously emitted failure too, for compatibility with existing reports.
  const result = { ...recovered, status: 'needs_attention', failureCode: 'login_recovery_requires_manual', retryable: false };
  const handoff = buildAttentionHandoff({ latest: { results: [result] }, plan: { targets: [{ ...target, candidates: [step.url] }] } });
  assert.equal(handoff.targets[0].loginRecoveryRequired, true);
  const { stdout } = await exec(powershellExecutable, ['-NoProfile', '-Command', `
    . './scripts/ManualVerification.ps1'
    @(
      (Test-ManualLoginContinuationTarget ([pscustomobject]@{previousStatus='login_required'})),
      (Test-ManualLoginContinuationTarget ([pscustomobject]@{previousStatus='needs_attention';loginRecoveryRequired=$true})),
      (Test-ManualLoginContinuationTarget ([pscustomobject]@{previousStatus='needs_attention';failureCode='login_recovery_requires_manual'})),
      (Test-ManualLoginContinuationTarget ([pscustomobject]@{previousStatus='needs_attention';failureCode='submission_quarantined'})),
      (Test-ManualLoginContinuationTarget ([pscustomobject]@{previousStatus='interactive_challenge';loginRecoveryRequired=$true}))
    ) | ConvertTo-Json -Compress
  `], { cwd: project, windowsHide: true });
  assert.deepEqual(JSON.parse(stdout), [true, true, true, false, false]);
});

test('PowerShell preflight retains only current authoritative disabled evidence', async t => {
  const f = await fixture(t), now = new Date();
  const disabled = await readCheckinFeatureStatus(statusRequest({ success: true, data: { checkin_enabled: false } }),
    target, { newApiFeatureStatusOrigins: [origin] }, now);
  const file = path.join(f.root, 'preflight.json');
  await fs.writeFile(file, JSON.stringify({ generatedAt: now.toISOString(), results: [disabled,
    { ...disabled, origin: 'https://invalid.example', evidence: { ...disabled.evidence, authoritative: false } }] }));
  const { stdout } = await exec(powershellExecutable, ['-NoProfile', '-Command', `
    . './scripts/NativePreflightCheckpoint.ps1'
    $saved = @(Read-NativePreflightConfirmations -Path '${file.replaceAll("'", "''")}')
    [pscustomobject]@{count=$saved.Count;status=$saved[0].status;availability=$saved[0].availabilityKind;
      confirmation=(Get-NativePreflightConfirmationStatus $saved[0] $false $false)} | ConvertTo-Json -Compress
  `], { cwd: project, windowsHide: true });
  assert.deepEqual(JSON.parse(stdout), { count: 1, status: 'not_available', availability: 'feature_disabled', confirmation: 'not_available' });
});

test('native inspection stops on disabled feature before any guard or pending-intent action', async () => {
  const source = await fs.readFile(new URL('../src/native-browser-inspect.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function inspectWithPlaywright() {');
  const end = source.indexOf('\nif (executeNewApiCheckin)', start);
  const page = { request: statusRequest({ success: true, data: { checkin_enabled: false } }) };
  let closed = 0; const outputs = [];
  const deps = { connectOverCdpWithRetry: async () => ({ contexts: () => [{ pages: () => [page] }], close: async () => { closed++; } }),
    chromium: {}, port: 23456, maxWaitSeconds: 1, expectedOrigin: origin,
    selectNewestOriginPage: () => page, config: { newApiFeatureStatusOrigins: [origin] }, readCheckinFeatureStatus,
    executeDailyForm: false, executeSamePage: false, mayExecuteCheckin: false,
    scope: { pending: () => assert.fail('disabled feature must not inspect or release pending intents') },
    guardPageSubmissions: () => assert.fail('disabled feature must stop before installing action guards'),
    console: { log: value => outputs.push(JSON.parse(value)) } };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction(...Object.keys(deps), source.slice(start, end) + '\nawait inspectWithPlaywright();')(...Object.values(deps));
  assert.equal(outputs[0].status, 'not_available'); assert.equal(outputs[0].availabilityKind, 'feature_disabled');
  assert.equal(closed, 1);
});

test('offline Edge restores a client-blocked form to home once, preserving normal forms', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 30000,
}, async t => {
  const f = await fixture(t), browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close()); const page = await browser.newPage();
  const visits = [];
  await page.route('**/*', route => { visits.push(new URL(route.request().url()).pathname);
    return route.fulfill({ contentType: 'text/html', body: '<form method="post" action="/attendance.php"><button>Submit</button></form>' }); });
  await page.goto(origin + '/'); const guard = await guardPageSubmissions(page, target, null, { readOnly: true });
  await page.locator('button').click(); await page.waitForTimeout(300); await guard.stop();
  const config = { ...f.config, nativeChallengePreflight: [{ url: origin + '/' }],
    preCheckinNavigationRules: { [origin]: { expectedPath: '/attendance.php', dailyUnsignedForm: {} } } };
  const selected = await selectNativeErrorPage([page], target, config); assert.equal(selected, page);
  const restored = await recoverNativeErrorPage(page, target, config); assert.equal(restored.recovered, true);
  assert.equal(await recoverNativeErrorPage(page, target, config), null);
  assert.deepEqual(visits, ['/', '/']);
});
