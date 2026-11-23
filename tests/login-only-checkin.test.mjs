import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { getConfiguredSequentialActionRule, processCandidate } from '../src/browser.mjs';
import { SUBMISSION_SCOPE } from '../src/submission-guard.mjs';
import { powershellExecutable } from './helpers/powershell.mjs';

const origin = 'https://ordinary.example';
const target = { origin, candidates: [origin + '/'] };
const step = { url: origin + '/me/signin', dailyCheckin: true, actionType: 'daily_checkin', actionTexts: ['普通签到'],
  actionTags: ['BUTTON'], completedControl: { selector: 'button', textPattern: '^签到完成$', matchByText: true },
  acceptGenericCheckinState: false, waitMs: 1000, entryNavigation: { homePath: '/', linkText: '签到', loginText: '登录' } };
const withSteps = (...steps) => ({ navigationTimeoutMs: 3000, sequentialActionRules: { [origin]: { steps } } });

test('the exact entry opts in only a single same-origin sequential step', () => {
  assert.deepEqual(getConfiguredSequentialActionRule(target, withSteps(step)).steps[0].entryNavigation, step.entryNavigation);
  for (const invalid of [{ ...step, url: step.url + '?state=1' },
    { ...step, entryNavigation: { ...step.entryNavigation, homePath: '//elsewhere.example/' } },
    { ...step, entryNavigation: { ...step.entryNavigation, loginText: '签到' } }]) {
    assert.throws(() => getConfiguredSequentialActionRule(target, withSteps(invalid)));
  }
  assert.throws(() => getConfiguredSequentialActionRule(target, withSteps(step, step)));
});

test('offline Edge follows the exact entry, only submits ordinary check-in and requires the completion control', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 30000,
}, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let home = '<a href="/login">登录</a>', signed = false, submissions = 0, unsafeActions = 0, passwordForm = false;
  const reserved = [];
  await page.exposeFunction('recordCheckin', () => { signed = true; submissions++; });
  await page.exposeFunction('unsafeAction', () => { unsafeActions++; });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin);
    const body = url.pathname === '/' ? home : passwordForm ? '<input type="password" aria-label="Password">' : `
      <button onclick="unsafeAction()">运气签到</button>
      <button onclick="recordCheckin();setTimeout(()=>{this.textContent='签到完成';this.disabled=true},100)">${signed ? '签到完成' : '普通签到'}</button>`;
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
  });
  const config = { ...withSteps(step), [SUBMISSION_SCOPE]: { begin: async () => reserved.push(page.url()) } };
  const run = () => processCandidate(page, target, origin + '/', config, {});
  assert.equal((await run()).status, 'login_required');
  home = '<a href="/wrong">签到</a>';
  assert.equal((await run()).failureCode, 'sequential_entry_unconfirmed');
  assert.equal(submissions, 0);
  assert.deepEqual(reserved, []);
  home = '<a href="/me/signin" onclick="unsafeAction()">签到</a>';
  passwordForm = true;
  assert.equal((await run()).status, 'login_required');
  assert.deepEqual(reserved, []);
  passwordForm = false;
  assert.equal((await run()).status, 'signed');
  assert.equal((await run()).status, 'already_signed');
  assert.equal(submissions, 1);
  assert.equal(unsafeActions, 0);
  assert.deepEqual(reserved, [step.url]);
});

