import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { powershellExecutable } from './helpers/powershell.mjs';
import { continueControlledManualSession } from '../src/manual-native-continuation.mjs';
import { recordManualSessionClosure } from '../src/manual-session-lifecycle.mjs';
import { bindSuccessEvidence, successEvidence } from '../src/checkin-evidence.mjs';
import { localRunDate } from '../src/retry-policy.mjs';
import { continueNativeSamePage } from '../src/same-page-sequential.mjs';
import { clickVisibleNativeChallengeControl } from '../src/native-checkin-action.mjs';
import { createSubmissionScope } from '../src/submission-guard.mjs';
import { freshNativePreflightHandoffs } from '../src/native-preflight-state.mjs';

const exec = promisify(execFile), root = path.resolve(import.meta.dirname, '..');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const origin = 'https://attendance.example', other = 'https://retained.example';
const marker = 'a'.repeat(32);
const ps = command => exec(powershellExecutable, ['-NoProfile', '-NonInteractive', '-Command', command],
  { windowsHide: true, timeout: 30000 });
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nov15-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  for (const name of ['tmp', 'config', 'scripts', 'src']) await fs.mkdir(path.join(dir, name));
  return dir;
}

test('direct object fallback preserves full inventory and existing profile/marker/start identity checks', { skip: process.platform !== 'win32' }, async () => {
  const result = await ps(`
. ${quote(path.join(root, 'scripts/Resolve-Runtime.ps1'))}
$script:cim=0;$script:wmi=0;$script:lookups=0;$script:snapshots=0
$script:start=[datetime]::UtcNow
function Start-Sleep {param($Milliseconds)}
function Get-CimInstance {param($ClassName,$Filter,$OperationTimeoutSec,$ErrorAction) $script:cim++;throw 'cancelled'}
function Get-CheckinWmiProcesses {param($Filter) $script:wmi++;throw 'cancelled'}
function Get-CheckinLocalProcessSnapshot {param($ProcessName,$ProcessId)
  $script:snapshots++
  if($ProcessName -ne 'msedge.exe'){throw 'name filter lost'}
  foreach($number in @(11,12)){[pscustomobject]@{ProcessId=$number;Name='msedge.exe';StartedAt=$script:start}}
}
function Get-CheckinDirectProcessObject {param($ProcessId)
  $script:lookups++
  [pscustomobject]@{ProcessId=$ProcessId;Name='msedge.exe';StartedAt=$script:start
    CommandLine=('--user-data-dir=C:\\fixture\\'+$(if($ProcessId -eq 11){'project'}else{'other'})+' --checkin-launch=${marker}')}
}
$rows=@(Get-CheckinCimProcesses -Filter "Name='msedge.exe'")
if($rows.Count -ne 2 -or $script:cim -ne 4 -or $script:wmi -ne 1 -or $script:lookups -ne 2 -or $script:snapshots -ne 2){throw 'inventory incomplete'}
$config=[pscustomobject]@{browser='edge';browserProcessName='msedge.exe'}
function Get-Process {param($Id,$ErrorAction) [pscustomobject]@{StartTime=$script:start}}
$state=[pscustomobject]@{pid=11;launchMarker='${marker}';processStartedAt=$script:start.ToString('o')}
$selected=@(Get-CheckinManualSessionBrowserProcesses -Config $config -State $state -ProfilePath 'C:\\fixture\\project')
if($selected.Count -ne 1 -or $selected[0].ProcessId -ne 11){throw 'profile identity lost'}
$state.launchMarker='${'b'.repeat(32)}'
if(@(Get-CheckinManualSessionBrowserProcesses -Config $config -State $state -ProfilePath 'C:\\fixture\\project').Count -ne 0){throw 'wrong marker accepted'}
$state.launchMarker='${marker}';$state.processStartedAt=$script:start.AddMinutes(-5).ToString('o')
if(@(Get-CheckinManualSessionBrowserProcesses -Config $config -State $state -ProfilePath 'C:\\fixture\\project').Count -ne 0){throw 'reused PID accepted'}
'ok'`);
  assert.equal(result.stdout.trim(), 'ok');
});

