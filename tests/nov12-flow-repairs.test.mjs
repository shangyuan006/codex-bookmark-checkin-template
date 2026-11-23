import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { powershellExecutable } from './helpers/powershell.mjs';
import { waitForCalendarDayCheckinEvidence, classifyCalendarDayCheckinEvidence } from '../src/browser.mjs';
import { createSubmissionScope, runWithSubmissionJournal, readSubmissionJournal, SUBMISSION_SCOPE } from '../src/submission-guard.mjs';
import { dailyReadinessEvidence, bindSuccessEvidence, successEvidence } from '../src/checkin-evidence.mjs';
import { freshNativePreflightHandoffs } from '../src/native-preflight-state.mjs';

const exec = promisify(execFile), root = path.resolve(import.meta.dirname, '..');
const origin = 'https://calendar.example', target = { origin, allowedOrigins: [origin] };
const empty = { loaded: false, domReady: true, buttonCount: 0, currentDateEvidenceCount: 0 };
const ready = { loaded: true, domReady: true, buttonCount: 1, currentDateEvidenceCount: 1,
  enabledCurrentDateButtonCount: 1, explicitTodayUnsigned: true };
function clock() {
  let now = Date.parse('2026-11-12T02:00Z');
  return { now: () => now, page: { url: () => origin + '/user/attendance', isClosed: () => false,
    waitForTimeout: async ms => { now += ms; } } };
}
const config = { calendarDayCheckinOrigins: [origin], calendarDayCheckinWaitMs: 15_000,
  checkinStatePollMs: 1000, automationUserDataDir: 'data/test-profile' };

test('native calendar deadline allows a dated control appearing after the old 15-second limit', async () => {
  const f = clock(), start = f.now();
  const evidence = await waitForCalendarDayCheckinEvidence(f.page, target, config, {
    deadline: start + 60_000, now: f.now, readEvidence: async () => f.now() - start >= 20_000 ? ready : empty,
  });
  assert.equal(classifyCalendarDayCheckinEvidence(evidence).status, 'ready');
  assert.equal(evidence.calendarDiagnostics.budgetMs, 60_000);
  assert.equal(evidence.calendarDiagnostics.elapsedMs, 20_000);
});

test('an exhausted calendar budget retains a fixed blocker under historical submission protection', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'calendar-budget-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'journal.json'), f = clock(), start = f.now();
  await createSubmissionScope(file, target, config, { now: () => new Date(start - 86400_000) }).begin();
  let mutations = 0;
  const result = await runWithSubmissionJournal(file, target, config, async active => {
    if (!active.checkinReadOnly) mutations++;
    const evidence = await waitForCalendarDayCheckinEvidence(f.page, target, config, {
      deadline: start + 60_000, now: f.now, readEvidence: async () => empty,
    });
    return classifyCalendarDayCheckinEvidence(evidence);
  }, { now: () => new Date(f.now()) });
  assert.equal(mutations, 0);
  assert.equal(result.failureCode, 'submission_quarantined');
  assert.equal(result.submissionObservation.failureCode, 'calendar_loading_timeout');
  assert.match(result.reason, /当前阻塞：日历页/);
  assert.equal(result.calendarDiagnostics.elapsedMs, 60_000);
  const journal = await readSubmissionJournal(file);
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0].state, 'uncertain');
});

test('fresh dated readiness permits one new daily action while the historical intent remains intact', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'calendar-continuation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'journal.json'), f = clock(), start = f.now();
  await createSubmissionScope(file, target, config, { now: () => new Date(start - 86400_000) }).begin();
  let submissions = 0;
  const result = await runWithSubmissionJournal(file, target, config, async active => {
    if (active.checkinReadOnly) {
      await waitForCalendarDayCheckinEvidence(f.page, target, config, { deadline: start + 60_000, now: f.now,
        readEvidence: async () => f.now() - start >= 20_000 ? ready : empty });
      return dailyReadinessEvidence(target, config, { now: new Date(f.now()) });
    }
    await active[SUBMISSION_SCOPE].begin(); submissions++;
    return bindSuccessEvidence({ status: 'signed', evidence: successEvidence('page_text', 'calendar_day_confirmed', new Date(f.now())) },
      target, config, new Date(f.now()));
  }, { now: () => new Date(f.now()) });
  assert.equal(result.status, 'signed'); assert.equal(submissions, 1);
  const journal = await readSubmissionJournal(file);
  assert.deepEqual(journal.entries.map(entry => entry.state), ['intent', 'confirmed']);
});

