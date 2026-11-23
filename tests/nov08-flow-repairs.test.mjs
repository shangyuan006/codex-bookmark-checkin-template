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
import { mergeAuthoritativeDailyResults } from '../src/logger.mjs';
import { recordManualSessionClosure } from '../src/manual-session-lifecycle.mjs';
import { continueControlledManualSession, continuationInspectionRule } from '../src/manual-native-continuation.mjs';
import { runConfiguredDailyFormCheckin } from '../src/daily-form-checkin.mjs';
import { runTargetFirstLinuxDoOAuthWithRetry } from '../src/reauth-checkin.mjs';

const exec = promisify(execFile), origin = 'https://repair.example';
const now = () => new Date();
const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now()).replaceAll('-', '');
const signed = (target = { origin }) => bindSuccessEvidence({ ...target, status: 'already_signed',
  evidence: successEvidence('page_text', 'page_completion_text') }, target, {});
const report = results => ({ runId: day() + '-120000', runState: 'final', isComplete: true,
  plannedTotal: results.length, processedTotal: results.length, finishedAt: now().toISOString(), results });
const quote = value => "'" + value.replaceAll("'", "''") + "'";
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nov08-flow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of ['tmp','config','logs','src','scripts']) await fs.mkdir(path.join(root, dir));
  return root;
}

test('bound success replaces an omitted failure reason and preserves its history', () => {
  const prior = { origin, status: 'interactive_challenge', reason: 'Cloudflare 验证未通过', failureCode: 'cloudflare_verification_unresolved' };
  const completion = signed();
  const merged = mergeAuthoritativeDailyResults(report([prior]), report([completion]));
  assert.equal(merged.results[0].status, 'already_signed');
  assert.doesNotMatch(merged.results[0].reason, /未通过/);
  assert.equal(merged.results[0].failureCode, null);
  assert.equal(merged.results[0].observationHistory.at(-1).reason, prior.reason);
});

test('delayed observations never resubmit an attempted form or calendar action', () => {
  for (const [mode, expected] of [['execute-daily-form','verify-daily-form'], ['execute-calendar','verify-calendar']]) {
    assert.equal(continuationInspectionRule({ mode }, { submissionAttempted: true }, true).mode, expected);
    assert.equal(continuationInspectionRule({ mode }, { actionAttempted: false }, true).mode, mode);
  }
});

test('retained continuation observes a pending click, then caches only bound completion', async t => {
  const root = await fixture(t), bookmarksPath = path.join(root, 'Bookmarks');
  await fs.writeFile(bookmarksPath, JSON.stringify({ roots: { synced: { type: 'folder', name: 'Container', children: [
    { type: 'folder', name: 'Daily', children: [{ type: 'url', name: 'Fixture', url: origin + '/' }] },
  ] } } }));
  const config = { bookmarksPath, mobileFolderNames: ['Container'], targetFolderNames: ['Daily'],
    automationUserDataDir: path.join(root, 'data/profile'), nativeChallengePreflight: [{ url: origin + '/',
      action: { actionTexts: ['立即签到'], clickChallenge: true } }] };
  await fs.writeFile(path.join(root, 'config/config.json'), JSON.stringify(config));
  const state = { mode: 'native', controlledCheckin: true, windowReady: true, profile: config.automationUserDataDir,
    nativeDebugPort: 27123, launchMarker: 'a'.repeat(32), targetCount: 1, targets: [{ origin }] };
  await continueControlledManualSession(root, config, state, {
    inspect: async () => ({ status: 'interactive_challenge', actionAttempted: true }),
  });
  const complete = await continueControlledManualSession(root, config, state, { readyOnly: true,
    inspect: async (target, rule) => {
      assert.equal(rule.mode, 'verify-checkin');
      assert.equal(rule.action.clickChallenge, false);
      return signed(target);
    } });
  assert.equal(complete.unresolvedCount, 0);
  await continueControlledManualSession(root, config, state, { readyOnly: true,
    inspect: async () => assert.fail('confirmed page must not be revisited') });
  const otherSession = { ...state, launchMarker: 'b'.repeat(32) };
  const pending = await continueControlledManualSession(root, config, otherSession, { readyOnly: true,
    inspect: async (_target, rule) => {
      assert.equal(rule.mode, 'execute-checkin', 'another session cannot borrow the previous click');
      return { status: 'already_signed' };
    } });
  assert.equal(pending.unresolvedCount, 1, 'bare status never authorizes closure');
});