for (const scenario of ['new_process', 'pid_reuse', 'missing_command', 'lookup_denied', 'wrong_name', 'wrong_creation']) {
  test(`incomplete direct inventory remains unknown: ${scenario}`, { skip: process.platform !== 'win32' }, async () => {
    const result = await ps(`
. ${quote(path.join(root, 'scripts/Resolve-Runtime.ps1'))}
$script:snapshots=0;$script:start=[datetime]::UtcNow
function Start-Sleep {param($Milliseconds)}
function Get-CimInstance {param($ClassName,$Filter,$OperationTimeoutSec,$ErrorAction) throw 'cancelled'}
function Get-CheckinWmiProcesses {param($Filter) throw 'cancelled'}
function Get-CheckinLocalProcessSnapshot {param($ProcessName,$ProcessId)
  $script:snapshots++
  $started=$script:start
  if('${scenario}' -eq 'pid_reuse' -and $script:snapshots%2 -eq 0){$started=$started.AddMinutes(1)}
  [pscustomobject]@{ProcessId=11;Name='msedge.exe';StartedAt=$started}
  if('${scenario}' -eq 'new_process' -and $script:snapshots%2 -eq 0){[pscustomobject]@{ProcessId=12;Name='msedge.exe';StartedAt=$started}}
}
function Get-CheckinDirectProcessObject {param($ProcessId)
  if('${scenario}' -eq 'lookup_denied'){throw 'PRIVATE PROVIDER ERROR'}
  [pscustomobject]@{ProcessId=$ProcessId
    Name=$(if('${scenario}' -eq 'wrong_name'){'chrome.exe'}else{'msedge.exe'})
    StartedAt=$(if('${scenario}' -eq 'wrong_creation'){$script:start.AddMinutes(-1)}else{$script:start})
    CommandLine=$(if('${scenario}' -eq 'missing_command'){''}else{'--user-data-dir=C:\\fixture'})}
}
try { Get-CheckinCimProcesses -Filter "Name='msedge.exe'";throw 'accepted incomplete inventory' } catch {
  if($_.FullyQualifiedErrorId -notlike 'CheckinProcessQueryFailed*'){throw}
  if($_.Exception.Message -match 'PRIVATE'){throw 'provider error leaked'}
}
if($script:snapshots -gt 4){throw 'fallback is unbounded'}
'ok'`);
    assert.equal(result.stdout.trim(), 'ok');
  });
}

test('direct PID query and stable empty inventory are supported without widening unsupported filters', { skip: process.platform !== 'win32' }, async () => {
  const result = await ps(`
. ${quote(path.join(root, 'scripts/Resolve-Runtime.ps1'))}
$script:start=[datetime]::UtcNow
function Get-CheckinLocalProcessSnapshot {param($ProcessName,$ProcessId)
  if($ProcessId -eq 123){[pscustomobject]@{ProcessId=123;Name='chrome.exe';StartedAt=$script:start}}
  elseif($ProcessName -ne 'absent.exe'){throw 'filter changed'}
}
function Get-CheckinDirectProcessObject {param($ProcessId)
  [pscustomobject]@{ProcessId=$ProcessId;Name='chrome.exe';StartedAt=$script:start;CommandLine='fixture'}
}
if(@(Get-CheckinDirectProcesses -Filter 'ProcessId=123').Count -ne 1){throw 'PID query failed'}
if(@(Get-CheckinDirectProcesses -Filter "Name='absent.exe'").Count -ne 0){throw 'empty query failed'}
$rejected=$false
try{Get-CheckinDirectProcesses -Filter "Name='chrome.exe' OR Name='msedge.exe'"}catch{$rejected=$true}
if(-not $rejected){throw 'unsupported query widened'}
'ok'`);
  assert.equal(result.stdout.trim(), 'ok');
});

