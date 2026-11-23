import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { nativeSubmissionHandoff } from '../src/native-checkin-recovery.mjs';
import { freshNativePreflightHandoffs } from '../src/native-preflight-state.mjs';
import { updateOAuthRetryBudget, inspectOAuthRetryBudget } from '../src/oauth-retry-budget.mjs';
import { assertOAuthHandoffIdentity } from '../src/oauth-handoff-identity.mjs';
import { continueRetainedNativeOAuth } from '../src/native-oauth-continuation.mjs';
import { clickConfiguredSequentialAction, getConfiguredSequentialActionRule, processCandidate, tryConfiguredSequentialActions } from '../src/browser.mjs';
import { runWithSubmissionJournal, readSubmissionJournal } from '../src/submission-guard.mjs';

const exec = promisify(execFile), origin = 'https://daily.example';
const target = { origin, candidates: [origin + '/profile'], allowedOrigins: [origin] };
const browserOnly = { skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 30_000 };
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nov10-repair-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function offlinePage(t) {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  return browser.newPage();
}

test('native verification and uncertain submission blockers survive only their matching preflight attempt', () => {
  const now = new Date(), attempt = 'a'.repeat(32);
  for (const input of [{ status: 'interactive_challenge', actionAttempted: true },
    { status: 'ready', actionAttempted: true },
    { status: 'ready', verificationRecoveryDiagnostics: { outcome: 'rejected_intent_released' } }]) {
    const normalized = nativeSubmissionHandoff(input);
    const report = { generatedAt: now.toISOString(), results: [{ ...normalized, origin, preflightAttemptId: attempt }] };
    assert.equal(normalized.retryable, false);
    assert.equal(normalized.manualBrowserMode, 'native');
    assert.equal(freshNativePreflightHandoffs(report, new Set([origin]), attempt, now).size, 1);
    assert.equal(freshNativePreflightHandoffs(report, new Set([origin]), 'b'.repeat(32), now).size, 0);
  }
  assert.deepEqual(nativeSubmissionHandoff({ status: 'signed', actionAttempted: true }), { status: 'signed', actionAttempted: true });
  assert.deepEqual(nativeSubmissionHandoff({ status: 'ready', actionAttempted: false }), { status: 'ready', actionAttempted: false });
});

test('one visible handoff remains after automatic and native budgets are exhausted, without resetting either', async t => {
  const dir = await temporary(t), binding = { file: path.join(dir, 'budget.json'), key: 'fixture', cycle: 'logout', limit: 1 };
  await updateOAuthRetryBudget(binding, 'automatic');
  await updateOAuthRetryBudget(binding, 'automatic', { authorizationOutcome: 'provider_challenge_unresolved' });
  await updateOAuthRetryBudget(binding, 'native');
  assert.deepEqual(await inspectOAuthRetryBudget(binding), { automaticAllowed: false, nativeAllowed: false });
  assert.equal((await updateOAuthRetryBudget(binding, 'handoff')).allowed, true);
  assert.equal((await updateOAuthRetryBudget(binding, 'handoff')).allowed, false);
  assert.deepEqual(await inspectOAuthRetryBudget(binding), { automaticAllowed: false, nativeAllowed: false });
  assert.equal((await updateOAuthRetryBudget({ ...binding, cycle: 'next-logout' }, 'handoff')).allowed, true);
});

test('visible handoff requires matching tracked account, profile, port, stage and launch identity', () => {
  const root = process.cwd(), profile = path.join(root, 'data/fixture-profile');
  const state = { stage: 'agentrouter', accountKey: 'linuxdo', profile, nativeDebugPort: 23456,
    pid: 123, processStartedAt: new Date().toISOString(), launchMarker: 'a'.repeat(32) };
  const scope = { root, profile, port: 23456, accountKey: 'linuxdo', provider: 'LinuxDO', native: true, stage: 'manual_target_oauth' };
  assert.doesNotThrow(() => assertOAuthHandoffIdentity(state, scope));
  for (const mismatch of [{ accountKey: 'other' }, { profile: path.join(root, 'data/other') }, { port: 23457 },
    { native: false }, { provider: 'GitHub' }, { stage: 'automatic_target' }]) {
    assert.throws(() => assertOAuthHandoffIdentity(state, { ...scope, ...mismatch }));
  }
  for (const mismatch of [{ launchMarker: '' }, { processStartedAt: '' }, { pid: 0 }, { stage: 'provider' }]) {
    assert.throws(() => assertOAuthHandoffIdentity({ ...state, ...mismatch }, scope));
  }
});

