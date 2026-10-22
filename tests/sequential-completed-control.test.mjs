import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { normalizeSequentialCompletedControl, sequentialCompletedControlMatches } from '../src/sequential-action-evidence.mjs';
import { getConfiguredSequentialActionRule, tryConfiguredSequentialActions } from '../src/browser.mjs';

const origin = 'https://daily.example';
const target = { origin, allowedOrigins: [origin], candidates: [`${origin}/`] };
const completedControl = { selector: 'a[data-daily-status]', textPattern: '^已签到\\s*[1-9][0-9]*\\s*天$' };
const config = { navigationTimeoutMs: 3000, sequentialActionRules: { [origin]: { steps: [{
  url: `${origin}/`, actionTexts: ['签到'], actionTags: ['BUTTON'], completedControl,
  acceptGenericCheckinState: false, waitMs: 1000,
}] } } };

test('completed control patterns stay anchored and bounded', () => {
  assert.equal(normalizeSequentialCompletedControl(null), null);
  assert.deepEqual(getConfiguredSequentialActionRule(target, config).steps[0].completedControl, completedControl);
  for (const raw of [{ ...completedControl, selector: '' }, { ...completedControl, selector: 'x'.repeat(301) },
    { ...completedControl, textPattern: '已签到' }, { ...completedControl, textPattern: '^[$' },
    { ...completedControl, textPattern: '^' + 'x'.repeat(201) + '$' }]) {
    assert.throws(() => normalizeSequentialCompletedControl(raw));
  }
});

test('completion requires one visible control and supports a changing day count', () => {
  const control = text => ({ text, visible: true, interactive: true });
  for (const text of ['已签到1天', '已签到 2 天', '已签到\n100 天']) {
    assert.equal(sequentialCompletedControlMatches([control(text)], completedControl), true);
  }
  for (const text of ['已签到 0 天', '累计已签到 2 天', '已签到 2 天，今日未签到', '签到中', '签到']) {
    assert.equal(sequentialCompletedControlMatches([control(text)], completedControl), false);
  }
  assert.equal(sequentialCompletedControlMatches([{ ...control('已签到 1 天'), visible: false }], completedControl), false);
  assert.equal(sequentialCompletedControlMatches([{ ...control('已签到 1 天'), interactive: false }], completedControl), false);
  assert.equal(sequentialCompletedControlMatches([control('已签到 1 天'), control('已签到 1 天')], completedControl), false);
  assert.equal(sequentialCompletedControlMatches([control('已签到 1 天')], null), false);
});

test('offline Edge confirms the exact status control and never clicks an already completed action', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 30000,
}, async t => {
  const { chromium } = createRequire(import.meta.url)('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let html;
  await page.route(`${origin}/**`, route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  for (const count of [1, 2, 100]) {
    html = `<a data-daily-status href="/account">已签到 ${count} 天</a><button onclick="window.clicks++">签到</button><script>window.clicks=0</script>`;
    const result = await tryConfiguredSequentialActions(page, target, config);
    assert.equal(result.status, 'already_signed');
    assert.equal(await page.evaluate(() => window.clicks), 0);
  }
  for (const markup of ['<p>已签到 1 天</p>', '<a data-daily-status hidden>已签到 1 天</a>',
    '<div data-daily-status>已签到 1 天</div>', '<a data-daily-status>累计已签到 1 天</a>',
    '<a data-daily-status>已签到 1 天</a><a data-daily-status>已签到 1 天</a>']) {
    html = `${markup}<button onclick="window.clicks++">签到</button><script>window.clicks=0</script>`;
    const result = await tryConfiguredSequentialActions(page, target, { ...config, checkinReadOnly: true });
    assert.equal(result.status, 'unconfirmed');
    assert.equal(await page.evaluate(() => window.clicks), 0);
  }
  html = `<button onclick="window.clicks++; this.outerHTML='<a data-daily-status href=/account>已签到 2 天</a>'">签到</button><script>window.clicks=0</script>`;
  const submitted = await tryConfiguredSequentialActions(page, target, config);
  assert.equal(submitted.status, 'signed');
  assert.equal(await page.evaluate(() => window.clicks), 1);
});
