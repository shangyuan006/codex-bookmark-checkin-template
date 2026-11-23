import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { powershellExecutable } from './helpers/powershell.mjs';
import { recordOAuthHandoffCompletion } from '../src/oauth-handoff-identity.mjs';
import { controlledManualTargets } from '../src/manual-native-continuation.mjs';
import { selectSamePageManualTarget } from '../src/live-checkin-session.mjs';
import { continueCheckinOnSamePage, samePageCloseReason } from '../src/same-page-checkin.mjs';
import { recordManualSessionClosure } from '../src/manual-session-lifecycle.mjs';

const exec = promisify(execFile), origin = 'https://daily.example', marker = 'a'.repeat(32);
const sourceRoot = path.resolve(import.meta.dirname, '..');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nov11-flow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  for (const name of ['scripts', 'src', 'config', 'tmp', 'logs', 'data/profile']) await fs.mkdir(path.join(root, name), { recursive: true });
  return root;
}

test('OAuth success is durable without stdout and refuses a replaced session', async t => {
  const root = await fixture(t), stateFile = path.join(root, 'tmp/agentrouter-manual-state.json');
  const state = { accountKey: 'linuxdo', stage: 'agentrouter', nativeDebugPort: 23456, pid: 123,
    processStartedAt: new Date().toISOString(), launchMarker: marker, profile: path.join(root, 'data/profile') };
  const scope = { root, accountKey: state.accountKey, port: 23456, profile: state.profile,
    native: true, provider: 'LinuxDO', stage: 'manual_target_oauth', launchMarker: marker };
  await fs.writeFile(stateFile, JSON.stringify(state));
  assert.equal(await recordOAuthHandoffCompletion(stateFile, scope, { status: 'needs_attention', oauthStage: 'provider_authorization' }), false);
  assert.equal(JSON.parse(await fs.readFile(stateFile)).oauthCompletion, undefined);
  await recordOAuthHandoffCompletion(stateFile, scope, { status: 'logged_in', oauthStage: 'completed', token: 'PRIVATE' });
  const saved = JSON.parse(await fs.readFile(stateFile));
  assert.equal(saved.oauthCompletion.status, 'logged_in');
  assert.equal(saved.oauthCompletion.launchMarker, marker);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE|token|signed/);
  await fs.writeFile(stateFile, JSON.stringify({ ...state, launchMarker: 'b'.repeat(32) }));
  await assert.rejects(recordOAuthHandoffCompletion(stateFile, scope, { status: 'logged_in', oauthStage: 'completed' }), /session changed/);
  assert.equal(JSON.parse(await fs.readFile(stateFile)).oauthCompletion, undefined);
});

test('ordinary retained targets are selected before a long-lived same-page target', () => {
  const slow = { origin: 'https://slow.example', manualBrowserMode: 'native' }, fast = { origin };
  const config = { samePageManualCheckinRules: { [slow.origin]: { expectedPath: '/calendar', actionName: '签到',
    widgetSelector: '.verification', responseSelector: 'input[name=response]', preferSamePage: true } },
    nativeChallengePreflight: [slow, fast].map(t => ({ url: t.origin + '/profile', action: { actionTexts: ['签到'] } })) };
  const handoff = { targets: [slow, fast] };
  assert.deepEqual(controlledManualTargets(handoff, config), [fast]);
  assert.equal(selectSamePageManualTarget({ targets: [slow] }, config), slow);
  assert.deepEqual(handoff.targets, [slow, fast]);
});

