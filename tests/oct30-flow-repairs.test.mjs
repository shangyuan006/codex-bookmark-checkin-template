import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { findUniqueOAuthProviderControl } from '../src/oauth-provider-control.mjs';
import { reauthRecoveryAction } from '../src/reauth-recovery.mjs';
import { recoverVerifiedReauthLogout } from '../src/reauth-checkin.mjs';
import { processCandidate, runConfiguredCalendarDayCheckin } from '../src/browser.mjs';
import { inspectConfiguredDailyUnsignedForm, inspectConfiguredFormCompletion, findConfiguredVerifiedFormAction } from '../src/pre-checkin-navigation.mjs';
import { createSubmissionScope, runWithSubmissionJournal, readSubmissionJournal, SUBMISSION_SCOPE } from '../src/submission-guard.mjs';
import { dailyReadinessEvidence, bindSuccessEvidence, successEvidence } from '../src/checkin-evidence.mjs';
import { powershellExecutable } from './helpers/powershell.mjs';

const origin = 'https://checkin.example';
const target = { origin };
const now = new Date('2026-10-30T04:00:00Z');
const yesterday = new Date('2026-10-29T04:00:00Z');
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oct30-repairs-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { file: path.join(directory, 'journal.json'), statePath: path.join(directory, 'reauth.json') };
}

test('calendar preflight uses the existing project profile exclusively and releases it after inspection', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-calendar-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const name of ['scripts', 'config', 'data/profile', 'tmp', 'src']) await fs.mkdir(path.join(directory, name), { recursive: true });
  for (const name of ['Prepare-NativeWafSession.ps1', 'NativePreflightCheckpoint.ps1', 'CheckinCycle.ps1', 'ResultContract.ps1', 'CheckinContract.generated.ps1']) {
    await fs.copyFile(new URL(`../scripts/${name}`, import.meta.url), path.join(directory, 'scripts', name));
  }
  const trace = path.join(directory, 'tmp/trace.jsonl');
  const quote = value => `'${String(value).replaceAll("'", "''")}'`;
  await fs.writeFile(path.join(directory, 'scripts/Resolve-Runtime.ps1'), `
    function Resolve-CheckinNode { ${quote(process.execPath)} }
    function Resolve-CheckinBrowser { [pscustomobject]@{DisplayName='Fixture Edge'} }
    function Get-CheckinProfileBrowserProcesses { if($global:FixtureBusy){ [pscustomobject]@{ProcessId=7} } }
    function Start-Sleep {}
  `);
  await fs.writeFile(path.join(directory, 'scripts/ManualAbandonment.ps1'), 'function Get-TodayAbandonedOrigins { @{} }');
  await fs.writeFile(path.join(directory, 'scripts/NativePreflightBrowserClose.ps1'), `
    function Close-NativePreflightBrowser {
      $global:FixtureBusy=$false
      [IO.File]::AppendAllText(${quote(trace)},'{"event":"close"}'+[Environment]::NewLine)
    }
  `);
  await fs.writeFile(path.join(directory, 'scripts/Open-PlainLoginChrome.ps1'), `
    param([switch]$Offscreen,[switch]$NativeMinimal,[int]$RemoteDebuggingPort,[string]$UserDataDirOverride,[string[]]$Urls)
    if($global:FixtureBusy){ throw 'Profile is already owned' }
    $global:FixtureBusy=$true
    $entry=[pscustomobject]@{event='launch';profile=$UserDataDirOverride;minimal=[bool]$NativeMinimal;urls=$Urls}
    [IO.File]::AppendAllText(${quote(trace)},($entry|ConvertTo-Json -Compress)+[Environment]::NewLine)
  `);
  await fs.writeFile(path.join(directory, 'src/native-browser-inspect.mjs'), `
    if(process.argv[5]!=='execute-calendar')process.exit(19);
    console.log(JSON.stringify({status:'already_signed',siteBodyLoaded:true,actionAttempted:false,calendarDiagnostics:{outcome:'already_signed'}}));
  `);
  const profile = path.join(directory, 'data/profile');
  await fs.writeFile(path.join(directory, 'config/config.json'), JSON.stringify({ automationUserDataDir: profile,
    nativeWafPreflightUrls: [], agentrouterAccounts: [], disabledCheckinOrigins: [], knownNoCheckinFeatureOrigins: [],
    calendarDayCheckinOrigins: [origin], nativeChallengePreflight: [{ url: origin + '/user/attendance', waitSeconds: 5,
      nativeMinimal: true, calendarDayCheckin: true, maxAttempts: 1 }] }));
  const exec = promisify(execFile);
  const command = busy => `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $global:FixtureBusy=$${busy ? 'true' : 'false'}; & ${quote(path.join(directory, 'scripts/Prepare-NativeWafSession.ps1'))} -Origins '${origin}'`;
  await assert.rejects(exec(powershellExecutable, ['-NoProfile', '-Command', command(true)], { windowsHide: true }), /正被占用/);
  await assert.rejects(fs.access(trace));
  await exec(powershellExecutable, ['-NoProfile', '-Command', command(false)], { windowsHide: true });
  const events = (await fs.readFile(trace, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(events.map(entry => entry.event), ['launch', 'close']);
  assert.equal(events[0].profile, profile);
  assert.equal(events[0].minimal, true);
  assert.deepEqual(events[0].urls, [origin + '/user/attendance']);
  const report = JSON.parse(await fs.readFile(path.join(directory, 'tmp/native-waf-preflight.json')));
  assert.equal(report.results[0].status, 'already_signed');
  assert.equal(report.results[0].calendarDiagnostics.outcome, 'already_signed');
});

