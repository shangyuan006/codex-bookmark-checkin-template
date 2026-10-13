import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { linuxDoAuthorizationRequiresLogin } from '../src/oauth-linuxdo-login.mjs';
import { reauthLoginFailureResult, shouldRetryOAuthFailureStage } from '../src/reauth-checkin.mjs';
import { isConfiguredProviderAuthorizationPage, authorizeConfiguredOAuthProvider } from '../src/oauth-provider-authorization.mjs';
const exec = promisify(execFile);
const fakePage = (url, password = false) => ({ url: () => url, locator: () => ({ count: async () => password ? 1 : 0 }) });

test('only an official LinuxDO login surface routes back to provider recovery', async () => {
  assert.equal(await linuxDoAuthorizationRequiresLogin(fakePage('https://linux.do/login', true), 'LinuxDO'), true);
  assert.equal(await linuxDoAuthorizationRequiresLogin(fakePage('https://linux.do/login'), 'LinuxDO'), false);
  assert.equal(await linuxDoAuthorizationRequiresLogin(fakePage('https://linux.do/', true), 'LinuxDO'), true);
  for (const url of ['https://linux.do/', 'https://connect.linux.do/oauth2/authorize', 'https://target.example/login',
    'https://linux.do.evil.example/login', 'http://linux.do/login']) {
    assert.equal(await linuxDoAuthorizationRequiresLogin(fakePage(url), 'LinuxDO'), false);
  }
  assert.equal(await linuxDoAuthorizationRequiresLogin(fakePage('https://linux.do/login'), 'GitHub'), false);
});

test('production authorization stage reports a provider login redirect rather than completed authorization', async () => {
  const source = await fs.readFile(new URL('../src/oauth-login.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  if (isConfiguredProviderAuthorizationPage(page.url(), provider)) {');
  const end = source.indexOf('\n  setOAuthStage("target_callback");', start);
  assert.ok(start >= 0 && end > start);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction('page', 'isConfiguredProviderAuthorizationPage', 'linuxDoAuthorizationRequiresLogin', `
    const provider='LinuxDO', providerWaitMs=1000, privateResult=false, config={};
    let oauthStage=null, authorizationOutcome=null, providerAuthorizationChallengeOutcome=null, providerAuthorizationChallengeClicks=0;
    const setOAuthStage=value=>{oauthStage=value;};
    const authorizeConfiguredOAuthProvider=async()=>({clicked:true,outcome:'authorization_clicked'});
    const describeConfiguredAuthorizationSurface=async()=>({challengeFrameCount:0});
    const clickConfiguredLoginChallengeControl=async()=>false;
    try { ${source.slice(start, end)} } catch {}
    return {oauthStage,authorizationOutcome};
  `);
  for (const destination of ['https://linux.do/login', 'https://target.example/callback']) {
    let current = 'https://connect.linux.do/oauth2/authorize';
    const page = { ...fakePage(current, destination.includes('linux.do')), url: () => current,
      waitForTimeout: async () => { current = destination; }, waitForLoadState: async () => {} };
    const result = await execute(page, isConfiguredProviderAuthorizationPage, linuxDoAuthorizationRequiresLogin);
    if (destination.includes('linux.do')) {
      assert.deepEqual(result, { oauthStage: 'linuxdo_provider_login_required', authorizationOutcome: 'provider_login_required' });
    } else assert.equal(result.authorizationOutcome, 'authorization_departed');
  }
});

test('provider-login expiry is a non-retryable handoff with a precise reason', () => {
  const result = reauthLoginFailureResult('LinuxDO', 'linuxdo_provider_login_required');
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.retryable, false);
  assert.match(result.reason, /授权跳回提供方登录表单/);
  assert.equal(shouldRetryOAuthFailureStage('linuxdo_provider_login_required'), false);
});

