import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { powershellExecutable } from './helpers/powershell.mjs';
import { continueRetainedNativeOAuth, reserveRetainedProviderLogin } from '../src/native-oauth-continuation.mjs';
import { recoverSavedLinuxDoLogin } from '../src/oauth-linuxdo-login.mjs';
import { continueOAuthProviderReturn } from '../src/oauth-provider-return.mjs';
import { createOAuthTimeBudget } from '../src/oauth-time-budget.mjs';
import { sanitizeOAuthFlowDiagnostic } from '../src/oauth-flow-diagnostics.mjs';
import { localRunDate } from '../src/retry-policy.mjs';

const root = path.resolve(import.meta.dirname, '..'), exec = promisify(execFile);
const origin = 'https://target.example', ordinary = 'https://attendance.example';
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const config = { reauthCheckinRules: { [origin]: { accountMenuSelector: '#account' } },
  linuxDoLoginRecovery: { socialProvider: 'GitHub' } };
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nov16-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  for (const name of ['tmp', 'scripts', 'src', 'config']) await fs.mkdir(path.join(dir, name));
  return dir;
}
function socialFixture({ challenge = false, clearChallenge = true, transition = true } = {}) {
  const state = { url: 'https://linux.do/login', clock: 0, challenge, clicks: 0, reservations: 0 };
  const page = { url: () => state.url, isClosed: () => false,
    locator: selector => selector === 'input[type="password"]:visible'
      ? { count: async () => state.url.endsWith('/login') ? 1 : 0 }
      : { count: async () => state.challenge ? 1 : 0, nth: () => ({ isVisible: async () => state.challenge }) },
    getByRole: (role, { name }) => ({ count: async () => name === '使用 GitHub 登录' ? 1 : 0,
      isVisible: async () => true, click: async options => {
        assert.equal(name, '使用 GitHub 登录');
        if (!options?.trial) { state.clicks++; if (transition) state.url = 'https://connect.linux.do/oauth2/authorize'; }
      } }),
    waitForLoadState: async () => {},
    waitForTimeout: async ms => { state.clock += ms; if (clearChallenge) state.challenge = false; },
  };
  const run = (activeConfig = config) => continueRetainedNativeOAuth({ pages: () => [page] }, origin, activeConfig, {
    waitMs: 1000, timeBudget: createOAuthTimeBudget({ now: () => state.clock }),
    reserveProviderLogin: async () => ++state.reservations === 1,
    recoverLogin: (page, wait, options) => recoverSavedLinuxDoLogin(page, wait, {
      ...options, now: () => state.clock, verifySession: async () => true,
    }),
    continueProvider: (page, target, provider, active, options) => continueOAuthProviderReturn(page, target, provider, active, {
      ...options, now: () => state.clock,
      authorize: async () => { state.url = origin + '/callback'; return { clicked: true, outcome: 'authorization_clicked' }; },
    }),
    confirmTarget: async (context, target, active, options) => {
      assert.equal(options.acceptPage(page), true); assert.equal(state.url, origin + '/callback');
      return { loggedIn: true };
    },
  });
  return { state, page, run };
}

test('retained LinuxDO login waits for verification, uses configured GitHub, and continues consent', async () => {
  const f = socialFixture({ challenge: true });
  const result = await f.run();
  assert.equal(result.status, 'logged_in'); assert.equal(result.oauthStage, 'completed');
  assert.equal(result.loginRecoveryOutcome, 'login_recovered');
  assert.equal(f.state.clicks, 1); assert.equal(f.state.reservations, 1);
  assert.equal(result.evidence, undefined, 'login is not daily reward evidence');
});

test('an unresolved login challenge does not reserve or click, and the next observation can resume', async () => {
  const f = socialFixture({ challenge: true, clearChallenge: false });
  const first = await f.run();
  assert.equal(first.oauthStage, 'linuxdo_login_challenge');
  assert.equal(first.loginRecoveryOutcome, 'login_challenge_pending');
  assert.equal(f.state.clicks, 0); assert.equal(f.state.reservations, 0);
  f.state.challenge = false;
  assert.equal((await f.run()).status, 'logged_in');
  assert.equal(f.state.clicks, 1);
});