test('calendar blockers survive the current preflight handoff without accepting another attempt', () => {
  const now = new Date(), attempt = 'a'.repeat(32);
  for (const failureCode of ['calendar_loading_timeout', 'calendar_today_not_found', 'calendar_completion_unconfirmed']) {
    const report = { generatedAt: now.toISOString(), results: [{ origin, status: 'needs_attention', failureCode,
      retryable: false, preflightAttemptId: attempt }] };
    assert.equal(freshNativePreflightHandoffs(report, new Set([origin]), attempt, now).get(origin).failureCode, failureCode);
    assert.equal(freshNativePreflightHandoffs(report, new Set([origin]), 'b'.repeat(32), now).size, 0);
  }
});

for (const scenario of ['ready', 'transient_query', 'persistent_query', 'startup_failure', 'partial_session']) {
  test(`manual window launch reports actual readiness and safely bounds retries: ${scenario}`, { timeout: 30_000 }, async t => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'manual-launch-result-'));
    t.after(() => fs.rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
    for (const directory of ['scripts', 'config', 'tmp', 'logs']) await fs.mkdir(path.join(fixture, directory));
    for (const name of ['Open-ManualLogin', 'ManualVerification', 'CheckinContract.generated', 'ResultContract']) {
      await fs.copyFile(path.join(root, 'scripts', name + '.ps1'), path.join(fixture, 'scripts', name + '.ps1'));
    }
    await fs.writeFile(path.join(fixture, 'config/config.json'), JSON.stringify({
      runMutexName: `Local\\LaunchResult-${randomUUID()}`, nodeExecutable: process.execPath,
    }));
    await fs.writeFile(path.join(fixture, 'scripts/Resolve-Runtime.ps1'), `
$script:queries=0
function Resolve-CheckinNode($Config) { return $Config.nodeExecutable }
function Get-CheckinAutomationBrowserProcesses {
  $script:queries++
  if ('${scenario}' -eq 'persistent_query' -or ('${scenario}' -eq 'transient_query' -and $script:queries -eq 1)) {
    throw [System.Management.Automation.ErrorRecord]::new([InvalidOperationException]::new('private fixture error'),
      'CheckinProcessQueryFailed',[System.Management.Automation.ErrorCategory]::ResourceUnavailable,$null)
  }
  return @()
}
`);
    await fs.writeFile(path.join(fixture, 'scripts/Open-PlainLoginChrome.ps1'), `
param([switch]$NativeMinimal,[switch]$TrackManualSession)
$root=Split-Path -Parent $PSScriptRoot
$counter=Join-Path $root 'tmp/open-count'
$count=if(Test-Path $counter){[int](Get-Content $counter)}else{0}
$count++;[IO.File]::WriteAllText($counter,[string]$count)
if('${scenario}' -eq 'startup_failure' -and $count -eq 1){throw 'private fixture failure'}
if('${scenario}' -eq 'partial_session') {
  [IO.File]::WriteAllText((Join-Path $root 'tmp/manual-session.json'),' {"mode":"native","windowReady":false}')
  throw 'private fixture failure after reservation'
}
[IO.File]::WriteAllText((Join-Path $root 'tmp/manual-session.json'),'{"mode":"native","windowReady":true}')
`);
    const execution = await exec(powershellExecutable, ['-NoProfile', '-NonInteractive', '-File', path.join(fixture, 'scripts/Open-ManualLogin.ps1')],
      { cwd: fixture, windowsHide: true, timeout: 20_000 }).then(() => 0, error => {
      if (typeof error.code !== 'number') throw error; return error.code;
    });
    const outcome = JSON.parse(await fs.readFile(path.join(fixture, 'tmp/manual-handoff-launch-outcome.json')));
    const logs = await fs.readFile(path.join(fixture, 'logs/scheduler.log'), 'utf8');
    const failed = ['persistent_query', 'partial_session'].includes(scenario);
    assert.equal(execution, failed ? 1 : 0);
    assert.equal(outcome.state, failed ? 'failed' : 'window_ready');
    assert.equal(outcome.attempt, ['transient_query', 'startup_failure'].includes(scenario) ? 2 : 1);
    assert.doesNotMatch(logs, /private fixture/);
    if (failed) assert.doesNotMatch(logs, /已确认就绪/);
    else assert.match(logs, /已确认就绪/);
    if (scenario === 'partial_session') {
      assert.equal(await fs.readFile(path.join(fixture, 'tmp/open-count'), 'utf8'), '1');
      assert.equal(JSON.parse(await fs.readFile(path.join(fixture, 'tmp/manual-session.json'))).windowReady, false);
    }
    await assert.rejects(fs.access(path.join(fixture, 'tmp/manual-handoff-launch.json')), { code: 'ENOENT' });
  });
}
