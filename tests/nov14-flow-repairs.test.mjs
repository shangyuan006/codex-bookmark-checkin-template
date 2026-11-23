import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { powershellExecutable } from './helpers/powershell.mjs';
import { continueRetainedNativeOAuth } from '../src/native-oauth-continuation.mjs';
import { waitForOAuthTargetSession } from '../src/oauth-target-completion.mjs';
import { runConfiguredDailyFormCheckin } from '../src/daily-form-checkin.mjs';
import { inspectConfiguredManualCheckinRoute, discoverConfiguredManualCheckinRoute } from '../src/manual-checkin-route.mjs';
import { requiresManualAttention } from '../src/attention-urls.mjs';
import { processTarget } from '../src/browser.mjs';

const exec = promisify(execFile), root = path.resolve(import.meta.dirname, '..');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const origin = 'https://daily.example', marker = 'a'.repeat(32);
const config = { reauthCheckinRules: { [origin]: { accountMenuSelector: '#account' } } };
const page = path => ({ url: () => origin + path, isClosed: () => false });

test('retained OAuth confirms the real target alongside its stale login tab without restarting OAuth', async () => {
  const login = page('/login'), target = page('/console/token'); let confirmations = 0;
  const result = await continueRetainedNativeOAuth({ pages: () => [target, login] }, origin, config, {
    confirmExistingTarget: async (context, selected, active, options) => {
      confirmations++;
      assert.equal(options.acceptPage(target), true); assert.equal(options.acceptPage(login), false);
      assert.equal(options.preferredPage, target);
      return { loggedIn: true, page: target };
    }, continueProvider: () => assert.fail('must not authorize again'),
    confirmTarget: () => assert.fail('must not restart callback waiting'),
  });
  assert.equal(confirmations, 1); assert.equal(result.status, 'logged_in');
  assert.equal(result.oauthStage, 'completed'); assert.equal(result.evidence, undefined);
});

test('an unconfirmed target/login pair cannot become a confirmed session by URL alone', async () => {
  const result = await continueRetainedNativeOAuth({ pages: () => [page('/console'), page('/login')] }, origin, config, {
    confirmExistingTarget: async () => ({ loggedIn: false }),
    continueProvider: () => assert.fail('ambiguous pages must remain untouched'),
  });
  assert.equal(result.status, 'needs_attention'); assert.equal(result.continuationOutcome, 'page_not_unique');
});

test('active consent and multiple target sessions cannot borrow an unrelated authenticated page', async () => {
  const consent = { url: () => 'https://connect.linux.do/oauth2/authorize', isClosed: () => false };
  for (const pages of [[consent, page('/console')], [page('/console'), page('/profile'), page('/login')]]) {
    const result = await continueRetainedNativeOAuth({ pages: () => pages }, origin, config, {
      confirmExistingTarget: () => assert.fail('existing target scope is ambiguous'),
      continueProvider: () => assert.fail('ambiguous pages must remain untouched'),
    });
    assert.equal(result.status, 'needs_attention'); assert.equal(result.continuationOutcome, 'page_not_unique');
  }
});

test('authenticated target control tolerates an incidental provider label but never a password or challenge', async () => {
  for (const blocker of [null, 'passwordVisible', 'challengeVisible']) {
    let clock = 0; const target = page('/console');
    const result = await waitForOAuthTargetSession({ pages: () => [target] }, origin, config, {
      timeoutMs: 600, stableMs: 100, pollMs: 100, now: () => clock, wait: async ms => { clock += ms; },
      readSurface: async () => ({ ready: true, kind: 'authenticated_target', authenticatedControl: true,
        ...(blocker ? { [blocker]: true } : {}) }), hasProviderControl: async () => true,
    });
    assert.equal(result.loggedIn, blocker === null);
  }
});