test('a submitted retained login is not clicked again by later observations', async () => {
  const f = socialFixture({ transition: false });
  assert.equal((await f.run()).loginRecoveryOutcome, 'login_submitted');
  assert.equal((await f.run()).loginRecoveryOutcome, 'login_attempt_pending');
  assert.equal(f.state.clicks, 1);
});

test('login without an explicit social preference stays manual and is classified as a login page', async () => {
  const f = socialFixture();
  const result = await f.run({ reauthCheckinRules: config.reauthCheckinRules });
  assert.equal(result.loginRecoveryOutcome, 'login_not_configured');
  assert.equal(result.currentPageKind, 'provider_login');
  assert.equal(result.continuationOutcome, 'provider_pending'); assert.equal(f.state.clicks, 0);
  const absent = await continueRetainedNativeOAuth({ pages: () => [] }, origin, config);
  assert.equal(absent.continuationOutcome, 'page_not_found');
});

test('retained login reservation is durable and cannot be borrowed by another session', async t => {
  const dir = await fixture(t), marker = randomBytes(16).toString('hex');
  const file = path.join(dir, 'tmp/state.json'), profile = path.join(dir, 'profile');
  const state = { accountKey: 'linuxdo', stage: 'agentrouter', nativeDebugPort: 23456, profile,
    pid: 123, processStartedAt: new Date().toISOString(), launchMarker: marker };
  const scope = { root: dir, accountKey: 'linuxdo', profile, port: 23456, provider: 'LinuxDO',
    native: true, stage: 'manual_target_oauth', launchMarker: marker };
  await fs.writeFile(file, JSON.stringify(state));
  assert.equal(await reserveRetainedProviderLogin(file, scope), true);
  assert.equal(await reserveRetainedProviderLogin(file, scope), false);
  const saved = await fs.readFile(file, 'utf8');
  await assert.rejects(reserveRetainedProviderLogin(file, { ...scope, launchMarker: 'b'.repeat(32) }));
  assert.equal(await fs.readFile(file, 'utf8'), saved);
});

test('OAuth diagnostics retain fixed continuation reasons while discarding private values', () => {
  const entry = { flow: 'manual_target_oauth', provider: 'LinuxDO', status: 'needs_attention',
    oauthStage: 'linuxdo_login_challenge', continuationOutcome: 'provider_pending',
    loginRecoveryOutcome: 'login_challenge_pending', currentPageKind: 'provider_login',
    flowPageKinds: ['provider_login'], url: 'https://private.example/?token=secret', password: 'x' };
  const safe = sanitizeOAuthFlowDiagnostic(entry);
  assert.equal(safe.continuationOutcome, 'provider_pending');
  assert.equal(safe.loginRecoveryOutcome, 'login_challenge_pending');
  assert.equal(safe.currentPageKind, 'provider_login'); assert.doesNotMatch(JSON.stringify(safe), /secret|private\.example/);
  assert.equal(safe.password, undefined);
  const invalid = sanitizeOAuthFlowDiagnostic({ ...entry, continuationOutcome: 'secret', loginRecoveryOutcome: 'secret' });
  assert.equal(invalid.continuationOutcome, undefined); assert.equal(invalid.loginRecoveryOutcome, undefined);
});

