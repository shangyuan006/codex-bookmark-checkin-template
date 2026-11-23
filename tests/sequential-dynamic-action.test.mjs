import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { getConfiguredSequentialActionRule, selectConfiguredSequentialActionCandidate, tryConfiguredSequentialActions } from '../src/browser.mjs';

const origin = 'https://daily.example';
const target = { origin, allowedOrigins: [origin] };
const step = { url: `${origin}/calendar`, actionType: 'daily_checkin', actionTexts: ['签到'],
  actionTags: ['BUTTON'], actionTextPattern: '^签到\\s*·\\s*\\+\\d+$', completedTexts: ['今日已签到'],
  acceptGenericCheckinState: false, waitMs: 1000 };
const config = { navigationTimeoutMs: 3000, sequentialActionRules: { [origin]: { steps: [step] } } };
const control = text => ({ text, tagName: 'BUTTON', visible: true, disabled: false });

test('dynamic action text is opt-in and still requires a unique safe enabled control', () => {
  const normalized = getConfiguredSequentialActionRule(target, config).steps[0];
  for (const text of ['签到 · +1', '签到 · +25', '签到 · +100']) {
    assert.ok(selectConfiguredSequentialActionCandidate([control(text)], normalized, [origin]).candidate);
  }
  for (const candidate of [control('补签到 · +5'), control('签到 · +5，充值'), control('签到记录'),
    { ...control('签到 · +5'), disabled: true }, { ...control('签到 · +5'), visible: false },
    { ...control('签到 · +5'), tagName: 'A' }, { ...control('签到 · +5'), formAction: 'https://outside.example/' }]) {
    assert.equal(selectConfiguredSequentialActionCandidate([candidate], normalized, [origin]).candidate, null);
  }
  assert.equal(selectConfiguredSequentialActionCandidate([control('签到 · +1'), control('签到 · +2')], normalized, [origin]).candidate, null);
  assert.equal(selectConfiguredSequentialActionCandidate([control('签到 · +1')], { ...normalized, actionTextPattern: undefined }, [origin]).candidate, null);
  for (const actionTextPattern of ['签到', '^$', '^[$', '^x\n$', '^' + 'x'.repeat(201) + '$']) {
    assert.throws(() => getConfiguredSequentialActionRule(target, { sequentialActionRules: { [origin]: { steps: [{ ...step, actionTextPattern }] } } }));
  }
});

test('offline Edge waits for dynamic action completion and does not repeat an already signed action', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 30000,
}, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let clicks = 0;
  await page.exposeFunction('recordClick', () => clicks++);
  await page.route(`${origin}/**`, route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
    body: `<button onclick="recordClick(); setTimeout(()=>this.textContent='今日已签到',150)">${clicks ? '今日已签到' : '签到 · +25'}</button>` }));
  assert.equal((await tryConfiguredSequentialActions(page, target, config)).status, 'signed');
  assert.equal(clicks, 1);
  assert.equal((await tryConfiguredSequentialActions(page, target, config)).status, 'already_signed');
  assert.equal(clicks, 1);
});

test('offline Edge dismisses a guide recreated by the step navigation before clicking', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 30000,
}, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let clicks = 0;
  await page.exposeFunction('recordClick', () => clicks++);
  await page.route(`${origin}/**`, route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
    body: `<button onclick="recordClick();this.textContent='今日已签到'">签到 · +15</button>
      <div class="guide" style="position:fixed;inset:0;background:white;z-index:100">
        回到首页<button class="skip" onclick="this.parentElement.remove()">跳过</button></div>` }));
  const result = await tryConfiguredSequentialActions(page, target, { ...config,
    preCheckinDismissRules: { [origin]: { selectors: ['.guide .skip'], maxDismissals: 1, waitMs: 50 } } });
  assert.equal(result.status, 'signed');
  assert.equal(clicks, 1);
  assert.equal(await page.locator('.guide').count(), 0);
});