test('navigation errors and missing actions leave historical uncertainty unchanged', async t => {
  for (const failure of ['throw', 'no_action']) {
    const { file } = await fixture(t);
    await createSubmissionScope(file, target, {}, { now: () => yesterday }).begin();
    const original = await readSubmissionJournal(file);
    const run = () => runWithSubmissionJournal(file, target, {}, async config => {
      if (config.checkinReadOnly) return dailyReadinessEvidence(target, {}, { now });
      assert.deepEqual(await readSubmissionJournal(file), original);
      if (failure === 'throw') throw new Error('navigation timeout');
      return { status: 'no_action', submissionAttempted: false };
    }, { now: () => now });
    if (failure === 'throw') await assert.rejects(run, /navigation timeout/);
    else assert.equal((await run()).status, 'needs_attention');
    assert.deepEqual(await readSubmissionJournal(file), original);
  }
});

test('actual uncertain submissions retain their intent and prohibit another same-day action', async t => {
  const { file } = await fixture(t);
  await createSubmissionScope(file, target, {}, { now: () => yesterday }).begin();
  let submissions = 0;
  const result = await runWithSubmissionJournal(file, target, {}, async config => {
    if (config.checkinReadOnly) return dailyReadinessEvidence(target, {}, { now });
    await config[SUBMISSION_SCOPE].begin();
    submissions++;
    throw new Error('response lost after clicking');
  }, { now: () => now });
  assert.equal(result.failureCode, 'submission_quarantined');
  assert.equal(submissions, 1);
  const scope = createSubmissionScope(file, target, {}, { now: () => now });
  await assert.rejects(scope.prepareNewCycleAfterVerifiedReadiness(dailyReadinessEvidence(target, {}, { now })), /Same-cycle/);
  await assert.rejects(scope.begin(), /禁止重复/);
});

test('a prepared continuation rechecks concurrent intents and the cycle at the actual action', async t => {
  for (const change of ['concurrent', 'midnight']) {
    const { file } = await fixture(t);
    await createSubmissionScope(file, target, {}, { now: () => yesterday }).begin();
    let clock = now;
    const scope = createSubmissionScope(file, target, {}, { now: () => clock });
    const proof = dailyReadinessEvidence(target, {}, { now });
    await scope.prepareNewCycleAfterVerifiedReadiness(proof);
    assert.equal((await readSubmissionJournal(file)).entries.length, 1);
    if (change === 'concurrent') await createSubmissionScope(file, target, {}, { now: () => now }).beginNewCycleAfterVerifiedReadiness(proof);
    else clock = new Date(now.getTime() + 86400000);
    await assert.rejects(scope.begin(), /changed before submission/);
  }
});

