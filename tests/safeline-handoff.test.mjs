import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { classifyPageText } from '../src/detector.mjs';
import { processTarget } from '../src/browser.mjs';
import { freshNativePreflightResults, freshNativePreflightHandoffs, nativePreflightProgress } from '../src/native-preflight-state.mjs';
import { isRetryEligible, isResumeRetryEligible, recoveryEntriesForResults, filterAutomaticRetryOrigins } from '../src/retry-policy.mjs';
import { isTerminalResult } from '../src/result-contract.mjs';

const exec = promisify(execFile);
const origin = 'https://blocked.example';
const attemptId = 'a'.repeat(32);
const blocker = { origin, ...classifyPageText({ bodyText: '雷池 WAF 客户端异常，请确认您是合法用户' }) };

test('SafeLine stays unresolved and cannot enter automatic recovery, including an explicit scope on round two', () => {
  assert.equal(blocker.status, 'interactive_challenge');
  assert.equal(blocker.failureCode, 'safeline_client_challenge');
  assert.equal(blocker.retryable, false);
  assert.equal(isTerminalResult(blocker), false);
  assert.equal(isRetryEligible(blocker), false);
  assert.equal(isResumeRetryEligible(blocker, new Set([origin])), false);
  assert.deepEqual(recoveryEntriesForResults([blocker], [{ origin }]), []);
  const requested = new Set([origin, 'https://network.example']);
  assert.deepEqual([...filterAutomaticRetryOrigins(requested, [blocker])], ['https://network.example']);
  assert.equal(requested.size, 2); // An explicit new invocation retains its scope.
});

test('native handoffs require the exact current attempt, date, origin and blocker evidence', () => {
  const now = new Date(2026, 8, 17, 12);
  const observedAt = now.toISOString();
  const result = { ...blocker, observedAt, preflightAttemptId: attemptId, actionAttempted: false };
  const report = { generatedAt: observedAt, results: [result] };
  const allowed = new Set([origin]);
  const handoffs = freshNativePreflightHandoffs(report, allowed, attemptId, now);
  assert.equal(handoffs.size, 1);
  assert.equal(freshNativePreflightResults(report, allowed, now).size, 0);
  const progress = nativePreflightProgress([{ origin }], handoffs)[0];
  assert.equal(progress.retryable, false);
  assert.equal(progress.failureCode, blocker.failureCode);
  assert.equal(progress.actionAttempted, false);
  assert.equal(isTerminalResult(progress), false);
  for (const id of [undefined, '', 'b'.repeat(32), 'invalid']) {
    assert.equal(freshNativePreflightHandoffs(report, allowed, id, now).size, 0);
  }
  assert.equal(freshNativePreflightHandoffs(report, new Set(), attemptId, now).size, 0);
  for (const patch of [
    { observedAt: new Date(now.getTime() - 86400000).toISOString() },
    { observedAt: new Date(now.getTime() + 60000).toISOString() },
    { retryable: true }, { failureCode: 'other' }, { status: 'unconfirmed' },
  ]) {
    assert.equal(freshNativePreflightHandoffs({ ...report, results: [{ ...result, ...patch }] }, allowed, attemptId, now).size, 0);
  }
});

test('generic SafeLine failure closes once without opening other candidates or retrying', async () => {
  for (const clickThrows of [true, false]) {
    let opens = 0, closes = 0, visits = 0, clicks = 0;
    const context = { newPage: async () => {
      opens++;
      return {
        goto: async () => { visits++; }, url: () => `${origin}/`, close: async () => { closes++; },
        locator: selector => ({
          count: async () => ['button#sl-check', '#sl-text'].includes(selector) ? 1 : 0,
          innerText: async () => '客户端异常，请确认您是合法用户',
          isVisible: async () => true,
          click: async () => { clicks++; if (clickThrows) throw new Error('not clickable'); },
        }),
      };
    } };
    const result = await processTarget(context, { origin, candidates: [`${origin}/`, `${origin}/another`] }, {
      retryCount: 2, retryDelayMs: 1, navigationTimeoutMs: 100, cloudflareWaitMs: 0, targetTimeoutMs: 10000,
    }, [], null);
    assert.equal(result.status, 'interactive_challenge');
    assert.equal(result.retryable, false);
    assert.equal(result.failureCode, blocker.failureCode);
    assert.deepEqual([opens, closes, visits, clicks], [1, 1, 1, 1]);
    assert.equal(result.candidateHistory.length, 1);
  }
});

