import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { runConfiguredDailyFormCheckin } from '../src/daily-form-checkin.mjs';
import { tryConfiguredSequentialActions, processCandidate } from '../src/browser.mjs';
import { createSubmissionScope, runWithSubmissionJournal, attachSubmissionScope, guardPageSubmissions,
  readSubmissionJournal, SUBMISSION_SCOPE } from '../src/submission-guard.mjs';
import { recoveryEntriesForResults, withRecoveryProgress, filterAutomaticRetryOrigins } from '../src/retry-policy.mjs';
import { continueNativeCheckinAfterLogin } from '../src/native-login-continuation.mjs';
import { freshNativePreflightHandoffs } from '../src/native-preflight-state.mjs';
import { resultDisplayReason } from '../src/result-presentation.mjs';
import { powershellExecutable } from './helpers/powershell.mjs';

const origin = 'https://daily.example';
const target = { origin };
const browserOptions = { skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 25000 };
async function journal(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nov01-flow-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'journal.json');
}
async function edge(t) {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  return browser;
}
const formConfig = {
  navigationTimeoutMs: 3000, checkinStateWaitMs: 2000,
  preCheckinNavigationRules: { [origin]: {
    expectedPath: '/daily.php', steps: [{ role: 'link', name: '做种会员签到处' }],
    completedTextPattern: '连续签到\\s*\\d+\\s*天，获得\\s*\\d+\\s*魔力',
    dailyUnsignedForm: { visibleSelectors: ['form button'],
      nonEmptyValueSelectors: ['input[name=sign_token]', 'input[name=sign_submit]'],
      emptyValueSelectors: ['input[name=cf-turnstile-response]'], actionText: '提交签到',
      actionTexts: ['提交签到','验证已通过点此提交'], ignoreActionDecorations: true,
      pendingAction: { selector: '#submit', text: '等待上方验证通过', disabled: true }, pendingChallenge: 'turnstile' },
  } },
};
const formHtml = `<a href="/logout.php">退出</a><main></main><script>
  window.documentIdentity={};setTimeout(()=>{
    document.querySelector('main').innerHTML='<form><input type="hidden" name="sign_token" value="fixture-form">'
      +'<input type="hidden" name="sign_submit" value="1"><input type="hidden" name="cf-turnstile-response" value="">'
      +'<div class="cf-turnstile"><iframe src="https://challenges.cloudflare.com/turnstile/fixture"></iframe></div>'
      +'<button id="submit" disabled type="submit">⏳ 等待上方验证通过…</button></form>';
    document.querySelector('form').onsubmit=event=>{event.preventDefault();
      fetch('/daily.php',{method:'POST'}).then(()=>{document.querySelector('form').remove();
        setTimeout(()=>document.body.insertAdjacentHTML('beforeend','<p>连续签到 2 天，获得 10 魔力</p>'),250);});};
    setTimeout(()=>{document.querySelector('[name=cf-turnstile-response]').value='fixture-verified';
      const button=document.querySelector('#submit');button.disabled=false;button.textContent='✅ 验证已通过，点此提交';
      document.querySelector('.cf-turnstile').remove();},550);
  },300);
</script>`;

test('native daily form keeps one document through delayed readiness, verification and one journaled submit', browserOptions, async t => {
  const file = await journal(t), browser = await edge(t), page = await browser.newPage();
  const config = { ...formConfig, submissionJournalPath: file };
  const yesterday = new Date(Date.now() - 86400000);
  await createSubmissionScope(file, target, config, { now: () => yesterday }).begin();
  let formLoads = 0, posts = 0, active = { checkinReadOnly: true };
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.fulfill({ body: '<p>offline frame</p>', contentType: 'text/html' });
    if (route.request().method() === 'POST') { posts++; return route.fulfill({ body: '{}' }); }
    if (url.pathname === '/daily.php') formLoads++;
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: url.pathname === '/daily.php'
      ? formHtml : '<a href="/logout.php">退出</a><a href="/daily.php">做种会员签到处</a>' });
  });
  await page.goto(origin);
  await guardPageSubmissions(page, target, null, { readOnly: () => active.checkinReadOnly === true });
  const phases = [];
  const result = await runWithSubmissionJournal(file, target, config, async cfg => {
    active = cfg; phases.push(cfg.checkinReadOnly === true);
    attachSubmissionScope(page, cfg[SUBMISSION_SCOPE]);
    return runConfiguredDailyFormCheckin(page, target, cfg, { waitMs: 3000 });
  });
  assert.equal(result.status, 'signed'); assert.deepEqual(phases, [true,false]);
  assert.equal(result.evidence.source, 'page_text');
  assert.equal(result.formDiagnostics.submitted, true);
  assert.equal(formLoads, 1); assert.equal(posts, 1);
  const entries = (await readSubmissionJournal(file)).entries;
  assert.equal(entries.length, 2); assert.equal(entries[0].state, 'intent'); assert.equal(entries[1].state, 'confirmed');
  assert.doesNotMatch(JSON.stringify(result), /fixture-form|fixture-verified/);
});