test('production OAuth handles consent and approval challenges before entering target callback', async () => {
  const source = await fs.readFile(new URL('../src/oauth-login.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  if (isConfiguredProviderAuthorizationPage(page.url(), provider)) {');
  const end = source.indexOf('\n  setOAuthStage("target_callback");', start);
  assert.ok(start >= 0 && end > start);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction('page', 'isConfiguredProviderAuthorizationPage', 'authorizeConfiguredOAuthProvider',
    'clickConfiguredLoginChallengeControl', 'describeConfiguredAuthorizationSurface', 'clock', `
    const Date={now:()=>clock.value}, provider='LinuxDO', providerWaitMs=5000, privateResult=false, config={};
    const linuxDoAuthorizationRequiresLogin=async()=>false;
    let oauthStage=null, authorizationOutcome=null, providerAuthorizationChallengeOutcome=null, providerAuthorizationChallengeClicks=0;
    const setOAuthStage=value=>{oauthStage=value;};
    let failed=false;
    try { ${source.slice(start, end)} } catch {failed=true;}
    return {failed,oauthStage,authorizationOutcome,providerAuthorizationChallengeClicks};
  `);
  for (const blockedApproval of [false, true]) {
    const clock = { value: 0 };
    let phase = 'initial_challenge', consentClicks = 0, approvalClicked = false, approvalWaits = 0;
    const page = {
      url: () => phase === 'callback' ? 'https://target.example/callback'
        : phase === 'approval' ? 'https://connect.linux.do/oauth2/approve/fixture-request'
        : 'https://connect.linux.do/oauth2/authorize',
      getByText: text => ({ count: async () => text === '允许' && ['consent','approval'].includes(phase) ? 1 : 0,
        nth: () => ({ isVisible: async () => true, locator: () => ({ count: async () => 0 }),
          click: async () => { consentClicks += 1; phase = 'approval'; } }) }),
      locator: () => ({ count: async () => 0 }),
      waitForLoadState: async () => {},
      waitForTimeout: async ms => {
        clock.value += ms;
        if (phase === 'approval' && approvalClicked && !blockedApproval && ++approvalWaits === 2) phase = 'callback';
      },
    };
    const clickChallenge = async () => {
      if (phase === 'initial_challenge') { phase = 'consent'; return true; }
      if (phase === 'approval' && !approvalClicked) { approvalClicked = true; return true; }
      return false;
    };
    const describe = async () => ({ challengeFrameCount: ['initial_challenge','approval'].includes(phase) ? 1 : 0 });
    const result = await execute(page, isConfiguredProviderAuthorizationPage, authorizeConfiguredOAuthProvider, clickChallenge, describe, clock);
    assert.equal(consentClicks, 1, 'Never resubmit consent on the approval page');
    assert.equal(result.providerAuthorizationChallengeClicks, 2);
    assert.equal(result.failed, blockedApproval);
    assert.equal(result.authorizationOutcome, blockedApproval ? 'provider_challenge_unresolved' : 'authorization_departed');
    assert.equal(result.oauthStage, 'provider_authorization');
    assert.ok(clock.value <= 5500, 'Unresolved approval must have a finite wait');
  }
});

test('production native fallback opens only LinuxDO and records sequential continuation', async () => {
  const source = await fs.readFile(new URL('../scripts/Open-AgentRouterLogin.ps1', import.meta.url), 'utf8');
  const start = source.indexOf('    $safeOAuthStages = @(');
  const end = source.indexOf('\n$arguments = @(', start);
  assert.ok(start >= 0 && end > start);
  const { stdout } = await exec('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference='Stop'; $provider='LinuxDO'; $requestedAccountKey='sso'; $AgentRouterOnly=$true
    $ProviderOnly=$false; $ContinueToAgentRouter=$false; $providerChallengeHandoff=$true
    $browser=[pscustomobject]@{ProcessName='fixture.exe'}; $profile='fixture'
    $automaticResult=[pscustomobject]@{oauthStage='linuxdo_provider_login_required';authorizationOutcome='provider_login_required'}
    function Get-CimInstance { @() }; function Get-AgentRouterTargetCompletionProbe { 'unconfirmed' }
    if ($true) {
    ${source.slice(start, end)}
    [pscustomobject]@{providerOnly=[bool]$ProviderOnly;agentRouterOnly=[bool]$AgentRouterOnly;
      continueToTarget=[bool]$ContinueToAgentRouter;urls=@($loginUrls)} | ConvertTo-Json -Compress
  `], { windowsHide: true });
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(result, { providerOnly: true, agentRouterOnly: false, continueToTarget: true, urls: ['https://linux.do/login'] });
});
