import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { powershellExecutable } from './helpers/powershell.mjs';
import { readOpenCdState, runOpenCdCaptcha, waitForOpenCdCompletion } from '../src/open-cd-checkin.mjs';
import { assertManualVerificationExecution } from '../src/manual-verification-guard.mjs';
import { nativeInspectionError, nativeInspectionFailure, parseNativeInspectionOutput } from '../src/native-inspection-diagnostics.mjs';
import { continueControlledManualSession } from '../src/manual-native-continuation.mjs';
import { createSubmissionScope } from '../src/submission-guard.mjs';
import { bindSuccessEvidence, successEvidence } from '../src/checkin-evidence.mjs';
import { readCheckinFinalState } from '../src/checkin-final-state.mjs';

const exec = promisify(execFile), project = path.resolve(import.meta.dirname, '..');
const origin = 'https://daily.example', other = 'https://other.example', excluded = 'https://excluded.example';
const browserFixtures = process.env.CHECKIN_BROWSER_FIXTURES === '1';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nov24-repairs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const write = async (file, value) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), JSON.stringify(value));
  };
  return { root, write };
}

const unsigned = { loaded: true, authenticated: true, unsigned: true };
const signed = { loaded: true, authenticated: true, signed: true };
for (const scenario of ['delayed', 'reload', 'unknown', 'never', 'changed_origin']) {
  test(`OpenCD completion waits without resubmission: ${scenario}`, async () => {
    let samples = 0, reloads = 0;
    const page = { url: () => scenario === 'changed_origin' ? other : origin + '/',
      evaluate: async () => {
        samples++;
        return scenario === 'delayed' && samples >= 3 || scenario === 'reload' && reloads ? signed : unsigned;
      }, reload: async () => reloads++, click: () => assert.fail('read-only completion') };
    const result = await waitForOpenCdCompletion(page, origin,
      { serverSuccess: scenario !== 'unknown', wait: async () => {} });
    assert.equal(result?.status === 'already_signed', ['delayed', 'reload'].includes(scenario));
    assert.equal(reloads, ['reload', 'never'].includes(scenario) ? 1 : 0);
    if (scenario === 'unknown') assert.equal(samples, 1);
  });
}

for (const scenario of ['link', 'inert_js', 'duplicate', 'foreign', 'foreign_logout', 'wrong_path', 'login', 'challenge', 'signed_text', 'unsigned_with_success', 'signed_conflict']) {
  test(`OpenCD no-ID homepage entry: ${scenario}`, { skip: !browserFixtures }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close()); const page = await browser.newPage();
    const entry = `<a href="${scenario === 'inert_js' ? 'javascript:void(0);' : '#'}" onclick="return false">簽到</a>`;
    const body = scenario === 'signed_text' ? '<p>今天已经签到过</p>' : scenario === 'foreign'
      ? `<a href="${other}/plugin_sign-in.php">簽到</a>` : entry
        + (scenario === 'duplicate' ? entry : scenario === 'login' ? '<input type="password">'
          : scenario === 'challenge' ? '<div class="cf-turnstile">Verification</div>'
            : scenario === 'unsigned_with_success' ? '<p>今天已经签到过</p>'
              : scenario === 'signed_conflict' ? '<span id="sign_in_span">已签到</span>' : '');
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: `<a href="${scenario === 'foreign_logout' ? other + '/logout.php' : 'logout.php'}">退出</a>${body}` }));
    await page.goto(origin + (scenario === 'wrong_path' ? '/other' : '/'));
    const state = await readOpenCdState(page, origin);
    if (['link', 'inert_js', 'unsigned_with_success'].includes(scenario)) assert.deepEqual(state, { status: 'not_signed', entry: 'link' });
    else if (scenario === 'signed_text') assert.equal(state.status, 'already_signed');
    else assert.equal(state, null);
  });
}