test('native daily form cannot submit past a current-cycle uncertain intent', browserOptions, async t => {
  const file = await journal(t), browser = await edge(t), page = await browser.newPage();
  let posts = 0;
  await createSubmissionScope(file, target, formConfig).begin();
  await page.route('**/*', route => {
    if (route.request().method() === 'POST') posts++;
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: new URL(route.request().url()).origin === origin
      ? formHtml : '<p>offline frame</p>' });
  });
  await page.goto(origin + '/daily.php');
  const result = await runWithSubmissionJournal(file, target, formConfig,
    cfg => runConfiguredDailyFormCheckin(page, target, cfg, { waitMs: 2000 }));
  assert.equal(result.failureCode, 'submission_quarantined'); assert.equal(posts, 0);
});

test('native form stops before a forbidden terminal link and labels it as a private rule', browserOptions, async t => {
  const browser = await edge(t), page = await browser.newPage();
  const visits = [];
  await page.route(origin + '/**', route => {
    visits.push(new URL(route.request().url()).pathname);
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body:
      '<a href="/logout">退出</a><a href="/terminal.php">做种会员签到处</a>' });
  });
  await page.goto(origin);
  const config = { ...formConfig, preCheckinNavigationRules: { [origin]: {
    ...formConfig.preCheckinNavigationRules[origin], terminalPaths: ['/terminal.php'], terminalAssumeSigned: true,
  } } };
  const result = await runConfiguredDailyFormCheckin(page, target, config);
  assert.equal(result.status, 'already_signed'); assert.equal(result.evidence.source, 'user_rule');
  assert.equal(result.evidence.authoritative, false); assert.deepEqual(visits, ['/']);
});

test('HTTP errors retain a fixed status and never become visited or feature-disabled', browserOptions, async t => {
  const browser = await edge(t), page = await browser.newPage();
  for (const status of [404,500,522]) {
    await page.route(origin + '/**', route => route.fulfill({ status, contentType: 'text/html', body: '<p>Unavailable</p>' }));
    const result = await processCandidate(page, target, origin + '/attendance.php', { navigationTimeoutMs: 2000 }, []);
    assert.equal(result.status, 'deferred'); assert.equal(result.documentStatus, status);
    assert.equal(result.retryCause, 'upstream_unavailable'); assert.equal(result.availabilityKind, undefined);
    await page.unroute(origin + '/**');
  }
});

const endpoint = origin + '/api/me/attendance';
const sequential = { url: origin + '/', actionType: 'daily_checkin', dailyCheckin: true,
  actionTexts: ['签到'], actionTags: ['BUTTON'], acceptGenericCheckinState: false, waitMs: 1000,
  statusCheck: { url: endpoint, readOnly: true, signedField: 'claimed_today', pageFallback: true },
  completedControl: { selector: 'a.completed', textPattern: '^已签到\\s*[1-9][0-9]*\\s*天$' } };