for (const completes of [false, true]) test(`HTTP 422 is reported without repeated clicks; delayed completion=${completes}`, async () => {
  let tick = 0, clicks = 0;
  const stages = [];
  const result = await continueCheckinOnSamePage({
    rule: { siteReplaysAfterChallenge: true, startActionBeforeChallenge: true },
    readState: async () => ({ status: completes && tick >= 4 ? 'already_signed' : 'ready' }),
    readReady: async () => ({ buttonReady: true, widgetPresent: false }),
    submit: async () => { clicks++; return { clicked: true, intentReserved: true }; },
    readSubmissionDiagnostics: async () => ({ intentReserved: clicks > 0, submissionRequestObserved: tick > 0,
      submissionRequestCount: tick > 0 ? 2 : 0, submissionResponseCount: tick > 1 ? 2 : 0,
      submissionResponseStatus: tick > 1 ? 422 : undefined, submissionRejectedCount: tick > 1 ? 2 : 0 }),
    isClosed: () => false, shouldClose: async () => tick >= 7,
    onStage: async s => stages.push(s), now: () => tick * 500, delay: async () => { tick++; },
  });
  assert.equal(clicks, 1);
  assert.ok(stages.some(s => s.stage === 'submission_rejected' && s.failureCode === 'same_page_http_422_rejected'));
  if (completes) {
    assert.equal(result.status, 'already_signed'); assert.equal(result.failureCode, undefined);
    assert.equal(stages.at(-1).stage, 'completed'); assert.equal(stages.at(-1).reason, undefined);
  } else {
    assert.equal(result.status, 'unconfirmed'); assert.match(result.reason, /HTTP 422/);
    assert.equal(stages.at(-1).stage, 'submission_rejected');
  }
});

test('login and wrong-page waits are distinct from an unready verification widget', async () => {
  for (const [pageStatus, status, expected] of [['unexpected_page', 'ready', 'waiting_for_checkin_page'],
    ['ready', 'login_required', 'waiting_for_login'], ['action_not_found', 'ready', 'waiting_for_checkin_button'],
    ['button_disabled', 'ready', 'waiting_for_button_enabled']]) {
    let tick = 0; const stages = [];
    await continueCheckinOnSamePage({ readState: async () => ({ status }), readReady: async () => ({ pageStatus }),
      submit: async () => assert.fail('no eligible control'), isClosed: () => false, shouldClose: async () => tick > 2,
      onStage: async s => stages.push(s), delay: async () => { tick++; } });
    assert.equal(stages.at(-1).stage, expected);
  }
});

test('an exact same-page abandonment signal persists as abandoned, never completed', async t => {
  const root = await fixture(t), state = { sessionId: marker, mode: 'live_checkin', targets: [{ origin }] };
  const reason = samePageCloseReason({ sessionId: marker, command: 'close', reason: 'abandoned' }, marker);
  const closure = await recordManualSessionClosure(root, state, { results: [{ origin, status: 'abandoned' }] }, {}, { reason });
  assert.equal(closure.closeReason, 'abandoned'); assert.equal(closure.completionConfirmed, false);
  assert.equal(samePageCloseReason({ sessionId: 'b'.repeat(32), command: 'close', reason: 'abandoned' }, marker), 'external_close');
  assert.equal(samePageCloseReason({ sessionId: marker, command: 'close' }, marker), 'user_requested');
});

