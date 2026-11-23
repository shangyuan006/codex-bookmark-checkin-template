import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { powershellExecutable } from './helpers/powershell.mjs';
import { openReauthAccountMenu } from '../src/reauth-checkin.mjs';
import { applyTodayAbandonment, reconcileLatestAbandonment } from '../src/manual-abandonment.mjs';
import { writeRunResult } from '../src/logger.mjs';

const exec = promisify(execFile);
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const runPS = command => exec(powershellExecutable, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
  Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true });

for (const scenario of ['delayed_exit', 'still_occupied', 'already_closed']) {
  test(`preflight graceful shutdown: ${scenario}`, async () => {
    const { stdout } = await runPS(`
      $ErrorActionPreference='Stop'
      . ./scripts/NativePreflightBrowserClose.ps1
      $script:elapsed=0; $script:requests=0; $errorMessage=$null
      $clock=[datetimeoffset]'2026-10-25T10:00:00Z'
      try {
        Close-NativePreflightBrowser -GetProcesses {
          if ('${scenario}' -eq 'still_occupied' -or ('${scenario}' -eq 'delayed_exit' -and $script:elapsed -lt 22500)) {
            [pscustomobject]@{ProcessId=123}
          }
        } -RequestClose { param($targets) $script:requests++; if ($targets.Count -ne 1) { throw 'wrong scope' } } -Now { $clock.AddMilliseconds($script:elapsed) } -Wait { param($ms) $script:elapsed+=$ms }
      } catch { $errorMessage=$_.Exception.Message }
      [pscustomobject]@{elapsed=$script:elapsed;requests=$script:requests;failed=($null -ne $errorMessage)} | ConvertTo-Json -Compress
    `);
    const result = JSON.parse(stdout.trim());
    assert.deepEqual(result, scenario === 'already_closed'
      ? { elapsed: 0, requests: 0, failed: false }
      : scenario === 'delayed_exit' ? { elapsed: 22500, requests: 2, failed: false }
        : { elapsed: 30000, requests: 2, failed: true });
  });
}