test('normal close dispatches only saved login targets once; save-only and external close never dispatch', async t => {
  const execute = promisify(execFile);
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'login-only-close-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  for (const dir of ['scripts', 'config', 'tmp']) await fs.mkdir(path.join(fixture, dir));
  for (const name of ['Close-ManualLogin.ps1', 'ManualAbandonment.ps1', 'ManualVerification.ps1', 'CheckinContract.generated.ps1', 'ResultContract.ps1']) {
    await fs.copyFile(new URL('../scripts/' + name, import.meta.url), path.join(fixture, 'scripts', name));
  }
  const marker = 'a'.repeat(32);
  const previousMarker = 'b'.repeat(32);
  const previousOrigin = 'https://retained.example';
  const profile = path.join(fixture, 'profile');
  const other = 'https://different.example';
  const recovered = 'https://recovered.example';
  await fs.writeFile(path.join(fixture, 'config/config.json'), JSON.stringify({ automationUserDataDir: profile }));
  await fs.writeFile(path.join(fixture, 'scripts/Resolve-Runtime.ps1'), `
    function Get-CheckinManualSessionBrowserProcesses { param($Config,$ProfilePath,$State)
      if (-not $global:fixtureClosed) { [pscustomobject]@{ProcessId=12345} }
    }
    function ConvertTo-CheckinUtcDateTime($Value) { [datetime]$Value }
    function Test-CheckinProcessStartIdentity { param($Process,$RecordedStart,$ToleranceSeconds) $true }
    function Get-Process { param($Id,$ErrorAction)
      $p=[pscustomobject]@{MainWindowHandle=1}
      $p|Add-Member -MemberType ScriptMethod -Name CloseMainWindow -Value {$global:fixtureClosed=$true;return $true}
      $p
    }`);
  await fs.writeFile(path.join(fixture, 'scripts/Run-Checkin.ps1'), `
    param([string[]]$Origins, [int]$Attempts, [switch]$SuppressReport, [string]$ResumeManualSessionId)
    $global:calls += @{origins=$Origins; attempts=$Attempts; quiet=[bool]$SuppressReport; marker=$ResumeManualSessionId;
      closed=$global:fixtureClosed; retained=(Test-Path tmp/manual-session.json);
      pending=(Get-Content -Raw tmp/manual-verification.json | ConvertFrom-Json).state}
    exit 0`);
  for (const mode of ['normal', 'save-only', 'external', 'retained']) {
    const sourceRunId = mode === 'retained' ? '20261118-110000' : null;
    if (mode === 'retained') await fs.writeFile(path.join(fixture, 'tmp/manual-verification.json'), JSON.stringify({
      sourceRunId: '20261118-100000', state: 'pending_verification', authoritativeEvidenceRequired: true,
      manualSessionId: previousMarker, targets: [{ origin: previousOrigin, verificationStatus: 'pending_verification' }],
    }));
    await fs.writeFile(path.join(fixture, 'tmp/manual-session.json'), JSON.stringify({ schemaVersion: 2, mode: 'native',
      pid: 12345, profile, targetCount: 3, sourceRunId, launchMarker: marker, processStartedAt: new Date().toISOString(),
      targets: [{ origin, previousStatus: 'login_required' },
        { origin: recovered, previousStatus: 'needs_attention', loginRecoveryRequired: true },
        { origin: other, previousStatus: 'interactive_challenge' }] }));
    const { stdout } = await execute(powershellExecutable, ['-NoProfile', '-NonInteractive', '-Command', `
      $global:fixtureClosed=$${mode === 'external'}; $global:calls=@()
      & ./scripts/Close-ManualLogin.ps1 ${mode === 'save-only' ? '-SaveOnly' : ''} | Out-Null
      & ./scripts/Close-ManualLogin.ps1 | Out-Null
      @{calls=$global:calls}|ConvertTo-Json -Depth 6 -Compress
    `], { cwd: fixture, windowsHide: true, timeout: 15000 });
    const calls = JSON.parse(stdout.trim()).calls;
    assert.deepEqual(calls, ['normal', 'retained'].includes(mode) ? [{ origins: [origin, recovered], attempts: 1, quiet: true,
      marker, closed: true, retained: false, pending: 'pending_verification' }] : []);
    const pending = JSON.parse(await fs.readFile(path.join(fixture, 'tmp/manual-verification.json'), 'utf8'));
    assert.equal(pending.manualSessionId, marker);
    assert.deepEqual(pending.targets.map(item => item.origin), mode === 'retained' ? [origin, recovered, other, previousOrigin] : [origin, recovered, other]);
    assert.equal(pending.targets[1].loginRecoveryRequired, true);
    assert.ok(pending.targets.every(item => item.verificationStatus === 'pending_verification'));
    if (mode === 'retained') assert.equal(pending.targets[3].manualSessionId, previousMarker);
  }
});