test('OpenCD no-ID link opens the exact iframe and submits only once', { skip: !browserFixtures }, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close()); const page = await browser.newPage(); let posts = 0, reserved = 0;
  await page.route('**/*', route => {
    if (route.request().method() === 'POST') { posts++; return route.fulfill({ contentType: 'application/json', body: '{"state":"success"}' }); }
    const iframe = new URL(route.request().url()).pathname === '/plugin_sign-in.php';
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: iframe
      ? '<img src="data:image/png;base64,aA=="><input name="imagestring"><button id="ok" onclick="parent.done()">签到</button>'
      : `<a href="logout.php">退出</a><a href="#" onclick="event.preventDefault();this.insertAdjacentHTML('afterend', '<iframe id=i_signin src=/plugin_sign-in.php></iframe>')">簽到</a>
      <script>window.done=async()=>{await fetch('/plugin_sign-in.php',{method:'POST'});document.body.innerHTML='<a href=logout.php>退出</a><p>今天已经签到过</p>';}</script>` });
  });
  await page.goto(origin + '/');
  const result = await runOpenCdCaptcha(page, origin, {}, { readImage: async () => Buffer.from('fixture'),
    recognize: async () => ({ code: 'ABC123', confidence: 70 }), reserve: async () => reserved++,
    retryUsed: async () => false, retryRejected: () => assert.fail('must not retry'),
    rejectExhausted: () => assert.fail('must not reject'), wait: ms => page.waitForTimeout(Math.min(ms, 50)) });
  assert.equal(result.status, 'already_signed'); assert.equal(posts, 1); assert.equal(reserved, 1);
});

const pending = { state: 'pending_verification', authoritativeEvidenceRequired: true, sourceRunId: '20261124-fixture',
  targets: [origin, excluded].map(origin => ({ origin, verificationStatus: 'pending_verification' })) };
const options = { consume: true, allowSubset: true, resumeRequested: true, runDate: '20261124',
  selectedOrigins: new Set([origin, other]), verificationOrigins: [origin] };
test('mixed selection requires the exact pending intersection and retains the pending document', () => {
  const before = structuredClone(pending);
  assert.doesNotThrow(() => assertManualVerificationExecution(pending, options));
  assert.deepEqual(pending, before);
  for (const change of [{ consume: false }, { resumeRequested: false }, { verificationOrigins: [] },
    { verificationOrigins: [excluded] }, { verificationOrigins: [origin, excluded] },
    { verificationOrigins: [origin, origin] }, { verificationOrigins: ['invalid'] }, { verificationOrigins: null }]) {
    assert.throws(() => assertManualVerificationExecution(pending, { ...options, ...change }));
  }
  assert.doesNotThrow(() => assertManualVerificationExecution(pending,
    { ...options, selectedOrigins: [other], verificationOrigins: [] }));
});

test('PowerShell selects only the overlap and leaves other pending targets untouched', async t => {
  const f = await fixture(t); await f.write('pending.json', pending);
  const command = `. '${path.join(project, 'scripts/ManualVerification.ps1').replaceAll("'", "''")}';
    $pending=Get-PendingManualVerification -Path '${path.join(f.root, 'pending.json').replaceAll("'", "''")}';
    $selected=Select-ManualVerificationScope $pending @('${origin}','${other}');
    [ordered]@{ selected=@($selected.Origins); original=@($pending.Origins); targets=@($selected.Document.targets.origin) } | ConvertTo-Json -Compress`;
  const { stdout } = await exec(powershellExecutable, ['-NoProfile', '-Command', command], { windowsHide: true });
  const selected = JSON.parse(stdout); assert.deepEqual(selected.selected, [origin]);
  assert.deepEqual(new Set(selected.original), new Set([origin, excluded]));
  assert.deepEqual(new Set(selected.targets), new Set([origin, excluded]));
});

