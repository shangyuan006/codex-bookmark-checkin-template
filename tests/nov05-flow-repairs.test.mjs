import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { normalizeSequentialCompletedControl, sequentialCompletedControlMatches } from '../src/sequential-action-evidence.mjs';
import { tryConfiguredSequentialActions } from '../src/browser.mjs';
import { getConfiguredPreCheckinNavigationRule } from '../src/pre-checkin-navigation.mjs';
import { runConfiguredDailyFormCheckin } from '../src/daily-form-checkin.mjs';
import { readChallengeWidgetReadiness } from '../src/challenge-widget-readiness.mjs';

const exec = promisify(execFile);
const origin = 'https://repair.example';
const target = { origin, allowedOrigins: [origin] };
const browserOptions = { skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 30000 };
async function powershell(script) {
  const { stdout } = await exec('pwsh', ['-NoProfile', '-EncodedCommand', Buffer.from(
    "$ErrorActionPreference='Stop'\n" + script, 'utf16le').toString('base64')], { windowsHide: true });
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}
const completedControl = { selector: 'button.cal-att-pill, span.cal-att-pill',
  textPattern: '^(?:今日)?已签到(?:\\s*·\\s*\\+\\d+)?$', allowNonInteractive: true };

test('non-interactive completion requires explicit opt-in and a unique visible exact marker', () => {
  const rule = normalizeSequentialCompletedControl(completedControl);
  const marker = { visible: true, interactive: false, text: '已签到\n· +25' };
  assert.equal(sequentialCompletedControlMatches([marker], rule), true);
  assert.equal(sequentialCompletedControlMatches([marker], { ...rule, allowNonInteractive: undefined }), false);
  for (const observations of [[], [marker, marker], [{ ...marker, visible: false }],
    [{ ...marker, text: '签到 · +25' }], [{ ...marker, text: '昨天已签到 · +25' }]]) {
    assert.equal(sequentialCompletedControlMatches(observations, rule), false);
  }
  assert.equal(sequentialCompletedControlMatches([marker, { ...marker, visible: false }], rule), true);
  assert.throws(() => normalizeSequentialCompletedControl({ ...completedControl, allowNonInteractive: 'true' }));
});

test('offline Edge recognizes a button replaced by a static completion span without repeating the action', browserOptions, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(); let clicks = 0;
  await page.exposeFunction('recordClick', () => clicks++);
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
    body: clicks ? '<span class="cal-att-pill">已签到 · +25</span>' : `<button class="cal-att-pill"
      onclick="recordClick();setTimeout(()=>this.outerHTML='<span class=cal-att-pill>已签到 · +25</span>',200)">签到 · +25</button>` }));
  const config = { navigationTimeoutMs: 3000, sequentialActionRules: { [origin]: { steps: [{
    url: origin + '/calendar', actionType: 'daily_checkin', actionTexts: ['签到'], actionTags: ['BUTTON'],
    actionTextPattern: '^签到\\s*·\\s*\\+\\d+$', acceptGenericCheckinState: false,
    completedControl, completedTexts: [], waitMs: 1500,
  }] } } };
  assert.equal((await tryConfiguredSequentialActions(page, target, config)).status, 'signed');
  assert.equal((await tryConfiguredSequentialActions(page, target, config)).status, 'already_signed');
  assert.equal(clicks, 1);
});

test('selected-account post-OAuth verification skips unrelated login sync while normal runs retain it', async () => {
  const source = await fs.readFile(new URL('../scripts/Run-Checkin.ps1', import.meta.url), 'utf8');
  const start = source.indexOf('function Test-NeedsSavedLoginSync(');
  const end = source.indexOf('\nfunction ', start + 1);
  assert.ok(start > 0 && end > start);
  const result = await powershell(`${source.slice(start, end)}
    $now=Get-Date
    $resume=[pscustomobject]@{Report=[pscustomobject]@{results=@([pscustomobject]@{status='login_required'})}}
    [ordered]@{
      verify=(Test-NeedsSavedLoginSync $null $now 'provider' $true)
      verifyWithLoginFailure=(Test-NeedsSavedLoginSync $resume $now 'provider' $true)
      normal=(Test-NeedsSavedLoginSync $null $now '' $false)
      selectedLogin=(Test-NeedsSavedLoginSync $null $now 'provider' $false)
      ordinaryLoginFailure=(Test-NeedsSavedLoginSync $resume $now '' $false)
    } | ConvertTo-Json -Compress`);
  assert.deepEqual(result, { verify: false, verifyWithLoginFailure: false, normal: true,
    selectedLogin: true, ordinaryLoginFailure: true });
  assert.match(source, /Test-NeedsSavedLoginSync \$resumeCandidate \(Get-Date\) \$ReauthAccountKey \$PostOAuthVerify\.IsPresent/);
});

