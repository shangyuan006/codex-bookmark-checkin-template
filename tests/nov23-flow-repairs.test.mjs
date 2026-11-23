import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright-core';
import { submitImageCaptcha } from '../src/image-captcha-checkin.mjs';
import { isOpenCdCaptchaRejection, readOpenCdState, runOpenCdCaptcha } from '../src/open-cd-checkin.mjs';
import { createSubmissionScope, readSubmissionJournal, runWithSubmissionJournal, SUBMISSION_SCOPE,
  guardPageSubmissions } from '../src/submission-guard.mjs';
import { dailyReadinessEvidence, bindSuccessEvidence } from '../src/checkin-evidence.mjs';
import { createSamePageReadinessReader, readSamePageReadiness, samePageMaySubmit } from '../src/same-page-checkin.mjs';
import { continueNativeSamePage } from '../src/same-page-sequential.mjs';
import { observeNavigationTimeout } from '../src/navigation-observation.mjs';

const origin = 'https://daily.example', target = { origin, allowedOrigins: [origin] };
const browserFixtures = process.env.CHECKIN_BROWSER_FIXTURES === '1';
const rejection = { submissionsFrozen: true, allRejected: true, requestFailed: false,
  requestCount: 1, rejectionCount: 1, verificationRejectionCount: 1, pendingResponseCount: 0 };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nov23-repairs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  return { automationUserDataDir: path.join(root, 'profile'), submissionJournalPath: path.join(root, 'journal.json') };
}

for (const scenario of ['rejected', 'unknown', 'http_error', 'invalid_json', 'network_failed', 'multiple', 'success']) {
  test(`image captcha retries require one explicit rejection: ${scenario}`, async () => {
    const page = new EventEmitter(); let reserved = 0;
    const request = { method: () => 'POST', url: () => origin + '/plugin_sign-in.php' };
    const result = await submitImageCaptcha(page, { origin, responsePath: '/plugin_sign-in.php', image: {},
      input: { fill: async () => {} }, readImage: async () => Buffer.from('fixture'),
      recognize: async () => ({ code: 'ABC123', confidence: 67 }), reserve: async () => reserved++,
      classifyRejection: isOpenCdCaptchaRejection, wait: async () => {}, readCompletion: async () => null,
      submit: { click: async () => {
        page.emit('request', request);
        if (scenario === 'multiple') page.emit('request', request);
        if (scenario === 'network_failed') page.emit('requestfailed', request);
        page.emit('response', { request: () => request, status: () => scenario === 'http_error' ? 500 : 200,
          json: async () => scenario === 'invalid_json' ? null : ({ state: scenario === 'success' ? 'success' : 'error',
            msg: scenario === 'unknown' ? 'PRIVATE_VALUE' : '验证码错误', token: 'PRIVATE_VALUE' }) });
      } } });
    assert.equal(result.failureCode === 'image_captcha_rejected', scenario === 'rejected');
    assert.equal(reserved, 1); assert.doesNotMatch(JSON.stringify(result), /ABC123|PRIVATE_VALUE|验证码错误/);
    assert.equal(page.listenerCount('request'), 0); assert.equal(page.listenerCount('requestfailed'), 0);
    assert.equal(page.listenerCount('response'), 0);
  });
}

test('OpenCD rejection classifier accepts only exact captcha errors', () => {
  for (const msg of ['验证码错误', '驗證碼輸入錯誤，請重新輸入', '验证码不正确。']) {
    assert.equal(isOpenCdCaptchaRejection({ state: 'error', msg }, 200), true);
  }
  for (const msg of ['签到失败', '已签到', '验证码已过期', '验证码错误，但签到成功', '']) {
    assert.equal(isOpenCdCaptchaRejection({ state: 'error', msg }, 200), false);
  }
  assert.equal(isOpenCdCaptchaRejection({ state: 'success', msg: '验证码错误' }, 200), false);
  assert.equal(isOpenCdCaptchaRejection({ state: 'error', msg: '验证码错误' }, 422), false);
});

