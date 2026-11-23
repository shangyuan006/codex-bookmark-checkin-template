import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { continueOAuthProviderReturn } from '../src/oauth-provider-return.mjs';
import { createOAuthTimeBudget } from '../src/oauth-time-budget.mjs';
import { waitForOAuthTargetReturn } from '../src/oauth-target-completion.mjs';
import { sanitizeOAuthFlowDiagnostic } from '../src/oauth-flow-diagnostics.mjs';
import { loginHelperOutcome } from '../src/login-recovery.mjs';
import { reauthLoginFailureResult, runTargetFirstLinuxDoOAuthWithRetry } from '../src/reauth-checkin.mjs';

const origin = 'https://target.example';
const consent = 'https://connect.linux.do/oauth2/authorize';
const sso = 'https://linux.do/session/sso_provider';
function fixture(initial = consent) {
  let url = initial, clock = 0;
  const stages = [], observations = [];
  const page = { url: () => url, isClosed: () => false,
    locator: () => ({ count: async () => url === 'https://linux.do/login' ? 1 : 0 }),
    waitForTimeout: async ms => { clock += ms; }, waitForLoadState: async () => {} };
  const options = { now: () => clock, timeBudget: createOAuthTimeBudget({ now: () => clock }), waitMs: 90_000,
    onStage: stage => stages.push(stage), onProgress: value => observations.push(value),
    authorize: async () => { url = sso; return { clicked: true, outcome: 'authorization_clicked' }; },
    describe: async () => ({ challengeFrameCount: 0 }), clickChallenge: async () => false };
  return { page, stages, observations, options, now: () => clock, setUrl: value => { url = value; } };
}

test('consent returning to SSO is resumed before callback and authoritative session verification', async () => {
  const f = fixture();
  let ssoCalls = 0, authorizations = 0, sessionCalls = 0;
  const result = await continueOAuthProviderReturn(f.page, origin, 'LinuxDO', {}, { ...f.options,
    authorize: async () => { f.setUrl(++authorizations === 1 ? sso : origin + '/callback');
      return { clicked: true, outcome: 'authorization_clicked' }; },
    waitForSso: async (page, options) => {
      assert.equal(page, f.page);
      assert.equal(options.timeoutMs, 30_000);
      ssoCalls++;
      options.onChallengeObserved();
      await page.waitForTimeout(5000);
      f.setUrl(consent);
      return { transitioned: true };
    },
  });
  assert.equal(ssoCalls, 1);
  assert.equal(authorizations, 2);
  assert.equal(result.readyForCallback, true);
  assert.equal(result.authorizationOutcome, 'authorization_departed');
  assert.equal(result.loggedIn, undefined, 'Provider navigation alone cannot confirm login');
  assert.equal(result.providerReturnDiagnostics.ssoVisits, 1);
  const context = { pages: () => [f.page] };
  const completion = await waitForOAuthTargetReturn(context, origin,
    { savedLoginSessionRules: { [origin]: {} } }, { ...f.options, preferredPage: f.page,
      onPhase: phase => f.stages.push(phase),
      wait: async ms => { await f.page.waitForTimeout(ms); f.setUrl(origin + '/console'); },
      readSurface: async () => ({ ready: true, authenticatedControl: true }),
      verifySession: async () => { sessionCalls++; return { status: 'valid' }; },
    });
  assert.equal(completion.loggedIn, true);
  assert.ok(sessionCalls > 0);
  assert.ok(f.stages.includes('linuxdo_login_challenge'));
  assert.equal(f.stages.at(-1), 'session_verification');
});

test('unchanged SSO stops within 30 seconds without entering a 90 second target callback wait', async () => {
  const f = fixture(sso);
  const result = await continueOAuthProviderReturn(f.page, origin, 'LinuxDO', {}, { ...f.options,
    waitForSso: async (page, options) => { await page.waitForTimeout(options.timeoutMs); return { transitioned: false }; },
  });
  assert.equal(result.readyForCallback, false);
  assert.equal(f.now(), 30_000);
  assert.equal(f.stages.at(-1), 'linuxdo_sso_stalled');
  assert.equal(f.stages.includes('target_callback'), false);
  let calls = 0;
  const failure = { status: 'needs_attention', oauthStage: f.stages.at(-1), ...result };
  await runTargetFirstLinuxDoOAuthWithRetry({ provider: 'LinuxDO', linuxDoSessionStrategy: 'target_oauth' }, {},
    { oauthAttempts: 3 }, { runHelper: async () => { calls++; return failure; } });
  assert.equal(calls, 1);
  const presented = reauthLoginFailureResult('LinuxDO', failure.oauthStage, { diagnostics: failure });
  assert.equal(presented.retryable, false);
  assert.match(presented.reason, /SSO 中转未完成/);
  assert.equal(presented.providerReturnDiagnostics.outcome, 'provider_stalled');
});

