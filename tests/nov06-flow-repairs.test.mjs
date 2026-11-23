import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { powershellExecutable } from './helpers/powershell.mjs';
import { bindSuccessEvidence, successEvidence } from '../src/checkin-evidence.mjs';
import { continueRetainedNativeOAuth } from '../src/native-oauth-continuation.mjs';

const exec = promisify(execFile);
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const root = path.resolve(import.meta.dirname, '..');
const origin = 'https://repair.example';
async function powershell(script, cwd = root) {
  const { stdout } = await exec(powershellExecutable, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from("$ErrorActionPreference='Stop'\n" + script, 'utf16le').toString('base64')], { cwd, windowsHide: true, timeout: 30000 });
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}

test('manual request expires after completion, window closure, or session replacement', async () => {
  const now = new Date('2026-11-06T04:00:00Z');
  const completed = bindSuccessEvidence({ origin, status: 'already_signed', evidence: successEvidence('page_text', 'page_completion_text', now) }, { origin }, {}, now);
  const result = await powershell(`
    . ./scripts/ManualInteraction.ps1
    $now=[datetime]'${now.toISOString()}'
    $session=[pscustomobject]@{identity=('a'*32);visible=$true;targets=@([pscustomobject]@{origin='${origin}'})}
    $report=[pscustomobject]@{runId='20261106-120000';results=@([pscustomobject]@{origin='${origin}';status='interactive_challenge'})}
    $ready=Get-ManualInteractionStatus -Report $report -Sessions @($session) -Now $now
    $session.visible=$false
    $closed=Get-ManualInteractionStatus -Report $report -Sessions @($session) -ExpectedRequestId $ready.requestId -Now $now
    $session.visible=$true; $session.identity='b'*32
    $replaced=Get-ManualInteractionStatus -Report $report -Sessions @($session) -ExpectedRequestId $ready.requestId -Now $now
    $session.identity='a'*32
    $report.results=@((${quote(JSON.stringify(completed))}|ConvertFrom-Json))
    $done=Get-ManualInteractionStatus -Report $report -Sessions @($session) -ExpectedRequestId $ready.requestId -Now $now
    $report.results[0].evidence=$null
    $unbound=Get-ManualInteractionStatus -Report $report -Sessions @($session) -Now $now
    @{ready=$ready;closed=$closed;replaced=$replaced;done=$done;unbound=$unbound}|ConvertTo-Json -Depth 8 -Compress
  `);
  assert.equal(result.ready.mayAskUser, true);
  assert.equal(result.ready.targets.length, 1);
  assert.equal(result.closed.state, 'window_unavailable');
  for (const item of [result.closed, result.replaced, result.done]) {
    assert.equal(item.expired, true); assert.equal(item.mayAskUser, false);
  }
  assert.equal(result.done.resolvedTargets.length, 1);
  assert.equal(result.unbound.mayAskUser, true, 'unbound signed text must not retire human work');
});

test('manual prompt combines only visible unresolved accounts, excluding today abandonment', async () => {
  const result = await powershell(`
    . ./scripts/ManualInteraction.ps1
    $sessions=@(
      [pscustomobject]@{identity=('a'*32);visible=$true;targets=@([pscustomobject]@{origin='${origin}';accountKey='linuxdo'})},
      [pscustomobject]@{identity=('b'*32);visible=$true;targets=@([pscustomobject]@{origin='https://other.example'})})
    Get-ManualInteractionStatus -Sessions $sessions -AbandonedOrigins @('https://other.example') | ConvertTo-Json -Depth 5 -Compress
  `);
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].accountKey, 'linuxdo');
  assert.equal(result.resolvedTargets.length, 1);
});