test('image captcha retry is atomic, keeps history, and remains limited across restarts', async t => {
  const config = await fixture(t), scope = createSubmissionScope(config.submissionJournalPath, target, config);
  await scope.begin();
  await scope.beginAfterRejectedImageCaptcha(dailyReadinessEvidence(target, config), rejection);
  let entries = (await readSubmissionJournal(config.submissionJournalPath)).entries;
  assert.deepEqual(entries.map(e => e.state), ['rejected', 'intent']);
  assert.equal(entries[1].history[1].previousIntentId, entries[0].id);
  await assert.rejects(scope.beginAfterRejectedImageCaptcha(dailyReadinessEvidence(target, config), rejection));
  await scope.finishRejectedImageCaptcha(rejection);
  assert.equal((await scope.pending()).length, 0);
  assert.equal(await createSubmissionScope(config.submissionJournalPath, target, config).imageCaptchaRetryUsed(), true);
  const tomorrow = createSubmissionScope(config.submissionJournalPath, target, config,
    { now: () => new Date(Date.now() + 86400000) });
  assert.equal(await tomorrow.imageCaptchaRetryUsed(), false);
  entries = (await readSubmissionJournal(config.submissionJournalPath)).entries;
  assert.deepEqual(entries.map(e => e.state), ['rejected', 'rejected']);
});

for (const scenario of ['old_intent', 'wrong_account', 'wrong_cycle', 'wrong_origin', 'wrong_profile', 'stale', 'not_frozen', 'pending', 'failed', 'multiple']) {
  test(`image captcha recovery preserves protection: ${scenario}`, async t => {
    const config = await fixture(t), scope = createSubmissionScope(config.submissionJournalPath, target, config);
    await scope.begin(); const proof = dailyReadinessEvidence(target, config), receipt = { ...rejection };
    if (scenario === 'wrong_account') proof.evidence.binding.accountKey = 'other';
    if (scenario === 'wrong_cycle') proof.evidence.binding.cycleId = 'old';
    if (scenario === 'wrong_origin') proof.evidence.binding.observedOrigin = 'https://other.example';
    if (scenario === 'stale') proof.evidence.confirmedAt = new Date(Date.now() - 31000).toISOString();
    if (scenario === 'not_frozen') receipt.submissionsFrozen = false;
    if (scenario === 'pending') receipt.pendingResponseCount = 1;
    if (scenario === 'failed') receipt.requestFailed = true;
    if (scenario === 'multiple') receipt.requestCount = receipt.rejectionCount = receipt.verificationRejectionCount = 2;
    const active = ['old_intent', 'wrong_profile'].includes(scenario)
      ? createSubmissionScope(config.submissionJournalPath, target,
        scenario === 'wrong_profile' ? { ...config, automationUserDataDir: config.automationUserDataDir + '-other' } : config) : scope;
    await assert.rejects(active.beginAfterRejectedImageCaptcha(proof, receipt));
    assert.equal((await scope.pending()).length, 1);
    assert.equal((await readSubmissionJournal(config.submissionJournalPath)).entries.length, 1);
  });
}

test('fully rejected image retry does not acquire a new legacy intent', async t => {
  const config = await fixture(t);
  const result = await runWithSubmissionJournal(config.submissionJournalPath, target, config, async active => {
    const scope = active[SUBMISSION_SCOPE]; await scope.begin();
    await scope.beginAfterRejectedImageCaptcha(dailyReadinessEvidence(target, config), rejection);
    await scope.finishRejectedImageCaptcha(rejection);
    return { status: 'interactive_challenge', submissionAttempted: true, submissionTracked: true };
  });
  assert.equal(result.status, 'interactive_challenge');
  assert.deepEqual((await readSubmissionJournal(config.submissionJournalPath)).entries.map(e => e.state), ['rejected', 'rejected']);
});