async function controlledFixture(t) {
  const dir = await fixture(t), bookmarksPath = path.join(dir, 'Bookmarks');
  await fs.writeFile(bookmarksPath, JSON.stringify({ roots: { synced: { type: 'folder', name: 'Container', children: [
    { type: 'folder', name: 'Daily', children: [origin, other].map(url => ({ type: 'url', name: 'Fixture', url: url + '/' })) },
  ] } } }));
  const config = { bookmarksPath, mobileFolderNames: ['Container'], targetFolderNames: ['Daily'],
    automationUserDataDir: path.join(dir, 'profile'), nativeChallengePreflight: [origin, other].map(url => ({
      url: url + '/', action: { actionTexts: ['立即签到'] },
    })) };
  const state = { mode: 'native', controlledCheckin: true, windowReady: true, profile: config.automationUserDataDir,
    nativeDebugPort: 23456, launchMarker: marker, targetCount: 2, targets: [{ origin }, { origin: other }] };
  const abandon = async date => fs.writeFile(path.join(dir, 'tmp/manual-abandon.json'), JSON.stringify({
    schemaVersion: 1, date: date ?? localRunDate(), origins: [origin], createdAt: new Date().toISOString(),
  }));
  return { dir, config, state, abandon };
}

test('one abandoned page never blocks a bound completed page or becomes signed', async t => {
  const { dir, config, state, abandon } = await controlledFixture(t); await abandon();
  let calls = 0;
  const result = await continueControlledManualSession(dir, config, state, { readyOnly: true, inspect: async target => {
    calls++; assert.equal(target.origin, other);
    return bindSuccessEvidence({ origin: other, status: 'signed', evidence: successEvidence('page_text', 'page_completion_text') }, target, config);
  } });
  assert.deepEqual(result, { processedCount: 2, completedCount: 1, abandonedCount: 1, handledCount: 2, unresolvedCount: 0 });
  assert.equal(calls, 1);
  const progress = JSON.parse(await fs.readFile(path.join(dir, 'tmp/manual-continuation-progress.json')));
  assert.deepEqual(progress.results.map(item => item.status), ['abandoned', 'signed']);
  const closure = await recordManualSessionClosure(dir, state, { results: progress.results }, config, { reason: 'user_requested' });
  assert.equal(closure.closeReason, 'abandoned'); assert.equal(closure.completionConfirmed, false);
  assert.equal(closure.handledConfirmed, true); assert.equal(closure.targets[0].completedAt, null);
});

test('abandonment retains other unresolved pages and expires without trusting cached abandoned status', async t => {
  const { dir, config, state, abandon } = await controlledFixture(t); await abandon();
  const first = await continueControlledManualSession(dir, config, state, { readyOnly: true,
    inspect: async () => ({ status: 'needs_attention' }) });
  assert.equal(first.unresolvedCount, 1); assert.equal(first.completedCount, 0);
  const pendingClosure = await recordManualSessionClosure(dir, state, null, config, { reason: 'completed' });
  assert.equal(pendingClosure.closeReason, 'external_close'); assert.equal(pendingClosure.handledConfirmed, false);
  await abandon(localRunDate(new Date(Date.now() - 86400000)));
  let calls = 0;
  const next = await continueControlledManualSession(dir, config, state, { readyOnly: true,
    inspect: async () => { calls++; return { status: 'needs_attention' }; } });
  assert.equal(calls, 2); assert.equal(next.unresolvedCount, 2); assert.equal(next.abandonedCount, undefined);
  const expiredClosure = await recordManualSessionClosure(dir, state, null, config, { reason: 'completed' });
  assert.deepEqual(expiredClosure.targets.map(item => item.status), ['unconfirmed', 'unconfirmed']);
});