test('wrapper executes a mixed scope and retries the remainder without consuming an unrelated pending target', async t => {
  const f = await fixture(t);
  for (const folder of ['scripts', 'src', 'config', 'tmp', 'logs']) await fs.mkdir(path.join(f.root, folder));
  for (const name of ['CheckinContract.generated', 'Run-Checkin', 'Resolve-Runtime', 'RunLock', 'ManualVerification',
    'ResultContract', 'ManualAbandonment', 'NativeFallbackPolicy', 'PreflightScope', 'CheckinCycle',
    'TaskRetryPolicy', 'TaskRuntimeBudget', 'CheckinExecutionReport']) {
    await fs.copyFile(path.join(project, 'scripts', `${name}.ps1`), path.join(f.root, 'scripts', `${name}.ps1`));
  }
  const now = new Date(), day = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('');
  await f.write('config/config.json', { nodeExecutable: process.execPath, runMutexName: `Local\\MixedScope-${randomUUID()}`,
    taskTimeoutMinutes: 5, taskRunAttempts: 2, taskRetryDelayMinutes: 0, syncBookmarkSavedLogins: false,
    nativeWafPreflightUrls: [], nativeChallengePreflight: [] });
  await f.write('tmp/manual-verification.json', { ...pending, sourceRunId: `${day}-fixture`, createdAt: now.toISOString() });
  await f.write('logs/latest.json', { runId: `${day}-fixture`, runState: 'final', isComplete: true,
    planFingerprint: 'a'.repeat(64), plannedTotal: 3, processedTotal: 3,
    results: [origin, other, excluded].map(origin => ({ origin, status: 'needs_attention' })) });
  await fs.writeFile(path.join(f.root, 'src/current-plan.mjs'), "console.log(JSON.stringify({planFingerprint:'a'.repeat(64)}));");
  await fs.writeFile(path.join(f.root, 'src/index.mjs'), `
    import fs from 'node:fs/promises';
    import { assertManualVerificationExecution } from ${JSON.stringify(pathToFileURL(path.join(project, 'src/manual-verification-guard.mjs')).href)};
    import { bindSuccessEvidence, successEvidence } from ${JSON.stringify(pathToFileURL(path.join(project, 'src/checkin-evidence.mjs')).href)};
    const arg = name => process.argv[process.argv.indexOf(name) + 1];
    const selected = arg('--origins').split(',');
    const scope = arg('--manual-verification-scope');
    const pending = JSON.parse(await fs.readFile('tmp/manual-verification.json'));
    assertManualVerificationExecution(pending, { consume: process.argv.includes('--consume-manual-verification'),
      allowSubset: true, resumeRequested: process.argv.includes('--resume-report'), selectedOrigins: selected,
      verificationOrigins: scope === 'none' ? [] : scope.split(','), runDate: ${JSON.stringify(day)} });
    const attempts = await fs.readFile('tmp/attempts.json').then(JSON.parse).catch(()=>[]);
    attempts.push({selected, scope}); await fs.writeFile('tmp/attempts.json', JSON.stringify(attempts));
    const id = arg('--execution-attempt-id'), now = new Date();
    const results = selected.map(origin => origin === ${JSON.stringify(other)} && attempts.length === 1
      ? {origin, status:'login_required', retryable:true}
      : bindSuccessEvidence({status:'signed', evidence:successEvidence('page_text','fixture',now)}, {origin}, {}, now));
    results.push({origin:${JSON.stringify(excluded)}, status:'needs_attention',retryable:false});
    const report = {runId:${JSON.stringify(day)}+'-120000-'+id,executionAttemptId:id,planFingerprint:'a'.repeat(64),
      runState:'final',isComplete:true,plannedTotal:3,processedTotal:3,selectedOrigins:selected,finishedAt:now.toISOString(),results};
    await fs.mkdir('logs/'+report.runId,{recursive:true});
    await fs.writeFile('logs/'+report.runId+'/result.json',JSON.stringify(report));
    await fs.writeFile('logs/latest.json',JSON.stringify(report)); process.exitCode=2;
  `);
  await exec(powershellExecutable, ['-NoProfile', '-File', path.join(f.root, 'scripts/Run-Checkin.ps1'),
    '-Origins', `${origin},${other}`, '-Attempts', '2', '-SuppressReport'], { cwd: f.root, windowsHide: true, timeout: 30000 });
  const attempts = JSON.parse(await fs.readFile(path.join(f.root, 'tmp/attempts.json')));
  assert.deepEqual(attempts.map(item => item.scope), [origin, 'none']);
  assert.ok(attempts.every(item => item.selected.join(',') === `${origin},${other}`));
  const after = JSON.parse(await fs.readFile(path.join(f.root, 'tmp/manual-verification.json')));
  assert.equal(after.targets.find(target => target.origin === origin).verificationStatus, 'signed');
  assert.equal(after.targets.find(target => target.origin === excluded).verificationStatus, 'pending_verification');
  assert.equal(after.state, 'pending_verification');
});