async function continuationFixture(t) {
  const dir = await fixture(t), marker = randomBytes(16).toString('hex');
  const resumeSource = await fs.readFile(path.join(root, 'scripts/Resume-ManualCheckin.ps1'), 'utf8');
  await fs.writeFile(path.join(dir, 'scripts/Resume-ManualCheckin.ps1'), resumeSource.replace(
    '$sessionMarker = [string]$state.launchMarker',
    '$sessionMarker = [string]$state.launchMarker\n[IO.File]::WriteAllText((Join-Path $root "tmp/session-read"), $sessionMarker)'));
  await fs.writeFile(path.join(dir, 'config/config.json'), JSON.stringify({ runMutexName: `Local\\Nov16Run_${marker}` }));
  await fs.writeFile(path.join(dir, 'tmp/manual-session.json'), JSON.stringify({ launchMarker: marker, targetCount: 1,
    mode: 'native', controlledCheckin: true, windowReady: true, nativeDebugPort: 23456,
    pid: process.pid, processStartedAt: new Date().toISOString() }));
  await fs.writeFile(path.join(dir, 'scripts/Resolve-Runtime.ps1'), `
function Get-CheckinManualSessionBrowserProcesses {param($Config,$ProfilePath,$State)
 [pscustomobject]@{ProcessId=${process.pid};CommandLine='--remote-debugging-port=23456 --remote-debugging-address=127.0.0.1'}}
function Test-CheckinProcessStartIdentity {param($Process,$RecordedStart,$ToleranceSeconds) $true}
function ConvertTo-CheckinUtcDateTime {param($Value) [datetime]$Value}
function Resolve-CheckinNode {param($Config) ${quote(process.execPath)}}`);
  await fs.writeFile(path.join(dir, 'src/manual-native-continuation.mjs'),
    `import fs from 'node:fs';fs.appendFileSync('tmp/calls','1');console.log(JSON.stringify({processedCount:1,completedCount:0,unresolvedCount:1}));`);
  const resume = (...args) => exec(powershellExecutable, ['-NoProfile', '-NonInteractive', '-File',
    path.join(dir, 'scripts/Resume-ManualCheckin.ps1'), '-Json', ...args], { cwd: dir, windowsHide: true, timeout: 15000 })
    .then(result => JSON.parse(result.stdout));
  return { dir, marker, resume };
}
async function holdMutex(t, name) {
  const command = `$m=[Threading.Mutex]::new($false,${quote(name)});$null=$m.WaitOne();[Console]::Out.WriteLine('READY');[Console]::Out.Flush();try{$null=[Console]::In.ReadLine()}finally{$m.ReleaseMutex();$m.Dispose()}`;
  const child = spawn(powershellExecutable, ['-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const [ready] = await once(child.stdout, 'data'); assert.match(String(ready), /READY/);
  return () => child.stdin.end('\n');
}

for (const owner of ['observer', 'run']) test(`continuation distinguishes ${owner} contention without touching the page`,
  { skip: process.platform !== 'win32' }, async t => {
    const f = await continuationFixture(t);
    const release = await holdMutex(t, owner === 'observer' ? `Local\\CheckinManualContinue_${f.marker}` : `Local\\Nov16Run_${f.marker}`);
    const result = await f.resume('-ReadyOnly');
    assert.equal(result.state, 'busy');
    assert.equal(result.reason, owner === 'observer' ? 'manual_continuation_busy' : 'run_busy');
    assert.equal(result.retryable, true); assert.equal(result.completionConfirmed, false);
    assert.equal(result.unresolvedCount, 1);
    await assert.rejects(fs.access(path.join(f.dir, 'tmp/calls')));
    release();
  });

for (const change of ['none', 'closed', 'replaced']) test(`waiting continuation rechecks session identity after lock release: ${change}`,
  { skip: process.platform !== 'win32' }, async t => {
    const f = await continuationFixture(t), release = await holdMutex(t, `Local\\CheckinManualContinue_${f.marker}`);
    const pending = f.resume('-WaitSeconds', '5');
    const deadline = Date.now() + 8000;
    while (await fs.readFile(path.join(f.dir, 'tmp/session-read'), 'utf8').catch(() => '') !== f.marker) {
      assert.ok(Date.now() < deadline, 'continuation did not capture its original session identity');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const file = path.join(f.dir, 'tmp/manual-session.json');
    if (change === 'closed') await fs.unlink(file);
    if (change === 'replaced') {
      const state = JSON.parse(await fs.readFile(file)); state.launchMarker = 'b'.repeat(32);
      await fs.writeFile(file, JSON.stringify(state));
    }
    release(); const result = await pending;
    assert.equal(result.state, change === 'none' ? 'continued' : change === 'closed' ? 'session_closed' : 'session_changed');
    if (change === 'none') assert.equal(await fs.readFile(path.join(f.dir, 'tmp/calls'), 'utf8'), '1');
    else await assert.rejects(fs.access(path.join(f.dir, 'tmp/calls')));
  });

for (const scenario of ['independent', 'shared_profile', 'unknown_account', 'missing_account', 'overlap']) test(`partial abandonment with a dedicated account window: ${scenario}`,
  { skip: process.platform !== 'win32' }, async t => {
    const dir = await fixture(t), marker = randomBytes(16).toString('hex');
    for (const name of ['Set-TodayAbandonment', 'ManualAbandonment', 'ManualVerification', 'ResultContract', 'CheckinContract.generated', 'AgentRouterAccount']) {
      await fs.copyFile(path.join(root, 'scripts', name + '.ps1'), path.join(dir, 'scripts', name + '.ps1'));
    }
    const profile = path.join(dir, 'ordinary-profile'), dedicatedProfile = scenario === 'shared_profile' ? profile : path.join(dir, 'dedicated-profile');
    const selected = scenario === 'overlap' ? origin : ordinary;
    await fs.writeFile(path.join(dir, 'config/config.json'), JSON.stringify({ automationUserDataDir: profile,
      runMutexName: `Local\\Nov16Abandon_${marker}`, agentrouterAccounts: [{ accountId: 'linuxdo', origin, automationUserDataDir: dedicatedProfile }] }));
    const dedicated = JSON.stringify({ accountKey: scenario === 'unknown_account' ? 'other' : scenario === 'missing_account' ? '' : 'linuxdo', profile: dedicatedProfile, launchMarker: marker });
    const state = JSON.stringify({ schemaVersion: 2, mode: 'native', controlledCheckin: true, windowReady: true,
      sourceRunId: localRunDate() + '-120000', profile, launchMarker: marker, pid: 123,
      processStartedAt: new Date().toISOString(), nativeDebugPort: 23456, targetCount: 1, targets: [{ origin: selected }] });
    await fs.writeFile(path.join(dir, 'tmp/agentrouter-manual-state.json'), dedicated);
    await fs.writeFile(path.join(dir, 'tmp/manual-session.json'), state);
    await fs.writeFile(path.join(dir, 'scripts/Resolve-Runtime.ps1'), `
function Resolve-CheckinNode {param($Config) ${quote(process.execPath)}}
function ConvertTo-CheckinUtcDateTime {param($Value) [datetime]$Value}
function Get-CheckinManualSessionBrowserProcesses {param($Config,$State,$ProfilePath) [pscustomobject]@{ProcessId=123}}`);
    await fs.writeFile(path.join(dir, 'src/attention-urls.mjs'), `console.log(JSON.stringify({sourceRunId:'${localRunDate()}-120000',targets:[{origin:'${selected}',previousStatus:'needs_attention'}]}));`);
    const command = `$rejected=$false;try{& ${quote(path.join(dir, 'scripts/Set-TodayAbandonment.ps1'))} -Origins '${selected}' -PreserveSession|Out-Null}catch{$rejected=$true};@{rejected=$rejected;recorded=(Test-Path ${quote(path.join(dir, 'tmp/manual-abandon.json'))})}|ConvertTo-Json -Compress`;
    const result = await exec(powershellExecutable, ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: dir, windowsHide: true, timeout: 15000 });
    assert.deepEqual(JSON.parse(result.stdout), { rejected: scenario !== 'independent', recorded: scenario === 'independent' });
    assert.equal(await fs.readFile(path.join(dir, 'tmp/agentrouter-manual-state.json'), 'utf8'), dedicated);
    assert.equal(await fs.readFile(path.join(dir, 'tmp/manual-session.json'), 'utf8'), state);
    if (scenario === 'independent') {
      const abandoned = JSON.parse(await fs.readFile(path.join(dir, 'tmp/manual-abandon.json')));
      assert.deepEqual(abandoned.origins, [ordinary]);
    }
  });

test('save-close retains a controlled window when continuation reports busy even with an empty count',
  { skip: process.platform !== 'win32' }, async t => {
    const dir = await fixture(t), profile = path.join(dir, 'profile');
    for (const name of ['Close-ManualLogin', 'ManualAbandonment']) {
      await fs.copyFile(path.join(root, 'scripts', name + '.ps1'), path.join(dir, 'scripts', name + '.ps1'));
    }
    await fs.writeFile(path.join(dir, 'config/config.json'), JSON.stringify({ automationUserDataDir: profile }));
    await fs.writeFile(path.join(dir, 'tmp/manual-session.json'), JSON.stringify({ schemaVersion: 2, mode: 'native',
      controlledCheckin: true, pid: 123, profile, launchMarker: 'a'.repeat(32), processStartedAt: new Date().toISOString(),
      targetCount: 1, targets: [{ origin: ordinary }] }));
    await fs.writeFile(path.join(dir, 'scripts/Resolve-Runtime.ps1'), `
function Get-CheckinManualSessionBrowserProcesses {param($Config,$ProfilePath,$State) [pscustomobject]@{ProcessId=123}}
function ConvertTo-CheckinUtcDateTime {param($Value) [datetime]$Value}
function Test-CheckinProcessStartIdentity {param($Process,$RecordedStart,$ToleranceSeconds) $true}
function Get-Process {param($Id,$ErrorAction)
 $p=[pscustomobject]@{MainWindowHandle=1};$p|Add-Member ScriptMethod CloseMainWindow {$global:closed=$true;return $true};$p}`);
    await fs.writeFile(path.join(dir, 'scripts/Resume-ManualCheckin.ps1'),
      `param([switch]$ReadyOnly,[switch]$Json) '{"state":"busy","message":"busy","unresolvedCount":0}'`);
    const command = `$global:closed=$false;& ${quote(path.join(dir, 'scripts/Close-ManualLogin.ps1'))}|Out-Null;@{closed=$global:closed;retained=(Test-Path ${quote(path.join(dir, 'tmp/manual-session.json'))})}|ConvertTo-Json -Compress`;
    const result = await exec(powershellExecutable, ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: dir, windowsHide: true, timeout: 15000 });
    assert.deepEqual(JSON.parse(result.stdout), { closed: false, retained: true });
  });

test('offline Edge resumes GitHub login after an actual hCaptcha overlay clears', async t => {
  let browser;
  try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  catch { t.skip('Edge runtime unavailable'); return; }
  t.after(() => browser.close());
  const context = await browser.newContext(); let githubClicks = 0;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://linux.do' && url.pathname === '/session/current.json') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ current_user: {} }) });
    }
    const body = url.origin === origin ? '<button id="account">Account</button>'
      : url.origin === 'https://connect.linux.do' ? `<form action="${origin}/callback"><button>允许</button></form>`
        : `<div class="modal-container"><div class="captcha-container" style="position:fixed;inset:0;background:white">Verification</div></div><input type="password"><button onclick="location.href='https://connect.linux.do/oauth2/authorize'">使用 GitHub 登录</button>`;
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  const page = await context.newPage(); await page.goto('https://linux.do/login');
  // The overlay disappearing represents the user's successful verification.
  await page.evaluate(() => setTimeout(() => document.querySelector('.modal-container').remove(), 200));
  const result = await continueRetainedNativeOAuth(context, origin, config, {
    waitMs: 5000, reserveProviderLogin: async () => { githubClicks++; return githubClicks === 1; },
    // APIRequestContext bypasses page routes. Keep provider session evidence
    // synthetic as well, so this fixture never contacts a real account site.
    recoverLogin: (active, timeout, options) => recoverSavedLinuxDoLogin(active, timeout, {
      ...options, verifySession: async candidate => new URL(candidate.url()).origin === 'https://connect.linux.do',
    }),
    confirmTarget: async (active, target, conf, options) => {
      await page.locator('#account').waitFor({ state: 'visible', timeout: 3000 });
      const current = new URL(page.url());
      return { loggedIn: current.origin === origin && current.pathname === '/callback' && options.acceptPage(page) };
    },
  });
  assert.equal(result.status, 'logged_in', JSON.stringify(result)); assert.equal(githubClicks, 1);
  assert.equal(context.pages().length, 1); assert.equal(result.evidence, undefined);
});