async function completionFixture(t, { closeFails = false, code = 75 } = {}) {
  const root = await fixture(t);
  for (const name of ['Complete-AgentRouterLogin.ps1', 'AgentRouterVerificationQueue.ps1']) {
    await fs.copyFile(path.join(sourceRoot, 'scripts', name), path.join(root, 'scripts', name));
  }
  // Concurrent fixtures must not share the production account mutex.
  const completionScript = path.join(root, 'scripts/Complete-AgentRouterLogin.ps1');
  await fs.writeFile(completionScript, (await fs.readFile(completionScript, 'utf8'))
    .replace('Local\\CheckinOAuthComplete_', `Local\\CheckinOAuthComplete_${path.basename(root)}_`));
  await fs.writeFile(path.join(root, 'scripts/AgentRouterAccount.ps1'), `
function ConvertTo-AgentRouterAccountKey($AccountKey) { return $AccountKey }
function Resolve-AgentRouterAccountConfig($Accounts,$AccountKey) { return @($Accounts | Where-Object accountKey -eq $AccountKey)[0] }
function Write-AgentRouterProviderState($Path,$State) { [IO.File]::WriteAllText($Path,($State|ConvertTo-Json -Depth 8)) }
function Resolve-AgentRouterPowerShellExecutable { return '${powershellExecutable.replaceAll("'", "''")}' }
`);
  await fs.writeFile(path.join(root, 'scripts/ManualVerification.ps1'), `
function Get-ManualVerificationShanghaiDate($Now) { return $Now.ToString('yyyyMMdd') }
function Test-CheckinBoundSuccessEvidence($Result,$Now) { return $Result.evidence.authoritative -eq $true }
`);
  await fs.writeFile(path.join(root, 'scripts/Close-AgentRouterLogin.ps1'), `param($AccountKey)
$root=Split-Path -Parent $PSScriptRoot
$request=Get-Content -Raw (Join-Path $root 'tmp/agentrouter-verification-linuxdo.json')|ConvertFrom-Json
if($request.sessionMarker -ne '${marker}') { throw 'verification was not persisted before close' }
${closeFails ? "throw 'simulated interruption before window closure'" : "Remove-Item -LiteralPath (Join-Path $root 'tmp/agentrouter-manual-state.json')"}
`);
  await fs.writeFile(path.join(root, 'scripts/Run-Checkin.ps1'), `param($ReauthAccountKey,[switch]$PostOAuthVerify,$Attempts,[switch]$SuppressReport)
if($ReauthAccountKey -ne 'linuxdo' -or -not $PostOAuthVerify -or $Attempts -ne 1 -or -not $SuppressReport) {exit 9}
[IO.File]::WriteAllText((Join-Path (Split-Path -Parent $PSScriptRoot) 'tmp/verify-called'), 'true')
exit ${code}
`);
  await fs.writeFile(path.join(root, 'config/config.json'), JSON.stringify({ agentrouterAccounts: [{ origin,
    accountKey: 'linuxdo', provider: 'LinuxDO', automationUserDataDir: 'data/profile' }] }));
  await fs.writeFile(path.join(root, 'tmp/agentrouter-manual-state.json'), JSON.stringify({ accountKey: 'linuxdo',
    profile: path.join(root, 'data/profile'), stage: 'agentrouter', launchMarker: marker }));
  const run = async (session = marker) => exec(powershellExecutable, ['-NoProfile', '-NonInteractive', '-File',
    path.join(root, 'scripts/Complete-AgentRouterLogin.ps1'), '-AccountKey', 'linuxdo', '-ExpectedLaunchMarker', session],
  { cwd: root, windowsHide: true, timeout: 20_000 }).then(() => 0, e => { if (typeof e.code !== 'number') throw e; return e.code; });
  return { root, run };
}

test('OAuth close persists its exact reward request before a busy wrapper; replay does not reopen login', async t => {
  const f = await completionFixture(t);
  assert.equal(await f.run(), 75);
  const request = JSON.parse(await fs.readFile(path.join(f.root, 'tmp/agentrouter-verification-linuxdo.json')));
  assert.equal(request.state, 'pending'); assert.equal(request.sessionMarker, marker);
  assert.equal(await f.run(), 75);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'tmp/agentrouter-verification-linuxdo.json'))).requestId, request.requestId);
});

test('interruption during OAuth window close retains the durable verification request', async t => {
  const f = await completionFixture(t, { closeFails: true });
  assert.equal(await f.run(), 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'tmp/agentrouter-verification-linuxdo.json'))).state, 'pending');
  await fs.access(path.join(f.root, 'tmp/agentrouter-manual-state.json'));
  await assert.rejects(fs.access(path.join(f.root, 'tmp/verify-called')), { code: 'ENOENT' });
});

test('a stale completion observer cannot queue or close a replacement session', async t => {
  const f = await completionFixture(t);
  assert.equal(await f.run('b'.repeat(32)), 1);
  await assert.rejects(fs.access(path.join(f.root, 'tmp/agentrouter-verification-linuxdo.json')), { code: 'ENOENT' });
  await fs.access(path.join(f.root, 'tmp/agentrouter-manual-state.json'));
});