for (const [category, error] of [
  ['connection_failed', nativeInspectionError('connection_failed', 'connection')],
  ['target_missing', nativeInspectionError('target_missing', 'page_selection')],
  ['target_unavailable', nativeInspectionError('target_unavailable', 'page_selection')],
  ['page_unstable', nativeInspectionError('page_unstable', 'page_observation')],
  ['process_timeout', { killed: true }], ['process_failed', { code: 2 }],
  ['process_failed', { code: 'EPERM' }], ['inspection_failed', {}],
]) test(`native failure is fixed and private: ${category}`, () => {
  const result = nativeInspectionFailure({ ...error, inspectionCategory: error.inspectionCategory,
    inspectionPhase: error.inspectionPhase, message: 'PRIVATE_VALUE', stderr: 'PRIVATE_VALUE', stdout: 'PRIVATE_VALUE' });
  assert.equal(result.continuationDiagnostics.category, category);
  assert.equal(result.failureCode, `manual_continuation_${category}`);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_VALUE/);
});
test('invalid helper output is a distinct failure without retaining raw data', () => {
  for (const value of ['PRIVATE_VALUE', 'null', '[]', '{"status":"PRIVATE_VALUE"}']) {
    try { parseNativeInspectionOutput(value); assert.fail('invalid output accepted'); }
    catch (error) { assert.equal(nativeInspectionFailure(error).failureCode, 'manual_continuation_invalid_output'); }
  }
  assert.equal(parseNativeInspectionOutput('{"status":"needs_attention"}').status, 'needs_attention');
});

test('helper failure retains a newly reserved current-cycle submission', async t => {
  const f = await fixture(t);
  const config = { automationUserDataDir: path.join(f.root, 'profile'), submissionJournalPath: path.join(f.root, 'journal.json'),
    bookmarksPath: path.join(f.root, 'Bookmarks'), mobileFolderNames: ['Container'], targetFolderNames: ['Daily'],
    nativeChallengePreflight: [{ url: origin + '/daily', newApiCheckin: true }], newApiCheckinOrigins: [origin] };
  await f.write('Bookmarks', { roots: { synced: { type: 'folder', name: 'Container', children: [
    { type: 'folder', name: 'Daily', children: [{ type: 'url', name: 'Daily', url: origin + '/daily' }] }] } } });
  const state = { mode: 'native', controlledCheckin: true, windowReady: true, profile: config.automationUserDataDir,
    nativeDebugPort: 23456, launchMarker: 'a'.repeat(32), targetCount: 1, targets: [{ origin }] };
  const result = await continueControlledManualSession(f.root, config, state, { inspect: async () => {
    await createSubmissionScope(config.submissionJournalPath, { origin }, config).begin();
    throw Object.assign(new Error('PRIVATE_VALUE'), { killed: true, stderr: 'PRIVATE_VALUE' });
  } });
  assert.equal(result.unresolvedCount, 1);
  const saved = await fs.readFile(path.join(f.root, 'tmp/manual-continuation-progress.json'), 'utf8');
  const observation = JSON.parse(saved).results[0];
  assert.equal(observation.submissionAttempted, true);
  assert.equal(observation.continuationDiagnostics.category, 'process_timeout');
  assert.doesNotMatch(saved, /PRIVATE_VALUE/);
});

