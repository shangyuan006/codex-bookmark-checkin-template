import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildTimeoutReport } from '../src/finalize-timeout-report.mjs';
import { selectSavedLoginSyncOrigins } from '../src/login-sync-origins.mjs';
import { powershellExecutable } from './helpers/powershell.mjs';

const exec = promisify(execFile);
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
async function ps(source) {
  const { stdout } = await exec(powershellExecutable, ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'\n$WarningPreference='SilentlyContinue'\n${source}`], {
    windowsHide: true, timeout: 15000,
  });
  return JSON.parse(stdout);
}

test('only reports from the requested execution and attempt can determine progress or completion', async t => {
  const logs = await fs.mkdtemp(path.join(os.tmpdir(), 'checkin-attempt-'));
  t.after(() => fs.rm(logs, { recursive: true, force: true }));
  const execution = 'a'.repeat(32);
  const oldExecution = 'b'.repeat(32);
  const fingerprint = 'c'.repeat(64);
  const fixture = async (id, attempt, state, invalid = false) => {
    const runId = `20261118-100000-${id}-${attempt}`;
    const directory = path.join(logs, runId);
    const report = { runId, executionAttemptId: `${invalid ? oldExecution : id}-${attempt}`, runState: state,
      planFingerprint: fingerprint, results: [{ origin: 'https://fixture.example', status: 'signed' }] };
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, state === 'final' ? 'result.json' : 'progress.json'), JSON.stringify(report));
    return report;
  };
  const old = await fixture(oldExecution, 3, 'final');
  await fs.writeFile(path.join(logs, 'latest.json'), JSON.stringify(old));
  await fixture(execution, 1, 'final');
  const progress = await fixture(execution, 2, 'in_progress');
  await fixture(execution, 2, 'final', true);
  const result = await ps(`
    . ./scripts/CheckinExecutionReport.ps1
    $logs=${quote(logs)}; $id='${execution}'; $now=[datetime]'2026-11-18T10:00:30'
    $first=Find-CheckinExecutionReport $logs $id 1 '${fingerprint}' $now
    $current=Find-CheckinExecutionReport $logs $id 2 '${fingerprint}' $now
    $last=Find-CheckinExecutionReport $logs $id 0 '${fingerprint}' $now
    $unstarted=Find-CheckinExecutionReport $logs $id 3 '${fingerprint}' $now
    $changed=Find-CheckinExecutionReport $logs $id 2 'different-plan' $now
    @{first=$first.Report.runState; current=$current.Report.runState; last=$last.Report.executionAttemptId;
      unstarted=($null -eq $unstarted); changed=($null -eq $changed)} | ConvertTo-Json -Compress
  `);
  assert.deepEqual(result, { first: 'final', current: 'in_progress', last: `${execution}-2`, unstarted: true, changed: true });
  const recovered = buildTimeoutReport({ sources: [], planFingerprint: fingerprint,
    targets: [{ origin: 'https://fixture.example', candidates: [] }] }, progress);
  assert.equal(recovered.executionAttemptId, `${execution}-2`);
  assert.equal(recovered.runId, progress.runId);
});

test('a busy launch neither spends the daily budget nor acknowledges pending verification', async () => {
  const actual = await ps(`
    . ./scripts/TaskRuntimeBudget.ps1
    $ast=[Management.Automation.Language.Parser]::ParseFile((Resolve-Path scripts/Start-UserScheduler.ps1),[ref]$null,[ref]$null)
    foreach ($name in @('Test-SchedulerWaiting','Write-SchedulerClaim','Write-SchedulerState')) {
        $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$false)
        Invoke-Expression $definition.Extent.Text
    }
    function Read-SchedulerState { return [pscustomobject]$script:fixtureState }
    function Write-SchedulerJsonAtomic($Path,$Value) { $script:fixtureState=$Value }
    $statePath='fixture'; $now=[datetime]'2026-11-18T11:00:00'; $config=[pscustomobject]@{schedulerMaxDailyAttempts=3}
    $script:fixtureState=[ordered]@{phase='finished'; lastAttemptDate='2026-11-18'; attemptsToday=3;
      lastManualVerificationSourceRunId='older'; lastManualVerificationChangedAt='older'; lastRunId='prior-report'}
    $handoff=[pscustomobject]@{Mode='verification_ready';SourceRunId='current';ChangedAt='v2';VerificationRunId='new-report'}
    $report=[pscustomobject]@{Valid=$true;Complete=$false;RunId='new-report'}
    Write-SchedulerClaim $now
    $during=$script:fixtureState.attemptsToday
    Write-SchedulerState $now 75 $report $config $handoff
    $after=$script:fixtureState.attemptsToday; $version=$script:fixtureState.lastManualVerificationChangedAt
    $lastRun=$script:fixtureState.lastRunId
    $ready=-not (Test-SchedulerWaiting (Read-SchedulerState) $now $config $handoff $report)
    Write-SchedulerClaim $now
    Write-SchedulerState $now 2 $report $config $handoff
    $actualAttempts=$script:fixtureState.attemptsToday; $actualVersion=$script:fixtureState.lastManualVerificationChangedAt
    $handoff.ChangedAt='v3'
    Write-SchedulerClaim $now
    Write-SchedulerState $now 2 ([pscustomobject]@{Valid=$false;Complete=$false}) $config $handoff
    $limited=Test-SchedulerWaiting (Read-SchedulerState) $now.AddHours(2) $config $handoff $report
    $handoff.ChangedAt='v4'
    $freshReady=-not (Test-SchedulerWaiting (Read-SchedulerState) $now.AddHours(2) $config $handoff $report)
    @{during=$during; after=$after; version=$version; lastRun=$lastRun; ready=$ready;
      actualAttempts=$actualAttempts; actualVersion=$actualVersion; limited=$limited; freshReady=$freshReady} | ConvertTo-Json -Compress
  `);
  assert.deepEqual(actual, { during: 3, after: 3, version: 'older', lastRun: 'prior-report', ready: true,
    actualAttempts: 4, actualVersion: 'v2', limited: true, freshReady: true });
});