for (const scenario of ['selected', 'wrong_target', 'wrong_identity']) test(`partial abandonment preserves the controlled session: ${scenario}`, { skip: process.platform !== 'win32' }, async t => {
  const dir = await fixture(t), profile = path.join(dir, 'profile');
  for (const name of ['Set-TodayAbandonment.ps1', 'ManualAbandonment.ps1', 'ManualVerification.ps1', 'ResultContract.ps1', 'CheckinContract.generated.ps1']) {
    await fs.copyFile(path.join(root, 'scripts', name), path.join(dir, 'scripts', name));
  }
  await fs.writeFile(path.join(dir, 'scripts/Resolve-Runtime.ps1'), `
function Resolve-CheckinNode {param($Config) ${quote(process.execPath)}}
function ConvertTo-CheckinUtcDateTime {param($Value) if($Value){[datetime]$Value}}
function Get-CheckinManualSessionBrowserProcesses {param($Config,$State,$ProfilePath)
  [pscustomobject]@{ProcessId=${scenario === 'wrong_identity' ? 999 : 123}}
}`);
  await fs.writeFile(path.join(dir, 'config/config.json'), JSON.stringify({ automationUserDataDir: profile, runMutexName: `Local\\Fixture_${path.basename(dir)}` }));
  const state = { schemaVersion: 2, mode: 'native', controlledCheckin: true, windowReady: true, profile,
    sourceRunId: localRunDate() + '-120000', pid: 123, launchMarker: marker,
    processStartedAt: new Date().toISOString(), nativeDebugPort: 23456,
    targetCount: 2, targets: [{ origin }, { origin: other }] };
  const stateText = JSON.stringify(state);
  await fs.writeFile(path.join(dir, 'tmp/manual-session.json'), stateText);
  await fs.writeFile(path.join(dir, 'src/attention-urls.mjs'), `
    process.stdout.write(JSON.stringify({sourceRunId:'${localRunDate()}-120000',targets:[{origin:'${origin}',previousStatus:'needs_attention'}]}));`);
  const selected = scenario === 'wrong_target' ? 'https://outside.example' : origin;
  const result = await ps(`
$rejected=$false
try { & ${quote(path.join(dir, 'scripts/Set-TodayAbandonment.ps1'))} -Origins '${selected}' -PreserveSession | Out-Null }catch{$rejected=$true}
@{rejected=$rejected;recorded=(Test-Path ${quote(path.join(dir, 'tmp/manual-abandon.json'))})}|ConvertTo-Json -Compress`);
  assert.deepEqual(JSON.parse(result.stdout), { rejected: scenario !== 'selected', recorded: scenario === 'selected' });
  assert.equal(await fs.readFile(path.join(dir, 'tmp/manual-session.json'), 'utf8'), stateText);
});