const reauthTarget = { origin, accountKey: 'linuxdo', actionType: 'reauth' };
const reauthConfig = { reauthCheckinRules: { [origin]: { allowCycleContinuation: true } },
  agentrouterAccounts: [{ origin, accountKey: 'linuxdo' }] };
const checkpoint = { origin, accountKey: 'linuxdo', date: '20261030', status: 'logged_out',
  loginEvidenceReset: true, logoutConfirmed: true, updatedAt: now.toISOString() };

test('a fresh verified logout resumes the original reauth intent without repeated logout or another intent', async t => {
  const { file } = await fixture(t);
  await createSubmissionScope(file, reauthTarget, reauthConfig, { now: () => now }).begin();
  const phases = [];
  const result = await runWithSubmissionJournal(file, reauthTarget, reauthConfig, async config => {
    phases.push(config.checkinReadOnly);
    if (config.checkinReadOnly) {
      await config[SUBMISSION_SCOPE].prepareReauthenticationRecovery(checkpoint);
      return { status: 'needs_attention' };
    }
    await config[SUBMISSION_SCOPE].begin();
    assert.equal((await readSubmissionJournal(file)).entries.length, 1);
    return bindSuccessEvidence({ status: 'signed', evidence: successEvidence('reauth_state', 'quota_reward_confirmed', now) }, reauthTarget, reauthConfig, now);
  }, { now: () => now });
  assert.deepEqual(phases, [true, false]);
  assert.equal(result.status, 'signed');
  assert.equal((await readSubmissionJournal(file)).entries[0].state, 'confirmed');
});

test('reauth recovery rejects another account, unreset evidence, stale verification and a missing intent', async t => {
  const { file } = await fixture(t);
  await createSubmissionScope(file, reauthTarget, reauthConfig, { now: () => now }).begin();
  const scope = createSubmissionScope(file, reauthTarget, reauthConfig, { now: () => now });
  for (const invalid of [{ ...checkpoint, accountKey: 'github' }, { ...checkpoint, loginEvidenceReset: false },
    { ...checkpoint, logoutConfirmed: false }, { ...checkpoint, updatedAt: yesterday.toISOString() },
    { ...checkpoint, date: '20261029' }]) await assert.rejects(scope.prepareReauthenticationRecovery(invalid));
  const empty = await fixture(t);
  await assert.rejects(createSubmissionScope(empty.file, reauthTarget, reauthConfig, { now: () => now }).prepareReauthenticationRecovery(checkpoint));
});

test('reset-stage recovery requires the actual target login surface and persists a verified account checkpoint', async t => {
  const { statePath } = await fixture(t);
  const key = `${origin}::linuxdo`;
  const previous = { date: '20261030', status: 'evidence_reset', loginEvidenceReset: true, updatedAt: now.toISOString() };
  assert.equal(reauthRecoveryAction(previous, now), 'verify_logout');
  const rule = { origin, accountKey: 'linuxdo' };
  for (const scenario of ['authenticated', 'provider_home', 'stale_reward', 'verified']) {
    await fs.writeFile(statePath, JSON.stringify({ version: 2, entries: { [key]: previous, [`${origin}::github`]: { status: 'untouched' } } }));
    let closes = 0;
    const result = await recoverVerifiedReauthLogout({}, rule, statePath, key, previous, now, {
      openPage: async () => ({ page: {}, context: { close: async () => { closes++; } } }),
      readLogout: async () => ({ confirmed: ['stale_reward', 'verified'].includes(scenario) }),
      readReward: async () => scenario === 'stale_reward',
    });
    assert.equal(closes, 1);
    const state = JSON.parse(await fs.readFile(statePath));
    assert.deepEqual(state.entries[`${origin}::github`], { status: 'untouched' });
    if (scenario === 'verified') {
      assert.equal(result.status, 'logged_out');
      assert.equal(result.accountKey, 'linuxdo');
      assert.equal(reauthRecoveryAction(result, now), 'resume');
      assert.equal(state.entries[key].logoutConfirmed, true);
    } else { assert.equal(result, null); assert.deepEqual(state.entries[key], previous); }
  }
});