test('OpenCD POST path is protected before a durable intent exists', async () => {
  let matcher, handler, blocked = 0;
  const page = { route: async (m, h) => { matcher = m; handler = h; }, unroute: async () => {} };
  await guardPageSubmissions(page, target, { begin: async () => { throw new Error('pending'); } });
  assert.equal(matcher(new URL(origin + '/plugin_sign-in.php')), true);
  await handler({ request: () => ({ url: () => origin + '/plugin_sign-in.php', method: () => 'POST' }),
    abort: async () => blocked++, continue: () => assert.fail('must not submit') });
  assert.equal(blocked, 1);
});

test('no-challenge permission requires stable readiness in the same document', async () => {
  let clock = 0, document = 1, candidate = true;
  const rule = { allowSubmitWithoutChallenge: true };
  const read = createSamePageReadinessReader({}, target, rule, { now: () => clock,
    readReady: async () => ({ buttonReady: true, widgetPresent: false, responseFieldPresent: false,
      challengeAbsentCandidate: candidate, documentStartedAt: document }) });
  assert.equal(samePageMaySubmit(await read(), rule), false);
  clock = 2000; assert.equal(samePageMaySubmit(await read(), rule), true);
  document++; assert.equal(samePageMaySubmit(await read(), rule), false);
  clock += 1000; candidate = false; await read(); candidate = true; clock += 1000;
  assert.equal(samePageMaySubmit(await read(), rule), false);
  clock += 2000; const ready = await read();
  assert.equal(samePageMaySubmit(ready, rule), true);
  assert.equal(samePageMaySubmit(ready), false);
  assert.equal(samePageMaySubmit({ ...ready, responseFieldPresent: true }, rule), false);
  assert.equal(samePageMaySubmit({ ...ready, widgetPresent: true }, rule), false);
});

for (const scenario of ['signed', 'login', 'challenge', 'timeout', 'wrong_path', 'other_origin', 'not_timeout', 'unloaded', 'document_changed']) {
  test(`slow navigation observation stays read-only: ${scenario}`, async () => {
    let clock = 0, reads = 0;
    const url = origin + (scenario === 'wrong_path' ? '/other' : '/daily');
    const page = { url: () => scenario === 'other_origin' ? 'https://other.example/daily' : url,
      isClosed: () => false, goto: () => assert.fail(), reload: () => assert.fail(), click: () => assert.fail(),
      evaluate: async fn => String(fn).includes('document.readyState')
        ? { url, loaded: scenario !== 'unloaded', startedAt: 1 } : scenario === 'document_changed' ? 2 : 1 };
    const status = { signed: 'already_signed', login: 'login_required', challenge: 'interactive_challenge' }[scenario] ?? 'ready';
    const result = await observeNavigationTimeout(page, target, url,
      { navigationObservationRules: { [origin]: { paths: ['/daily'], waitMs: 1500 } } },
      { error: { name: scenario === 'not_timeout' ? 'Error' : 'TimeoutError' }, now: () => clock,
        delay: async ms => { clock += ms; }, readState: async () => { reads++; return { status }; } });
    if (['wrong_path', 'other_origin', 'not_timeout'].includes(scenario)) {
      assert.equal(result, null); assert.equal(reads, 0);
    } else if (['signed', 'login', 'challenge'].includes(scenario)) assert.equal(result.status, status);
    else { assert.equal(result.failureCode, 'navigation_observation_unconfirmed'); assert.equal(clock, 1500); }
    if (scenario === 'unloaded') assert.equal(reads, 0);
  });
}

