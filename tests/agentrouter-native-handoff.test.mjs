import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const quote = value => `'${value.replaceAll("'", "''")}'`;

for (const automaticAllowed of [true, false]) for (const successful of [true, false]) for (const continuationSucceeds of successful ? [false] : [false, true]) for (const checkpointOnly of successful ? [false, true] : [false]) test(`native LinuxDO continuation ${successful || continuationSucceeds ? 'verifies reward after login' : 'retains the actual authorization page for takeover'} (automaticAllowed=${automaticAllowed}, delayedConsent=${continuationSucceeds}, stdoutLost=${checkpointOnly})`, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-oauth-handoff-'));
  try {
    for (const name of ['scripts', 'src', 'config', 'tmp', 'data/profile']) await fs.mkdir(path.join(dir, name), { recursive: true });
    for (const name of ['Open-AgentRouterLogin.ps1', 'AgentRouterAccount.ps1']) {
      await fs.copyFile(new URL('../scripts/' + name, import.meta.url), path.join(dir, 'scripts', name));
    }
    await fs.writeFile(path.join(dir, 'config/config.json'), JSON.stringify({ agentrouterAccounts: [{
      origin: 'https://agentrouter.org', accountKey: 'linuxdo', provider: 'LinuxDO',
      linuxDoSessionStrategy: 'target_oauth', automationUserDataDir: 'data/profile',
    }] }));
    await fs.writeFile(path.join(dir, 'scripts/Resolve-Runtime.ps1'), `
function Resolve-CheckinNode { param($Config) ${quote(process.execPath)} }
function Resolve-CheckinBrowser { param($Config) [pscustomobject]@{Executable='fixture';ProcessName='fixture.exe'} }
function Get-CimInstance { @() }
function Get-CheckinProfileBrowserProcesses { param($Config,$ProfilePath) @() }
function Start-Process {
  param($FilePath,$ArgumentList,[switch]$PassThru)
  if (@($ArgumentList|Where-Object {$_ -like '--remote-debugging-port=*'}).Count -ne 1) {throw 'missing native port'}
  Add-Content -LiteralPath ${quote(path.join(dir, 'tmp/launches.txt'))} -Value 'launch'
  [pscustomobject]@{Id=123}
}
function Wait-CheckinVisibleBrowserWindow { param($Config,$ProfilePath,$LaunchMarker)
  [pscustomobject]@{ProcessId=123;ProcessStartedAt='2026-01-01T00:00:00Z'} }
`);
    await fs.writeFile(path.join(dir, 'src/prepare-native-browser-profile.mjs'), 'process.exitCode=0;');
    await fs.writeFile(path.join(dir, 'src/probe-agentrouter-session.mjs'),
      `console.log(JSON.stringify(process.argv.includes('--recovery-state') ? {action:'resume',automaticAllowed:${automaticAllowed}} : {status:'needs_attention'}));`);
    await fs.writeFile(path.join(dir, 'src/oauth-login.mjs'), `
import fs from 'node:fs';
const native=process.argv.includes('--native-cdp-port');
if(native&&!process.argv.includes('--native-visible-handoff'))throw Error('missing visible handoff reservation');
fs.appendFileSync(${JSON.stringify(path.join(dir, 'tmp/attempts.txt'))},native?'native\\n':'automatic\\n');
if(native&&${successful && checkpointOnly}) {
const file='tmp/agentrouter-manual-state.json';const state=JSON.parse(fs.readFileSync(file,'utf8'));
state.oauthCompletion={status:'logged_in',oauthStage:'completed',launchMarker:state.launchMarker};fs.writeFileSync(file,JSON.stringify(state));
} else console.log(JSON.stringify(native&&${successful} ? {status:'logged_in',oauthStage:'completed'}
 : {status:'needs_attention',oauthStage:'provider_authorization',authorizationOutcome:'provider_challenge_unresolved'}));
process.exitCode=native&&${successful}?0:2;
`);
    await fs.writeFile(path.join(dir, 'src/native-oauth-continuation.mjs'), `
import fs from 'node:fs';
const state=JSON.parse(fs.readFileSync('tmp/agentrouter-manual-state.json','utf8'));
if(state.nativeDebugPort!==Number(process.argv[2])||state.accountKey!==process.argv[3])throw Error('wrong retained window');
fs.appendFileSync('tmp/continuations.txt','resume\\n');
console.log(JSON.stringify(${continuationSucceeds} ? {status:'logged_in',oauthStage:'completed'}
 : {status:'needs_attention',oauthStage:'provider_authorization'}));
`);
    await fs.writeFile(path.join(dir, 'scripts/Close-AgentRouterLogin.ps1'), `param($AccountKey)
if ($AccountKey -ne 'linuxdo') {throw 'wrong account'}
Remove-Item -LiteralPath ${quote(path.join(dir, 'tmp/agentrouter-manual-state.json'))}
Set-Content -LiteralPath ${quote(path.join(dir, 'tmp/closed.txt'))} -Value 'closed'
`);
    await fs.writeFile(path.join(dir, 'scripts/Run-Checkin.ps1'), `
param($ReauthAccountKey,[switch]$PostOAuthVerify,$Attempts,[switch]$SuppressReport)
if ($ReauthAccountKey -ne 'linuxdo' -or -not $PostOAuthVerify -or $Attempts -ne 1) {exit 9}
Set-Content -LiteralPath ${quote(path.join(dir, 'tmp/verified.txt'))} -Value 'verified'
exit 0
`);
    await fs.writeFile(path.join(dir, 'scripts/Complete-AgentRouterLogin.ps1'), `param($AccountKey,$ExpectedLaunchMarker)
$state=Get-Content -Raw ${quote(path.join(dir, 'tmp/agentrouter-manual-state.json'))}|ConvertFrom-Json
if($state.launchMarker -cne $ExpectedLaunchMarker -or $state.accountKey -ne $AccountKey) {throw 'wrong completion identity'}
& ${quote(path.join(dir, 'scripts/Close-AgentRouterLogin.ps1'))} -AccountKey $AccountKey
& pwsh -NoProfile -NonInteractive -File ${quote(path.join(dir, 'scripts/Run-Checkin.ps1'))} -ReauthAccountKey $AccountKey -PostOAuthVerify -Attempts 1 -SuppressReport
exit $LASTEXITCODE
`);
    const { stdout } = await exec('pwsh', ['-NoProfile', '-NonInteractive', '-File', path.join(dir, 'scripts/Open-AgentRouterLogin.ps1'),
      '-AccountKey', 'linuxdo'], { cwd: dir, windowsHide: true, timeout: 30000 });
    assert.equal((await fs.readFile(path.join(dir, 'tmp/launches.txt'), 'utf8')).trim(), 'launch');
    assert.equal((await fs.readFile(path.join(dir, 'tmp/attempts.txt'), 'utf8')).trim(), automaticAllowed ? 'automatic\nnative' : 'native');
    if (!successful) assert.equal((await fs.readFile(path.join(dir, 'tmp/continuations.txt'), 'utf8')).trim(), 'resume');
    if (successful || continuationSucceeds) {
      assert.match(stdout, /reward was authoritatively verified/);
      assert.equal((await fs.readFile(path.join(dir, 'tmp/verified.txt'), 'utf8')).trim(), 'verified');
      await assert.rejects(fs.access(path.join(dir, 'tmp/agentrouter-manual-state.json')), { code: 'ENOENT' });
    } else {
      const state = JSON.parse(await fs.readFile(path.join(dir, 'tmp/agentrouter-manual-state.json'), 'utf8'));
      assert.equal(state.stage, 'agentrouter');
      assert.equal(state.handoffStage, 'provider_authorization');
      assert.equal(state.accountKey, 'linuxdo');
      await assert.rejects(fs.access(path.join(dir, 'tmp/closed.txt')), { code: 'ENOENT' });
      await assert.rejects(fs.access(path.join(dir, 'tmp/verified.txt')), { code: 'ENOENT' });
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