test('delayed logout verification dates its recovery proof at observation, preserving freshness', async t => {
  const { file, statePath } = await fixture(t);
  let time = now;
  const scope = createSubmissionScope(file, reauthTarget, reauthConfig, { now: () => time });
  await scope.begin();
  const previous = { date: '20261030', status: 'evidence_reset', loginEvidenceReset: true, updatedAt: now.toISOString() };
  const key = `${origin}::linuxdo`;
  await fs.writeFile(statePath, JSON.stringify({ entries: { [key]: previous } }));
  const proof = await recoverVerifiedReauthLogout({}, reauthTarget, statePath, key, previous, () => time, {
    openPage: async () => ({ page: {}, context: { close: async () => {} } }),
    readLogout: async () => { time = new Date(now.getTime() + 60000); return { confirmed: true }; },
    readReward: async () => false,
  });
  assert.equal(proof.updatedAt, time.toISOString());
  const recovery = createSubmissionScope(file, reauthTarget, reauthConfig, { now: () => time });
  await recovery.prepareReauthenticationRecovery(proof);
  assert.equal((await readSubmissionJournal(file)).entries.length, 1);
});

test('offline form transitions from disabled verification to enabled submit and one delayed authoritative result', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 20000,
}, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const target = { origin, candidates: [origin + '/'] };
  const config = { navigationTimeoutMs: 3000, actionWaitMs: 1, checkinStateWaitMs: 2000, checkinStatePollMs: 20,
    preCheckinNavigationRules: { [origin]: { expectedPath: '/daily.php', steps: [{ role: 'link', name: '做种会员签到处' }],
      completedTextPattern: '连续签到\\s*\\d+\\s*天[\\s\\S]{0,120}获得[\\s\\S]{0,30}魔力',
      dailyUnsignedForm: { visibleSelectors: ['form button[type=submit]'],
        nonEmptyValueSelectors: ['input[name=sign_token]', 'input[name=sign_submit]'],
        emptyValueSelectors: ['input[name=cf-turnstile-response]'], actionText: '提交签到',
        actionTexts: ['提交签到', '验证已通过点此提交'], ignoreActionDecorations: true,
        pendingAction: { selector: '#submit', text: '等待上方验证通过', disabled: true }, pendingChallenge: 'turnstile' } } },
    challengeInteractionRules: { [origin]: { type: 'click', phase: 'before', waitMs: 1000, settleMs: 50, retryAction: false } } };
  const visits = [];
  const daily = `<a href="/logout.php">退出</a><form onsubmit="event.preventDefault();window.submissions=(window.submissions||0)+1;
    if(!this.querySelector('[name=cf-turnstile-response]').value)return;
    this.remove();setTimeout(()=>document.body.insertAdjacentHTML('beforeend','<p>连续签到 1 天，获得 10 魔力</p>'),300);">
    <input type="hidden" name="sign_token" value="fixture-token"><input type="hidden" name="sign_submit" value="1">
    <input type="hidden" name="cf-turnstile-response" value=""><div class="cf-turnstile">
    <input type="checkbox" onclick="document.querySelector('[name=cf-turnstile-response]').value='fixture-response';
      const submit=document.querySelector('#submit');submit.disabled=false;submit.textContent='✅ 验证已通过，点此提交';this.parentElement.remove();">
    <iframe src="https://challenges.cloudflare.com/turnstile/fixture"></iframe></div>
    <button id="submit" type="submit" disabled>⏳ 等待上方验证通过…</button></form>`;
  await page.route('**/*', route => {
    const url = new URL(route.request().url()); visits.push(url.pathname);
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: url.origin !== origin ? '<p>Offline frame</p>'
      : url.pathname === '/' ? '<a href="/logout.php">退出</a><a href="/daily.php">做种会员签到处</a>' : daily });
  });
  await page.goto(origin + '/daily.php');
  assert.equal((await inspectConfiguredDailyUnsignedForm(page, target, origin, config)).status, 'not_signed');
  assert.equal(await findConfiguredVerifiedFormAction(page, target, origin, config), null, 'disabled challenge state cannot submit');
  await page.locator('input[type=checkbox]').click();
  assert.equal((await inspectConfiguredDailyUnsignedForm(page, target, origin, config)).status, 'not_signed');
  assert.ok(await findConfiguredVerifiedFormAction(page, target, origin, config));
  assert.equal(await inspectConfiguredFormCompletion(page, config), null, 'verification alone is not check-in completion');
  visits.length = 0;
  const result = await processCandidate(page, target, target.candidates[0], config, []);
  assert.equal(result.status, 'signed');
  assert.equal(result.evidence.outcome, 'configured_form_completion');
  assert.equal(await page.evaluate(() => window.submissions), 1);
  assert.deepEqual(visits.filter(path => path === '/daily.php'), ['/daily.php'], 'never reload the one-time result endpoint');
});