test('process query retries cancellation, uses exact profile/PID identity, and does not hide persistent failure', async t => {
  const dir = await temporary(t), driver = path.join(dir, 'processes.ps1');
  await fs.writeFile(driver, String.raw`param($Runtime)
$ErrorActionPreference='Stop'
. $Runtime
function Get-CheckinWmiProcesses { param($Filter) throw 'Fixture WMI query failed' }
function Get-CheckinDirectProcesses { param($Filter) throw 'Fixture direct query failed' }
function Start-Sleep { param($Milliseconds) }
$script:calls=0; $script:mode='transient'; $script:filters=@()
$profile=Join-Path $PSScriptRoot 'project profile'
$marker='a'*32
$start=[datetime]::UtcNow
$quoted=Test-CheckinBrowserProfileArgument ('msedge.exe "--user-data-dir='+$profile+'" --new-window') $profile
$substring=Test-CheckinBrowserProfileArgument ('msedge.exe --user-data-dir="'+$profile+'-other"') $profile
function Get-CimInstance { param($ClassName,$Filter,$ErrorAction)
  $script:calls++; $script:filters+= $Filter
  if($script:mode -eq 'persistent' -or ($script:mode -eq 'transient' -and $script:calls -eq 1) -or ($script:mode -eq 'pid' -and $Filter -like 'Name=*')) { throw '调用已取消' }
  if($script:mode -eq 'absent') { return @() }
  [pscustomobject]@{Name='msedge.exe';ProcessId=123;CommandLine='msedge.exe --user-data-dir="'+$profile+'" --checkin-launch='+$marker}
}
function Get-Process { param($Id,$ErrorAction) [pscustomobject]@{Id=$Id;StartTime=$start} }
$config=[pscustomobject]@{browser='edge'}
$state=[pscustomobject]@{pid=123;processStartedAt=$start.ToString('o');launchMarker=$marker}
$retryCount=@(Get-CheckinProfileBrowserProcesses $config $profile).Count
$transientCalls=$script:calls
$script:mode='persistent'; $failed=$false
try { Get-CheckinProfileBrowserProcesses $config $profile | Out-Null } catch { $failed=$true }
$script:mode='pid'
$fallback=@(Get-CheckinManualSessionBrowserProcesses $config $state $profile).Count
$state.processStartedAt=$start.AddMinutes(-1).ToString('o')
$reused=@(Get-CheckinManualSessionBrowserProcesses $config $state $profile).Count
$state.processStartedAt=$start.ToString('o');$state.launchMarker='b'*32
$wrongMarker=@(Get-CheckinManualSessionBrowserProcesses $config $state $profile).Count
$state.launchMarker=$marker
$wrongProfile=@(Get-CheckinManualSessionBrowserProcesses $config $state ($profile+'-other')).Count
$script:mode='absent'
$absent=@(Get-CheckinProfileBrowserProcesses $config $profile).Count
[ordered]@{retryCount=$retryCount;transientCalls=$transientCalls;persistentFailed=$failed;fallback=$fallback;reused=$reused;wrongMarker=$wrongMarker;wrongProfile=$wrongProfile;absent=$absent;filters=$script:filters;quoted=$quoted;substring=$substring}|ConvertTo-Json -Compress
`);
  const { stdout } = await exec('pwsh', ['-NoProfile', '-NonInteractive', '-File', driver,
    '-Runtime', path.resolve('scripts/Resolve-Runtime.ps1')], { windowsHide: true, timeout: 20_000 });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.retryCount, 1); assert.equal(result.transientCalls, 2); assert.equal(result.persistentFailed, true);
  assert.equal(result.fallback, 1); assert.equal(result.reused, 0); assert.equal(result.wrongMarker, 0);
  assert.equal(result.wrongProfile, 0); assert.equal(result.absent, 0);
  assert.equal(result.quoted, true); assert.equal(result.substring, false);
  assert.ok(result.filters.every(filter => filter === "Name='msedge.exe'" || filter === 'ProcessId=123'));
});

for (const scenario of ['late_button', 'late_completion', 'ambiguous']) test(`offline sequential readiness: ${scenario}`, browserOnly, async t => {
  const page = await offlinePage(t); let clicks = 0, reservations = 0;
  await page.exposeFunction('recordClick', () => clicks++);
  await page.route(origin + '/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
    body: `<main>个人资料</main><script>setTimeout(()=>{document.body.innerHTML+=${JSON.stringify(scenario === 'late_completion'
      ? '<p>今日已签到</p>' : '<button onclick="recordClick()">立即签到</button>'.repeat(scenario === 'ambiguous' ? 2 : 1))}},450)</script>` }));
  await page.goto(origin + '/profile');
  const step = getConfiguredSequentialActionRule(target, { sequentialActionRules: { [origin]: { steps: [{
    url: origin + '/profile', actionTexts: ['立即签到'], actionTags: ['BUTTON'], completedTexts: ['今日已签到'], waitMs: 1500,
  }] } } }).steps[0];
  const result = await clickConfiguredSequentialAction(page, step, [origin], async () => reservations++);
  assert.equal(clicks, scenario === 'late_button' ? 1 : 0);
  assert.equal(reservations, clicks);
  if (scenario === 'late_completion') assert.equal(result.completion.status, 'already_signed');
  if (scenario === 'ambiguous') assert.equal(result.outcome, 'action_not_unique');
});