test('SSO returning to a login form tries saved login once and preserves manual handoff on failure', async () => {
  const f = fixture(sso);
  let recoveries = 0;
  const result = await continueOAuthProviderReturn(f.page, origin, 'LinuxDO', {}, { ...f.options,
    waitForSso: async () => { f.setUrl('https://linux.do/login'); return { transitioned: true }; },
    recoverLogin: async () => { recoveries++; return { recovered: false }; },
  });
  assert.equal(result.readyForCallback, false);
  assert.equal(recoveries, 1);
  assert.equal(result.authorizationOutcome, 'provider_login_required');
  assert.equal(f.stages.at(-1), 'linuxdo_provider_login_required');
});

test('restored login on provider home resumes target OAuth in the same flow with the newest page', async () => {
  const f = fixture('https://linux.do/login');
  const next = { ...f.page, url: () => origin + '/callback' };
  let restarts = 0;
  const result = await continueOAuthProviderReturn(f.page, origin, 'LinuxDO', {}, { ...f.options,
    recoverLogin: async () => { f.setUrl('https://linux.do/'); return { recovered: true }; },
    resumeTargetOAuth: async page => { assert.equal(page, f.page); restarts++; return next; },
  });
  assert.equal(result.readyForCallback, true);
  assert.equal(result.page, next);
  assert.equal(restarts, 1);
  assert.equal(result.providerReturnDiagnostics.loginRecoveries, 1);
  assert.equal(result.providerReturnDiagnostics.restarts, 1);
});

test('repeated SSO and consent cycles have a finite transition limit', async () => {
  const f = fixture();
  let visits = 0;
  const result = await continueOAuthProviderReturn(f.page, origin, 'LinuxDO', {}, { ...f.options,
    waitForSso: async () => { visits++; f.setUrl(consent); return { transitioned: true }; },
  });
  assert.equal(result.readyForCallback, false);
  assert.equal(visits, 3);
  assert.equal(f.stages.at(-1), 'linuxdo_sso_stalled');
});

test('repeated provider-home recovery never starts a second target OAuth', async () => {
  const f = fixture('https://linux.do/');
  let restarts = 0;
  const result = await continueOAuthProviderReturn(f.page, origin, 'LinuxDO', {}, { ...f.options,
    resumeTargetOAuth: async page => { restarts++; return page; },
  });
  assert.equal(result.readyForCallback, false);
  assert.equal(restarts, 1);
});

test('SSO receives only the remaining provider budget and target callbacks are not revisited', async () => {
  const f = fixture(sso);
  await f.page.waitForTimeout(134_000);
  const result = await continueOAuthProviderReturn(f.page, origin, 'LinuxDO', {}, { ...f.options,
    waitForSso: async (page, options) => { assert.equal(options.timeoutMs, 1000); f.setUrl(origin + '/callback'); return { transitioned: true }; },
  });
  assert.equal(result.readyForCallback, true);
  assert.equal(result.authorizationOutcome, null);
  assert.equal(result.providerReturnDiagnostics.ssoVisits, 1);
});

test('a provider route without a known continuation settles briefly and hands off precisely', async () => {
  const f = fixture('https://linux.do/session/other');
  const result = await continueOAuthProviderReturn(f.page, origin, 'LinuxDO', {}, f.options);
  assert.equal(result.readyForCallback, false);
  assert.equal(f.now(), 5000);
  assert.equal(f.stages.at(-1), 'linuxdo_sso_stalled');
});

test('GitHub callbacks do not invoke LinuxDO recovery or emit provider-return diagnostics', async () => {
  const f = fixture('https://github.com/login/oauth/authorize');
  const result = await continueOAuthProviderReturn(f.page, origin, 'GitHub', {}, { ...f.options,
    authorize: async () => { f.setUrl(origin + '/callback'); return { clicked: true, outcome: 'authorization_clicked' }; },
    requiresLogin: async () => assert.fail('GitHub must not use LinuxDO login recovery'),
    waitForSso: async () => assert.fail('GitHub must not use LinuxDO SSO recovery'),
  });
  assert.equal(result.readyForCallback, true);
  assert.equal(result.providerReturnDiagnostics, undefined);
});