for (const pending of [true, false]) test(`mixed-session close retains unresolved pages and dispatches once only after handling all (pending=${pending})`, { skip: process.platform !== 'win32' }, async t => {
  const dir = await fixture(t), profile = path.join(dir, 'profile');
  for (const name of ['Close-ManualLogin.ps1', 'ManualAbandonment.ps1']) {
    await fs.copyFile(path.join(root, 'scripts', name), path.join(dir, 'scripts', name));
  }
  await fs.writeFile(path.join(dir, 'config/config.json'), JSON.stringify({ automationUserDataDir: profile }));
  await fs.writeFile(path.join(dir, 'tmp/manual-session.json'), JSON.stringify({ schemaVersion: 2, mode: 'native',
    controlledCheckin: true, pid: 123, profile, launchMarker: marker, processStartedAt: new Date().toISOString(),
    targetCount: 2, targets: [{ origin }, { origin: other }] }));
  await fs.writeFile(path.join(dir, 'tmp/manual-abandon.json'), JSON.stringify({ schemaVersion: 1,
    date: localRunDate(), origins: [origin] }));
  await fs.writeFile(path.join(dir, 'scripts/Resolve-Runtime.ps1'), `
function Resolve-CheckinNode {param($Config) ${quote(process.execPath)}}
function Get-CheckinManualSessionBrowserProcesses {param($Config,$ProfilePath,$State)
  if(-not $global:closed){[pscustomobject]@{ProcessId=123}}
}
function ConvertTo-CheckinUtcDateTime {param($Value) [datetime]$Value}
function Test-CheckinProcessStartIdentity {param($Process,$RecordedStart,$ToleranceSeconds) $true}
function Get-Process {param($Id,$ErrorAction)
  $p=[pscustomobject]@{MainWindowHandle=1}
  $p|Add-Member ScriptMethod CloseMainWindow {$global:closed=$true;return $true}
  $p
}
`);
  await fs.writeFile(path.join(dir, 'scripts/Resume-ManualCheckin.ps1'), `param([switch]$ReadyOnly,[switch]$Json)
    '{"processedCount":2,"completedCount":${pending ? 0 : 1},"abandonedCount":1,"unresolvedCount":${pending ? 1 : 0}}'`);
  await fs.writeFile(path.join(dir, 'scripts/Continue-ManualHandoff.ps1'), '$global:dispatches++');
  // Closure semantics are verified above using the real lifecycle module;
  // this stub isolates the PowerShell save/close and dispatch integration.
  await fs.writeFile(path.join(dir, 'src/manual-session-lifecycle.mjs'), `
    import fs from 'node:fs';import path from 'node:path';
    fs.writeFileSync(path.join(import.meta.dirname,'../tmp/manual-session-history.json'),JSON.stringify({sessions:[{identity:'${marker}',closeReason:'abandoned'}]}));`);
  const result = await ps(`
$global:closed=$false;$global:dispatches=0
& ${quote(path.join(dir, 'scripts/Close-ManualLogin.ps1'))} | Out-Null
& ${quote(path.join(dir, 'scripts/Close-ManualLogin.ps1'))} | Out-Null
@{closed=$global:closed;dispatches=$global:dispatches;retained=(Test-Path ${quote(path.join(dir, 'tmp/manual-session.json'))})}|ConvertTo-Json -Compress`);
  assert.deepEqual(JSON.parse(result.stdout), { closed: !pending, dispatches: pending ? 0 : 1, retained: pending });
  if (!pending) {
    const verification = JSON.parse(await fs.readFile(path.join(dir, 'tmp/manual-verification.json')));
    assert.deepEqual(verification.targets.map(target => target.origin), [other]);
  }
});

test('same-page native preflight failures survive only their bound attempt and do not fall through to generic submission', () => {
  const now = new Date(), attemptId = 'b'.repeat(32);
  const result = { origin, status: 'needs_attention', failureCode: 'same_page_verification_unresolved', retryable: false,
    preflightAttemptId: attemptId };
  const report = { generatedAt: now.toISOString(), results: [result] };
  assert.equal(freshNativePreflightHandoffs(report, new Set([origin]), attemptId, now).size, 1);
  assert.equal(freshNativePreflightHandoffs(report, new Set([origin]), marker, now).size, 0);
});