test('reviewed sequential page fallback submits only an authenticated unique action and still enforces isolation', browserOptions, async t => {
  const browser = await edge(t);
  for (const kind of ['safe','anonymous','duplicate','401','read-only','historical','current']) {
    const page = await browser.newPage(), file = await journal(t);
    const config = { navigationTimeoutMs: 2000, submissionJournalPath: file,
      sequentialActionRules: { [origin]: { steps: [sequential] } }, checkinReadOnly: kind === 'read-only' };
    if (['historical','current'].includes(kind)) await createSubmissionScope(file, { ...target, actionType: 'daily_checkin' }, config,
      { now: () => new Date(Date.now() - (kind === 'historical' ? 86400000 : 0)) }).begin();
    let posts = 0;
    await page.route(origin + '/**', route => {
      if (route.request().method() === 'POST') { posts++; return route.fulfill({ body: '{}' }); }
      if (route.request().url() === endpoint) return route.fulfill({ status: kind === '401' ? 401 : 500,
        contentType: 'text/html', body: '<p>private diagnostic stays here</p>' });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body:
        `${kind === 'anonymous' ? '' : '<a href="/logout">退出</a>'}<button onclick="fetch('/submit',{method:'POST'}).then(()=>{
          this.remove();document.body.insertAdjacentHTML('beforeend','<a href=/economy class=completed>已签到2天</a>');})">签到</button>
          ${kind === 'duplicate' ? '<button>签到</button>' : ''}` });
    });
    const view = new Proxy(page, { get(object, key) {
      if (key === 'request') return { get: async () => ({ url: () => endpoint, status: () => kind === '401' ? 401 : 500,
        text: async () => 'private diagnostic stays here', dispose: async () => {} }) };
      const value = Reflect.get(object, key, object);
      return typeof value === 'function' ? value.bind(object) : value;
    } });
    const result = await tryConfiguredSequentialActions(view, target, config);
    assert.equal(posts, kind === 'safe' ? 1 : 0, kind);
    if (kind === 'safe') { assert.equal(result.status, 'signed'); assert.equal(result.actionResults[0].statusDiagnostics.httpStatus, 500); }
    if (kind === '401') assert.equal(result.status, 'login_required');
    if (['historical','current'].includes(kind)) assert.equal(result.failureCode, 'submission_quarantined');
    assert.doesNotMatch(JSON.stringify(result), /private diagnostic/);
    await page.close();
  }
});

test('unchanged recovery stops the next internal round but remains available for manual or explicit retry', () => {
  const prior = { ...target, status: 'visited', failureCode: 'visit_completion_unconfirmed', documentStatus: 200 };
  const stopped = withRecoveryProgress({ ...prior, reason: 'different text', durationMs: 100 }, prior);
  assert.equal(stopped.recoveryProgress.stopped, true);
  assert.deepEqual(recoveryEntriesForResults([stopped], [target]), []);
  assert.deepEqual([...filterAutomaticRetryOrigins(new Set([origin]), [stopped])], []);
  assert.equal(stopped.retryable, undefined);
  for (const next of [{ ...prior, status: 'login_required' }, { ...prior, documentStatus: 404 },
    { ...prior, formDiagnostics: { readinessObserved: true } }]) {
    assert.equal(withRecoveryProgress(next, prior).recoveryProgress?.stopped === true, false);
  }
  assert.equal(withRecoveryProgress(prior, prior, { loginRecovered: true }).recoveryProgress.stopped, false);
});

test('submission protection shows the underlying fixed cause without private text', () => {
  const result = { failureCode: 'submission_quarantined', reason: '存在尚未确认的提交',
    submissionObservation: { oauthStage: 'github_autofill_missing', reason: 'private account', url: 'https://private.example' } };
  const text = resultDisplayReason(result);
  assert.match(text, /GitHub 登录会话失效/); assert.doesNotMatch(text, /private/);
  assert.equal(resultDisplayReason({ ...result, reason: text }), text);
});

test('daily-form login recovery stays on the native path and retains blockers for this attempt', async () => {
  let id;
  const config = { nativeChallengePreflight: [{ url: origin + '/', dailyFormCheckin: true }] };
  const result = await continueNativeCheckinAfterLogin(target, config, { succeeded: true }, {
    runPreflight: async (_origin, attemptId) => { id = attemptId; },
    readConfirmations: async attemptId => {
      assert.equal(attemptId, id);
      const generatedAt = new Date().toISOString();
      return freshNativePreflightHandoffs({ generatedAt, results: [{ origin, status: 'needs_attention',
        failureCode: 'daily_form_readiness_unconfirmed', retryable: false, preflightAttemptId: id,
        formDiagnostics: { readinessObserved: false }, manualBrowserMode: 'native' }] }, new Set([origin]), attemptId);
    },
  });
  assert.equal(result.failureCode, 'daily_form_readiness_unconfirmed');
  assert.equal(result.retryable, false); assert.equal(result.manualBrowserMode, 'native');
  assert.equal(result.formDiagnostics.readinessObserved, false);
});

