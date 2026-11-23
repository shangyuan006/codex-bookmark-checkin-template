import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { clickVisibleNativeChallengeControl } from '../src/native-checkin-action.mjs';
import { runConfiguredDailyFormCheckin } from '../src/daily-form-checkin.mjs';
import { manualPrecheckinContentScript } from '../src/manual-precheckin-extension.mjs';
import { controlledManualTargets, continueControlledManualSession } from '../src/manual-native-continuation.mjs';
import { bindSuccessEvidence, successEvidence } from '../src/checkin-evidence.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { powershellExecutable } from './helpers/powershell.mjs';

const origin = 'https://repair.example';
const rule = { actionTexts: ['立即签到'], clickChallenge: true, challengeFrameStableMs: 3000 };
const target = { origin, candidates: [origin + '/'], title: 'Fixture' };
const config = { automationUserDataDir: path.resolve('data/fixture-profile'),
  nativeChallengePreflight: [{ url: origin + '/', action: rule }] };

for (const scenario of ['pending', 'completed', 'save_only']) test(`controlled window closure: ${scenario}`, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'controlled-close-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const name of ['scripts', 'config', 'tmp']) await fs.mkdir(path.join(directory, name));
  for (const name of ['Close-ManualLogin.ps1', 'ManualAbandonment.ps1']) {
    await fs.copyFile(path.resolve('scripts', name), path.join(directory, 'scripts', name));
  }
  const profile = path.join(directory, 'data/profile');
  await fs.writeFile(path.join(directory, 'config/config.json'), JSON.stringify({ automationUserDataDir: profile }));
  await fs.writeFile(path.join(directory, 'tmp/manual-session.json'), JSON.stringify({ schemaVersion: 2, mode: 'native',
    controlledCheckin: true, pid: 12345, profile, targetCount: 1, targets: [{ origin }], processStartedAt: new Date().toISOString() }));
  await fs.writeFile(path.join(directory, 'scripts/Resume-ManualCheckin.ps1'), `param([switch]$Json)
    $global:resumeCalls++; '{"unresolvedCount":${scenario === 'completed' ? 0 : 1}}'`);
  await fs.writeFile(path.join(directory, 'scripts/Resolve-Runtime.ps1'), `
    function Get-CheckinManualSessionBrowserProcesses { param($Config,$ProfilePath,$State)
      if(-not $global:fixtureClosed){[pscustomobject]@{ProcessId=12345}}
    }
    function ConvertTo-CheckinUtcDateTime($Value){[datetime]$Value}
    function Test-CheckinProcessStartIdentity {param($Process,$RecordedStart,$ToleranceSeconds) $true}
    function Get-Process {param($Id,$ErrorAction)
      $p=[pscustomobject]@{MainWindowHandle=1}
      $p|Add-Member -MemberType ScriptMethod -Name CloseMainWindow -Value {$global:fixtureClosed=$true;return $true}
      $p
    }`);
  const { stdout } = await promisify(execFile)(powershellExecutable, ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference='Stop';$global:resumeCalls=0;$global:fixtureClosed=$false
    & ./scripts/Close-ManualLogin.ps1 ${scenario === 'save_only' ? '-SaveOnly' : ''}
    @{retained=(Test-Path tmp/manual-session.json);closed=$global:fixtureClosed;calls=$global:resumeCalls}|ConvertTo-Json -Compress
  `], { cwd: directory, windowsHide: true, timeout: 30000 });
  const observed = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(observed, { retained: scenario === 'pending', closed: scenario !== 'pending', calls: scenario === 'save_only' ? 0 : 1 }, stdout);
});

test('controlled handoff selects reviewed rules from a mixed queue and excludes other profiles', () => {
  const handoff = { targets: [target, { origin: 'https://unavailable.example' }] };
  assert.deepEqual(controlledManualTargets(handoff, config), [target]);
  assert.deepEqual(controlledManualTargets(handoff, { ...config, nativeChallengePreflight: [
    { ...config.nativeChallengePreflight[0], automationUserDataDir: path.resolve('data/another-profile') },
  ] }), []);
  assert.deepEqual(controlledManualTargets(handoff, { ...config, nativeChallengePreflight: [
    { ...config.nativeChallengePreflight[0], dailyFormCheckin: true },
  ] }), []);
});

test('controlled continuation records only bound completion and leaves incomplete work pending', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'controlled-checkin-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bookmarksPath = path.join(root, 'Bookmarks');
  await fs.writeFile(bookmarksPath, JSON.stringify({ roots: { synced: { type: 'folder', name: 'Container', children: [
    { type: 'folder', name: 'Daily', children: [{ type: 'url', name: 'Fixture', url: origin + '/' }] },
  ] } } }));
  const active = { ...config, bookmarksPath, mobileFolderNames: ['Container'], targetFolderNames: ['Daily'] };
  const state = { mode: 'native', controlledCheckin: true, windowReady: true, profile: config.automationUserDataDir,
    nativeDebugPort: 27123, launchMarker: 'a'.repeat(32), targetCount: 1, targets: [{ origin }] };
  let calls = 0;
  const inspect = async (selected, selectedRule) => {
    calls++; assert.equal(selected.origin, origin); assert.equal(selectedRule.mode, 'execute-checkin');
    return bindSuccessEvidence({ origin, status: 'already_signed', evidence: successEvidence('page_text', 'page_completion_text') }, selected, active);
  };
  assert.deepEqual(await continueControlledManualSession(root, active, state, { inspect }),
    { processedCount: 1, completedCount: 1, unresolvedCount: 0 });
  assert.equal(calls, 1);
  const incomplete = await continueControlledManualSession(root, active, state, {
    inspect: async () => ({ status: 'already_signed' }),
  });
  assert.equal(incomplete.unresolvedCount, 1, 'a bare status cannot authorize closing the window');
  await assert.rejects(continueControlledManualSession(root, active, { ...state, profile: path.resolve('data/other') }, { inspect }));
  assert.equal(calls, 1, 'invalid session must not connect or submit');
});

test('offline Edge verifies closed roots, exact navigation and same-document form continuation', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 120000,
}, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let scenario = 'ready';
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.fulfill({ contentType: 'text/html', body: '<div id="host"></div>' });
    assert.equal(url.hostname, 'challenges.cloudflare.com');
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<div id="widget"></div><script>
      const root=document.querySelector('#widget').attachShadow({mode:'closed'});
      root.innerHTML='<style>input{opacity:0;width:22px;height:22px}label{display:block;width:220px;height:40px}</style>'+
        '<label for="check"><input id="check" type="checkbox">Verify you are human</label>'+
        '<p style="display:none">Verification failed</p>';
      ${['no_checkbox_loading', 'no_checkbox_failed', 'no_checkbox_success', 'no_checkbox_expired'].includes(scenario)
        ? `root.innerHTML=${JSON.stringify('<p>' + ({ no_checkbox_loading: '正在验证…', no_checkbox_failed: '验证失败',
          no_checkbox_success: '成功！', no_checkbox_expired: '验证已过期' })[scenario] + '</p><p hidden>PRIVATE_WIDGET_TEXT</p>')};` : ''}
      ${scenario === 'loading' ? "root.querySelector('label').insertAdjacentHTML('afterend','<p>Verifying</p>');" : ''}
      root.querySelector('input')?.addEventListener('click',()=>parent.postMessage('fixture-checked','${origin}'));
      ${scenario === 'replacement' ? `setTimeout(()=>{
        const old=root.querySelector('input'), fresh=old.cloneNode(true);old.replaceWith(fresh);
        fresh.addEventListener('click',()=>parent.postMessage('fixture-checked','${origin}'));
      },1300);` : ''}
      </script>` });
  });
  const mount = async ({ duplicate = false, obstructed = false, rebuild = false } = {}) => {
    await page.goto(origin + '/daily');
    await page.evaluate(({ duplicate, obstructed, rebuild }) => {
      window.clicks = 0;
      window.addEventListener('message', event => { if (event.data === 'fixture-checked') window.clicks++; });
      const root = document.querySelector('#host').attachShadow({ mode: 'closed' });
      root.innerHTML = '<iframe style="border:0;width:300px;height:70px" src="https://challenges.cloudflare.com/fixture"></iframe>'
        + (duplicate ? '<iframe style="border:0;width:300px;height:70px" src="https://challenges.cloudflare.com/other"></iframe>' : '');
      if (rebuild) setTimeout(() => {
        const old = root.querySelector('iframe'); old.replaceWith(old.cloneNode(true));
      }, 1200);
      if (obstructed) {
        const overlay = document.createElement('div');
        overlay.style = 'position:fixed;inset:0;z-index:999;background:white'; document.body.append(overlay);
      }
    }, { duplicate, obstructed, rebuild });
    await page.waitForTimeout(200);
  };
  await t.test('one hidden input with a visible associated label is clicked after stability', async () => {
    await mount();
    const result = await clickVisibleNativeChallengeControl(page, origin, rule);
    assert.equal(result.clicked, true, JSON.stringify(result));
    assert.equal(result.outcome, 'challenge_checkbox_clicked');
    assert.ok(result.details.frameStableMs >= 3000);
    await page.waitForFunction(() => window.clicks === 1);
    assert.doesNotMatch(JSON.stringify(result), /fixture-checked|https:|Verify you/);
  });
  await t.test('duplicate frames and overlays do not receive clicks', async () => {
    await mount({ duplicate: true });
    assert.equal((await clickVisibleNativeChallengeControl(page, origin, rule)).outcome, 'challenge_frame_not_unique');
    assert.equal(await page.evaluate(() => window.clicks), 0);
    await mount({ obstructed: true });
    assert.equal((await clickVisibleNativeChallengeControl(page, origin, rule)).outcome, 'challenge_obstructed');
    assert.equal(await page.evaluate(() => window.clicks), 0);
  });
  await t.test('replacement checkbox restarts the stability wait', async () => {
    scenario = 'replacement'; await mount();
    const startedAt = Date.now();
    const result = await clickVisibleNativeChallengeControl(page, origin, rule);
    assert.equal(result.clicked, true, JSON.stringify(result));
    assert.ok(Date.now() - startedAt >= 4000, 'must stabilize the replacement control');
    await page.waitForFunction(() => window.clicks === 1); scenario = 'ready';
  });
  await t.test('a visible verifying state is observed without clicking', async () => {
    scenario = 'loading'; await mount();
    const result = await clickVisibleNativeChallengeControl(page, origin, rule);
    assert.equal(result.clicked, false);
    assert.equal(result.outcome, 'challenge_loading');
    assert.equal(await page.evaluate(() => window.clicks), 0); scenario = 'ready';
  });
  for (const [state, outcome] of [['loading', 'challenge_loading'], ['failed', 'challenge_verification_failed'],
    ['success', 'challenge_already_resolved'], ['expired', 'challenge_expired']]) {
    await t.test(`closed-root ${state} panel is classified without a checkbox`, async () => {
      scenario = 'no_checkbox_' + state; await mount();
      const result = await clickVisibleNativeChallengeControl(page, origin, rule);
      assert.equal(result.outcome, outcome, JSON.stringify(result)); assert.equal(result.clicked, false);
      assert.equal(await page.evaluate(() => window.clicks), 0);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE|验证|https:|signed/);
      scenario = 'ready';
    });
  }
  await t.test('a replacement iframe is rebound and stabilized before one click', async () => {
    scenario = 'ready'; await mount({ rebuild: true }); const startedAt = Date.now();
    const result = await clickVisibleNativeChallengeControl(page, origin, rule);
    assert.equal(result.clicked, true, JSON.stringify(result));
    assert.ok(result.details.frameReplacementCount >= 1, JSON.stringify(result));
    assert.ok(result.details.frameStableMs >= 3000); assert.ok(Date.now() - startedAt >= 4000);
    await page.waitForFunction(() => window.clicks === 1);
  });
  await t.test('mixed CSS and exact text selectors deduplicate the visible navigation control', async () => {
    await page.goto(origin + '/');
    await page.evaluate(() => {
      document.body.innerHTML = '<a href="/daily.php">做种会员签到处</a>';
      document.querySelector('a').onclick = event => { event.preventDefault(); history.pushState({}, '', '/daily.php'); };
    });
    await page.evaluate(manualPrecheckinContentScript, { [origin]: { expectedPath: '/daily.php', waitMs: 1000,
      afterClickWaitMs: 1, steps: [{ selector: "a[href='/daily.php'], a:text-is('签到赚魔力'), a:text-is('做种会员签到处')" }] } });
    assert.equal(new URL(page.url()).pathname, '/daily.php');
    assert.equal(await page.locator('html').getAttribute('data-manual-precheckin-state'), 'complete');
    await page.goto(origin + '/');
    await page.evaluate(manualPrecheckinContentScript, { [origin]: { expectedPath: '/daily.php', waitMs: 1000,
      afterClickWaitMs: 1, steps: [{ selector: 'a:has-text("unsupported")' }] } });
    assert.equal(await page.locator('html').getAttribute('data-manual-precheckin-state'), 'unsupported_selector');
  });
  await t.test('verification is followed by exactly one form submission in the retained document', async () => {
    scenario = 'ready';
    const active = { checkinStateWaitMs: 1000, navigationTimeoutMs: 1000,
      preCheckinNavigationRules: { [origin]: { expectedPath: '/daily.php', steps: [{ role: 'link', name: '签到入口' }],
        completedTextPattern: '连续签到\\s*\\d+\\s*天[\\s\\S]{0,30}获得[\\s\\S]{0,30}魔力',
        dailyUnsignedForm: { visibleSelectors: ['form button'], nonEmptyValueSelectors: ['[name=sign_token]', '[name=sign_submit]'],
          emptyValueSelectors: ['[name=cf-turnstile-response]'], actionText: '提交签到', pendingChallenge: 'turnstile' } } } };
    await page.goto(origin + '/daily.php');
    await page.evaluate(() => {
      window.documentIdentity = document; window.submissions = 0;
      document.body.innerHTML = '<a href="/logout.php">退出</a><form><input name="sign_token" value="fixture">'
        + '<input name="sign_submit" value="1"><input name="cf-turnstile-response" value="">'
        + '<div class="cf-turnstile" id="host"></div><button type="submit">提交签到</button></form>';
      document.querySelector('#host').attachShadow({ mode: 'closed' }).innerHTML =
        '<iframe style="border:0;width:300px;height:70px" src="https://challenges.cloudflare.com/fixture"></iframe>';
      window.addEventListener('message', event => {
        if (event.data !== 'fixture-checked') return;
        document.querySelector('[name=cf-turnstile-response]').value = 'fixture-response';
        document.querySelector('#host').remove();
      });
      document.querySelector('form').onsubmit = event => {
        event.preventDefault(); window.submissions++;
        window.sameDocument = window.documentIdentity === document;
        window.verified = !!document.querySelector('[name=cf-turnstile-response]').value;
        event.target.remove(); setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p>连续签到 3 天，获得 10 魔力</p>'), 100);
      };
    });
    const advanceChallenge = p => clickVisibleNativeChallengeControl(p, origin, rule);
    const pendingReadOnly = await runConfiguredDailyFormCheckin(page, target, { ...active, checkinReadOnly: true }, {
      waitMs: 10, advanceChallenge: async () => assert.fail('pending read-only form must not click a widget'),
    });
    assert.equal(pendingReadOnly.actionAttempted, false);
    assert.equal(await page.evaluate(() => window.submissions), 0);
    const result = await runConfiguredDailyFormCheckin(page, target, active, { waitMs: 15000, advanceChallenge });
    assert.equal(result.status, 'signed', JSON.stringify(result));
    assert.equal(result.formDiagnostics.challengeClicks, 1);
    assert.deepEqual(await page.evaluate(() => [window.submissions, window.sameDocument, window.verified]), [1, true, true]);
    assert.equal(result.evidence.binding.observedOrigin, origin);
    const readOnly = await runConfiguredDailyFormCheckin(page, target, { ...active, checkinReadOnly: true }, {
      waitMs: 10, advanceChallenge: async () => assert.fail('read-only must not click a widget'),
    });
    assert.equal(readOnly.status, 'signed');
    assert.equal(await page.evaluate(() => window.submissions), 1);
  });
});