test('the session observer recovers durable OAuth completion and leaves unresolved or replaced sessions open', async t => {
  const root = await fixture(t), stateFile = path.join(root, 'tmp/agentrouter-manual-state.json');
  await fs.copyFile(path.join(sourceRoot, 'scripts/Watch-AgentRouterLogin.ps1'), path.join(root, 'scripts/Watch-AgentRouterLogin.ps1'));
  await fs.writeFile(path.join(root, 'config/config.json'), '{}');
  await fs.writeFile(path.join(root, 'scripts/Resolve-Runtime.ps1'), `
function Resolve-CheckinNode { param($Config) '${process.execPath.replaceAll("'", "''")}' }
`);
  await fs.writeFile(path.join(root, 'scripts/Complete-AgentRouterLogin.ps1'), `param($AccountKey,$ExpectedLaunchMarker)
$file=Join-Path (Split-Path -Parent $PSScriptRoot) 'tmp/agentrouter-manual-state.json'
$s=Get-Content -Raw $file|ConvertFrom-Json
if($s.accountKey -ne $AccountKey -or $s.launchMarker -cne $ExpectedLaunchMarker) {throw 'wrong observer session'}
[IO.File]::WriteAllText((Join-Path (Split-Path -Parent $PSScriptRoot) 'tmp/recovered'), 'true')
Remove-Item -LiteralPath $file
`);
  const state = { accountKey: 'linuxdo', stage: 'agentrouter', launchMarker: marker };
  const run = seconds => exec(powershellExecutable, ['-NoProfile', '-NonInteractive', '-File',
    path.join(root, 'scripts/Watch-AgentRouterLogin.ps1'), '-AccountKey', 'linuxdo', '-SessionMarker', marker,
    '-TimeoutSeconds', String(seconds)], { cwd: root, windowsHide: true, timeout: 25_000 });
  await fs.writeFile(stateFile, JSON.stringify(state));
  await run(1);
  await fs.access(stateFile);
  await assert.rejects(fs.access(path.join(root, 'tmp/recovered')), { code: 'ENOENT' });
  await fs.writeFile(stateFile, JSON.stringify({ ...state, launchMarker: 'b'.repeat(32), oauthCompletion: {
    status: 'logged_in', oauthStage: 'completed', launchMarker: marker } }));
  await run(1);
  await fs.access(stateFile);
  await fs.writeFile(stateFile, JSON.stringify({ ...state, oauthCompletion: {
    status: 'logged_in', oauthStage: 'completed', launchMarker: marker } }));
  await run(15);
  await fs.access(path.join(root, 'tmp/recovered'));
  await assert.rejects(fs.access(stateFile), { code: 'ENOENT' });
});

test('the ordinary manual entry selects the bounded native subset before starting a same-page helper', async t => {
  const root = await fixture(t);
  await fs.copyFile(path.join(sourceRoot, 'scripts/Open-ManualLogin.ps1'), path.join(root, 'scripts/Open-ManualLogin.ps1'));
  await fs.writeFile(path.join(root, 'scripts/ManualVerification.ps1'), `
function Test-ManualHandoffLaunchActive { return $false }
function Write-ManualHandoffLaunch { }
function Remove-ManualHandoffLaunch { }
`);
  await fs.writeFile(path.join(root, 'scripts/Resolve-Runtime.ps1'), `
function Resolve-CheckinNode { return '${process.execPath.replaceAll("'", "''")}' }
function Get-CheckinAutomationBrowserProcesses { return @() }
`);
  await fs.writeFile(path.join(root, 'src/manual-native-continuation.mjs'), `console.log(JSON.stringify({origins:['${origin}']}));`);
  await fs.writeFile(path.join(root, 'src/live-checkin-session.mjs'), "throw Error('same-page helper must not take the profile first');");
  await fs.writeFile(path.join(root, 'scripts/Open-PlainLoginChrome.ps1'), `
param([switch]$NativeMinimal,[switch]$TrackManualSession,[switch]$ControlledCheckin,[int]$RemoteDebuggingPort,[string[]]$Origins)
if(-not $NativeMinimal -or -not $TrackManualSession -or -not $ControlledCheckin -or $RemoteDebuggingPort -lt 1024 -or $Origins.Count -ne 1 -or $Origins[0] -ne '${origin}') {throw 'wrong selected subset'}
[IO.File]::WriteAllText((Join-Path (Split-Path -Parent $PSScriptRoot) 'tmp/native-opened'), 'true')
[IO.File]::WriteAllText((Join-Path (Split-Path -Parent $PSScriptRoot) 'tmp/manual-session.json'), '{"mode":"native","windowReady":true}')
`);
  await fs.writeFile(path.join(root, 'scripts/Resume-ManualCheckin.ps1'), "param([switch]$Json) '{\"unresolvedCount\":0}'");
  await fs.writeFile(path.join(root, 'scripts/Close-ManualLogin.ps1'), `param([switch]$SaveOnly)
if(-not $SaveOnly) {throw 'expected confirmed save'}
[IO.File]::WriteAllText((Join-Path (Split-Path -Parent $PSScriptRoot) 'tmp/native-closed'), 'true')
`);
  await fs.writeFile(path.join(root, 'config/config.json'), JSON.stringify({ runMutexName: 'Local\\Nov11Queue-' + path.basename(root),
    nativeChallengePreflight: [{ url: origin }], samePageManualCheckinRules: { 'https://slow.example': { enabled: true } } }));
  await exec(powershellExecutable, ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts/Open-ManualLogin.ps1')],
    { cwd: root, windowsHide: true, timeout: 20_000 });
  await fs.access(path.join(root, 'tmp/native-opened'));
  await fs.access(path.join(root, 'tmp/native-closed'));
});