for (const scenario of ['confirmed', 'waiting', 'mismatched_step', 'mixed_actions']) test(`automatic native preflight uses the retained-page runner: ${scenario}`, { skip: process.platform !== 'win32' }, async t => {
  const dir = await fixture(t), profile = path.join(dir, 'data/profile');
  await fs.mkdir(profile, { recursive: true });
  for (const name of ['Prepare-NativeWafSession.ps1', 'ManualAbandonment.ps1']) {
    await fs.copyFile(path.join(root, 'scripts', name), path.join(dir, 'scripts', name));
  }
  await fs.writeFile(path.join(dir, 'scripts/Resolve-Runtime.ps1'), `
function Resolve-CheckinNode {param($Config) ${quote(process.execPath)}}
function Resolve-CheckinBrowser {param($Config) [pscustomobject]@{DisplayName='Fixture'}}
function Get-CheckinProfileBrowserProcesses {param($Config,$ProfilePath) @()}
`);
  await fs.writeFile(path.join(dir, 'scripts/NativePreflightCheckpoint.ps1'), `
function Read-NativePreflightConfirmations {param($Path,$Config,[switch]$IncludePrepared) @()}
function Get-NativePreflightConfirmationStatus {param($Inspection,$Explicit,$Endpoint) $Inspection.status}
function Test-ConfirmedNotAvailable {param($Result) $false}
function Write-NativePreflightCheckpoint {param($Path,$Results,$Config)
  [IO.File]::WriteAllText($Path,(ConvertTo-Json -InputObject @{results=@($Results)} -Depth 20))}
`);
  await fs.writeFile(path.join(dir, 'scripts/NativePreflightBrowserClose.ps1'), `
function Complete-NativePreflightAttempt {param($Cleanup,$Failure) & $Cleanup}
function Close-NativePreflightBrowser {param($GetProcesses,$RequestClose) }
`);
  await fs.writeFile(path.join(dir, 'scripts/Open-PlainLoginChrome.ps1'), `
param([switch]$Offscreen,[switch]$NativeMinimal,$RemoteDebuggingPort,$UserDataDirOverride,$Urls)
[IO.File]::WriteAllText((Join-Path $PSScriptRoot '../tmp/launched'),'true')
`);
  const inspection = scenario === 'confirmed' ? { status: 'already_signed' }
    : { status: 'unconfirmed', failureCode: 'same_page_verification_unresolved', retryable: false, reason: 'Waiting' };
  await fs.writeFile(path.join(dir, 'src/native-browser-inspect.mjs'), `
if(process.argv[5]!=='execute-same-page')throw new Error('wrong execution mode');
console.log(JSON.stringify(${JSON.stringify(inspection)}));`);
  await fs.writeFile(path.join(dir, 'config/config.json'), JSON.stringify({ automationUserDataDir: profile, nativeWafPreflightUrls: [],
    nativeChallengePreflight: [{ url: origin + '/attendance.php', waitSeconds: 5, maxAttempts: 1, samePageCheckin: true,
      ...(scenario === 'mixed_actions' ? { action: { actionTexts: ['立即签到'] } } : {}) }],
    samePageManualCheckinRules: { [origin]: { browserMode: 'native', expectedPath: '/attendance.php', sequentialActionType: 'daily_checkin' } },
    sequentialActionRules: { [origin]: { steps: [{ url: origin + (scenario === 'mismatched_step' ? '/wrong.php' : '/attendance.php'), actionType: 'daily_checkin' }] } },
  }));
  const result = await ps(`
function Start-Sleep {param($Seconds)}
$rejected=$false;$detail=''
try { & ${quote(path.join(dir, 'scripts/Prepare-NativeWafSession.ps1'))} -Origins '${origin}' -AttemptId '${marker}' }catch{$rejected=$true;$detail=$_.Exception.Message}
@{rejected=$rejected;detail=$detail}|ConvertTo-Json -Compress`);
  const invalid = ['mismatched_step', 'mixed_actions'].includes(scenario);
  assert.equal(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)).rejected, invalid, result.stdout);
  assert.equal(await fs.access(path.join(dir, 'tmp/launched')).then(() => true).catch(() => false), !invalid);
  if (!invalid) {
    const report = JSON.parse(await fs.readFile(path.join(dir, 'tmp/native-waf-preflight.json')));
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].status, scenario === 'confirmed' ? 'already_signed' : 'needs_attention');
    if (scenario === 'waiting') {
      assert.equal(report.results[0].failureCode, 'same_page_verification_unresolved');
      assert.equal(report.results[0].manualBrowserMode, 'native');
    }
  }
});