test('PowerShell reporting distinguishes page evidence, private rules and unbound legacy completion', async () => {
  const script = new URL('../scripts/ResultContract.ps1', import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1');
  const command = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); . '${decodeURIComponent(script).replaceAll("'", "''")}'; Get-CheckinCompletionSummary @(
    [pscustomobject]@{status='signed';evidence=[pscustomobject]@{source='page_text';authoritative=$true}},
    [pscustomobject]@{status='already_signed';evidence=[pscustomobject]@{source='user_rule';authoritative=$false}},
    [pscustomobject]@{status='signed'}
  )`;
  const { stdout } = await promisify(execFile)(powershellExecutable, ['-NoProfile','-Command', command], { windowsHide: true });
  assert.match(stdout, /页面\/接口确认 1；本地规则确认 1；证据不完整 1/);
});

test('native wrapper selects daily-form mode, checkpoints before closing, and propagates blocked forms', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-form-wrapper-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const name of ['scripts','config','data/profile','tmp','src']) await fs.mkdir(path.join(directory, name), { recursive: true });
  for (const name of ['Prepare-NativeWafSession.ps1','NativePreflightCheckpoint.ps1','CheckinCycle.ps1','ResultContract.ps1','CheckinContract.generated.ps1']) {
    await fs.copyFile(new URL(`../scripts/${name}`, import.meta.url), path.join(directory, 'scripts', name));
  }
  const quote = value => `'${String(value).replaceAll("'", "''")}'`;
  const checkpoint = path.join(directory, 'tmp/native-waf-preflight.json');
  await fs.writeFile(path.join(directory, 'scripts/Resolve-Runtime.ps1'), `
    function Resolve-CheckinNode { ${quote(process.execPath)} }
    function Resolve-CheckinBrowser { [pscustomobject]@{DisplayName='Fixture Edge'} }
    function Get-CheckinProfileBrowserProcesses {}
    function Start-Sleep {}
  `);
  await fs.writeFile(path.join(directory, 'scripts/ManualAbandonment.ps1'), 'function Get-TodayAbandonedOrigins { @{} }');
  await fs.writeFile(path.join(directory, 'scripts/NativePreflightBrowserClose.ps1'), `
    function Close-NativePreflightBrowser {
      if($env:FIXTURE_NATIVE_FORM_OUTCOME -eq 'signed') {
        $saved=Get-Content -LiteralPath ${quote(checkpoint)} -Raw | ConvertFrom-Json
        if($saved.results[0].formDiagnostics.submitted -ne $true){ throw 'Checkpoint missing before cleanup' }
      }
    }
  `);
  await fs.writeFile(path.join(directory, 'scripts/Open-PlainLoginChrome.ps1'), `
    param([switch]$Offscreen,[switch]$NativeMinimal,[int]$RemoteDebuggingPort,[string]$UserDataDirOverride,[string[]]$Urls)
    if(-not $NativeMinimal -or $Urls[0] -ne '${origin}/'){throw 'Wrong native entry'}
  `);
  await fs.writeFile(path.join(directory, 'src/native-browser-inspect.mjs'), `
    if(process.argv[5]!=='execute-daily-form')process.exit(19);
    const signed=process.env.FIXTURE_NATIVE_FORM_OUTCOME==='signed';
    console.log(JSON.stringify({status:signed?'signed':'needs_attention',siteBodyLoaded:true,
      failureCode:signed?undefined:'daily_form_readiness_unconfirmed',retryable:false,
      formDiagnostics:{submitted:signed},reason:signed?'confirmed':'form not ready'}));
  `);
  await fs.writeFile(path.join(directory, 'config/config.json'), JSON.stringify({
    automationUserDataDir: path.join(directory, 'data/profile'), nativeWafPreflightUrls: [],
    preCheckinNavigationRules: formConfig.preCheckinNavigationRules,
    nativeChallengePreflight: [{ url: origin + '/', waitSeconds: 5, nativeMinimal: true, maxAttempts: 1, dailyFormCheckin: true }],
  }));
  for (const outcome of ['blocked','signed']) {
    const { stdout } = await promisify(execFile)(powershellExecutable, ['-NoProfile','-File',
      path.join(directory,'scripts/Prepare-NativeWafSession.ps1'),'-Origins',origin], {
      windowsHide: true, env: { ...process.env, FIXTURE_NATIVE_FORM_OUTCOME: outcome } });
    const report = JSON.parse(await fs.readFile(checkpoint, 'utf8'));
    assert.equal(report.results[0].status, outcome === 'signed' ? 'signed' : 'needs_attention');
    assert.equal(report.results[0].formDiagnostics.submitted, outcome === 'signed');
    if (outcome === 'blocked') assert.equal(report.results[0].failureCode, 'daily_form_readiness_unconfirmed');
    assert.doesNotMatch(stdout, /Checkpoint missing|Wrong native entry/);
  }
});