test('process inventory falls back after bounded CIM cancellation and preserves failures as unknown', { skip: process.platform !== 'win32' }, async () => {
  const command = `
. ${quote(path.join(root, 'scripts/Resolve-Runtime.ps1'))}
$script:cim=0;$script:wmi=0
function Start-Sleep { param($Milliseconds) }
function Get-CimInstance { param($ClassName,$Filter,$OperationTimeoutSec,$ErrorAction)
  if($Filter -ne 'ProcessId=123' -or $OperationTimeoutSec -ne 5){throw 'wrong query'}
  $script:cim++;throw 'cancelled'
}
function Get-CheckinWmiProcesses { param($Filter) $script:wmi++;[pscustomobject]@{ProcessId=123;Name='fixture.exe'} }
$rows=@(Get-CheckinCimProcesses -Filter 'ProcessId=123')
if($rows.Count -ne 1 -or $rows[0].ProcessId -ne 123 -or $script:cim -ne 4 -or $script:wmi -ne 1){throw 'fallback failed'}
function Get-CheckinWmiProcesses { param($Filter) throw 'PRIVATE ERROR' }
function Get-CheckinDirectProcesses { param($Filter) throw 'PRIVATE DIRECT ERROR' }
try{Get-CheckinCimProcesses -Filter 'ProcessId=123';throw 'unexpected empty inventory'}catch{
  if($_.FullyQualifiedErrorId -notlike 'CheckinProcessQueryFailed*'){throw}
  if($_.Exception.Message -match 'PRIVATE'){throw 'raw error leaked'}
}
function Get-CimInstance { param($ClassName,$Filter,$OperationTimeoutSec,$ErrorAction) @() }
if(@(Get-CheckinCimProcesses -Filter 'ProcessId=123').Count -ne 0){throw 'successful empty query changed'}
'ok'`;
  const result = await exec(powershellExecutable, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
  assert.equal(result.stdout.trim(), 'ok');
});

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nov14-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  for (const name of ['scripts', 'src', 'config', 'tmp', 'data/profile']) await fs.mkdir(path.join(dir, name), { recursive: true });
  return dir;
}

for (const outcome of ['confirmed', 'pending', 'promotion_interrupted', 'wrong_port', 'wrong_start']) test(`orphan native recovery ${outcome} keeps the original browser identity`, { skip: process.platform !== 'win32' }, async t => {
  const dir = await fixture(t), profile = path.join(dir, 'data/profile');
  for (const file of ['Resume-AgentRouterNativeWindow.ps1', 'AgentRouterAccount.ps1']) {
    await fs.copyFile(path.join(root, 'scripts', file), path.join(dir, 'scripts', file));
  }
  await fs.writeFile(path.join(dir, 'config/config.json'), JSON.stringify({ agentrouterAccounts: [{
    origin: 'https://agentrouter.org', accountKey: 'linuxdo', provider: 'LinuxDO', automationUserDataDir: profile,
  }] }));
  await fs.writeFile(path.join(dir, 'tmp/agentrouter-native-state.json'), JSON.stringify({ schemaVersion: 1,
    stage: 'automatic_native', accountKey: 'linuxdo', profile, pid: 123, launchMarker: marker,
    processStartedAt: '2026-01-01T00:00:00Z', nativeDebugPort: 23456 }));
  await fs.writeFile(path.join(dir, 'scripts/Resolve-Runtime.ps1'), `
function Resolve-CheckinNode { param($Config) ${quote(process.execPath)} }
function Get-CheckinManualSessionBrowserProcesses { param($Config,$ProfilePath,$State)
  [pscustomobject]@{ProcessId=123;CommandLine='--checkin-launch=${marker} --remote-debugging-port=${outcome === 'wrong_port' ? 34567 : 23456}'}
}
function Get-Process { param($Id,$ErrorAction) [pscustomobject]@{Id=123} }
function Test-CheckinProcessStartIdentity { param($Process,$RecordedStart) $${outcome === 'wrong_start' ? 'false' : 'true'} }
function Wait-CheckinVisibleBrowserWindow { param($Config,$ProfilePath,$LaunchMarker)
  ${outcome === 'promotion_interrupted' ? "throw 'visibility unknown'" : '[pscustomobject]@{ProcessId=123}'}
}
function Start-Process { param($FilePath,$ArgumentList,$WindowStyle)
  if(($ArgumentList -join ' ') -notmatch 'Watch-AgentRouterLogin.ps1'){throw 'must not launch another browser'}
  if($WindowStyle -ne 'Hidden'){throw 'observer must be hidden'}
}
`);
  await fs.writeFile(path.join(dir, 'src/native-oauth-continuation.mjs'), `
import fs from 'node:fs';
const state=JSON.parse(fs.readFileSync('tmp/agentrouter-manual-state.json','utf8'));
if(state.pid!==123||state.launchMarker!=='${marker}'||state.nativeDebugPort!==23456||state.stage!=='agentrouter')throw Error('wrong session');
fs.appendFileSync('tmp/inspected.txt',process.argv.includes('--show-window')?'show\\n':'inspect\\n');
console.log(JSON.stringify(${outcome === 'confirmed'}?{status:'logged_in',oauthStage:'completed'}:{status:'needs_attention'}));
`);
  await fs.writeFile(path.join(dir, 'scripts/Complete-AgentRouterLogin.ps1'), `param($AccountKey,$ExpectedLaunchMarker)
if($AccountKey -ne 'linuxdo' -or $ExpectedLaunchMarker -cne '${marker}'){throw 'wrong completion'}
Set-Content -LiteralPath (Join-Path $PSScriptRoot '../tmp/verified.txt') -Value 'verified'
Remove-Item -LiteralPath (Join-Path $PSScriptRoot '../tmp/agentrouter-manual-state.json')
exit 0
`);
  const run = exec(powershellExecutable, ['-NoProfile','-NonInteractive','-File',path.join(dir,'scripts/Resume-AgentRouterNativeWindow.ps1'),'-AccountKey','linuxdo'], { cwd: dir, windowsHide: true });
  if (outcome === 'promotion_interrupted') {
    await assert.rejects(run);
    await fs.access(path.join(dir, 'tmp/agentrouter-native-state.json'));
    const tracked = JSON.parse(await fs.readFile(path.join(dir, 'tmp/agentrouter-manual-state.json')));
    assert.equal(tracked.launchMarker, marker); assert.equal(tracked.nativeContinuationReady, undefined);
  } else if (outcome.startsWith('wrong')) {
    await assert.rejects(run);
    await fs.access(path.join(dir, 'tmp/agentrouter-native-state.json'));
    await assert.rejects(fs.access(path.join(dir, 'tmp/agentrouter-manual-state.json')));
    await assert.rejects(fs.access(path.join(dir, 'tmp/inspected.txt')));
  } else {
    await run;
    const calls = await fs.readFile(path.join(dir, 'tmp/inspected.txt'), 'utf8');
    assert.equal(calls, outcome === 'confirmed' ? 'inspect\n' : 'inspect\nshow\n');
    await assert.rejects(fs.access(path.join(dir, 'tmp/agentrouter-native-state.json')));
    if (outcome === 'pending') {
      const state = JSON.parse(await fs.readFile(path.join(dir, 'tmp/agentrouter-manual-state.json')));
      assert.equal(state.nativeContinuationReady, true); assert.equal(state.launchMarker, marker);
    } else await fs.access(path.join(dir, 'tmp/verified.txt'));
  }
});