for (const scenario of ['sharing', 'replace', 'nested', 'exhausted', 'permanent']) {
  test(`checkpoint atomic commit preserves old valid JSON during ${scenario} failure`, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-retry-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const escaped = directory.replaceAll("'", "''");
    const result = await powershell(`
      . ./scripts/NativePreflightCheckpoint.ps1
      ${scenario === 'nested' ? `Add-Type 'public class CheckpointFixtureException : System.IO.IOException {
        public CheckpointFixtureException() : base("fixture sharing failure", new System.ComponentModel.Win32Exception(32)) {
          HResult = unchecked((int)0x80070020);
        }
      }'` : ''}
      $destination=Join-Path '${escaped}' 'checkpoint.json'; $temporary=Join-Path '${escaped}' 'new.tmp'
      [IO.File]::WriteAllText($destination, '{"version":1}')
      [IO.File]::WriteAllText($temporary, '{"version":2}')
      $state=@{attempts=0;waits=0;preserved=$true;failed=$false}
      $commit={param($source,$path)
        $state.attempts++
        ${scenario === 'permanent' ? "throw [UnauthorizedAccessException]::new('fixture permanent failure')" : `
        if (${scenario === 'exhausted' ? '$true' : '$state.attempts -le 2'}) {
          ${scenario === 'nested'
    ? 'throw [CheckpointFixtureException]::new()'
    : `throw [IO.IOException]::new('fixture transient failure',(-2147024896 + ${scenario === 'sharing' ? 32 : 1175}))`}
        }
        [IO.File]::Replace($source,$path,[NullString]::Value)`}
      }
      $wait={param($milliseconds)
        $state.waits++
        $state.preserved=$state.preserved -and (([IO.File]::ReadAllText($destination)|ConvertFrom-Json).version -eq 1)
      }
      try { Commit-NativePreflightCheckpoint -TemporaryPath $temporary -Path $destination -Commit $commit -Wait $wait }
      catch { $state.failed=$true }
      $state.version=([IO.File]::ReadAllText($destination)|ConvertFrom-Json).version
      $state.tempExists=[IO.File]::Exists($temporary)
      $state | ConvertTo-Json -Compress`);
    const failed = ['exhausted', 'permanent'].includes(scenario);
    assert.deepEqual(result, { attempts: scenario === 'permanent' ? 1 : scenario === 'exhausted' ? 4 : 3,
      waits: scenario === 'permanent' ? 0 : scenario === 'exhausted' ? 3 : 2,
      preserved: true, failed, version: failed ? 1 : 2, tempExists: failed });
  });
}

const formConfig = { checkinStateWaitMs: 2000, navigationTimeoutMs: 3000,
  preCheckinNavigationRules: { [origin]: { expectedPath: '/daily.php', steps: [{ role: 'link', name: '每日签到' }],
    completedTextPattern: '连续签到\\s*\\d+\\s*天[\\s\\S]{0,120}获得[\\s\\S]{0,30}魔力',
    dailyUnsignedForm: { visibleSelectors: ['form button[type=submit]'],
      nonEmptyValueSelectors: ['input[name=sign_token]', 'input[name=sign_submit]'],
      emptyValueSelectors: ['input[name=cf-turnstile-response]'], actionText: '提交签到',
      actionTexts: ['提交签到', '验证已通过点此提交'], ignoreActionDecorations: true, pendingChallenge: 'turnstile',
      pendingAction: { selector: '#submit', text: '请先完成验证', disabled: true },
      verifiedAction: { selector: '#submit', text: '验证已通过点此提交' }, continuationWaitMs: 2200 } } } };
const pendingHtml = `<a href="/logout.php">退出</a><form id="daily">
  <input name="sign_token" type="hidden" value="FIXTURE"><input name="sign_submit" type="hidden" value="1">
  <input name="cf-turnstile-response" type="hidden" value="">
  <button id="submit" type="submit" disabled>请先完成验证</button>
  <iframe src="https://challenges.cloudflare.com/turnstile/v0/fixture"></iframe></form>`;

test('same-page grace is explicit and bounded', () => {
  for (const continuationWaitMs of [-1, 60001, '1000', 1.5]) {
    const config = structuredClone(formConfig);
    config.preCheckinNavigationRules[origin].dailyUnsignedForm.continuationWaitMs = continuationWaitMs;
    assert.throws(() => getConfiguredPreCheckinNavigationRule(target, origin, config));
  }
  const config = structuredClone(formConfig);
  delete config.preCheckinNavigationRules[origin].dailyUnsignedForm.continuationWaitMs;
  assert.equal(getConfiguredPreCheckinNavigationRule(target, origin, config).dailyUnsignedForm.continuationWaitMs, undefined);
});

test('offline Edge submits once when verified readiness arrives during retained-document grace', browserOptions, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(); let submissions = 0, navigations = 0;
  await page.exposeFunction('recordSubmit', () => submissions++);
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) return route.fulfill({ body: '<label>等待验证</label>' });
    navigations++;
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: pendingHtml + `<script>
      setTimeout(()=>{document.querySelector('iframe').remove();const b=document.querySelector('button');
        b.disabled=false;b.textContent='验证已通过，点此提交'},1000);
      document.querySelector('form').onsubmit=e=>{e.preventDefault();recordSubmit();
        setTimeout(()=>{document.querySelector('button').remove();document.body.append('连续签到 5 天，获得 100 魔力')},600)};
    </script>` });
  });
  await page.goto(origin + '/daily.php');
  const result = await runConfiguredDailyFormCheckin(page, target, formConfig, { waitMs: 100 });
  assert.equal(result.status, 'signed'); assert.equal(result.formDiagnostics.continuationUsed, true);
  assert.equal(result.formDiagnostics.submitted, true); assert.equal(submissions, 1); assert.equal(navigations, 1);
  assert.doesNotMatch(JSON.stringify(result), /FIXTURE|sign_token/);
});

test('offline Edge never submits when grace expires, the form changes, or the same URL reloads', browserOptions, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  for (const scenario of ['pending', 'no_opt_in', 'token_missing', 'reload', 'different_path']) {
    const page = await browser.newPage(); let submissions = 0, navigations = 0;
    await page.exposeFunction('recordSubmit', () => submissions++);
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin !== origin) return route.fulfill({ body: '<label>等待验证</label>' });
      navigations++;
      const change = scenario === 'reload' ? 'location.reload()'
        : scenario === 'different_path' ? "location.href='/other.php'"
          : scenario === 'token_missing' ? `document.querySelector('input[name=sign_token]').value='';
            document.querySelector('iframe').remove();document.querySelector('button').disabled=false;
            document.querySelector('button').textContent='验证已通过，点此提交'` : '';
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: pendingHtml + `<script>
        document.querySelector('form').onsubmit=e=>{e.preventDefault();recordSubmit()};
        ${change && navigations === 1 ? `setTimeout(()=>{${change}},700);` : ''}
      </script>` });
    });
    await page.goto(origin + '/daily.php');
    const config = structuredClone(formConfig);
    config.preCheckinNavigationRules[origin].dailyUnsignedForm.continuationWaitMs = scenario === 'no_opt_in' ? 0 : 1500;
    const result = await runConfiguredDailyFormCheckin(page, target, config, { waitMs: 100 });
    assert.equal(submissions, 0, scenario); assert.equal(result.actionAttempted, false, scenario);
    assert.equal(result.formDiagnostics.continuationUsed === true, scenario !== 'no_opt_in', scenario);
    if (scenario === 'reload' || scenario === 'different_path') {
      assert.equal(result.failureCode, 'daily_form_page_changed', scenario);
      assert.equal(result.formDiagnostics.samePage, false, scenario);
    }
    await page.close();
  }
});

test('offline widget diagnostics distinguish empty and loaded documents without exposing text or changing readiness', browserOptions, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  for (const [html, expected] of [['', [true, 0, false]], ['<main>PRIVATE-FIXTURE</main>', [false, 0, false]],
    ['<input type="checkbox">', [false, 1, true]],
    ['<input type="checkbox"><span>正在验证</span>', [false, 1, false]]]) {
    await page.setContent(html);
    const detailed = await readChallengeWidgetReadiness(page.mainFrame(), { includeDiagnostics: true });
    assert.equal(detailed.documentLoaded, true);
    assert.deepEqual([detailed.documentEmpty, detailed.checkboxCandidateCount, detailed.checkboxReady], expected);
    const { documentLoaded, documentEmpty, checkboxCandidateCount, ...ordinary } = detailed;
    assert.deepEqual(await readChallengeWidgetReadiness(page.mainFrame()), ordinary);
    assert.doesNotMatch(JSON.stringify(detailed), /PRIVATE-FIXTURE|<main>/);
  }
});
