import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { waitForOAuthTargetSession, waitForOAuthTargetReturn } from '../src/oauth-target-completion.mjs';
import { createOAuthTimeBudget } from '../src/oauth-time-budget.mjs';
import { sanitizeOAuthFlowDiagnostic } from '../src/oauth-flow-diagnostics.mjs';

const origin = 'https://target.example';
const config = { reauthCheckinRules: { [origin]: { accountMenuSelector: '#account' } } };
function fixture() {
  let time = 0, url = origin + '/oauth/linuxdo', closed = false;
  const page = { url: () => url, isClosed: () => closed };
  return { page, context: { pages: () => [page] },
    setUrl: value => { url = value; }, close: () => { closed = true; },
    options: { timeoutMs: 6000, now: () => time, wait: async ms => { time += ms; },
      readSurface: async () => ({ kind: 'authenticated_target', ready: true, authenticatedControl: true }) },
    time: () => time };
}

test('OAuth waits for a slow callback and account control instead of a fixed 1.5 second delay', async () => {
  const f = fixture();
  const result = await waitForOAuthTargetSession(f.context, origin, config, { ...f.options,
    wait: async ms => { await f.options.wait(ms); if (f.time() >= 4000) f.setUrl(origin + '/console/token'); } });
  assert.equal(result.loggedIn, true);
  assert.equal(result.outcome, 'session_confirmed');
  assert.equal(result.elapsedMs, 4500);
});

test('an empty callback, a login form or a target page without session evidence never confirms login', async () => {
  for (const kind of ['callback', 'target_login', 'target_content', 'challenge_visible']) {
    const f = fixture();
    if (kind !== 'callback') f.setUrl(origin + '/console');
    const result = await waitForOAuthTargetSession(f.context, origin, config, { ...f.options,
      readSurface: async () => ({ kind, ready: true, authenticatedControl: false,
        challengeVisible: kind === 'challenge_visible' }) });
    assert.equal(result.loggedIn, false, kind);
    assert.equal(result.elapsedMs, 6000);
  }
});

test('callback recovery follows new flow pages and ignores stale unrelated sessions', async () => {
  const f = fixture(), stale = { url: () => origin + '/profile' };
  const callback = { url: () => f.time() >= 2000 ? origin + '/console' : origin + '/callback' };
  const result = await waitForOAuthTargetSession({ pages: () => [stale, f.page, callback] }, origin, config, {
    ...f.options, acceptPage: page => page !== stale,
    readSurface: async page => { assert.notEqual(page, stale); return { ready: true, authenticatedControl: true }; },
  });
  assert.equal(result.page, callback);
  assert.equal(result.loggedIn, true);
  assert.equal(result.elapsedMs, 2500);
});

test('configured session verification must become valid and stay on the same page', async () => {
  const f = fixture(); f.setUrl(origin + '/console');
  const result = await waitForOAuthTargetSession(f.context, origin, { savedLoginSessionRules: { [origin]: {} } }, {
    ...f.options, verifySession: async () => ({ status: f.time() < 2000 ? 'unknown' : 'valid' }),
  });
  assert.equal(result.loggedIn, true);
  assert.equal(result.elapsedMs, 2500);
  const moved = fixture(); moved.setUrl(origin + '/console');
  const rejected = await waitForOAuthTargetSession(moved.context, origin, { savedLoginSessionRules: { [origin]: {} } }, {
    ...moved.options, verifySession: async () => { moved.setUrl(origin + '/oauth/linuxdo'); return { status: 'valid' }; },
  });
  assert.equal(rejected.loggedIn, false);
});

test('closing the OAuth window ends waiting, and a remaining provider control blocks success', async () => {
  const f = fixture(); f.close();
  assert.equal((await waitForOAuthTargetSession(f.context, origin, config, f.options)).elapsedMs, 0);
  const login = fixture(); login.setUrl(origin + '/console');
  assert.equal((await waitForOAuthTargetSession(login.context, origin, config, {
    ...login.options, hasProviderControl: async () => true,
  })).loggedIn, false);
});

test('a missing callback exhausts only the callback wait and never begins session verification', async () => {
  const f = fixture(), phases = [], observations = [];
  f.setUrl('https://provider.example/');
  const result = await waitForOAuthTargetReturn(f.context, origin, config, {
    ...f.options, waitMs: 1000, timeBudget: createOAuthTimeBudget({ now: f.options.now }),
    onPhase: phase => phases.push(phase), onCallbackProgress: value => observations.push(value),
    readSurface: async () => { assert.fail('No target session probe before callback arrival'); },
  });
  assert.equal(result.loggedIn, false);
  assert.equal(result.terminationReason, 'wait_timeout');
  assert.equal(result.timeoutPhase, 'callback');
  assert.equal(f.time(), 1000);
  assert.deepEqual(phases, []);
  assert.equal(observations.at(-1).outcome, 'target_not_returned');
  assert.equal(observations.at(-1).budgetMs, 1000);
});