for (const scenario of ['consent', 'pending', 'ambiguous', 'redirect_only', 'unbound_config']) {
  test(`offline Edge retained OAuth continuation: ${scenario}`, { skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 20000 }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    let consentClicks = 0, providerStarts = 0;
    const page = await context.newPage();
    await page.exposeFunction('recordConsent', () => consentClicks++);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin && url.pathname === '/login') providerStarts++;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: url.hostname === 'connect.linux.do'
        ? `<main>授权页面正在加载</main>${scenario === 'pending' ? '' : `<script>setTimeout(()=>{const button=document.createElement('button');button.textContent='允许';button.onclick=()=>{recordConsent();location.href=${JSON.stringify(origin + '/console/token')}};document.body.append(button)},600)</script>`}`
        : scenario === 'redirect_only' ? '<main>回调尚未完成</main>' : '<button id="account-menu">Account</button>' });
    });
    await page.goto('https://connect.linux.do/oauth2/authorize?fixture=1');
    if (scenario === 'ambiguous') await context.newPage().then(other => other.goto(origin + '/profile'));
    const result = await continueRetainedNativeOAuth(context, origin, scenario === 'unbound_config' ? {} : {
      reauthCheckinRules: { [origin]: { accountMenuSelector: '#account-menu' } },
    }, { waitMs: scenario === 'consent' ? 3000 : 1500 });
    assert.equal(result.status, scenario === 'consent' ? 'logged_in' : 'needs_attention');
    assert.equal(consentClicks, ['consent', 'redirect_only'].includes(scenario) ? 1 : 0);
    assert.equal(providerStarts, 0);
    assert.equal(context.pages().length, scenario === 'ambiguous' ? 2 : 1);
    assert.equal(page.isClosed(), false);
  });
}

async function queueFixture(t, exitCode = 2, proof = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'queued-account-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const name of ['scripts', 'tmp', 'config', 'logs', 'data']) await fs.mkdir(path.join(directory, name));
  for (const name of ['AgentRouterVerificationQueue', 'AgentRouterAccount', 'ManualVerification', 'ResultContract', 'CheckinContract.generated',
    'Invoke-PendingAccountVerification', 'Close-ManualLogin', 'ManualAbandonment', 'Complete-AgentRouterLogin']) {
    await fs.copyFile(path.join(root, 'scripts', name + '.ps1'), path.join(directory, 'scripts', name + '.ps1'));
  }
  const accountOrigin = 'https://agentrouter.org';
  const now = new Date();
  const account = bindSuccessEvidence({ origin: accountOrigin, accountKey: 'linuxdo', actionType: 'reauth', status: 'signed',
    evidence: successEvidence('reward_log', 'daily_reward_confirmed', now) },
  { origin: accountOrigin, accountKey: 'linuxdo', actionType: 'reauth' }, {}, now);
  if (!proof) delete account.evidence;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).replaceAll('-', '');
  const report = { runId: day + '-120000', runState: 'final', isComplete: true, results: [
    { origin: accountOrigin, accountResults: [account] }, { origin, status: 'error' },
  ] };
  const profile = path.join(directory, 'data/profile');
  const config = { automationUserDataDir: profile, runMutexName: 'Local\\QueueFixture-' + path.basename(directory),
    agentrouterAccounts: [{ origin: accountOrigin, accountKey: 'linuxdo', provider: 'LinuxDO', automationUserDataDir: profile }] };
  await fs.writeFile(path.join(directory, 'config/config.json'), JSON.stringify(config));
  await fs.writeFile(path.join(directory, 'logs/latest.json'), JSON.stringify(report));
  await fs.writeFile(path.join(directory, 'scripts/Run-Checkin.ps1'), `
param($ReauthAccountKey,[switch]$PostOAuthVerify,$Attempts,[switch]$SuppressReport)
if($ReauthAccountKey -ne 'linuxdo' -or -not $PostOAuthVerify -or $Attempts -ne 1){exit 9}
Add-Content -LiteralPath ${quote(path.join(directory, 'tmp/calls.txt'))} -Value 'verify'
exit ${exitCode}
`);
  await fs.writeFile(path.join(directory, 'scripts/Resolve-Runtime.ps1'), `
function Get-CheckinManualSessionBrowserProcesses { @() }
function Get-CheckinAutomationBrowserProcesses { @() }
function ConvertTo-CheckinUtcDateTime($Value) { [datetime]$Value }
`);
  return { directory, profile, config, day };
}