for (const mode of ['closed', 'inventory_failed', 'launch_failed']) test(`automatic native window registration survives ${mode}`, { skip: process.platform !== 'win32' }, async t => {
  const dir = await fixture(t);
  for (const file of ['Invoke-AgentRouterNativeRecovery.ps1', 'AgentRouterAccount.ps1']) {
    await fs.copyFile(path.join(root, 'scripts', file), path.join(dir, 'scripts', file));
  }
  await fs.writeFile(path.join(dir, 'config/config.json'), JSON.stringify({ agentrouterAccounts: [{
    origin: 'https://agentrouter.org', accountKey: 'linuxdo', provider: 'LinuxDO',
    linuxDoSessionStrategy: 'target_oauth', automationUserDataDir: 'data/profile',
  }] }));
  await fs.writeFile(path.join(dir, 'scripts/Resolve-Runtime.ps1'), `
function Resolve-CheckinNode {param($Config) ${quote(process.execPath)}}
function Resolve-CheckinBrowser {param($Config) @{Executable='fixture'}}
function Get-CheckinProfileBrowserProcesses {param($Config,$ProfilePath)
  if($global:owned){[pscustomobject]@{ProcessId=123}}
}
function Start-Process {param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru)
  ${mode === 'launch_failed' ? "throw 'launch failed'" : "$global:owned=$true; [pscustomobject]@{Id=123;StartTime=[datetime]'2026-01-01T00:00:00Z'}"}
}
function Get-CheckinManualSessionBrowserProcesses {param($Config,$ProfilePath,$State)
  ${mode === 'inventory_failed' ? "throw 'inventory unknown'" : '[pscustomobject]@{ProcessId=123}'}
}
function Get-Process {param($Id,$ErrorAction)
  $p=[pscustomobject]@{Id=123};$p|Add-Member -MemberType ScriptMethod -Name CloseMainWindow -Value {$global:owned=$false;return $true};$p
}
`);
  await fs.writeFile(path.join(dir, 'src/prepare-native-browser-profile.mjs'), '');
  await fs.writeFile(path.join(dir, 'src/probe-agentrouter-session.mjs'), 'console.log(JSON.stringify({action:"resume",nativeAllowed:true}));');
  await fs.writeFile(path.join(dir, 'src/oauth-login.mjs'), `
import fs from 'node:fs';
const s=JSON.parse(fs.readFileSync('tmp/agentrouter-native-state.json','utf8'));
if(s.stage!=='automatic_native'||s.pid!==123||!s.processStartedAt||!s.nativeDebugPort||!/^[a-f0-9]{32}$/.test(s.launchMarker))throw Error('registration missing');
console.log(JSON.stringify({status:'logged_in',oauthStage:'completed'}));`);
  const run = exec(powershellExecutable, ['-NoProfile','-NonInteractive','-File','scripts/Invoke-AgentRouterNativeRecovery.ps1','-AccountKey','linuxdo'], { cwd: dir, windowsHide: true });
  if (mode === 'closed') { assert.equal(JSON.parse((await run).stdout).status, 'logged_in'); }
  else await assert.rejects(run);
  if (mode === 'inventory_failed') {
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'tmp/agentrouter-native-state.json')));
    assert.equal(saved.pid, 123); assert.equal(saved.stage, 'automatic_native');
  } else await assert.rejects(fs.access(path.join(dir, 'tmp/agentrouter-native-state.json')));
});

