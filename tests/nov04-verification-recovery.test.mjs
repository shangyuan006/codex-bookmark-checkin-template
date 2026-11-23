import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright-core';
import { normalizeNativeVerificationRecovery, watchNativeCheckinSubmissions,
  readNativeVerificationStatus, settleNativeVerificationRecovery } from '../src/native-checkin-recovery.mjs';
import { readChallengeWidgetReadiness } from '../src/challenge-widget-readiness.mjs';
import { bindSuccessEvidence, successEvidence, dailyReadinessEvidence } from '../src/checkin-evidence.mjs';
import { createSubmissionScope, readSubmissionJournal, guardPageSubmissions, attachSubmissionScope, reconcileSubmissionResult } from '../src/submission-guard.mjs';
import { waitForNativeReadOnlyCompletion } from '../src/native-checkin-state.mjs';
import { getConfiguredPreCheckinNavigationRule, inspectConfiguredDailyUnsignedForm,
  findConfiguredVerifiedFormAction } from '../src/pre-checkin-navigation.mjs';
import { runConfiguredDailyFormCheckin } from '../src/daily-form-checkin.mjs';
import { nativeSubmissionHandoff } from '../src/native-checkin-recovery.mjs';
import { readCheckinFeatureStatus } from '../src/checkin-feature-status.mjs';

const origin = 'https://verification.example';
const target = { origin, allowedOrigins: [origin] };
const recovery = { refreshPath: '/api/user/auth/refresh', selfPath: '/api/user/self',
  checkinPath: '/api/user/daily-v2', rejectionMessageIncludes: 'Turnstile' };
const browserOptions = { skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 25000 };
async function journal(t, config = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'verified-rejection-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'journal.json');
  return { file, scope: createSubmissionScope(file, target, config) };
}
function emitResponse(page, status = 200, body = { success: false, message: 'Turnstile verification required' }, requestPath = recovery.checkinPath) {
  const request = { method: () => 'POST', url: () => origin + requestPath };
  page.emit('request', request);
  page.emit('response', { request: () => request, status: () => status, json: async () => body });
  return request;
}

test('native recovery requires exact non-mutating status paths and an explicit rejection marker', () => {
  assert.deepEqual(normalizeNativeVerificationRecovery(recovery), recovery);
  for (const bad of ['//outside.example/api', '/api/../logout', '/api/logout', '/api/delete/account',
    '/api/status?token=private', '/api/%73tatus', '/api/status#fragment']) {
    assert.throws(() => normalizeNativeVerificationRecovery({ ...recovery, checkinPath: bad }));
  }
  assert.throws(() => normalizeNativeVerificationRecovery({ ...recovery, rejectionMessageIncludes: '' }));
});

test('submission watcher follows replacement pages and releases only explicit verification rejections', async () => {
  for (const scenario of ['rejected', 'unknown', 'success_replay', 'network_failure', 'auth_only', 'wrong_path', 'pending']) {
    const page = new EventEmitter(), next = new EventEmitter();
    const watcher = watchNativeCheckinSubmissions(page, origin, recovery); watcher.attach(next); watcher.attach(next);
    if (scenario !== 'auth_only') emitResponse(next, 200,
      scenario === 'unknown' ? { success: false, message: 'Unspecified error' } : undefined,
      scenario === 'wrong_path' ? recovery.checkinPath + '/history' : recovery.checkinPath);
    if (scenario === 'rejected' || scenario === 'auth_only') emitResponse(page, 401);
    if (scenario === 'success_replay') emitResponse(page, 200, { success: true });
    if (scenario === 'network_failure' || scenario === 'pending') {
      const request = { method: () => 'POST', url: () => origin + recovery.checkinPath };
      page.emit('request', request);
      if (scenario === 'network_failure') page.emit('requestfailed', request);
    }
    await watcher.stop();
    assert.equal(watcher.allRejected(), scenario === 'rejected', scenario);
    assert.equal(next.listenerCount('response'), 0);
    assert.doesNotMatch(JSON.stringify(watcher.diagnostics()), /Turnstile|https:|private|message/);
  }
});