test('native CF-before-submit form waits in the same document, ignores navigation and submits exactly once', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 45000,
}, async t => {
  const dir = await fixture(t), browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(); let posts = 0;
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === 'challenges.cloudflare.com') return route.fulfill({ contentType: 'text/html', body:
      `<div id="widget"></div><script>const root=document.querySelector('#widget').attachShadow({mode:'closed'});
      root.innerHTML='<label style="display:block;width:220px;height:40px"><input type="checkbox">Verify you are human</label>';
      root.querySelector('input').onclick=()=>parent.postMessage('verified','${origin}');</script>` });
    if (request.method() === 'POST') {
      posts++; assert.equal(url.pathname, '/attendance.php');
      assert.match(request.postData(), /cf-turnstile-response=fixture/);
      return route.fulfill({ body: 'ok' });
    }
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
      <a href="/attendance.php" onclick="window.navClicks++;return false">[签到得魔力]</a>
      <form action="/attendance.php" method="post"><div class="cf-turnstile" id="host"></div>
      <input name="cf-turnstile-response" value=""><input type="submit" value="立即签到"></form>
      <script>window.navClicks=0;window.initialDocument=document;
      document.querySelector('#host').attachShadow({mode:'closed'}).innerHTML=
        '<iframe style="border:0;width:300px;height:70px" src="https://challenges.cloudflare.com/fixture"></iframe>';
      window.addEventListener('message',e=>{if(e.data==='verified')document.querySelector('[name=cf-turnstile-response]').value='fixture'});
      document.querySelector('form').onsubmit=e=>{e.preventDefault();
        window.sameDocument=window.initialDocument===document;
        fetch('/attendance.php',{method:'POST',body:new URLSearchParams(new FormData(e.target))}).then(()=>{
          e.target.remove();setTimeout(()=>document.body.append('今天已经签到'),100)})};</script>` });
  });
  const target = { origin, allowedOrigins: [origin] };
  const config = { submissionJournalPath: path.join(dir, 'journal.json'), samePageManualCheckinRules: { [origin]: {
    expectedPath: '/attendance.php', widgetSelector: '.cf-turnstile', responseSelector: 'form input[name=cf-turnstile-response]',
    browserMode: 'native', sequentialActionType: 'daily_checkin', nativeClickChallenge: true,
  } }, sequentialActionRules: { [origin]: { steps: [{ url: origin + '/attendance.php', actionType: 'daily_checkin',
    dailyCheckin: true, actionTexts: ['立即签到'], actionTags: ['INPUT'], completedIncludes: ['今天已经签到'],
    acceptGenericCheckinState: true, disabledActionIsComplete: false, reloadOnUnconfirmed: false }] } } };
  await page.goto(origin + '/attendance.php');
  // The production guard continues to the network. Offline fixtures must
  // continue to the older fulfillment route instead of resolving .example.
  const retained = new Proxy(page, { get(object, key) {
    if (key === 'route') return (match, handler) => page.route(match, route => handler({
      request: () => route.request(), abort: value => route.abort(value), continue: () => route.fallback(),
    }));
    const value = Reflect.get(object, key); return typeof value === 'function' ? value.bind(object) : value;
  } });
  const scope = createSubmissionScope(config.submissionJournalPath, { ...target, actionType: 'daily_checkin' }, config);
  const waiting = await continueNativeSamePage(retained, target, config, { waitMs: 500, continuationOnly: true });
  assert.equal(waiting.submissionAttempted, false); assert.equal(posts, 0); assert.equal((await scope.pending()).length, 0);
  let challengeClicks = 0;
  const completed = await continueNativeSamePage(retained, target, config, { waitMs: 15000, advanceChallenge: async () => {
    assert.equal((await scope.pending()).length, 0, 'verification must precede submission intent');
    const result = await clickVisibleNativeChallengeControl(page, origin, { actionTexts: ['立即签到'], clickChallenge: true, challengeFrameStableMs: 3000 });
    assert.equal(result.clicked, true, JSON.stringify(result)); challengeClicks++;
  } });
  assert.equal(completed.status, 'signed', JSON.stringify(completed)); assert.equal(posts, 1); assert.equal(challengeClicks, 1);
  assert.equal(completed.actionResults[0].evidence.binding.actionType, 'daily_checkin');
  assert.deepEqual(await page.evaluate(() => [window.navClicks, window.sameDocument]), [0, true]);
  assert.equal((await scope.pending()).length, 0);
  const repeated = await continueNativeSamePage(retained, target, config, { readOnly: true, waitMs: 1000 });
  assert.equal(repeated.status, 'signed'); assert.equal(posts, 1);

  await page.goto(origin + '/attendance.php');
  await page.locator('[name=cf-turnstile-response]').fill('fixture'); await scope.begin();
  const ambiguous = await continueNativeSamePage(retained, target, config, { continuationOnly: true, waitMs: 500 });
  assert.equal(ambiguous.status, 'needs_attention'); assert.equal(posts, 1, 'an ambiguous intent must not submit again');
});
