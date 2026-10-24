import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForStableOAuthProviderControl } from '../src/oauth-provider-readiness.mjs';
import { findUniqueOAuthProviderControl } from '../src/oauth-provider-control.mjs';

function fixture() {
  let time = 0, element = {}, covered = false, clicks = 0, disposed = 0, handles = 0;
  const options = {
    now: () => time,
    wait: async ms => { time += ms; },
    findControl: async () => ({
      count: async () => 1,
      elementHandle: async () => {
        handles++;
        const current = element;
        return {
          element: current,
          isVisible: async () => true,
          isEnabled: async () => true,
          click: async ({ trial } = {}) => {
            if (covered) throw new Error('announcement intercepts pointer events');
            if (!trial) clicks++;
          },
          evaluate: async (_callback, other) => current === other.element,
          dispose: async () => { disposed++; },
        };
      },
    }),
  };
  return { page: { url: () => 'https://login.example/login' }, options,
    time: () => time, clicks: () => clicks, handles: () => handles, disposed: () => disposed,
    cover: value => { covered = value; }, replace: () => { element = {}; } };
}

test('provider readiness requires two actionable observations and never submits the login', async () => {
  const f = fixture();
  const control = await waitForStableOAuthProviderControl(f.page, f.options);
  assert.equal(f.time(), 500);
  assert.equal(f.clicks(), 0);
  await control.click();
  await control.dispose();
  assert.equal(f.clicks(), 1);
  assert.equal(f.disposed(), f.handles());
});

test('a late announcement and a replaced login card restart the stability check', async () => {
  const f = fixture();
  let dismissed = 0;
  const control = await waitForStableOAuthProviderControl(f.page, { ...f.options,
    preparePage: async () => {
      if (f.time() === 500) { f.replace(); f.cover(true); }
      if (f.time() === 1000) { f.cover(false); dismissed++; }
    },
  });
  assert.equal(f.time(), 1500);
  assert.equal(dismissed, 1);
  assert.equal(f.clicks(), 0);
  await control.dispose();
  assert.equal(f.disposed(), f.handles());
});

test('replacement, ambiguity and permanent overlays exhaust a bounded wait without a click', async () => {
  for (const kind of ['replacement', 'ambiguity', 'overlay']) {
    const f = fixture();
    const options = { ...f.options, timeoutMs: 1250 };
    if (kind === 'replacement') options.preparePage = async () => f.replace();
    if (kind === 'ambiguity') options.findControl = async () => null;
    if (kind === 'overlay') f.cover(true);
    assert.equal(await waitForStableOAuthProviderControl(f.page, options), null);
    assert.equal(f.time(), 1250);
    assert.equal(f.clicks(), 0);
    assert.equal(f.disposed(), f.handles());
  }
});

test('an exhausted enclosing OAuth budget releases inspected elements before propagating', async () => {
  const f = fixture();
  await assert.rejects(waitForStableOAuthProviderControl(f.page, { ...f.options,
    assertActive: () => { if (f.time() >= 500) throw new Error('enclosing budget exhausted'); },
  }), /enclosing budget exhausted/);
  assert.equal(f.disposed(), f.handles());
  assert.equal(f.clicks(), 0);
});

test('offline Edge waits for a late announcement, rebinds the new card, and navigates once', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 30_000,
}, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  context.setDefaultTimeout(5000);
  const page = await context.newPage();
  let navigations = 0, dismissals = 0;
  await context.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/authorized') navigations++;
    await route.fulfill({ contentType: 'text/html', body: path === '/login' ? `
      <button id="provider">Continue with GitHub</button>
      <script>setTimeout(() => {
        const replacement = document.createElement('button');
        replacement.id = 'provider'; replacement.textContent = 'Continue with GitHub';
        replacement.onclick = () => location.assign('/authorized');
        document.querySelector('#provider').replaceWith(replacement);
        const notice = document.createElement('div'); notice.id = 'notice';
        notice.style.cssText = 'position:fixed;inset:0;background:white;z-index:1000';
        notice.innerHTML = '<button onclick="this.parentElement.remove()">Close Notice</button>';
        document.body.appendChild(notice);
      }, 100);</script>` : '<p>OAuth destination fixture</p>' });
  });
  await page.goto('https://login.example/login');
  const control = await waitForStableOAuthProviderControl(page, {
    findControl: () => findUniqueOAuthProviderControl(page, 'GitHub'),
    preparePage: async () => {
      const close = page.getByRole('button', { name: 'Close Notice', exact: true });
      if (await close.count()) { await close.click(); dismissals++; }
    },
    timeoutMs: 6000,
  });
  assert.ok(control);
  assert.equal(navigations, 0);
  const destination = page.waitForURL('https://login.example/authorized');
  await control.click();
  await destination;
  await control.dispose();
  assert.equal(dismissals, 1);
  assert.equal(navigations, 1);
});