test('fresh endpoint readiness alone cannot unlock a native intent or overwrite its history', async t => {
  const { file, scope } = await journal(t); await scope.begin();
  const proof = dailyReadinessEvidence(target, {}, { source: 'status_endpoint' });
  await assert.rejects(scope.rejectAfterVerifiedReadiness(proof), /Frozen explicitly rejected/);
  const rejected = { submissionsFrozen: true, allRejected: true, requestCount: 2, rejectionCount: 2,
    verificationRejectionCount: 1, requestFailed: false };
  for (const evidence of [{ ...proof.evidence, source: 'page_text' },
    { ...proof.evidence, confirmedAt: new Date(Date.now() - 60000).toISOString() },
    { ...proof.evidence, binding: { ...proof.evidence.binding, accountKey: 'other' } }]) {
    await assert.rejects(scope.rejectAfterVerifiedReadiness({ ...proof, evidence }, rejected));
  }
  await assert.rejects(createSubmissionScope(file, target).rejectAfterVerifiedReadiness(proof, rejected), /active check-in/);
  assert.equal((await readSubmissionJournal(file)).entries[0].state, 'intent');
  await scope.rejectAfterVerifiedReadiness(proof, rejected);
  const entry = (await readSubmissionJournal(file)).entries[0];
  assert.equal(entry.state, 'rejected'); assert.equal(entry.history[0].event, 'intent');
  assert.equal(entry.history.at(-1).reasonCode, 'verification_required');
  await createSubmissionScope(file, target).begin();
  assert.equal((await readSubmissionJournal(file)).entries.length, 2);
});

test('native recovery freezes before status verification and preserves unknown or successful replays', async t => {
  for (const scenario of ['rejected', 'unknown', 'signed', 'status_unknown']) {
    const { file, scope } = await journal(t); await scope.begin();
    const page = new EventEmitter(), watcher = watchNativeCheckinSubmissions(page, origin, recovery);
    emitResponse(page, scenario === 'unknown' ? 500 : 200);
    let frozen = false;
    const result = await settleNativeVerificationRecovery({ page, origin, rule: recovery, config: {}, scope, watcher,
      result: { status: 'interactive_challenge' }, freeze: async () => { frozen = true; },
      readStatus: async () => {
        assert.equal(frozen, true); assert.equal(page.listenerCount('request'), 0);
        return scenario === 'signed' ? { status: 'already_signed' } : scenario === 'status_unknown' ? null
          : dailyReadinessEvidence(target, {}, { source: 'status_endpoint' });
      } });
    assert.equal(result.verificationRecoveryDiagnostics.outcome,
      scenario === 'rejected' ? 'rejected_intent_released' : scenario === 'signed' ? 'completed' : 'protected');
    assert.equal((await readSubmissionJournal(file)).entries[0].state, scenario === 'rejected' ? 'rejected' : 'intent');
  }
});

test('fresh loaded state replaces a stale challenge explanation without releasing its lock', () => {
  const negative = dailyReadinessEvidence(target, {}, { source: 'status_endpoint' });
  const entries = [{ startedAt: new Date().toISOString(), cycleId: negative.evidence.binding.cycleId,
    identity: { siteOrigin: origin, accountKey: 'default', actionType: 'checkin' },
    history: [{ submissionObservation: { status: 'interactive_challenge', failureCode: 'cloudflare_verification_unresolved' } }] }];
  const result = reconcileSubmissionResult({ status: 'ready', siteBodyLoaded: true }, entries, target);
  assert.equal(result.failureCode, 'submission_quarantined');
  assert.equal(result.submissionObservation.status, 'ready');
  assert.equal(result.submissionObservation.failureCode, undefined);
});