for (const mode of ['delayed_completion', 'wrong_port', 'inventory_failed']) test(`native observer ${mode} rechecks ownership before controlling the retained page`, { skip: process.platform !== 'win32' }, async t => {
  const dir = await fixture(t), stateFile = path.join(dir, 'tmp/agentrouter-manual-state.json');
  await fs.copyFile(path.join(root, 'scripts/Watch-AgentRouterLogin.ps1'), path.join(dir, 'scripts/Watch-AgentRouterLogin.ps1'));
  await fs.writeFile(path.join(dir, 'config/config.json'), '{}');
  await fs.writeFile(stateFile, JSON.stringify({ accountKey: 'linuxdo', launchMarker: marker, stage: 'agentrouter',
    profile: path.join(dir, 'data/profile'), pid: 123, nativeDebugPort: 23456, nativeContinuationReady: true }));
  await fs.writeFile(path.join(dir, 'scripts/Resolve-Runtime.ps1'), `
function Resolve-CheckinNode {param($Config) ${quote(process.execPath)}}
$script:time=[datetime]'2026-01-01T00:00:00Z'
function Get-Date {$script:time=$script:time.AddSeconds(1);$script:time}
function Start-Sleep {param($Seconds)}
function Get-CheckinManualSessionBrowserProcesses {param($Config,$ProfilePath,$State)
  ${mode === 'inventory_failed' ? "throw 'inventory unknown'" : `[pscustomobject]@{ProcessId=123;CommandLine='--remote-debugging-port=${mode === 'wrong_port' ? 34567 : 23456}'}`}
}
`);
  await fs.writeFile(path.join(dir, 'src/native-oauth-continuation.mjs'), `
import fs from 'node:fs';const file='tmp/agentrouter-manual-state.json';const s=JSON.parse(fs.readFileSync(file,'utf8'));
fs.appendFileSync('tmp/observed','inspect\\n');
s.oauthCompletion={status:'logged_in',oauthStage:'completed',launchMarker:s.launchMarker};fs.writeFileSync(file,JSON.stringify(s));`);
  await fs.writeFile(path.join(dir, 'scripts/Complete-AgentRouterLogin.ps1'), `param($AccountKey,$ExpectedLaunchMarker)
if($AccountKey -ne 'linuxdo' -or $ExpectedLaunchMarker -cne '${marker}'){throw 'wrong completion'}
Remove-Item -LiteralPath (Join-Path $PSScriptRoot '../tmp/agentrouter-manual-state.json')
[IO.File]::WriteAllText((Join-Path $PSScriptRoot '../tmp/verified'), 'true')
`);
  await exec(powershellExecutable, ['-NoProfile','-NonInteractive','-File','scripts/Watch-AgentRouterLogin.ps1',
    '-AccountKey','linuxdo','-SessionMarker',marker,'-TimeoutSeconds','60'], { cwd: dir, windowsHide: true });
  if (mode === 'delayed_completion') {
    assert.equal(await fs.readFile(path.join(dir, 'tmp/observed'), 'utf8'), 'inspect\n');
    await fs.access(path.join(dir, 'tmp/verified'));
    await assert.rejects(fs.access(stateFile));
  } else {
    await fs.access(stateFile);
    await assert.rejects(fs.access(path.join(dir, 'tmp/observed')));
    await assert.rejects(fs.access(path.join(dir, 'tmp/verified')));
  }
});