test('offline consent popup is continued with its stale login opener still open', browserOnly, async t => {
  const page = await offlinePage(t), context = page.context(); let clicks = 0;
  await context.exposeFunction('consentClicked', () => clicks++);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: url.hostname === 'connect.linux.do'
      ? `<a href="${origin}/console" onclick="consentClicked()">允许</a>` : url.pathname === '/login'
        ? '<button onclick="window.open(\'https://connect.linux.do/oauth2/authorize\')">使用 LinuxDO 继续</button>'
        : '<button id="account-menu">Account</button>' });
  });
  await page.goto(origin + '/login');
  const popupEvent = page.waitForEvent('popup'); await page.getByRole('button').click();
  const popup = await popupEvent; await popup.waitForLoadState();
  const result = await continueRetainedNativeOAuth(context, origin, { reauthCheckinRules: { [origin]: { accountMenuSelector: '#account-menu' } } });
  assert.equal(result.status, 'logged_in'); assert.equal(clicks, 1);
  assert.equal(page.url(), origin + '/login'); assert.equal(context.pages().length, 2);
});

for (const completed of [true, false]) test(`offline sequential runner handles late frontend state (completed=${completed})`, browserOnly, async t => {
  const page = await offlinePage(t); let clicks = 0;
  await page.exposeFunction('recordClick', () => clicks++);
  await page.route(origin + '/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
    `<main>个人资料</main><script>setTimeout(()=>{document.body.innerHTML+=${JSON.stringify(completed ? '<p>今日已签到</p>'
      : '<button onclick="recordClick();this.textContent=\'今日已签到\'">立即签到</button>')}},1200)</script>` }));
  const result = await tryConfiguredSequentialActions(page, target, { navigationTimeoutMs: 3000,
    sequentialActionRules: { [origin]: { steps: [{ url: origin + '/profile', actionTexts: ['立即签到'],
      actionTags: ['BUTTON'], completedTexts: ['今日已签到'], waitMs: 2000 }] } } });
  assert.equal(result.status, completed ? 'already_signed' : 'signed');
  assert.equal(clicks, completed ? 0 : 1);
  assert.equal(result.actionResults.length, 1);
});

for (const rejected of [true, false]) test(`offline generic submission retains network evidence (explicitRejection=${rejected})`, browserOnly, async t => {
  const dir = await temporary(t), page = await offlinePage(t); let posts = 0;
  const rule = { refreshPath: '/refresh', selfPath: '/self', checkinPath: '/checkin', rejectionMessageIncludes: 'Turnstile required' };
  await page.route(origin + '/**', route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (pathname === '/refresh') return route.fulfill({ json: { success: true, data: { access_token: '<fixture-token>', user: { id: 1 } } } });
    if (pathname === '/self') return route.fulfill({ json: { success: true, data: { id: 1 } } });
    if (pathname === '/checkin') {
      if (request.method() === 'POST') { posts++; return route.fulfill({ json: rejected
        ? { success: false, message: 'Turnstile required' } : { success: true } }); }
      return route.fulfill({ json: { success: true, data: { checked_in_today: false } } });
    }
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<button onclick="fetch(\'/checkin\',{method:\'POST\'})">立即签到</button>' });
  });
  // Let the security route fall through to the offline fixture, never network.
  const proxy = new Proxy(page, { get(object, key) {
    if (key === 'route') return (match, handler) => page.route(match, route => handler({
      request: () => route.request(), abort: code => route.abort(code), continue: () => route.fallback() }));
    const value = Reflect.get(object, key); return typeof value === 'function' ? value.bind(object) : value;
  } });
  const file = path.join(dir, 'journal.json'), config = { submissionJournalPath: file,
    navigationTimeoutMs: 3000, actionWaitMs: 50, checkinStateWaitMs: 50, checkinStatePollMs: 20,
    nativeChallengePreflight: [{ url: origin + '/profile', action: { verificationRecovery: rule } }] };
  const result = await runWithSubmissionJournal(file, target, config, active => processCandidate(proxy, target, origin + '/profile', active, []));
  assert.equal(posts, 1); assert.equal(result.retryable, false);
  assert.equal(result.verificationRecoveryDiagnostics.requestCount, 1);
  assert.equal(result.verificationRecoveryDiagnostics.outcome, rejected ? 'rejected_intent_released' : 'protected');
  const journal = await readSubmissionJournal(file);
  assert.equal(journal.entries[0].state, rejected ? 'rejected' : 'uncertain');
  assert.doesNotMatch(JSON.stringify(journal), /access_token|Turnstile required/);
});