test('widget evaluation errors have fixed diagnostics instead of pretending the checkbox was absent', async () => {
  for (const [message, expected] of [['Execution context was destroyed: PRIVATE', 'context_unavailable'],
    ['Frame was detached: PRIVATE', 'detached'], ['Timeout PRIVATE', 'timeout'], ['PRIVATE exception', 'evaluation_failed']]) {
    const result = await readChallengeWidgetReadiness({ evaluate: async () => { throw new Error(message); } });
    assert.equal(result.inspectionState, 'unreadable'); assert.equal(result.inspectionError, expected);
    assert.equal(result.checkboxReady, false); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
});

test('post-action grace observes delayed CF completion on the same document without extra actions or navigation', async () => {
  let time = 0;
  const result = await waitForNativeReadOnlyCompletion({
    url: () => origin + '/profile', waitForTimeout: async ms => { time += ms; },
    goto: async () => assert.fail('must retain the same document'),
  }, origin, {}, { timeoutMs: 8000, waitForCloudflareCompletion: true, now: () => time,
    readState: async () => time < 2000 ? { state: { status: 'interactive_challenge',
      failureCode: 'cloudflare_verification_unresolved' }, cloudflareUnresolved: true }
      : time < 4000 ? { state: { status: 'ready' }, dailyReadiness: dailyReadinessEvidence(target) }
        : { state: { status: 'already_signed' } } });
  assert.equal(result.state.status, 'already_signed'); assert.equal(time, 4000);
});

test('native inspector integrates same-page grace, exact endpoint protection and explicit rejection recovery', async t => {
  const source = await fs.readFile(new URL('../src/native-browser-inspect.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function inspectWithPlaywright() {');
  const end = source.indexOf('\nif (executeNewApiCheckin)', start);
  for (const completed of [false, true]) {
    const { file, scope } = await journal(t);
    let time = 0, clicks = 0, closed = 0;
    const page = new EventEmitter(), routes = [], output = [];
    Object.assign(page, { url: () => origin + '/profile', waitForLoadState: async () => {},
      waitForTimeout: async ms => { time += ms; }, route: async (match, handler) => routes.push({ match, handler }) });
    const context = { pages: () => [page], route: async (match, handler) => routes.push({ match, handler }) };
    const state = async () => ({ state: !clicks ? { status: 'ready' }
      : completed && time >= 3000 ? { status: 'already_signed' }
        : { status: 'interactive_challenge', failureCode: 'cloudflare_verification_unresolved' },
      siteBodyLoaded: true, cloudflareUnresolved: clicks > 0 && (!completed || time < 3000) });
    const dependencies = {
      connectOverCdpWithRetry: async () => ({ contexts: () => [context], close: async () => { closed++; } }),
      chromium: {}, port: 12345, maxWaitSeconds: 1, expectedOrigin: origin, scope,
      inspectionMode: 'execute-checkin',
      attachSubmissionScope, guardPageSubmissions, executeCheckin: true, executeCalendar: false,
      executeDailyForm: false, executeSamePage: false, continuationOnly: false, forceReadOnly: false, mayExecuteCheckin: true,
      selectNewestOriginPage: () => page, pagesForOrigin: () => [page], readPageState: state, config: {},
      actionRule: { actionTexts: ['立即签到'], clickChallenge: true, verificationRecovery: recovery }, allowEndpointReady: false,
      watchNativeCheckinSubmissions, nativeSubmissionHandoff, readCheckinFeatureStatus, settleNativeVerificationRecovery: options => settleNativeVerificationRecovery({ ...options,
        readStatus: async () => dailyReadinessEvidence(target, {}, { source: 'status_endpoint' }) }),
      createNativeSafeLineReader: (_origin, options) => ({ read: options.readState, diagnostics: () => null }),
      createNativeCloudflareReader: (_origin, options) => ({ read: options.readState, diagnostics: () => null }),
      waitForNativeReadOnlyCompletion: (page, origin, config, options) => waitForNativeReadOnlyCompletion(page, origin, config, { ...options, now: () => time }),
      waitForNativeCheckinAction: async () => { await scope.begin(); clicks++; emitResponse(page); return { clicked: true, outcome: 'clicked' }; },
      nativeEvidence: async value => ['signed', 'already_signed'].includes(value.status)
        ? bindSuccessEvidence({ ...value, evidence: successEvidence('page_text', 'native_confirmed_completion') }, target) : value,
      reconcileSubmissionResult, Date: { now: () => time }, setTimeout: (callback, ms) => { time += ms; callback(); },
      console: { log: value => output.push(JSON.parse(value)) },
    };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction(...Object.keys(dependencies), source.slice(start, end) + '\nawait inspectWithPlaywright();')(...Object.values(dependencies));
    assert.equal(clicks, 1); assert.equal(closed, 1);
    assert.equal(output[0].status, completed ? 'already_signed' : 'interactive_challenge');
    assert.equal(output[0].verificationRecoveryDiagnostics.outcome, completed ? 'completed' : 'rejected_intent_released');
    assert.equal((await readSubmissionJournal(file)).entries[0].state, completed ? 'confirmed' : 'rejected');
    assert.equal(time, completed ? 3000 : 30000);
    assert.equal(routes.length, 2, 'both context and page must protect replacement tabs');
    for (const route of routes) {
      assert.equal(route.match(new URL(origin + recovery.checkinPath)), true);
      let blocked = false;
      await route.handler({ request: () => ({ method: () => 'POST', url: () => origin + recovery.checkinPath }),
        abort: async () => { blocked = true; }, continue: async () => assert.fail('finalization must freeze asynchronous replay') });
      assert.equal(blocked, true);
    }
  }
});

const formConfig = { dailyFormReadinessWaitMs: 100, checkinStateWaitMs: 3000,
  preCheckinNavigationRules: { [origin]: { expectedPath: '/daily.php', steps: [{ role: 'link', name: '每日签到' }],
    completedTextPattern: '连续签到\\s*\\d+\\s*天[\\s\\S]{0,120}获得[\\s\\S]{0,30}魔力',
    dailyUnsignedForm: { visibleSelectors: ['form button[type=submit]'], nonEmptyValueSelectors: ['input[name=sign_token]', 'input[name=sign_submit]'],
      emptyValueSelectors: ['input[name=cf-turnstile-response]'], actionText: '提交签到',
      actionTexts: ['提交签到', '验证已通过点此提交'], ignoreActionDecorations: true, pendingChallenge: 'turnstile',
      verifiedAction: { selector: 'form button[type=submit]', text: '验证已通过点此提交' } } } } };
const formHtml = `<a href="/logout.php">退出</a><form id="daily"><input name="sign_token" type="hidden" value="PRIVATE">
  <input name="sign_submit" type="hidden" value="1"><input name="cf-turnstile-response" type="hidden" value="">
  <button type="submit">验证已通过，点此提交</button></form>`;

test('verified submit fallback requires an explicit exact Turnstile action label', () => {
  const rule = formConfig.preCheckinNavigationRules[origin];
  for (const change of [{ pendingChallenge: undefined }, { verifiedAction: { selector: '', text: '验证已通过点此提交' } },
    { verifiedAction: { selector: 'button', text: '随便点击' } }]) {
    assert.throws(() => getConfiguredPreCheckinNavigationRule(target, origin, { preCheckinNavigationRules: {
      [origin]: { ...rule, dailyUnsignedForm: { ...rule.dailyUnsignedForm, ...change } } } }));
  }
});

test('offline verified label with an empty widget response submits once and waits for delayed completion', browserOptions, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); let submissions = 0;
  await page.exposeFunction('recordSubmit', () => submissions++);
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: formHtml +
    `<script>document.querySelector('form').onsubmit=e=>{e.preventDefault();recordSubmit();setTimeout(()=>{
      document.querySelector('button').remove();document.body.append('连续签到 5 天，获得 100 魔力')},700)}</script>` }));
  await page.goto(origin + '/daily.php');
  const result = await runConfiguredDailyFormCheckin(page, target, formConfig, { waitMs: 1000 });
  assert.equal(result.status, 'signed'); assert.equal(submissions, 1); assert.equal(page.url(), origin + '/daily.php');
  assert.equal(result.formDiagnostics.verificationReady, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|sign_token/);
});