test('a stale target session and the current target login page cannot substitute for a callback', async () => {
  const f = fixture(), stale = { url: () => origin + '/console' };
  f.setUrl(origin + '/login');
  const result = await waitForOAuthTargetReturn({ pages: () => [stale, f.page] }, origin, config, {
    ...f.options, waitMs: 1000, acceptPage: page => page !== stale,
    timeBudget: createOAuthTimeBudget({ now: f.options.now }),
  });
  assert.equal(result.loggedIn, false);
  assert.equal(result.timeoutPhase, 'callback');
});

test('an arrived but empty callback records a session wait timeout deterministically', async () => {
  const f = fixture(), phases = [], observations = [];
  const result = await waitForOAuthTargetReturn(f.context, origin, config, {
    ...f.options, waitMs: 1000, timeBudget: createOAuthTimeBudget({ now: f.options.now }),
    onPhase: phase => phases.push(phase), onProgress: value => observations.push(value),
  });
  assert.equal(result.loggedIn, false);
  assert.equal(result.outcome, 'callback_pending');
  assert.equal(result.terminationReason, 'wait_timeout');
  assert.equal(result.timeoutPhase, 'session');
  assert.deepEqual(phases, ['session_verification']);
  assert.equal(observations.at(-1).budgetMs, 1000);
});

test('a callback in a new flow page selects that page and confirms a stable session', async () => {
  const f = fixture(), phases = [], selected = [];
  f.setUrl('https://provider.example/');
  const callback = { url: () => f.time() < 2000 ? origin + '/callback' : origin + '/console' };
  const result = await waitForOAuthTargetReturn({ pages: () => f.time() < 1000 ? [f.page] : [f.page, callback] }, origin, config, {
    ...f.options, waitMs: 4000, timeBudget: createOAuthTimeBudget({ now: f.options.now }),
    onPhase: phase => phases.push(phase), onCallbackPage: page => selected.push(page),
  });
  assert.equal(result.loggedIn, true);
  assert.equal(result.page, callback);
  assert.equal(result.terminationReason, undefined);
  assert.deepEqual(selected, [callback]);
  assert.deepEqual(phases, ['session_verification']);
  assert.equal(f.time(), 2500);
});

test('callback diagnostics contain only fixed outcomes and bounded counters', () => {
  const value = sanitizeOAuthFlowDiagnostic({ flow: 'automatic_target', status: 'needs_attention',
    callbackDiagnostics: { outcome: 'callback_pending', polls: 12, elapsedMs: 5000, url: origin + '/callback?private=value', body: 'private' } });
  assert.deepEqual(value.callbackDiagnostics, { outcome: 'callback_pending', polls: 12, elapsedMs: 5000 });
  assert.equal(sanitizeOAuthFlowDiagnostic({ flow: 'automatic_target', callbackDiagnostics: { outcome: 'private' } }).callbackDiagnostics, undefined);
});

test('offline Edge waits through callback rendering and verifies a delayed authenticated session', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 30_000,
}, async t => {
  const { chromium } = createRequire(import.meta.url)('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.ok([origin, 'https://provider.example'].includes(url.origin));
    if (url.origin === 'https://provider.example') {
      await route.fulfill({ contentType: 'text/html',
        body: '<script>setTimeout(()=>location.href="https://target.example/oauth/linuxdo",600)</script>' });
      return;
    }
    const callback = url.pathname === '/oauth/linuxdo';
    await route.fulfill({ contentType: 'text/html', body: callback
      ? '<script>setTimeout(()=>location.href="/console",1900)</script>'
      : '<button id="account">Account</button>' });
  });
  const page = await context.newPage();
  await page.goto('https://provider.example/authorize');
  const result = await waitForOAuthTargetReturn(context, origin, config, {
    timeBudget: createOAuthTimeBudget(), waitMs: 8000, pollMs: 100,
  });
  assert.equal(result.loggedIn, true);
  assert.ok(result.elapsedMs >= 1900);
  assert.equal(new URL(page.url()).pathname, '/console');
});

test('offline Edge keeps a provider page in the callback phase and stops at the configured wait', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 30_000,
}, async t => {
  const { chromium } = createRequire(import.meta.url)('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<p>Provider</p>' }));
  const page = await context.newPage();
  await page.goto('https://provider.example/');
  const started = Date.now(), phases = [];
  const result = await waitForOAuthTargetReturn(context, origin, config, {
    timeBudget: createOAuthTimeBudget(), waitMs: 600, pollMs: 50,
    onPhase: phase => phases.push(phase),
  });
  assert.equal(result.loggedIn, false);
  assert.equal(result.terminationReason, 'wait_timeout');
  assert.equal(result.timeoutPhase, 'callback');
  assert.deepEqual(phases, []);
  assert.ok(Date.now() - started < 5000, 'No second session wait or automatic navigation');
  assert.equal(page.url(), 'https://provider.example/');
});