async function browserPage(t) {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close()); return browser.newPage();
}
test('slow-page observation bounds an unresolved state read', async () => {
  const url = origin + '/daily', started = Date.now();
  const page = { url: () => url, isClosed: () => false,
    evaluate: async () => ({ url, loaded: true, startedAt: 1 }) };
  const result = await observeNavigationTimeout(page, target, url,
    { navigationObservationRules: { [origin]: { paths: ['/daily'], waitMs: 1000 } } },
    { error: { name: 'TimeoutError' }, readState: () => new Promise(() => {}) });
  assert.equal(result.failureCode, 'navigation_observation_unconfirmed');
  assert.ok(Date.now() - started < 2500);
});
const home = (body) => `<a href="logout.php">退出</a>${body}`;
for (const scenario of ['record', 'signed', 'history_text', 'unsigned', 'challenge', 'password', 'other_origin', 'duplicate']) {
  test(`OpenCD completion control is scoped and authenticated: ${scenario}`, { skip: !browserFixtures }, async t => {
    const page = await browserPage(t);
    const record = '<a href="/plugin_sign-in.php?cmd=show-log">查看簽到記錄</a>';
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: home(
      scenario === 'history_text' ? '<p>查看簽到記錄</p>' : scenario === 'signed' ? '<a id="sign_in_span">已签到</a>'
      : record + (scenario === 'unsigned' ? '<a id="sign_in_span">簽到</a>'
        : scenario === 'challenge' ? '<div class="cf-turnstile">Verification</div>'
        : scenario === 'password' ? '<input type="password">' : scenario === 'duplicate' ? record : '')) }));
    await page.goto((scenario === 'other_origin' ? 'https://other.example' : origin) + '/');
    const state = await readOpenCdState(page, origin);
    assert.equal(state?.status === 'already_signed', ['record', 'signed'].includes(scenario));
    if (scenario === 'unsigned') assert.equal(state.status, 'not_signed');
  });
}