test('offline verified submit refuses malformed, unbound, ambiguous or still-challenged forms', browserOptions, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: formHtml }));
  for (const scenario of ['valid', 'no_opt_in', 'missing_token', 'duplicate_token', 'other_form', 'disabled', 'duplicate_button', 'wrong_label', 'visible_challenge', 'external_form', 'external_action']) {
    await page.goto(origin + '/daily.php');
    await page.evaluate(scenario => {
      const button = document.querySelector('button'), token = document.querySelector('input[name=sign_token]');
      if (scenario === 'missing_token') token.value = '';
      if (scenario === 'duplicate_token') token.after(token.cloneNode());
      if (scenario === 'other_form') { const other = document.createElement('form'); document.body.append(other); other.append(document.querySelector('input[name=cf-turnstile-response]')); }
      if (scenario === 'disabled') button.disabled = true;
      if (scenario === 'duplicate_button') button.after(button.cloneNode(true));
      if (scenario === 'wrong_label') button.textContent = '提交签到';
      if (scenario === 'visible_challenge') { const challenge = document.createElement('div'); challenge.className = 'cf-turnstile'; challenge.textContent = '验证中'; document.body.append(challenge); }
      if (scenario === 'external_form') document.querySelector('form').action = 'https://outside.example/submit';
      if (scenario === 'external_action') button.formAction = 'https://outside.example/submit';
    }, scenario);
    const config = structuredClone(formConfig);
    if (scenario === 'no_opt_in') delete config.preCheckinNavigationRules[origin].dailyUnsignedForm.verifiedAction;
    const result = await inspectConfiguredDailyUnsignedForm(page, target, origin, config);
    assert.equal(result?.status ?? null, scenario === 'valid' ? 'not_signed' : null, scenario);
    assert.equal(Boolean(await findConfiguredVerifiedFormAction(page, target, origin, config)), scenario === 'valid', scenario);
  }
});