test('final state rereads fresh completion and pending work without changing files', async t => {
  const f = await fixture(t), now = new Date('2026-11-24T08:00:00Z');
  const config = { agentrouterAccounts: [{ accountKey: 'fixture', origin }] };
  await f.write('config/config.json', config); await f.write('data/last-valid-bookmark-plan.json', { targets: [{ origin }] });
  const report = { runId: '20261124-fixture', runState: 'final', isComplete: true, finishedAt: now.toISOString(),
    results: [{ origin, status: 'needs_attention' }] };
  await f.write('logs/latest.json', report);
  assert.equal((await readCheckinFinalState(f.root, { now })).readyToFinish, false);
  report.results = [bindSuccessEvidence({ origin, status: 'signed', evidence: successEvidence('page_text', 'fixture', now) },
    { origin }, config, now)];
  await f.write('logs/latest.json', report);
  assert.equal((await readCheckinFinalState(f.root, { now })).allCheckinsComplete, true);
  for (const [file, state] of [['tmp/manual-session.json', { targets: [{ origin }] }],
    ['tmp/agentrouter-verification-fixture.json', { state: 'pending', date: '20261124', accountKey: 'fixture' }],
    ['tmp/manual-verification.json', { ...pending, targets: [{ origin: other }] }]]) {
    await f.write(file, state);
    const before = await fs.readFile(path.join(f.root, file), 'utf8');
    const final = await readCheckinFinalState(f.root, { now });
    assert.equal(final.readyToFinish, false, file);
    assert.equal(await fs.readFile(path.join(f.root, file), 'utf8'), before);
    await fs.unlink(path.join(f.root, file));
  }
  await f.write('tmp/manual-handoff.json', { sourceRunId: '20261124-fixture', state: 'awaiting_manual_handoff', targets: [{ origin }] });
  assert.equal((await readCheckinFinalState(f.root, { now })).readyToFinish, true, 'stale queue cannot hide fresh completion');
  assert.equal((await readCheckinFinalState(f.root, { now: new Date('2026-11-25T08:00:00Z') })).readyToFinish, false);
  await f.write('data/last-valid-bookmark-plan.json', { targets: [{ origin }, { origin: other }] });
  assert.deepEqual((await readCheckinFinalState(f.root, { now })).remainingTargets, [{ origin: other, status: 'missing' }]);
});

test('final state reads newly changed bookmarks instead of trusting the last saved plan', async t => {
  const f = await fixture(t), now = new Date('2026-11-24T08:00:00Z');
  const config = { bookmarksPath: path.join(f.root, 'Bookmarks'), mobileFolderNames: ['Container'], targetFolderNames: ['Daily'] };
  await f.write('config/config.json', config);
  await f.write('data/last-valid-bookmark-plan.json', { targets: [{ origin }], targetCount: 1 });
  await f.write('Bookmarks', { roots: { synced: { type: 'folder', name: 'Container', children: [
    { type: 'folder', name: 'Daily', children: [origin, other].map(url => ({ type: 'url', name: 'Daily', url })) }] } } });
  await f.write('logs/latest.json', { runId: '20261124-fixture', runState: 'final', isComplete: true,
    finishedAt: now.toISOString(), results: [bindSuccessEvidence({ status: 'signed',
      evidence: successEvidence('page_text', 'fixture', now) }, { origin }, config, now)] });
  const state = await readCheckinFinalState(f.root, { now });
  assert.equal(state.expectedCount, 2); assert.equal(state.readyToFinish, false);
  assert.deepEqual(state.remainingTargets, [{ origin: other, status: 'missing' }]);
});