for (const scenario of ['retry_success', 'unknown', 'twice_rejected', 'late_replay']) {
  test(`OpenCD iframe and AJAX flow: ${scenario}`, { skip: !browserFixtures }, async t => {
    const page = await browserPage(t), config = await fixture(t); let posts = 0, recognitions = 0, completed = false;
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() === 'POST') {
        posts++; const success = scenario === 'retry_success' && posts === 2; completed = success;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ state: success ? 'success' : 'error',
          msg: scenario === 'unknown' ? 'PRIVATE_VALUE' : '验证码错误' }) });
      }
      if (url.pathname === '/plugin_sign-in.php') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<form>
        <img src="data:image/png;base64,iVBORw0KGgo="><input name="imagestring"><button id="ok">签到</button></form>
        <script>document.querySelector('form').onsubmit=e=>{e.preventDefault();parent.do_signin();}</script>` });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: home(completed
        ? '<a href="/plugin_sign-in.php?cmd=show-log">查看簽到記錄</a>'
        : `<a href="#" id="sign_in_span">簽到</a><script>
          document.querySelector('#sign_in_span').onclick=e=>{e.preventDefault();const f=document.createElement('iframe');
            f.id='i_signin';f.src='/plugin_sign-in.php';document.body.append(f);};
          window.do_signin=async()=>{const r=await fetch('/plugin_sign-in.php',{method:'POST'});const data=await r.json();
            document.querySelector('#i_signin').remove();document.querySelector('#sign_in_span').textContent=data.state==='success'?'已签到':data.msg;};
          ${scenario === 'late_replay' ? "setTimeout(()=>{const action=window.do_signin;window.do_signin=async()=>{await action();setTimeout(()=>fetch('/plugin_sign-in.php',{method:'POST'}).catch(()=>{}),150);};},0);" : ''}
          </script>`) });
    });
    await page.goto(origin + '/');
    const result = await runWithSubmissionJournal(config.submissionJournalPath, target, config, async active => {
      const scope = active[SUBMISSION_SCOPE];
      return bindSuccessEvidence(await runOpenCdCaptcha(page, origin, config, {
        reserve: () => scope.begin(), retryUsed: () => scope.imageCaptchaRetryUsed(),
        retryRejected: async (proof, receipt) => { await scope.beginAfterRejectedImageCaptcha(proof, receipt); return true; },
        rejectExhausted: receipt => scope.finishRejectedImageCaptcha(receipt),
        recognize: async () => { recognitions++; return { code: 'ABC123', confidence: 56 }; },
        readImage: async () => { assert.equal((await scope.pending()).length, Number(recognitions > 0)); return Buffer.from('fixture'); },
        wait: ms => page.waitForTimeout(Math.min(ms, 100)),
      }), target, config);
    });
    assert.equal(posts, ['unknown', 'late_replay'].includes(scenario) ? 1 : 2); assert.equal(recognitions, posts);
    assert.equal(result.status === 'already_signed', scenario === 'retry_success');
    const entries = (await readSubmissionJournal(config.submissionJournalPath)).entries;
    assert.deepEqual(entries.map(e => e.state), scenario === 'retry_success' ? ['rejected', 'confirmed']
      : ['unknown', 'late_replay'].includes(scenario) ? ['uncertain'] : ['rejected', 'rejected']);
    assert.doesNotMatch(JSON.stringify({ result, entries }), /ABC123|PRIVATE_VALUE/);
  });
}

const plainRule = { expectedPath: '/attendance.php', widgetSelector: '.cf-turnstile',
  responseSelector: 'input[name=cf-turnstile-response]', browserMode: 'native', sequentialActionType: 'daily_checkin',
  allowSubmitWithoutChallenge: true };
for (const scenario of ['plain', 'hidden_token', 'hidden_widget', 'script', 'wrong_form', 'password', 'extra_input', 'logged_out']) {
  test(`plain form fallback validates absence of verification: ${scenario}`, { skip: !browserFixtures }, async t => {
    const page = await browserPage(t);
    const extra = { hidden_token: '<input name="cf-turnstile-response" type="hidden">',
      hidden_widget: '<div class="cf-turnstile" hidden></div>', script: '<script>window.verification="turnstile"</script>',
      password: '<input type="password">', extra_input: '<input name="other">' }[scenario] ?? '';
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
      (scenario === 'logged_out' ? '' : '<a href="logout.php">退出</a>')
      + `<form method="post" action="${scenario === 'wrong_form' ? '/other' : '/attendance.php'}">${extra}<input type="submit" value="立即签到"></form>` }));
    await page.goto(origin + '/attendance.php');
    const readiness = await readSamePageReadiness(page, target, { ...plainRule, actionName: '立即签到' });
    assert.equal(readiness.challengeAbsentCandidate === true, scenario === 'plain');
  });
}

for (const pending of [false, true]) test(`plain native form submits once and honors pending intent: ${pending}`,
  { skip: !browserFixtures }, async t => {
    const page = await browserPage(t), config = await fixture(t); let posts = 0;
    config.samePageManualCheckinRules = { [origin]: plainRule };
    config.sequentialActionRules = { [origin]: { steps: [{ url: origin + '/attendance.php', actionType: 'daily_checkin',
      dailyCheckin: true, actionTexts: ['立即签到'], actionTags: ['INPUT'], completedIncludes: ['今天已经签到'],
      acceptGenericCheckinState: false }] } };
    await page.route('**/*', route => {
      if (route.request().method() === 'POST') { posts++; return route.fulfill({ contentType: 'text/html; charset=utf-8', body: home('今天已经签到') }); }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: home('<form method="post"><input type="submit" value="立即签到"></form>') });
    });
    await page.goto(origin + '/attendance.php');
    if (pending) await createSubmissionScope(config.submissionJournalPath, { ...target, actionType: 'daily_checkin' }, config).begin();
    const result = await continueNativeSamePage(page, target, config, { waitMs: 4000, dismiss: async () => {},
      clickAction: async (page, step, allowed, reserve) => {
        await page.route(origin + '/attendance.php', route => {
          assert.equal(route.request().method(), 'POST'); posts++;
          return route.fulfill({ contentType: 'text/html; charset=utf-8', body: home('今天已经签到') });
        });
        await reserve(); await page.getByRole('button', { name: '立即签到', exact: true }).click(); return { clicked: true };
      } });
    assert.equal(posts, Number(!pending)); assert.equal(result.status === 'signed', !pending);
  });