test('offline native status reads respect cycle rules and never POST the check-in endpoint', browserOptions, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(), calls = []; let signed = false;
  await page.route('**/*', route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    calls.push([request.method(), pathname]);
    const body = pathname === recovery.refreshPath ? { success: true, data: { access_token: 'stub', user: { id: 1 } } }
      : pathname === recovery.selfPath ? { success: true, data: { id: 1 } }
        : pathname === recovery.checkinPath ? { success: true, data: { stats: { checked_in_today: signed } } } : null;
    return route.fulfill({ contentType: body ? 'application/json' : 'text/html', body: body ? JSON.stringify(body) : '<main>Fixture</main>' });
  });
  await page.goto(origin + '/profile');
  const config = { siteCycleRules: { [origin]: { timeZone: 'America/Los_Angeles', resetAt: '18:00' } } };
  const negative = await readNativeVerificationStatus(page, origin, recovery, config);
  assert.equal(negative.status, 'not_signed');
  assert.equal(negative.evidence.binding.cycleId, dailyReadinessEvidence(target, config).evidence.binding.cycleId);
  signed = true;
  const positive = await readNativeVerificationStatus(page, origin, recovery, config);
  assert.equal(positive.status, 'already_signed'); assert.equal(positive.evidence.source, 'status_endpoint');
  assert.equal(calls.filter(([method, pathname]) => method === 'POST' && pathname === recovery.checkinPath).length, 0);
  assert.doesNotMatch(JSON.stringify([negative, positive]), /PRIVATE|access_token/);
});

test('offline frozen native recovery blocks delayed site replay on a renamed endpoint', browserOptions, async t => {
  const { file, scope } = await journal(t);
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); let serverPosts = 0, frozen = false;
  await page.route('**/*', route => {
    if (new URL(route.request().url()).pathname !== recovery.checkinPath) return route.fulfill({ contentType: 'text/html', body: '<main>Fixture</main>' });
    serverPosts++; return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: false, message: 'Turnstile required' }) });
  });
  await page.goto(origin + '/profile');
  // Continue through the offline backend instead of the real network. The
  // production guard still decides whether to abort before that backend runs.
  const guardedPage = { route: (match, handler) => page.route(match, route => handler({
    request: () => route.request(), abort: code => route.abort(code), continue: () => route.fallback(),
  })) };
  await guardPageSubmissions(guardedPage, { ...target, submissionPaths: [recovery.checkinPath] }, scope, { readOnly: () => frozen });
  const watcher = watchNativeCheckinSubmissions(page, origin, recovery);
  await page.evaluate(endpoint => fetch(endpoint, { method: 'POST' }).then(r => r.json()), recovery.checkinPath);
  const result = await settleNativeVerificationRecovery({ page, origin, rule: recovery, config: {}, scope, watcher,
    result: { status: 'interactive_challenge' }, freeze: async () => { frozen = true; },
    readStatus: async () => dailyReadinessEvidence(target, {}, { source: 'status_endpoint' }) });
  assert.equal(result.verificationRecoveryDiagnostics.outcome, 'rejected_intent_released');
  const retry = await page.evaluate(endpoint => fetch(endpoint, { method: 'POST' }).then(() => 'sent').catch(() => 'blocked'), recovery.checkinPath);
  assert.equal(retry, 'blocked'); assert.equal(serverPosts, 1);
  const entries = (await readSubmissionJournal(file)).entries;
  assert.equal(entries.length, 1); assert.equal(entries[0].state, 'rejected');
});

test('offline widget inspection distinguishes visible loading, ready open-shadow controls and completion', browserOptions, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<div id="host"></div>');
  await page.evaluate(() => document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML =
    '<style>#verifying{display:none}</style><div id="verifying">Verifying</div><label><input type="checkbox">请验证您是真人</label>');
  assert.equal((await readChallengeWidgetReadiness(page.mainFrame())).inspectionState, 'ready');
  await page.evaluate(() => document.querySelector('#host').shadowRoot.querySelector('#verifying').style.display = 'block');
  assert.equal((await readChallengeWidgetReadiness(page.mainFrame())).inspectionState, 'loading');
  await page.evaluate(() => {
    const root = document.querySelector('#host').shadowRoot;
    root.querySelector('#verifying').remove(); root.querySelector('input').checked = true;
  });
  assert.equal((await readChallengeWidgetReadiness(page.mainFrame())).inspectionState, 'resolved');
});