test('closure history distinguishes completed and unconfirmed windows without private page data', async t => {
  const root = await fixture(t), state = { sessionId: 'a'.repeat(32), mode: 'live_checkin', targets: [{ origin }] };
  const entry = await recordManualSessionClosure(root, state, report([signed()]), {});
  assert.equal(entry.closeReason, 'completed');
  assert.equal(entry.completionConfirmed, true);
  const pending = await recordManualSessionClosure(root, { ...state, sessionId: 'b'.repeat(32) },
    report([{ origin, status: 'signed' }]), {}, { reason: 'completed' });
  assert.equal(pending.closeReason, 'external_close');
  assert.equal(pending.completionConfirmed, false);
  assert.deepEqual(Object.keys(entry.targets[0]).sort(), ['accountKey','completedAt','origin','status']);
});

test('an expired human request reports completed targets and the successful closure reason', async t => {
  const root = await fixture(t), identity = 'a'.repeat(32), requestId = 'c'.repeat(64);
  for (const name of ['Get-ManualHandoffStatus','Resolve-Runtime','AgentRouterAccount','ManualInteraction',
    'ManualAbandonment','ManualVerification','ResultContract','CheckinContract.generated','CheckinCycle']) {
    await fs.copyFile(path.resolve(`scripts/${name}.ps1`), path.join(root, `scripts/${name}.ps1`));
  }
  await fs.writeFile(path.join(root, 'config/config.json'), JSON.stringify({ automationUserDataDir: path.join(root, 'data/profile') }));
  const unrelated = 'https://unrelated.example';
  const completedReport = report([signed(), { origin: unrelated, status: 'needs_attention' }]);
  await fs.writeFile(path.join(root, 'logs/latest.json'), JSON.stringify(completedReport));
  await recordManualSessionClosure(root, { sessionId: identity, mode: 'live_checkin', targets: [{ origin }, { origin: unrelated }] }, completedReport, {});
  await fs.writeFile(path.join(root, 'tmp/manual-interaction-requests.json'), JSON.stringify([{ requestId, identities: [identity], targets: [{ origin }] }]));
  const { stdout } = await exec(powershellExecutable, ['-NoProfile', '-File', 'scripts/Get-ManualHandoffStatus.ps1',
    '-ExpectedRequestId', requestId], { cwd: root, windowsHide: true, timeout: 15000 });
  const status = JSON.parse(stdout);
  assert.equal(status.expired, true);
  assert.equal(status.mayAskUser, false);
  assert.equal(status.activeSessionCount, 0);
  assert.equal(status.requestState, 'completed');
  assert.equal(status.resolvedTargets[0].origin, origin);
  assert.deepEqual(status.resolvedTargets.map(target => target.origin), [origin]);
  assert.deepEqual(status.unavailableTargets, [], 'another target in the same window is outside this request');
  assert.equal(status.closedSessions[0].closeReason, 'external_close', 'window-wide reason is preserved');
  assert.deepEqual(status.closedSessions[0].targets.map(target => target.origin), [origin]);
  // A lost closure event cannot silently erase an unresolved requested target.
  const missing = 'https://missing.example';
  await fs.writeFile(path.join(root, 'tmp/manual-interaction-requests.json'), JSON.stringify([
    { requestId, identities: [identity], targets: [{ origin }, { origin: missing }] },
  ]));
  const second = await exec(powershellExecutable, ['-NoProfile', '-File', 'scripts/Get-ManualHandoffStatus.ps1',
    '-ExpectedRequestId', requestId], { cwd: root, windowsHide: true, timeout: 15000 });
  const incomplete = JSON.parse(second.stdout);
  assert.equal(incomplete.requestState, 'window_closed');
  assert.equal(incomplete.activeSessionCount, 0);
  assert.deepEqual(incomplete.unavailableTargets.map(target => target.origin), [missing]);
});