test('PowerShell retry paths skip blockers while handoff and successful manual verification remain available', async () => {
  const runner = await fs.readFile(new URL('../scripts/Run-Checkin.ps1', import.meta.url), 'utf8');
  const retryFunction = runner.slice(runner.indexOf('function Test-HasImmediateRetry('), runner.indexOf('function Resolve-RequestedCheckinOrigins('));
  const { stdout } = await exec('pwsh', ['-NoProfile', '-Command', `
    . ./scripts/ManualVerification.ps1
    . ./scripts/NativeFallbackPolicy.ps1
    function Test-IsCompleteFinalReport($Report) { $true }
    ${retryFunction}
    $result = [pscustomobject]@{origin='${origin}';status='interactive_challenge';retryable=$false;failureCode='safeline_client_challenge'}
    $report = [pscustomobject]@{runState='final';isComplete=$true;plannedTotal=1;processedTotal=1;results=@($result)}
    $handoff = @(Get-ManualHandoffTargets $report)
    $auto = Test-ManualVerificationImmediateResult $result (Get-Date)
    $fallback = @(Get-NativeFallbackRetryOrigins $report @('${origin}'))
    $retry = Test-HasImmediateRetry $report (Get-Date)
    $result.status='unconfirmed'
    $unconfirmedRetry = Test-HasImmediateRetry $report (Get-Date)
    $result.status='already_signed'
    [pscustomobject]@{handoff=@($handoff.origin);auto=$auto;fallback=$fallback;retry=$retry;unconfirmedRetry=$unconfirmedRetry;terminal=(Test-ManualVerificationResultTerminal $result)} | ConvertTo-Json -Compress
  `], { windowsHide: true });
  const result = JSON.parse(stdout);
  assert.deepEqual(result, { handoff: [origin], auto: false, fallback: [], retry: false, unconfirmedRetry: false, terminal: true });
});

test('wrapper preflight distinguishes automatic continuation from the first manual or explicit attempt', async () => {
  const runner = await fs.readFile(new URL('../scripts/Run-Checkin.ps1', import.meta.url), 'utf8');
  const start = runner.indexOf('                if ($null -ne $resumeCandidate)', runner.indexOf('if ($preflightConfigured) {'));
  const end = runner.indexOf('                if ($null -ne $manualVerification)', start);
  assert.ok(start > 0 && end > start);
  const { stdout } = await exec('pwsh', ['-NoProfile', '-Command', `
    . ./scripts/ResultContract.ps1
    $currentPreflightTargets=@([pscustomobject]@{origin='${origin}'},[pscustomobject]@{origin='https://network.example'})
    $resumeCandidate=[pscustomobject]@{Report=[pscustomobject]@{results=@(
      [pscustomobject]@{origin='${origin}';status='interactive_challenge';retryable=$false},
      [pscustomobject]@{origin='https://network.example';status='error'}
    )}}
    $cases=@()
    foreach ($case in @('automatic','explicit','manual','explicit-second','manual-second')) {
      $attempt=if($case -like '*second'){2}else{1}
      $requestedOrigins=if($case -like 'explicit*'){@('${origin}')}else{@()}
      $manualVerification=if($case -like 'manual*'){[pscustomobject]@{Origins=@('${origin}')}}else{$null}
      ${runner.slice(start, end)}
      $cases += [pscustomobject]@{case=$case;origins=@($preflightTargets.origin)}
    }
    ConvertTo-Json -InputObject @($cases) -Compress -Depth 4
  `], { windowsHide: true });
  for (const result of JSON.parse(stdout)) {
    assert.equal(result.origins.includes(origin), ['explicit', 'manual'].includes(result.case), result.case);
    assert.ok(result.origins.includes('https://network.example'));
  }
  assert.match(runner, /if \(\$attempt -gt 1\) \{ \$runArguments \+= '--automatic-retry'/);
});

test('native checkpoint transfers the blocker and permits a later authoritative success to replace it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'checkin-handoff-'));
  try {
    const checkpoint = path.join(dir, 'native.json');
    const script = await fs.readFile(new URL('../scripts/Prepare-NativeWafSession.ps1', import.meta.url), 'utf8');
    const start = script.indexOf('    $reportedInspection =');
    const end = script.indexOf('\n}', start);
    assert.ok(start > 0 && end > start);
    await exec('pwsh', ['-NoProfile', '-Command', `
      . ./scripts/NativePreflightCheckpoint.ps1
      $preflightPath='${checkpoint.replaceAll("'", "''")}'
      $origin='${origin}';$url='${origin}/';$AttemptId='${attemptId}'
      $inspection=$null;$lastInspection=[pscustomobject]@{status='interactive_challenge';failureCode='safeline_client_challenge';actionAttempted=$false;actionOutcome='not_attempted'}
      $preflightResults=@();$explicitlyConfirmed=$false;$endpointConfirmed=$false;$prepared=$false;$hasAction=$true
      ${script.slice(start, end)}
    `], { windowsHide: true });
    const report = JSON.parse(await fs.readFile(checkpoint, 'utf8'));
    assert.equal(freshNativePreflightHandoffs(report, new Set([origin]), attemptId).size, 1);
    assert.equal(freshNativePreflightResults(report, new Set([origin])).size, 0);
    await exec('pwsh', ['-NoProfile', '-Command', `
      . ./scripts/NativePreflightCheckpoint.ps1
      Write-NativePreflightCheckpoint '${checkpoint.replaceAll("'", "''")}' @([pscustomobject]@{origin='${origin}';status='already_signed'})
    `], { windowsHide: true });
    const confirmed = JSON.parse(await fs.readFile(checkpoint, 'utf8'));
    assert.equal(freshNativePreflightResults(confirmed, new Set([origin])).size, 1);
    assert.equal(freshNativePreflightHandoffs(confirmed, new Set([origin]), attemptId).size, 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
