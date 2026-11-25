import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { runOpenCdCaptcha } from '../src/open-cd-checkin.mjs';

const browserFixtures = process.env.CHECKIN_BROWSER_FIXTURES === '1';
const origin = 'https://daily.example';

for (const scenario of ['delayed_home', 'delayed_frame', 'foreign_frame', 'duplicate_frame', 'missing_frame']) {
  test(`OpenCD waits for loaded homepage and a unique reviewed iframe: ${scenario}`, { skip: !browserFixtures }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    let posts = 0, reservations = 0, recognitions = 0;
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() === 'POST') {
        posts++;
        return route.fulfill({ contentType: 'application/json', body: '{"state":"success"}' });
      }
      if (url.pathname === '/slow.js') {
        await new Promise(resolve => setTimeout(resolve, 450));
        return route.fulfill({ contentType: 'text/javascript', body: '' });
      }
      const frame = url.pathname === '/plugin_sign-in.php';
      const frameSource = scenario === 'foreign_frame' ? 'https://other.example/plugin_sign-in.php' : '/plugin_sign-in.php';
      const opening = scenario === 'missing_frame' ? '' : `const f=document.createElement('iframe');f.id='i_signin';f.src='${frameSource}';document.body.append(f);${scenario === 'duplicate_frame' ? 'document.body.append(f.cloneNode());' : ''}`;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: frame
        ? '<img src="data:image/png;base64,aA=="><input name="imagestring"><button id="ok" onclick="parent.done()">签到</button>'
        : `<a href="/logout.php">退出</a><a href="#" onclick="event.preventDefault();setTimeout(()=>{${opening}},${scenario === 'delayed_frame' ? 450 : 0})">簽到</a>
          <script>window.done=async()=>{await fetch('/plugin_sign-in.php',{method:'POST'});document.body.innerHTML='<a href=/logout.php>退出</a><span id=sign_in_span>已签到</span>';}</script>
          ${scenario === 'delayed_home' ? '<script async src="/slow.js"></script>' : ''}` });
    });
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
    const result = await runOpenCdCaptcha(page, origin, {}, {
      readinessTimeoutMs: 1200,
      readImage: async () => Buffer.from('fixture'),
      recognize: async () => { recognitions++; return { code: 'ABC123', confidence: 90 }; },
      reserve: async () => reservations++, retryUsed: async () => false,
      retryRejected: () => assert.fail('unexpected retry'), rejectExhausted: () => assert.fail('unexpected rejection'),
      wait: ms => page.waitForTimeout(Math.min(ms, 50)),
    });
    const expected = ['delayed_home', 'delayed_frame'].includes(scenario) ? 1 : 0;
    assert.equal(result.status, expected ? 'already_signed' : 'interactive_challenge');
    assert.equal(posts, expected); assert.equal(reservations, expected); assert.equal(recognitions, expected);
  });
}