test('the background observer continues delayed readiness and closes after confirmed completion', async t => {
  const root = await fixture(t), marker = 'd'.repeat(32);
  await fs.copyFile(path.resolve('scripts/Watch-ManualCheckin.ps1'), path.join(root, 'scripts/Watch-ManualCheckin.ps1'));
  await fs.copyFile(path.resolve('scripts/Resolve-Runtime.ps1'), path.join(root, 'scripts/Resolve-Runtime.ps1'));
  await fs.writeFile(path.join(root, 'scripts/Resume-ManualCheckin.ps1'), `param([switch]$ReadyOnly,[switch]$Json)
    if(-not $ReadyOnly){throw 'must not restart verification clicks'}
    $global:passes++; @{unresolvedCount=if($global:passes -ge 2){0}else{1}}|ConvertTo-Json -Compress`);
  await fs.writeFile(path.join(root, 'scripts/Close-ManualLogin.ps1'), `
    if($global:passes -lt 2){throw 'premature close'}
    Remove-Item -LiteralPath tmp/manual-session.json`);
  const { stdout } = await exec(powershellExecutable, ['-NoProfile','-Command', `
    $global:passes=0
    @{launchMarker=${quote(marker)};controlledCheckin=$true;pid=$PID;processStartedAt=(Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o')}|ConvertTo-Json|Set-Content tmp/manual-session.json
    & ./scripts/Watch-ManualCheckin.ps1 -SessionMarker ${quote(marker)}
    @{passes=$global:passes;retained=(Test-Path tmp/manual-session.json)}|ConvertTo-Json -Compress
  `], { cwd: root, windowsHide: true, timeout: 20000 });
  assert.deepEqual(JSON.parse(stdout), { passes: 2, retained: false });
  const stale = await exec(powershellExecutable, ['-NoProfile','-Command', `
    $global:passes=0
    @{launchMarker=${quote(marker)};controlledCheckin=$true;pid=$PID;processStartedAt=(Get-Date).AddDays(-1).ToString('o')}|ConvertTo-Json|Set-Content tmp/manual-session.json
    & ./scripts/Watch-ManualCheckin.ps1 -SessionMarker ${quote(marker)}
    @{passes=$global:passes;retained=(Test-Path tmp/manual-session.json)}|ConvertTo-Json -Compress
  `], { cwd: root, windowsHide: true, timeout: 10000 });
  assert.deepEqual(JSON.parse(stale.stdout), { passes: 0, retained: true }, 'reused PID must not trigger a click or a close');
});

for (const scenario of ['challenge','callback','login_form','success']) test(`automatic native OAuth fallback: ${scenario}`, async () => {
  const rule = { provider: 'LinuxDO', linuxDoSessionStrategy: 'target_oauth', oauthAttempts: 1 };
  const automatic = { challenge: { succeeded: false, oauthStage: 'provider_authorization', authorizationOutcome: 'provider_challenge_unresolved' },
    callback: { succeeded: false, oauthStage: 'target_callback', authorizationOutcome: 'authorization_departed', callbackWaitDiagnostics: { outcome: 'target_not_returned' } },
    login_form: { succeeded: false, oauthStage: 'linuxdo_provider_login_required' }, success: { succeeded: true, oauthStage: 'completed' } }[scenario];
  let nativeCalls = 0, helperCalls = 0;
  const result = await runTargetFirstLinuxDoOAuthWithRetry(rule, {}, rule, {
    runHelper: async (_rule, _config, _account, args) => { helperCalls++; assert.deepEqual(args, []); return automatic; },
    runNative: async () => { nativeCalls++; return { succeeded: true, oauthStage: 'completed' }; },
  });
  assert.equal(helperCalls, 1);
  assert.equal(nativeCalls, ['challenge','callback'].includes(scenario) ? 1 : 0);
  assert.equal(result.succeeded, scenario !== 'login_form');
});