test('closing the other manual session automatically consumes the selected account queue once', async t => {
  const { directory, profile, config, day } = await queueFixture(t);
  const state = { schemaVersion: 2, mode: 'native', pid: 1, startedAt: new Date().toISOString(), processStartedAt: new Date().toISOString(),
    profile, sourceRunId: day + '-100000', sourceFinishedAt: new Date().toISOString(), targetCount: 1, targets: [{ origin, previousStatus: 'interactive_challenge' }] };
  await fs.writeFile(path.join(directory, 'tmp/manual-session.json'), JSON.stringify(state));
  const result = await powershell(`
    . ./scripts/AgentRouterVerificationQueue.ps1
    $root=${quote(directory)}; $config=${quote(JSON.stringify(config))}|ConvertFrom-Json
    $path=Add-AgentRouterVerificationRequest -Root $root -AccountKey linuxdo
    Invoke-PendingAgentRouterVerification -Root $root -Config $config
    $before=Test-Path -LiteralPath (Join-Path $root 'tmp/calls.txt')
    & ./scripts/Close-ManualLogin.ps1
    Invoke-PendingAgentRouterVerification -Root $root -Config $config
    @{before=$before;request=(Get-Content -Raw -LiteralPath $path|ConvertFrom-Json);calls=@(Get-Content -LiteralPath (Join-Path $root 'tmp/calls.txt'))}|ConvertTo-Json -Depth 4 -Compress
  `, directory);
  assert.equal(result.before, false);
  assert.equal(result.request.state, 'complete');
  assert.deepEqual(result.calls, ['verify']);
  await assert.rejects(fs.access(path.join(directory, 'tmp/manual-session.json')), { code: 'ENOENT' });
});

for (const scenario of ['busy', 'unconfirmed', 'expired']) test(`account verification queue retains safe outcome: ${scenario}`, async t => {
  const { directory, config } = await queueFixture(t, scenario === 'busy' ? 75 : 2, scenario !== 'unconfirmed');
  const result = await powershell(`
    . ./scripts/AgentRouterVerificationQueue.ps1
    $root=${quote(directory)}; $config=${quote(JSON.stringify(config))}|ConvertFrom-Json
    $path=Add-AgentRouterVerificationRequest -Root $root -AccountKey linuxdo ${scenario === 'expired' ? '-Now (Get-Date).AddDays(-1)' : ''}
    Invoke-PendingAgentRouterVerification -Root $root -Config $config
    Get-Content -Raw -LiteralPath $path | ConvertFrom-Json | ConvertTo-Json -Compress
  `, directory);
  assert.equal(result.state, { busy: 'pending', unconfirmed: 'needs_attention', expired: 'expired' }[scenario]);
  if (scenario === 'expired') await assert.rejects(fs.access(path.join(directory, 'tmp/calls.txt')), { code: 'ENOENT' });
});