test('configured callback aliases retain the existing origin rewrite path without trusting arbitrary domains', async () => {
  for (const allowed of [true, false]) {
    const f = fixture('https://legacy.example/callback?code=fixture');
    const result = await continueOAuthProviderReturn(f.page, origin, 'LinuxDO', {
      oauthCallbackOriginAliases: { [origin]: allowed ? ['https://legacy.example'] : [] },
    }, f.options);
    assert.equal(result.readyForCallback, allowed);
    assert.equal(result.providerReturnDiagnostics.outcome, allowed ? 'callback_alias' : 'provider_stalled');
  }
});

test('provider-return diagnostics survive helper parsing with only bounded anonymous fields', () => {
  const raw = { status: 'needs_attention', oauthStage: 'linuxdo_sso_stalled', providerReturnDiagnostics: {
    outcome: 'provider_stalled', ssoVisits: 999, loginRecoveries: 42, restarts: -1,
    url: consent + '?token=private-fixture', body: 'private-fixture',
  } };
  const parsed = loginHelperOutcome(JSON.stringify(raw));
  assert.equal(parsed.oauthStage, 'linuxdo_sso_stalled');
  assert.deepEqual(parsed.providerReturnDiagnostics, { outcome: 'provider_stalled', ssoVisits: 3, loginRecoveries: 1, restarts: 0 });
  const diagnostic = sanitizeOAuthFlowDiagnostic({ ...raw, flow: 'automatic_target', provider: 'LinuxDO' });
  assert.doesNotMatch(JSON.stringify(diagnostic), /private-fixture|token=/);
  assert.deepEqual(diagnostic.providerReturnDiagnostics, parsed.providerReturnDiagnostics);
});

test('offline Edge follows consent, SSO iframe, resumed consent and delayed target session', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 30_000,
}, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const phases = [], visits = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.ok([origin, 'https://connect.linux.do', 'https://linux.do', 'https://challenges.cloudflare.com'].includes(url.origin));
    visits.push(url.origin + url.pathname);
    let body;
    if (url.origin === 'https://connect.linux.do') {
      const next = url.searchParams.has('resumed') ? origin + '/callback' : sso;
      body = `<button onclick="location.href='${next}'">允许</button>`;
    } else if (url.origin === 'https://linux.do') {
      body = `<iframe src="https://challenges.cloudflare.com/fixture" style="width:300px;height:80px"></iframe>
        <script>addEventListener('message', e => {if(e.origin==='https://challenges.cloudflare.com' && e.data==='passed')
          location.href='${consent}?resumed=1';});</script>`;
    } else if (url.origin === 'https://challenges.cloudflare.com') {
      body = '<input type="checkbox" style="margin:20px" onchange="parent.postMessage(\'passed\',\'https://linux.do\')">';
    } else {
      body = url.pathname === '/callback' ? '<script>setTimeout(()=>location.href="/console",1200)</script>'
        : '<button id="account">Account</button>';
    }
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  const page = await context.newPage();
  await page.goto(consent);
  const timeBudget = createOAuthTimeBudget();
  const returned = await continueOAuthProviderReturn(page, origin, 'LinuxDO', {}, {
    timeBudget, waitMs: 10_000, onStage: value => phases.push(value),
  });
  assert.equal(returned.readyForCallback, true);
  assert.equal(returned.providerReturnDiagnostics.ssoVisits, 1);
  assert.ok(phases.includes('linuxdo_login_challenge'));
  const verified = await waitForOAuthTargetReturn(context, origin,
    { reauthCheckinRules: { [origin]: { accountMenuSelector: '#account' } } }, {
      timeBudget, waitMs: 5000, preferredPage: returned.page, onPhase: value => phases.push(value),
    });
  assert.equal(verified.loggedIn, true);
  assert.equal(new URL(verified.page.url()).pathname, '/console');
  assert.equal(visits.filter(value => value === 'https://connect.linux.do/oauth2/authorize').length, 2);
  assert.equal(phases.at(-1), 'session_verification');
});