test('native automatic recovery consumes only the existing isolated logout flow', async t => {
  const root = await fixture(t);
  for (const name of ['Invoke-AgentRouterNativeRecovery','AgentRouterAccount']) await fs.copyFile(path.resolve(`scripts/${name}.ps1`), path.join(root, `scripts/${name}.ps1`));
  await fs.writeFile(path.join(root, 'config/config.json'), JSON.stringify({ agentrouterAccounts: [{ origin: 'https://agentrouter.org',
    accountKey: 'linuxdo', provider: 'LinuxDO', linuxDoSessionStrategy: 'target_oauth', automationUserDataDir: 'data/profile' }] }));
  await fs.writeFile(path.join(root, 'scripts/Resolve-Runtime.ps1'), `
    function Resolve-CheckinNode {param($Config) ${quote(process.execPath)}}
    function Resolve-CheckinBrowser {param($Config) @{Executable='fixture'}}
    function Get-CheckinProfileBrowserProcesses {param($Config,$ProfilePath)
      if($global:fixtureOwned){[pscustomobject]@{ProcessId=123;CommandLine="--checkin-launch=$marker"}}
    }
    function Start-Process {param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru)
      if($WindowStyle -ne 'Hidden' -or $ArgumentList -notcontains '--window-position=-32000,-32000'){throw 'not offscreen'}
      $global:fixtureOwned=$true; [pscustomobject]@{Id=123;StartTime=[datetime]'2026-01-01T00:00:00Z'}
    }
    function Get-CheckinManualSessionBrowserProcesses {param($Config,$ProfilePath,$State)
      if($global:fixtureOwned){[pscustomobject]@{ProcessId=123}}
    }
    function Get-Process {param($Id,$ErrorAction)
      $p=[pscustomobject]@{MainWindowHandle=1}
      $p|Add-Member -MemberType ScriptMethod -Name CloseMainWindow -Value {$global:fixtureOwned=$false;return $true};$p
    }`);
  await fs.writeFile(path.join(root, 'src/prepare-native-browser-profile.mjs'), 'process.exitCode=0;');
  await fs.writeFile(path.join(root, 'src/probe-agentrouter-session.mjs'), 'console.log(JSON.stringify({action:"resume",nativeAllowed:true}));');
  await fs.writeFile(path.join(root, 'src/oauth-login.mjs'), `
    import fs from 'node:fs';
    const args=process.argv.slice(2);
    if(args.includes('--provider-only')||!args.includes('--native-cdp-port'))throw Error('wrong flow');
    fs.writeFileSync('tmp/native-call.json',JSON.stringify(args));
    console.log(JSON.stringify({status:'logged_in',oauthStage:'completed'}));`);
  const { stdout } = await exec(powershellExecutable, ['-NoProfile','-File','scripts/Invoke-AgentRouterNativeRecovery.ps1',
    '-AccountKey','linuxdo'], { cwd: root, windowsHide: true, timeout: 15000 });
  assert.equal(JSON.parse(stdout).status, 'logged_in');
  const args = JSON.parse(await fs.readFile(path.join(root, 'tmp/native-call.json'), 'utf8'));
  assert.ok(args.includes('automatic_native_target'));
  assert.equal(args.filter(value => value === 'https://agentrouter.org').length, 1);
  await assert.rejects(fs.access(path.join(root, 'tmp/agentrouter-manual-state.json')), { code: 'ENOENT' });
});

test('offline Edge submits a delayed verified form once without reloading its document', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 30000,
}, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<a href="/logout.php">退出</a>' }));
  await page.goto(origin + '/daily.php');
  const config = { checkinStateWaitMs: 1000, preCheckinNavigationRules: { [origin]: {
    expectedPath: '/daily.php', steps: [{ role: 'link', name: '签到入口' }], completedTextPattern: '连续签到.*获得.*魔力',
    dailyUnsignedForm: { visibleSelectors: ['form button'], nonEmptyValueSelectors: ['[name=sign_token]', '[name=sign_submit]'],
      emptyValueSelectors: ['[name=cf-turnstile-response]'], actionText: '提交签到', pendingChallenge: 'turnstile', continuationWaitMs: 30000 },
  } } };
  await page.evaluate(() => {
    window.retained = document; window.submits = 0;
    document.body.insertAdjacentHTML('beforeend', '<form><input name="sign_token" value="fixture"><input name="sign_submit" value="1">'
      + '<input name="cf-turnstile-response" value=""><div class="cf-turnstile"></div><button disabled>提交签到</button></form>');
    document.querySelector('.cf-turnstile').style = 'width:300px;height:70px';
    document.querySelector('form').onsubmit = event => { event.preventDefault(); window.submits++;
      event.target.remove(); document.body.insertAdjacentHTML('beforeend','<p>连续签到 1 天，获得魔力</p>'); };
  });
  const pending = await runConfiguredDailyFormCheckin(page, { origin }, config, { waitMs: 0, retainedOnly: true });
  assert.equal(pending.actionAttempted, false);
  await page.evaluate(() => { document.querySelector('[name=cf-turnstile-response]').value = 'fixture-ready';
    document.querySelector('.cf-turnstile').remove(); document.querySelector('button').disabled = false; });
  const complete = await runConfiguredDailyFormCheckin(page, { origin }, config, { waitMs: 0, retainedOnly: true });
  assert.equal(complete.status, 'signed', JSON.stringify(complete));
  assert.deepEqual(await page.evaluate(() => [window.submits, window.retained === document]), [1, true]);
  assert.equal((await runConfiguredDailyFormCheckin(page, { origin }, config, { waitMs: 0, retainedOnly: true })).status, 'signed');
  assert.equal(await page.evaluate(() => window.submits), 1);
});