test('Complete-AgentRouterLogin persists a busy verification for later consumption', async t => {
  const { directory, profile } = await queueFixture(t, 75);
  await fs.writeFile(path.join(directory, 'tmp/agentrouter-manual-state.json'), JSON.stringify({ accountKey: 'linuxdo', stage: 'agentrouter', profile, launchMarker: 'a'.repeat(32) }));
  await fs.writeFile(path.join(directory, 'scripts/Close-AgentRouterLogin.ps1'), `param($AccountKey)
if($AccountKey -ne 'linuxdo'){throw 'wrong account'}
Remove-Item -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'tmp/agentrouter-manual-state.json')
`);
  const result = await exec(powershellExecutable, ['-NoProfile', '-NonInteractive', '-File',
    path.join(directory, 'scripts/Complete-AgentRouterLogin.ps1'), '-AccountKey', 'linuxdo'],
  { cwd: directory, windowsHide: true, timeout: 30000 }).catch(error => error);
  assert.equal(result.code, 75);
  const ticket = JSON.parse(await fs.readFile(path.join(directory, 'tmp/agentrouter-verification-linuxdo.json'), 'utf8'));
  assert.equal(ticket.state, 'pending');
  await assert.rejects(fs.access(path.join(directory, 'tmp/agentrouter-manual-state.json')), { code: 'ENOENT' });
});

for (const visible of [true, false]) test(`native manual launch records the window before reporting readiness: visible=${visible}`, async t => {
  const { directory, day } = await queueFixture(t);
  await fs.mkdir(path.join(directory, 'src'));
  await fs.copyFile(path.join(root, 'scripts/Open-PlainLoginChrome.ps1'), path.join(directory, 'scripts/Open-PlainLoginChrome.ps1'));
  await fs.writeFile(path.join(directory, 'src/prepare-native-browser-profile.mjs'), 'process.exitCode=0;');
  await fs.writeFile(path.join(directory, 'src/manual-precheckin-extension.mjs'), 'console.log(JSON.stringify({enabled:false}));');
  await fs.writeFile(path.join(directory, 'src/attention-urls.mjs'), `console.log(JSON.stringify(${JSON.stringify({
    sourceRunId: day + '-100000', sourceFinishedAt: new Date().toISOString(), targets: [{ origin, url: origin + '/profile', previousStatus: 'interactive_challenge' }],
  })}));`);
  await fs.writeFile(path.join(directory, 'scripts/Resolve-Runtime.ps1'), `
function Resolve-CheckinNode { param($Config) ${quote(process.execPath)} }
function Resolve-CheckinBrowser { param($Config) [pscustomobject]@{Executable='fixture';DisplayName='Fixture Edge'} }
function Get-CheckinAutomationBrowserProcesses { @() }
function Start-Process {param($FilePath,$ArgumentList,[switch]$PassThru)
  ConvertTo-Json -InputObject @($ArgumentList) | Set-Content -LiteralPath ${quote(path.join(directory, 'tmp/launch-args.json'))}
  [pscustomobject]@{Id=$PID;StartTime=Get-Date}
}
function Wait-CheckinVisibleBrowserWindow {param($Config,$ProfilePath,$LaunchMarker)
  if(-not(Test-Path -LiteralPath ${quote(path.join(directory, 'tmp/manual-session.json'))})){throw 'window identity was not persisted'}
  ${visible ? "[pscustomobject]@{ProcessId=$PID;ProcessStartedAt=(Get-Date).ToUniversalTime().ToString('o')}" : '$null'}
}
`);
  const result = await exec(powershellExecutable, ['-NoProfile', '-NonInteractive', '-File',
    path.join(directory, 'scripts/Open-PlainLoginChrome.ps1'), '-NativeMinimal', '-TrackManualSession', '-Origins', origin],
  { cwd: directory, windowsHide: true, timeout: 30000 }).catch(error => error);
  const state = JSON.parse(await fs.readFile(path.join(directory, 'tmp/manual-session.json'), 'utf8'));
  const args = JSON.parse(await fs.readFile(path.join(directory, 'tmp/launch-args.json'), 'utf8'));
  assert.equal(state.windowReady, visible);
  assert.ok(args.includes('--window-position=60,60'));
  assert.ok(!args.some(arg => arg.startsWith('--remote-debugging-port=')));
  if (visible) { assert.equal(result.code, undefined); assert.match(result.stdout, /Fixture Edge/); }
  else { assert.notEqual(result.code, undefined); assert.doesNotMatch(result.stdout, /Fixture Edge/); }
});