test('passive checkpoint is reusable briefly, never proves check-in, and can be upgraded', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'passive-checkpoint-'));
  try {
    const file = path.join(dir, 'checkpoint.json');
    const { stdout } = await runPS(`
      $ErrorActionPreference='Stop'
      . ./scripts/NativePreflightCheckpoint.ps1
      $file=${quote(file)}
      $now=[datetimeoffset]::Now
      Write-NativePreflightCheckpoint $file @([pscustomobject]@{origin='https://one.example';status='prepared';passiveOnly=$true})
      $default=@(Read-NativePreflightConfirmations $file -Now $now.AddSeconds(1)).Count
      $fresh=@(Read-NativePreflightConfirmations $file -Now $now.AddSeconds(1) -IncludePrepared).Count
      $stale=@(Read-NativePreflightConfirmations $file -Now $now.AddMinutes(11) -IncludePrepared).Count
      Write-NativePreflightCheckpoint $file @([pscustomobject]@{origin='https://one.example';status='signed'})
      $confirmed=@(Read-NativePreflightConfirmations $file -Now $now.AddSeconds(1)).Count
      [pscustomobject]@{normal=$default;fresh=$fresh;stale=$stale;confirmed=$confirmed}|ConvertTo-Json -Compress
    `);
    assert.deepEqual(JSON.parse(stdout.trim()), { normal: 0, fresh: 1, stale: 0, confirmed: 1 });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('manual browser contention exits busy and the dedicated entry cannot report completion', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'busy-checkin-'));
  try {
    await Promise.all(['scripts', 'config', 'tmp'].map(name => fs.mkdir(path.join(dir, name))));
    const names = ['Run-Checkin', 'Resolve-Runtime', 'RunLock', 'ManualVerification', 'ResultContract',
      'ManualAbandonment', 'NativeFallbackPolicy', 'PreflightScope', 'CheckinCycle', 'TaskRetryPolicy',
      'TaskRuntimeBudget', 'CheckinContract.generated', 'CheckinExecutionReport'];
    await Promise.all(names.map(name => fs.copyFile(`scripts/${name}.ps1`, path.join(dir, 'scripts', `${name}.ps1`))));
    await fs.writeFile(path.join(dir, 'config', 'config.json'), JSON.stringify({
      nodeExecutable: process.execPath, runMutexName: `Local\\CheckinFixture-${path.basename(dir)}`,
    }));
    await fs.writeFile(path.join(dir, 'tmp', 'manual-session.json'), '{}');
    const runner = path.join(dir, 'scripts', 'Run-Checkin.ps1');
    await assert.rejects(exec(powershellExecutable, ['-NoProfile', '-File', runner,
      '-ReauthAccountKey', 'linuxdo', '-SuppressReport'], { windowsHide: true }), error => {
      assert.equal(error.code, 75);
      assert.match(error.stdout, /WARNING:/);
      assert.doesNotMatch(error.stdout, /开始签到任务级/);
      return true;
    });
    await assert.rejects(fs.access(path.join(dir, 'logs')), { code: 'ENOENT' });
    const { stdout } = await runPS(`
      $ErrorActionPreference='Stop'
      $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD 'scripts/Open-AgentRouterLogin.ps1'),[ref]$null,[ref]$null)
      $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-AgentRouterAccountCheckin'},$false)
      Invoke-Expression $definition.Extent.Text
      function Resolve-AgentRouterPowerShellExecutable { ${quote(powershellExecutable)} }
      $PSScriptRoot=${quote(path.join(dir, 'scripts'))}; $requestedAccountKey='linuxdo'
      try { $code=Invoke-AgentRouterAccountCheckin; 'unexpected success' }
      catch { 'blocked before completion' }
    `);
    assert.match(stdout, /blocked before completion/);
    assert.doesNotMatch(stdout, /unexpected success/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('late announcement is rechecked before one actual menu click; uncertain clicks are not repeated', async () => {
  for (const uncertain of [false, true]) {
    let trials = 0, actual = 0, dismissals = 0;
    const candidate = { isVisible: async () => true, click: async options => {
      if (options.trial) { if (++trials === 1) throw new Error('late overlay'); }
      else { actual++; if (uncertain) throw new Error('delivery uncertain'); }
    } };
    const page = { url: () => 'https://one.example/console', waitForTimeout: async () => {},
      locator: () => ({ count: async () => 1, nth: () => candidate }) };
    const operation = openReauthAccountMenu(page, {}, { accountMenuSelector: 'button', evidenceWaitMs: 100 }, {}, {
      dismissOverlay: async () => ++dismissals === 2,
    });
    if (uncertain) await assert.rejects(operation, /delivery uncertain/);
    else assert.equal(await operation, true);
    assert.equal(trials, 2); assert.equal(actual, 1); assert.equal(dismissals, 2);
  }
});

test('offline Edge dismisses the real modal before clicking the account menu', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 15000,
}, async t => {
  const { chromium } = createRequire(import.meta.url)('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const origin = 'https://one.example';
  await page.route(`${origin}/**`, route => route.fulfill({ contentType: 'text/html', body:
    '<button id="account" onclick="window.menuOpened=true">Account</button><div role="dialog" style="position:fixed;inset:0;background:white"><button class="close" onclick="this.parentElement.remove()">Close</button></div>' }));
  await page.goto(`${origin}/console`);
  const dismissed = await openReauthAccountMenu(page, { origin, allowedOrigins: [origin] },
    { accountMenuSelector: '#account', evidenceWaitMs: 1000 },
    { actionWaitMs: 1000, preCheckinDismissRules: { [origin]: { selectors: ['.close'], waitMs: 1 } } });
  assert.equal(dismissed, true);
  assert.equal(await page.evaluate(() => window.menuOpened), true);
  assert.equal(await page.getByRole('dialog').count(), 0);
});

const now = new Date('2026-10-25T11:30:00Z');
const abandonment = { schemaVersion: 1, date: '20261025', origins: ['https://skip.example'] };
const report = { runId: '20261025-193000', runState: 'final', isComplete: true, plannedTotal: 2, processedTotal: 2,
  results: [{ origin: 'https://skip.example', status: 'needs_attention', failureCode: 'login_required', reason: 'login required' },
    { origin: 'https://other.example', status: 'needs_attention' }], summary: { needs_attention: 2 },
  selectedOrigins: ['https://other.example'], selectedSummary: { needs_attention: 1 } };

test('today abandonment clears actionable state without inventing success or changing past days', () => {
  const updated = applyTodayAbandonment(report, abandonment, now);
  assert.deepEqual(updated.summary, { abandoned: 1, needs_attention: 1 });
  assert.deepEqual(updated.selectedSummary, { needs_attention: 1 });
  assert.equal(updated.results[0].abandonment.previousFailureCode, 'login_required');
  assert.equal(updated.results[0].failureCode, undefined);
  assert.equal(updated.results[0].retryable, false);
  assert.equal(report.results[0].status, 'needs_attention');
  assert.equal(applyTodayAbandonment(report, { ...abandonment, date: '20261024' }, now), report);
  assert.equal(applyTodayAbandonment(report, { ...abandonment, origins: ['https://skip.example/private'] }, now), report);
  const signed = { ...report, results: [{ origin: 'https://skip.example', status: 'already_signed' }] };
  assert.equal(applyTodayAbandonment(signed, abandonment, now), signed);
});

test('network skip preserves the original failure when its reason is updated and expires tomorrow', () => {
  const legacy = applyTodayAbandonment(report, abandonment, now);
  const marker = { ...abandonment, reasons: { 'https://skip.example': 'network_unavailable' } };
  const network = applyTodayAbandonment(legacy, marker, now);
  const skipped = network.results[0];
  assert.equal(skipped.status, 'abandoned');
  assert.equal(skipped.abandonment.reasonCode, 'network_unavailable');
  assert.equal(skipped.abandonment.previousStatus, 'needs_attention');
  assert.equal(skipped.abandonment.previousFailureCode, 'login_required');
  assert.equal(skipped.abandonment.previousReason, 'login required');
  assert.match(skipped.reason, /网络不可用.*次日/);
  assert.equal(skipped.retryable, false);
  assert.equal(applyTodayAbandonment(network, marker, now), network, 'same marker is idempotent');
  const tomorrow = new Date(now.getTime() + 86400000);
  const nextReport = { ...report, runId: '20261026-193000' };
  assert.equal(applyTodayAbandonment(nextReport, marker, tomorrow), nextReport);
  const unknown = applyTodayAbandonment(report, { ...marker, reasons: { 'https://skip.example': 'unknown' } }, now);
  assert.equal(unknown.results[0].abandonment.reasonCode, 'user_requested');
});

test('abandonment is synchronized immediately and survives a scoped report write', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'abandoned-report-'));
  try {
    const logs = path.join(dir, 'logs');
    const runDir = path.join(logs, '20261025-193100');
    await fs.mkdir(runDir, { recursive: true });
    await fs.mkdir(path.join(dir, 'tmp'));
    await fs.writeFile(path.join(dir, 'tmp', 'manual-abandon.json'), JSON.stringify(abandonment));
    await fs.writeFile(path.join(logs, 'latest.json'), JSON.stringify(report));
    const archive = path.join(logs, 'original-result.json');
    await fs.writeFile(archive, JSON.stringify(report));
    assert.equal((await reconcileLatestAbandonment(dir, now)).updated, true);
    const updated = JSON.parse(await fs.readFile(path.join(logs, 'latest.json'), 'utf8'));
    assert.equal(updated.results[0].status, 'abandoned');
    assert.equal((await reconcileLatestAbandonment(dir, now)).updated, false);
    await writeRunResult(logs, { directory: runDir }, report, { now });
    const written = JSON.parse(await fs.readFile(path.join(logs, 'latest.json'), 'utf8'));
    assert.deepEqual(written.summary, { abandoned: 1, needs_attention: 1 });
    assert.equal(written.results[0].status, 'abandoned');
    assert.equal(written.results[1].status, 'needs_attention');
    const scoped = { ...report, runId: '20261025-193101', isComplete: false,
      selectedTotal: 1, selectedProcessedTotal: 1, results: [{ origin: 'https://other.example', status: 'not_available',
        availabilityKind: 'feature_disabled', evidence: { source: 'configuration', outcome: 'known_no_checkin_feature',
          authoritative: true, confirmedAt: now.toISOString() } }] };
    await writeRunResult(logs, { directory: runDir }, scoped, { now, updateLatest: false, reconcileLatest: true });
    const merged = JSON.parse(await fs.readFile(path.join(logs, 'latest.json'), 'utf8'));
    assert.deepEqual(merged.summary, { abandoned: 1, not_available: 1 });
    assert.equal(merged.results[0].status, 'abandoned');
    assert.deepEqual(JSON.parse(await fs.readFile(archive, 'utf8')), report);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