test('only a fresh selected failure can move a saved site from verification back to manual', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'checkin-queue-owner-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const actual = await ps(`
    . ./scripts/ManualVerification.ps1
    . ./scripts/ManualAbandonment.ps1
    $ast=[Management.Automation.Language.Parser]::ParseFile((Resolve-Path scripts/Run-Checkin.ps1),[ref]$null,[ref]$null)
    foreach ($name in @('Write-ManualHandoff','Test-IsCompleteFinalReport')) {
        $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$false)
        Invoke-Expression $definition.Extent.Text
    }
    $folder=${quote(folder)}
    $manualVerificationPath=Join-Path $folder 'verification.json'; $manualHandoffPath=Join-Path $folder 'handoff.json'
    $manualSessionPath=Join-Path $folder 'session.json'; $manualAbandonPath=Join-Path $folder 'abandon.json'
    $now=Get-Date; $day=Get-ManualVerificationShanghaiDate $now; $stamp=$now.ToUniversalTime().ToString('o')
    $a='https://saved.example'; $b='https://open.example'; $c='https://not-rechecked.example'
    $firstRun="$day-100000"; $retryRun="$day-110000"
    $pending=[pscustomobject]@{sourceRunId=$firstRun; createdAt=$stamp; sourceFinishedAt=$stamp;
      state='pending_verification'; authoritativeEvidenceRequired=$true; verificationRunId=$firstRun;
      targets=@(@{origin=$a;verificationStatus='login_required'},@{origin=$c;verificationStatus='pending_verification'})}
    Write-ManualVerificationDocument $pending $manualVerificationPath
    $rows=@($a,$b,$c | ForEach-Object { [pscustomobject]@{origin=$_;status='login_required'} })
    $report=[pscustomobject]@{runId=$retryRun; runState='final'; isComplete=$true; plannedTotal=3; processedTotal=3;
      results=$rows; selectedOrigins=@($a); timeoutRecovered=$false}
    Write-ManualHandoff $report $now | Out-Null
    $before=(Get-Content -Raw $manualHandoffPath | ConvertFrom-Json).targets.origin
    $pending.verificationRunId=$retryRun
    Write-ManualVerificationDocument $pending $manualVerificationPath
    Write-ManualHandoff $report $now | Out-Null
    $after=(Get-Content -Raw $manualHandoffPath | ConvertFrom-Json).targets.origin
    $retained=(Get-Content -Raw $manualVerificationPath | ConvertFrom-Json).targets.origin
    @{before=@($before);after=@($after);retained=@($retained)} | ConvertTo-Json -Compress
  `);
  assert.deepEqual(actual, { before: ['https://open.example'], after: ['https://saved.example', 'https://open.example'],
    retained: ['https://not-rechecked.example'] });
});

test('scoped encrypted login sync only includes selected origins and their configured aliases', () => {
  const target = { origin: 'https://one.example', allowedOrigins: ['https://alias.example'] };
  const unrelated = { origin: 'https://two.example', allowedOrigins: ['https://two-alias.example'] };
  const explicit = ['https://other.example'];
  assert.deepEqual(selectSavedLoginSyncOrigins(explicit, [target, unrelated], [target.origin]),
    ['https://alias.example', target.origin]);
  assert.deepEqual(selectSavedLoginSyncOrigins(explicit, [target, unrelated], ['https://unknown.example']), []);
  assert.deepEqual(selectSavedLoginSyncOrigins(explicit, [target, unrelated], explicit), explicit);
  assert.deepEqual(selectSavedLoginSyncOrigins(explicit, [target, unrelated], []), []);
});

test('scoped database sync leaves other subdomains and ports unchanged', async t => {
  const python = await exec('python', ['--version'], { windowsHide: true, timeout: 5000 }).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!python) return t.skip('optional Python runtime is unavailable');
  const { DatabaseSync } = await import('node:sqlite');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'saved-login-scope-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const [source, target] = ['from.db', 'to.db'].map(name => path.join(folder, name));
  const origins = ['https://example.test', 'https://sub.example.test', 'https://example.test:8443'];
  for (const [filename, value] of [[source, 'new-fixture'], [target, 'old-fixture']]) {
    const db = new DatabaseSync(filename);
    db.exec('create table logins(id integer primary key, origin_url text, signon_realm text, fixture_value text)');
    const insert = db.prepare('insert into logins(origin_url,signon_realm,fixture_value) values(?,?,?)');
    for (const origin of origins) insert.run(`${origin}/login`, `${origin}/`, value);
    db.close();
  }
  const { stdout } = await exec('python', ['scripts/Sync-ChromeSavedLogins.py', source, target, origins[0], '--exact-origins'], {
    windowsHide: true, timeout: 10000,
  });
  assert.equal(JSON.parse(stdout).copied, 1);
  const db = new DatabaseSync(target, { readOnly: true });
  try {
    const values = new Map(db.prepare('select origin_url,fixture_value from logins').all()
      .map(row => [row.origin_url, row.fixture_value]));
    assert.deepEqual(origins.map(origin => values.get(`${origin}/login`)), ['new-fixture', 'old-fixture', 'old-fixture']);
  } finally { db.close(); }
});
