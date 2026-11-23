import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { clickConfiguredChallengeControl } from '../src/browser.mjs';
import { navigateConfiguredPreCheckinPage, verifyMissingNavigationControl } from '../src/pre-checkin-navigation.mjs';
import { createNativeCloudflareReader } from '../src/native-cloudflare-recovery.mjs';
import { readNativeCheckinState } from '../src/native-checkin-state.mjs';

const origin = 'https://checkin.example';
const frameOrigin = 'https://challenges.cloudflare.com';

test('offline Edge exercises renamed navigation and CF recovery through real DOM frames', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 60000,
}, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const visits = [];
  let mainHtml = '';
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    visits.push(url.origin + url.pathname);
    const body = url.origin === origin ? mainHtml : url.origin === frameOrigin
      ? `<input type="checkbox" aria-label="Verify fixture" style="margin:20px"
          onchange="parent.postMessage('fixture-verified','${origin}')">`
      : '<p>Unexpected offline fixture request</p>';
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  const page = await context.newPage();
  const homeHtml = link => `<a href="/logout.php">退出</a><p>${'站点首页内容。'.repeat(30)}</p>${link}`;
  const oldRule = { steps: [{ selector: "a:text-is('签到赚魔力')" }], expectedPath: '/daily.php',
    terminalWhenNavigationControlMissing: true, terminalAssumeSigned: true,
    terminalRequireAuthenticatedPage: true, terminalMissingControlPaths: ['/', '/index.php'],
    waitMs: 500, afterClickWaitMs: 100, terminalPaths: ['/retired.php'] };
  const configFor = rule => ({ navigationTimeoutMs: 2000, preCheckinNavigationRules: { [origin]: rule } });
  const target = { origin };

  await t.test('a renamed visible link prevents false completion with the old selector', async () => {
    mainHtml = homeHtml('<a href="/daily.php">做种会员签到处</a>');
    await page.goto(origin + '/');
    const result = await verifyMissingNavigationControl(page, target, origin, configFor(oldRule));
    assert.equal(result.terminalUnconfirmed.failureCode, 'terminal_navigation_changed');
    assert.equal(result.terminalNoAction, undefined);
  });

  await t.test('the configured path follows the visible entry even after its label changes', async () => {
    const rule = { ...oldRule, steps: [{ selector: "a[href='/daily.php'], a:text-is('签到赚魔力'), a:text-is('做种会员签到处')" }] };
    for (const label of ['签到赚魔力', '做种会员签到处', '新的会员签到入口']) {
      mainHtml = homeHtml(`<a href="/daily.php">${label}</a>`);
      await page.goto(origin + '/');
      const before = visits.length;
      assert.equal(await navigateConfiguredPreCheckinPage(page, target, origin, configFor(rule)), true);
      assert.equal(new URL(page.url()).pathname, '/daily.php');
      assert.deepEqual(visits.slice(before), [origin + '/daily.php']);
    }
    mainHtml = homeHtml('<a href="/retired.php">做种会员签到处</a>');
    await page.goto(origin + '/');
    const before = visits.length;
    assert.deepEqual(await navigateConfiguredPreCheckinPage(page, target, origin, configFor(rule)), { terminalPath: '/retired.php' });
    assert.deepEqual(visits.slice(before), [], 'terminal links must be recognized before navigation');
  });

  await t.test('completion by missing entry still requires its actual disappearance', async () => {
    mainHtml = homeHtml('');
    await page.goto(origin + '/');
    assert.deepEqual(await verifyMissingNavigationControl(page, target, origin, configFor(oldRule)), { terminalNoAction: true });
  });

  const challengeHtml = rounds => `<p>每日签到</p><button id="daily" onclick="window.businessClicks++">立即签到</button>
    <div class="cf-turnstile"><iframe style="width:300px;height:70px;border:0"
      src="${frameOrigin}/turnstile/fixture"></iframe></div>
    <script>
      window.businessClicks=0;window.frameClicks=0;
      addEventListener('message',event=>{
        if(event.origin!=='${frameOrigin}'||event.data!=='fixture-verified')return;
        window.frameClicks++;
        const widget=document.querySelector('.cf-turnstile');
        widget.replaceChildren();
        if(window.frameClicks<${rounds}){
          setTimeout(()=>{
            const frame=document.createElement('iframe');
            frame.style='width:300px;height:70px;border:0';
            frame.src='${frameOrigin}/turnstile/fixture?round='+window.frameClicks;
            widget.append(frame);
          },100);
        }else{
          widget.remove();
          ${rounds > 1 ? "setTimeout(()=>{document.querySelector('#daily').textContent='今日已签到';},400);" : ''}
        }
      });
    </script>`;

  await t.test('configured CF follow-up reads the page after a real frame click without a scope error', async () => {
    mainHtml = challengeHtml(1);
    await page.goto(origin + '/profile');
    const result = await clickConfiguredChallengeControl(page,
      { waitMs: 15000, frameStableMs: 3000 }, origin, { checkinStatePollMs: 20 });
    assert.equal(result.status, 'ready', 'passing verification alone must not mean signed');
    assert.equal(await page.evaluate(() => window.frameClicks), 1);
    assert.equal(await page.evaluate(() => window.businessClicks), 0);
  });

  await t.test('native CF recovery handles replacement frames and waits for the signed control', async () => {
    mainHtml = challengeHtml(3);
    await page.goto(origin + '/profile');
    const deadline = Date.now() + 35000;
    const reader = createNativeCloudflareReader(origin, {
      readState: active => readNativeCheckinState(active, origin), enabled: true,
      rule: { actionTexts: ['立即签到'], clickChallenge: true, challengeFrameStableMs: 3000 },
      deadline: () => deadline,
    });
    const result = await reader.read(page);
    assert.equal(result.state.status, 'already_signed');
    assert.equal(reader.diagnostics().clickCount, 3);
    assert.equal(await page.evaluate(() => window.frameClicks), 3);
    assert.equal(await page.evaluate(() => window.businessClicks), 0);
  });
});
