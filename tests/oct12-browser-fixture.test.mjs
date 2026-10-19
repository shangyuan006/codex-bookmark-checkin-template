import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readReauthLogoutEvidence, waitForReauthLogout } from '../src/reauth-logout.mjs';
import { oauthTargetPageObservation, prepareOAuthTargetPage, readOAuthTargetSurface } from '../src/oauth-target-state.mjs';
import { dismissConfiguredPreCheckinOverlay } from '../src/browser.mjs';
import { findUniqueOAuthProviderControl } from '../src/oauth-provider-control.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

test('offline Edge verifies logout transitions and announcement dismissal using real rendered controls', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 30000,
}, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  const origin = 'https://example.test';
  const rule = { origin, provider: 'GitHub', loginUrl: `${origin}/login`, accountMenuSelector: '#account-menu', evidenceWaitMs: 5000 };
  const config = { reauthCheckinRules: { [origin]: rule }, actionWaitMs: 0,
    preCheckinDismissRules: { [origin]: { selectors: ['.semi-modal-wrap button.semi-modal-close'], waitMs: 1, maxDismissals: 1 } } };
  let mode = 'delayed';
  let providerMarkup = '<button id="provider">使用 GitHub 继续</button>';
  await context.route(`${origin}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    let content;
    if (path === '/console') {
      content = `<button id="account-menu">Account</button><button id="logout" onclick="${mode === 'never' ? ''
        : `setTimeout(()=>location.href='/login',${mode === 'delayed' ? 1500 : 0})`}">Logout</button>`;
    } else if (path === '/login') {
      content = mode === 'shell' ? '<main>Loading login controls</main>'
        : providerMarkup;
      if (mode === 'stale') content += '<button id="account-menu">Account</button>';
      if (mode === 'flash') content += '<script>setTimeout(()=>location.href="/console",350)</script>';
      if (mode === 'notice') content += '<div class="semi-modal-wrap" role="dialog" style="position:fixed;inset:0;z-index:100;background:white"><button class="semi-modal-close" onclick="this.parentElement.remove()">Close notice</button></div>';
    } else throw new Error('Unexpected fixture navigation');
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: content });
  });

  await t.test('a slow logout waits for navigation and stable login controls', async () => {
    mode = 'delayed';
    await page.goto(`${origin}/console`);
    await page.locator('#logout').click();
    const started = Date.now();
    const result = await waitForReauthLogout(page, rule);
    assert.equal(result.confirmed, true); assert.ok(Date.now() - started >= 2200);
    assert.equal(new URL(page.url()).pathname, '/login');
  });

  await t.test('an ineffective logout remains unconfirmed', async () => {
    mode = 'never';
    await page.goto(`${origin}/console`);
    await page.locator('#logout').click();
    const result = await waitForReauthLogout(page, rule, { timeoutMs: 1100 });
    assert.equal(result.confirmed, false); assert.equal(result.targetSurface, 'authenticated_target');
  });

  await t.test('a brief login-page redirect cannot become a resumable logout', async () => {
    mode = 'flash';
    await page.goto(`${origin}/login`);
    assert.equal((await waitForReauthLogout(page, rule, { timeoutMs: 1300 })).confirmed, false);
    assert.equal(new URL(page.url()).pathname, '/console');
  });

  await t.test('the login URL alone and stale authenticated controls are insufficient', async () => {
    for (const scenario of ['shell', 'stale']) {
      mode = scenario;
      await page.goto(`${origin}/login`);
      assert.equal((await readReauthLogoutEvidence(page, rule)).confirmed, false);
    }
  });

  await t.test('a configured announcement is dismissed before the provider control is used', async () => {
    mode = 'notice';
    await page.goto(`${origin}/login`);
    assert.equal((await readReauthLogoutEvidence(page, rule)).confirmed, false);
    const observation = await prepareOAuthTargetPage(page, origin, config, { dismissOverlay: dismissConfiguredPreCheckinOverlay });
    assert.equal(observation.targetSurface, 'target_login');
    assert.equal(observation.noticeObserved, true);
    assert.equal(observation.noticeDismissed, true);
    assert.equal(observation.noticeDismissDiagnostics.outcome, 'dismissed');
    const provider = await findUniqueOAuthProviderControl(page, 'GitHub');
    assert.ok(provider);
    await provider.click({ trial: true });
    assert.equal((await waitForReauthLogout(page, rule)).confirmed, true);
  });

  await t.test('an announcement appearing after the first observation is still recorded when actually dismissed', async () => {
    mode = 'provider';
    await page.goto(`${origin}/login`);
    const before = await readOAuthTargetSurface(page, origin, config);
    assert.equal(before.noticeVisible, false);
    await page.evaluate(() => {
      setTimeout(() => {
        const notice = document.createElement('div');
        notice.className = 'semi-modal-wrap';
        notice.setAttribute('role', 'dialog');
        notice.innerHTML = '<button class="semi-modal-close" onclick="this.parentElement.remove()">Close notice</button>';
        document.body.appendChild(notice);
      }, 150);
    });
    const dismissed = await dismissConfiguredPreCheckinOverlay(page, { origin, allowedOrigins: [origin] }, origin,
      { ...config, preCheckinDismissRules: { [origin]: { ...config.preCheckinDismissRules[origin], waitMs: 500 } } });
    assert.equal(dismissed, true);
    assert.equal((await readOAuthTargetSurface(page, origin, config)).noticeVisible, false);
    assert.deepEqual(oauthTargetPageObservation(before, dismissed),
      { targetSurface: 'target_login', noticeObserved: true, noticeDismissed: true });
  });

  await t.test('LinuxDO text and visible icon login entrances remain usable for logout confirmation', async () => {
    mode = 'provider';
    const linuxDoRule = { ...rule, provider: 'LinuxDO' };
    const icon = '<img alt="LINUX DO" width="24" height="24" src="data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%3E%3C/svg%3E">';
    for (const markup of [
      '<button>使用 Linux DO 继续</button>', '<button>LinuxDO 登录</button>',
      `<button>${icon}</button>`,
    ]) {
      providerMarkup = markup;
      await page.goto(`${origin}/login`);
      const provider = await findUniqueOAuthProviderControl(page, 'LinuxDO', { allowIconOnly: true });
      assert.ok(provider, 'A supported LinuxDO entrance must not be lost after logout');
      await provider.click({ trial: true });
      assert.equal((await readReauthLogoutEvidence(page, linuxDoRule)).confirmed, true);
    }
    for (const markup of [
      '<button disabled>使用 Linux DO 继续</button>', '<button>使用 GitHub 继续</button>',
      '<button>Linux DO</button>', '<button>LinuxDO 登录</button><button>Linux DO 登录</button>',
      `<button>${icon.replace('<img ', '<img style="display:none" ')}</button>`, icon,
    ]) {
      providerMarkup = markup;
      await page.goto(`${origin}/login`);
      assert.equal((await readReauthLogoutEvidence(page, linuxDoRule)).confirmed, false);
    }
  });

  await t.test('a password control must be editable to confirm the logout', async () => {
    mode = 'password';
    for (const [attributes, expected] of [['', true], ['disabled', false], ['readonly', false], ['hidden', false]]) {
      providerMarkup = `<input type="password" ${attributes}>`;
      await page.goto(`${origin}/login`);
      assert.equal((await readReauthLogoutEvidence(page, rule)).confirmed, expected);
    }
  });
});