test('handoff continuation dispatches the remaining queue without running the daily task or notifications', async t => {
  const root = await fixture(t);
  for (const name of ['Start-UserScheduler.ps1', 'Continue-ManualHandoff.ps1', 'CheckinExecutionReport.ps1']) {
    await fs.copyFile(path.join(sourceRoot, 'scripts', name), path.join(root, 'scripts', name));
  }
  for (const name of ['TaskRuntimeBudget', 'ManualVerification', 'ResultContract', 'ManualAbandonment', 'CheckinCycle', 'AgentRouterAccount']) {
    await fs.writeFile(path.join(root, 'scripts', name + '.ps1'), '');
  }
  await fs.writeFile(path.join(root, 'scripts/Resolve-Runtime.ps1'), `
function Test-ManualHandoffLaunchActive { return $false }
function Write-ManualHandoffLaunch { }
function Remove-ManualHandoffLaunch { }
function ConvertTo-ManualAbandonmentOrigin($Value) { return $Value }
function Start-Process { param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru)
if(-not ($ArgumentList -match 'Open-ManualLogin.ps1')) {throw 'unexpected process'}
[IO.File]::WriteAllText((Join-Path (Split-Path -Parent $PSScriptRoot) 'tmp/next-dispatched'), 'true')
[pscustomobject]@{Id=123;HasExited=$false}
}
`);
  await fs.writeFile(path.join(root, 'scripts/Open-ManualLogin.ps1'), '');
  for (const script of ['Run-Checkin.ps1', 'Invoke-CheckinNotificationOutbox.ps1']) {
    await fs.writeFile(path.join(root, 'scripts', script), `throw 'must not run during handoff-only dispatch'`);
  }
  await fs.writeFile(path.join(root, 'config/config.json'), JSON.stringify({
    schedulerMutexName: 'Local\\Nov11Dispatch-' + path.basename(root), runMutexName: 'Local\\Nov11DispatchRun-' + path.basename(root),
  }));
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '');
  await fs.writeFile(path.join(root, 'tmp/manual-handoff.json'), JSON.stringify({ state: 'awaiting_manual_handoff',
    authoritativeEvidenceRequired: true, sourceRunId: day + '-120000', targets: [{ origin }] }));
  const { stdout } = await exec(powershellExecutable, ['-NoProfile', '-NonInteractive', '-File',
    path.join(root, 'scripts/Continue-ManualHandoff.ps1')], { cwd: root, windowsHide: true, timeout: 15_000 });
  assert.doesNotMatch(stdout, /可恢复异常/);
  assert.ok(await fs.access(path.join(root, 'tmp/next-dispatched')).then(() => true, () => false),
    await fs.readFile(path.join(root, 'logs/scheduler.log'), 'utf8'));
});