const browserOptions = { skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 30000 };
test('retained alternate home follows the visible entry, preserves the verification document and submits once', browserOptions, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); let forms = 0, submissions = 0, navigations = 0;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST') { submissions++; return route.fulfill({ body: '{}' }); }
    navigations++; if (url.pathname === '/daily.php') forms++;
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<a href="/logout">退出</a>' + (url.pathname === '/daily.php'
      ? `<form><input type="hidden" name="daily" value="fixture"><input type="hidden" name="cf-turnstile-response" value="fixture-verified"><button>提交签到</button></form>
        <script>document.querySelector('form').onsubmit=e=>{e.preventDefault();fetch('/daily.php',{method:'POST'}).then(()=>{document.querySelector('form').remove();document.body.append('连续签到 2 天，获得 10 魔力')})}</script>`
      : '<a href="/daily.php">做种会员签到处</a>') });
  });
  await page.goto(origin + '/catalogue.php');
  const config = { navigationTimeoutMs: 3000, checkinStateWaitMs: 1000, preCheckinNavigationRules: { [origin]: {
    expectedPath: '/daily.php', steps: [{ role: 'link', name: '做种会员签到处' }],
    terminalRequireAuthenticatedPage: true, terminalMissingControlPaths: ['/', '/catalogue.php'],
    completedTextPattern: '连续签到\\s*\\d+\\s*天，获得\\s*\\d+\\s*魔力',
    dailyUnsignedForm: { visibleSelectors: ['form button'], nonEmptyValueSelectors: ['[name=daily]'],
      emptyValueSelectors: ['[name=cf-turnstile-response]'], actionText: '提交签到', pendingChallenge: 'turnstile' },
  } } };
  const result = await runConfiguredDailyFormCheckin(page, { origin }, config, { retainedOnly: true, waitMs: 1000 });
  assert.equal(result.status, 'signed'); assert.equal(forms, 1); assert.equal(submissions, 1); assert.equal(navigations, 2);
});

test('explicit mini-program entry becomes actionable manual work without clicking or collecting the QR', browserOptions, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); let clicks = 0;
  await page.exposeFunction('clicked', () => clicks++);
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
    '<button onclick="clicked()">去小程序签到</button><img alt="QR" src="data:image/png;base64,PRIVATE">' }));
  const config = { navigationTimeoutMs: 2000, manualCheckinRouteRules: { [origin]: {
    kind: 'wechat_mini_program', pagePath: '/profile', controlTexts: ['去小程序签到'],
  } } };
  await page.goto(origin + '/wallet');
  assert.equal(await inspectConfiguredManualCheckinRoute(page, { origin }, config), null);
  const result = await discoverConfiguredManualCheckinRoute(page, { origin }, config);
  assert.equal(new URL(page.url()).pathname, '/profile'); assert.equal(result.status, 'needs_attention');
  assert.equal(result.failureCode, 'external_checkin_required'); assert.equal(requiresManualAttention(result), true);
  assert.equal(clicks, 0); assert.equal(result.evidence, undefined); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|data:|base64/);
  await page.setContent('<button>去小程序签到</button><button>立即签到</button>');
  assert.equal(await inspectConfiguredManualCheckinRoute(page, { origin }, config), null);
  await page.setContent('<input type=password><button>去小程序签到</button>');
  assert.equal(await inspectConfiguredManualCheckinRoute(page, { origin }, config), null);
});

test('generic discovery and observation recognize the mini-program route without clicking it', browserOptions, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const context = await browser.newContext(); let clicks = 0;
  await context.exposeFunction('clicked', () => clicks++);
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
    '<a href="/logout">退出登录</a><p>' + '这是首页内容。'.repeat(40) + '</p>' + (new URL(route.request().url()).pathname === '/profile'
      ? '<button onclick="clicked()">去小程序签到</button>' : '<a href="/profile">个人中心</a>') }));
  const base = { navigationTimeoutMs: 2000, retryCount: 0, checkinStateWaitMs: 100,
    actionWaitMs: 0, checkinActionDiscoveryWaitMs: 0, extendedDiscoveryWaitMs: 0,
    extendedDiscoveryOrigins: [origin], manualCheckinRouteRules: { [origin]: {
      kind: 'wechat_mini_program', pagePath: '/profile', controlTexts: ['去小程序签到'],
    } } };
  for (const observation of [false, true]) {
    const result = await processTarget(context, { origin, candidates: [origin + (observation ? '/profile' : '/home')] },
      { ...base, ...(observation ? { checkinReadOnly: true, checkinObservationOnly: true } : {}) }, {}, '');
    assert.equal(result.failureCode, 'external_checkin_required', JSON.stringify(result));
    assert.equal(result.status, 'needs_attention'); assert.equal(clicks, 0);
  }
});