test('native calendar adapter uses the current dated DOM, submits once and keeps read-only observation passive', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 20000,
}, async t => {
  const { file } = await fixture(t);
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', day: 'numeric' }).format(new Date());
  const config = { calendarDayCheckinOrigins: [origin], calendarDayCheckinWaitMs: 1000, actionWaitMs: 1, navigationTimeoutMs: 3000 };
  let signed = false, submissions = 0;
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
    `<a href="/logout.php">退出</a><p>今日${signed ? '已' : '未'}签到</p><button aria-current="date" ${signed ? 'disabled' : ''}
      onclick="fetch('/attendance',{method:'POST'}).then(()=>{this.disabled=true;document.querySelector('p').textContent='今日已签到';})">${day}</button>` })) ;
  await page.route(origin + '/attendance', route => { signed = true; submissions++; return route.fulfill({ body: '{}' }); });
  await page.goto(origin + '/user/attendance');
  assert.equal((await runConfiguredCalendarDayCheckin(page, target, { ...config, checkinReadOnly: true })).status, 'not_signed');
  assert.equal(submissions, 0);
  const result = await runWithSubmissionJournal(file, target, config, async active => {
    const { attachSubmissionScope } = await import('../src/submission-guard.mjs');
    attachSubmissionScope(page, active[SUBMISSION_SCOPE]);
    return runConfiguredCalendarDayCheckin(page, target, active);
  });
  assert.equal(result.status, 'signed'); assert.equal(submissions, 1);
  assert.equal((await runConfiguredCalendarDayCheckin(page, target, { ...config, checkinReadOnly: true })).status, 'already_signed');
  assert.equal(submissions, 1);
  assert.equal((await readSubmissionJournal(file)).entries[0].state, 'confirmed');
});

test('offline Edge recognizes provider actions among many controls, nested wrappers and hidden labels', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 20000,
}, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`${Array.from({ length: 50 }, (_, i) => `<a href="#">Item ${i}</a>`).join('')}
    <div role="button"><button id="linuxdo">使用 LinuxDO 继续</button></div>
    <button>使用 GitHub 继续<span hidden>使用 LinuxDO 继续</span></button>`);
  const control = await findUniqueOAuthProviderControl(page, 'LinuxDO', { allowIconOnly: true });
  assert.equal(await control.getAttribute('id'), 'linuxdo');
  await page.locator('body').evaluate(body => body.insertAdjacentHTML('beforeend', '<button>Linux DO 登录</button>'));
  assert.equal(await findUniqueOAuthProviderControl(page, 'LinuxDO', { allowIconOnly: true }), null, 'distinct login actions must fail closed');
});
