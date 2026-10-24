import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { closeAutomationContext } from '../src/automation-context-close.mjs';
import { tryBearerCheckin, verifyConfiguredBearerSession } from '../src/bearer-checkin.mjs';

const origin = 'https://session.example.test';
const config = { bearerCheckinRules: { [origin]: { verificationDelayMs: 0 } } };

// All traffic is intercepted. Browser-managed cookies remain inside temporary
// profiles; the test never exports cookies, storage state, or credentials.
for (const failurePhase of ['identity', 'status', 'submission']) {
  test(`offline Edge preserves a refreshed session after ${failurePhase} failure and isolates accounts`, {
    skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 45_000,
  }, async t => {
    const { chromium } = await import('playwright-core');
    const root = await mkdtemp(join(tmpdir(), 'checkin-session-fixture-'));
    const active = new Set();
    t.after(async () => {
      for (const context of active) await context.close();
      await rm(root, { recursive: true, force: true });
    });
    const initial = randomUUID(), rotated = randomUUID(), access = randomUUID();
    let failDownstream = true, submissions = 0, refreshes = 0;
    let reusedRotatedCookie = false;
    const launch = async name => {
      const context = await chromium.launchPersistentContext(join(root, name), {
        channel: 'msedge', headless: true, acceptDownloads: false, serviceWorkers: 'block',
      });
      active.add(context);
      await context.route('**/*', async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        const cookie = await request.headerValue('cookie') ?? '';
        const hasRotated = cookie.split(';').some(part => part.trim() === `fixture_session=${rotated}`);
        const hasInitial = cookie.split(';').some(part => part.trim() === `fixture_session=${initial}`);
        const json = (body, status = 200, headers = {}) => route.fulfill({
          status, contentType: 'application/json', body: JSON.stringify(body), headers,
        });
        if (path === '/seed') return route.fulfill({
          contentType: 'text/html', body: '<p>Isolated login fixture</p>',
          headers: { 'set-cookie': `fixture_session=${initial}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600` },
        });
        if (path === '/profile') return route.fulfill({ contentType: 'text/html', body: '<p>Session fixture</p>' });
        if (path === '/api/user/auth/refresh') {
          refreshes++;
          if (!hasInitial && !hasRotated) return json({ success: false }, 401);
          if (!failDownstream && hasRotated) reusedRotatedCookie = true;
          return json({ success: true, data: { ['access' + '_token']: access, token_type: 'Bearer' } }, 200,
            { 'set-cookie': `fixture_session=${rotated}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600` });
        }
        const authorized = hasRotated && await request.headerValue('authorization') === `Bearer ${access}`;
        if (!authorized) return json({ success: false }, 401);
        if (path === '/api/data/self') return failDownstream && failurePhase === 'identity'
          ? json({ success: false }, 503) : json({ success: true, data: { user: { id: 42 } } });
        if (path === '/api/user/checkin' && request.method() === 'POST') {
          submissions++;
          return json({ success: false }, 503);
        }
        if (path === '/api/user/checkin') return failDownstream && failurePhase === 'status'
          ? json({ success: false }, 503)
          : json({ success: true, data: { stats: { checked_in_today: !failDownstream } } });
        return route.abort();
      });
      return context;
    };
    const close = async context => {
      const result = await closeAutomationContext(context);
      assert.equal(result.closed, true, 'normal shutdown must complete before reusing the profile');
      active.delete(context);
    };
    const first = await launch('account-a');
    try {
      const page = first.pages()[0];
      await page.goto(`${origin}/seed`);
      const result = await tryBearerCheckin(page, origin, config);
      assert.equal(result.status, 'deferred');
      assert.equal(refreshes, 1);
      assert.equal(submissions, failurePhase === 'submission' ? 1 : 0);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(`${initial}|${rotated}|${access}`));
    } finally {
      // The same production cleanup path runs after a downstream failure.
      await close(first);
    }
    failDownstream = false;
    const reopened = await launch('account-a');
    try {
      const page = reopened.pages()[0];
      await page.goto(`${origin}/profile`);
      assert.deepEqual(await verifyConfiguredBearerSession(page, origin, config), { status: 'valid' });
      assert.equal(reusedRotatedCookie, true);
      assert.equal((await tryBearerCheckin(page, origin, config)).status, 'already_signed');
      assert.equal(submissions, failurePhase === 'submission' ? 1 : 0);
    } finally { await close(reopened); }
    reusedRotatedCookie = false;
    const otherAccount = await launch('account-b');
    try {
      const page = otherAccount.pages()[0];
      await page.goto(`${origin}/profile`);
      assert.deepEqual(await verifyConfiguredBearerSession(page, origin, config), { status: 'invalid' });
      assert.equal(reusedRotatedCookie, false);
    } finally { await close(otherAccount); }
  });
}
