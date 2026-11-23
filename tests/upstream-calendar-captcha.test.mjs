import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { piggoApiData, piggoCalendarStatus, piggoAccountFingerprint, piggoCalendarRule,
  piggoResponseFresh, readPiggoCalendarState } from '../src/piggo-calendar.mjs';
import { isNexusCaptchaRejectedText, runNexusImageCaptcha } from '../src/nexus-image-captcha.mjs';
import { createSubmissionScope, readSubmissionJournal } from '../src/submission-guard.mjs';
import { dailyReadinessEvidence, bindSuccessEvidence, successEvidence } from '../src/checkin-evidence.mjs';
import { summarizeUnknownReports, unknownRowCategory } from '../src/unknown-summary.mjs';
import { continueNativeSamePage } from '../src/same-page-sequential.mjs';

const origin = 'https://calendar.example', target = { origin, actionType: 'daily_checkin' };
const at = new Date('2026-11-23T04:00:00Z'), today = '2026-11-23';
const envelope = data => ({ code: 0, msg: '', data });
const calendar = (status = 'today') => envelope({ cells: [], selected: today,
  detail: { is_today: true, ymd: today, attendance: { status } } });
const accountFingerprint = piggoAccountFingerprint(envelope({ user: { id: 7 } }), origin);
const enabled = () => ({ piggoCalendarRules: { [origin]: { enabled: true } },
  unsignedSubmissionRecoveryRules: { [origin]: { enabled: true, reader: 'piggo_calendar', actionType: 'daily_checkin' } } });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'upstream-calendar-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  return { root, config: { ...enabled(), automationUserDataDir: path.join(root, 'profile'), submissionJournalPath: path.join(root, 'journal.json') } };
}
const unsigned = (config, when = at) => ({ ...dailyReadinessEvidence(target, config, { source: 'status_endpoint', now: when }),
  accountFingerprint, businessDate: today, passiveReader: 'piggo_calendar', passiveObservedAt: when.toISOString(),
  passiveDocumentStartedAt: when.getTime() - 100, submissionAttempted: false });

test('PigGo requires the exact current-day calendar structure', () => {
  assert.equal(piggoCalendarStatus(calendar('today'), today), 'not_signed');
  assert.equal(piggoCalendarStatus(calendar('checked'), today), 'already_signed');
  for (const mutate of [v => v.code = 1, v => delete v.msg, v => v.data.selected = '2026-11-22',
    v => v.data.detail.ymd = '2026-11-22', v => v.data.detail.is_today = false,
    v => v.data.detail.attendance.status = 'unknown', v => v.data.cells = null]) {
    const value = calendar(); mutate(value); assert.equal(piggoCalendarStatus(value, today), null);
  }
  assert.equal(piggoApiData({ code: 0, data: {} }), null);
  assert.equal(piggoAccountFingerprint({ user: { id: '7' } }, origin), null);
  assert.equal(piggoAccountFingerprint({ user: { id: 0 } }, origin), null);
  assert.match(accountFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(piggoCalendarRule(target, {}), null);
  assert.throws(() => piggoCalendarRule(target, { piggoCalendarRules: { [origin]: { enabled: true, arbitrary: true } } }));
});

test('PigGo response timestamps reject missing, future, stale and previous-day data', () => {
  for (const [date, expected] of [[at.toUTCString(), true], [null, false],
    [new Date(at.getTime() + 61000).toUTCString(), false], [new Date(at.getTime() - 301000).toUTCString(), false],
    ['Sun, 22 Nov 2026 04:00:00 GMT', false]]) {
    assert.equal(piggoResponseFresh({ headers: () => ({ date }) }, at), expected);
  }
  assert.equal(piggoResponseFresh({ headers: () => ({ date: at.toUTCString(), age: '1' }) }, at), false);
  assert.equal(piggoResponseFresh({ headers: () => ({ date: at.toUTCString(), warning: '110 stale' }) }, at), false);
});

test('unknown recovery reserves once under lock and keeps the original outcome', async t => {
  const { config } = await fixture(t); let clock = new Date(at.getTime() - 1000);
  const original = createSubmissionScope(config.submissionJournalPath, target, config, { now: () => clock });
  await original.begin({ accountFingerprint }); await original.observe({ status: 'unconfirmed' });
  clock = at;
  const left = createSubmissionScope(config.submissionJournalPath, target, config, { now: () => clock });
  const right = createSubmissionScope(config.submissionJournalPath, target, config, { now: () => clock });
  const reservations = await Promise.allSettled([left.reserveUnsignedRecovery(unsigned(config), { documentStartedAt: at.getTime() - 500 }),
    right.reserveUnsignedRecovery(unsigned(config), { documentStartedAt: at.getTime() - 500 })]);
  assert.equal(reservations.filter(r => r.status === 'fulfilled').length, 1);
  let journal = await readSubmissionJournal(config.submissionJournalPath);
  assert.deepEqual(journal.entries.map(e => e.state), ['uncertain', 'intent']);
  assert.equal(journal.entries[1].unsignedRecovery.originalOutcome, 'unknown');
  assert.equal((await original.pending()).length, 1);
  const winner = reservations[0].status === 'fulfilled' ? left : right;
  await winner.observe({ ...bindSuccessEvidence({ status: 'already_signed',
    evidence: successEvidence('status_endpoint', 'piggo_calendar_signed', at) }, target, config, at), accountFingerprint });
  journal = await readSubmissionJournal(config.submissionJournalPath);
  assert.deepEqual(journal.entries.map(e => e.state), ['uncertain', 'confirmed']);
  assert.equal((await original.pending()).length, 0);
  const restarted = createSubmissionScope(config.submissionJournalPath, target, config, { now: () => clock });
  await assert.rejects(restarted.reserveUnsignedRecovery(unsigned(config), { documentStartedAt: at.getTime() - 500 }));
});

for (const scenario of ['unbound_old_intent', 'wrong_account', 'wrong_profile', 'wrong_cycle', 'stale', 'future',
  'wrong_day', 'page_text', 'old_document', 'old_passive_document', 'no_opt_in', 'wrong_reader', 'multiple']) {
  test(`unsigned recovery retains protection: ${scenario}`, async t => {
    const { config } = await fixture(t); const before = new Date(at.getTime() - 1000);
    const scope = createSubmissionScope(config.submissionJournalPath, target, config, { now: () => before });
    await scope.begin(scenario === 'unbound_old_intent' ? {} : { accountFingerprint });
    let activeConfig = config, proof = unsigned(config), doc = at.getTime() - 500;
    if (scenario === 'wrong_account') proof.accountFingerprint = 'b'.repeat(64);
    if (scenario === 'wrong_profile') activeConfig = { ...config, automationUserDataDir: config.automationUserDataDir + '-other' };
    if (scenario === 'wrong_cycle') proof.evidence.binding.cycleId = 'old';
    if (scenario === 'stale') proof = unsigned(config, new Date(at.getTime() - 31000));
    if (scenario === 'future') proof = unsigned(config, new Date(at.getTime() + 1));
    if (scenario === 'wrong_day') proof.businessDate = '2026-11-22';
    if (scenario === 'page_text') proof.evidence.source = 'page_text';
    if (scenario === 'old_document') doc = before.getTime();
    if (scenario === 'old_passive_document') proof.passiveDocumentStartedAt = before.getTime();
    if (scenario === 'no_opt_in') activeConfig = { ...config, unsignedSubmissionRecoveryRules: {} };
    if (scenario === 'wrong_reader') proof.passiveReader = 'generic';
    if (scenario === 'multiple') {
      const journal = await readSubmissionJournal(config.submissionJournalPath);
      journal.entries.push({ ...journal.entries[0], id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
      await fs.writeFile(config.submissionJournalPath, JSON.stringify(journal));
    }
    const current = createSubmissionScope(config.submissionJournalPath, target, activeConfig, { now: () => at });
    await assert.rejects(current.reserveUnsignedRecovery(proof, { documentStartedAt: doc }));
    assert.equal((await current.pending()).length, scenario === 'multiple' ? 2 : 1);
  });
}

test('a changed API account cannot confirm an earlier PigGo intent', async t => {
  const { config } = await fixture(t);
  const scope = createSubmissionScope(config.submissionJournalPath, target, config, { now: () => at });
  await scope.begin({ accountFingerprint });
  await scope.observe({ ...bindSuccessEvidence({ status: 'already_signed', evidence: successEvidence('status_endpoint', 'piggo_calendar_signed', at) }, target, config, at),
    accountFingerprint: 'b'.repeat(64) });
  assert.equal((await scope.pending()).length, 1);
});

test('a corrupted stored recovery receipt cannot hide the original unknown intent', async t => {
  const { config } = await fixture(t);
  const before = createSubmissionScope(config.submissionJournalPath, target, config, { now: () => new Date(at.getTime() - 1000) });
  await before.begin({ accountFingerprint });
  const scope = createSubmissionScope(config.submissionJournalPath, target, config, { now: () => at });
  await scope.reserveUnsignedRecovery(unsigned(config), { documentStartedAt: at.getTime() - 500 });
  const journal = await readSubmissionJournal(config.submissionJournalPath);
  journal.entries[1].unsignedRecovery.receipt.accountFingerprint = 'b'.repeat(64);
  await fs.writeFile(config.submissionJournalPath, JSON.stringify(journal));
  await assert.rejects(readSubmissionJournal(config.submissionJournalPath));
});

test('unknown summary rejects malformed reports and retains row counts across nested actions', async t => {
  const { root } = await fixture(t);
  const reports = [
    ['20261123-120000', [{ origin, accountResults: [{ accountKey: 'a', status: 'unconfirmed' },
      { accountKey: 'b', actionResults: [{ actionType: 'draw', status: 'signed' }, { actionType: 'daily', status: 'unconfirmed' }] }] }]],
    ['20260230-120001', [{ origin, status: 'unconfirmed' }]],
    ['20261123-120002', [{ origin, status: 'unconfirmed', actionResults: 'bad' }]],
  ];
  for (const [name, results] of reports) {
    const dir = path.join(root, 'logs', name); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ runId: name, results }));
  }
  const result = await summarizeUnknownReports(root);
  assert.equal(result.complete, false); assert.equal(result.filesRead, 1);
  assert.equal(result.totals.unknownRows, 2); assert.equal(result.groups.length, 2);
  assert.equal(result.errors.length, 2);
  assert.equal(unknownRowCategory({ status: 'unconfirmed', captchaAttempts: [{ requestCount: 1 }] }), 'requestObservedRows');
});

test('Nexus rejection requires an explicit complete error line', () => {
  for (const text of ['图片代码无效', '驗證碼無效', 'Invalid image code!', 'captcha invalid']) assert.equal(isNexusCaptchaRejectedText(text), true);
  for (const text of ['验证码无效，但已签到', '签到成功', '教程：验证码无效怎么办', '']) assert.equal(isNexusCaptchaRejectedText(text), false);
});

test('unknown summary separates request, click, verification and missing evidence', async t => {
  const { root } = await fixture(t);
  const rows = [
    { submissionDiagnostics: { submissionRequestCount: 1 } },
    { submissionDiagnostics: { action: { phase: 'dispatch_click', outcome: 'failed', dispatchInvoked: true } } },
    { submissionObservation: { status: 'interactive_challenge' } }, {},
    { submissionDiagnostics: { action: { phase: 'trial_click', outcome: 'failed', dispatchInvoked: false } } },
  ].map(value => ({ origin, status: 'needs_attention', failureCode: 'submission_quarantined', ...value }));
  for (const [index, name] of ['20261123-120000', '20261123-120001'].entries()) {
    const dir = path.join(root, 'logs', name); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ runId: name, results: index ? [rows[0]] : rows }));
  }
  const summary = await summarizeUnknownReports(root);
  assert.equal(summary.totals.unknownRows, 6); assert.equal(summary.totals.requestObservedRows, 2);
  for (const key of ['clickDispatchedRows', 'verificationWaitRows', 'preDispatchFailureRows', 'missingObservationRows']) assert.equal(summary.totals[key], 1);
  assert.equal(summary.countUnit, 'report_rows');
  assert.doesNotMatch(JSON.stringify(summary), /calendar\.example|accountKey|reason/);
  assert.equal(unknownRowCategory({ status: 'signed', submissionAttempted: true }), null);
});

const browserFixtures = process.env.CHECKIN_BROWSER_FIXTURES === '1';
async function browserContext(t) {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext(); t.after(() => browser.close()); return context;
}

for (const scenario of ['signed', 'unsigned', 'locked', 'login', 'stale', 'wrong_date', 'wrong_account', 'no_me']) {
  test(`PigGo passive browser contract: ${scenario}`, { skip: !browserFixtures }, async t => {
    const context = await browserContext(t); let posts = 0;
    const config = enabled();
    if (scenario === 'wrong_account') config.piggoCalendarRules[origin].expectedAccountFingerprint = 'b'.repeat(64);
    await context.route('**/*', async route => {
      const r = route.request(), u = new URL(r.url());
      if (r.method() === 'POST') { posts++; return route.fulfill({ json: {} }); }
      if (u.pathname.startsWith('/v1/')) {
        if (u.pathname.endsWith('/me') && scenario === 'no_me') return route.abort();
        const json = scenario === 'locked' ? { code: 'idle_locked', data: {} } : u.pathname.endsWith('/me')
          ? envelope({ user: { id: 7 } }) : calendar(scenario === 'signed' ? 'checked' : 'today');
        if (scenario === 'wrong_date' && json.data?.detail) json.data.detail.ymd = '2026-11-22';
        return route.fulfill({ status: scenario === 'locked' ? 423 : scenario === 'login' ? 401 : 200,
          headers: { date: scenario === 'stale' ? new Date(at.getTime() - 400000).toUTCString() : at.toUTCString() },
          json });
      }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<script>
        fetch('/v1/web/me');fetch('/v1/web/calendar?year=2026&month=11&day=23');
        fetch('/v1/web/calendar/attendance',{method:'POST'}).catch(()=>{});
        </script><p>Calendar</p>` });
    });
    const retained = await context.newPage(); await retained.goto('about:blank');
    const result = await readPiggoCalendarState(context, target, config, { now: () => at, timeoutMs: 700, retainedPage: retained });
    assert.equal(result.status, scenario === 'signed' ? 'already_signed' : scenario === 'unsigned' ? 'not_signed'
      : ['locked', 'login'].includes(scenario) ? 'login_required' : 'unconfirmed');
    if (scenario === 'locked') assert.equal(result.failureCode, 'piggo_idle_locked');
    assert.equal(posts, 0); assert.equal(retained.url(), 'about:blank'); assert.equal(context.pages().length, 1);
    assert.doesNotMatch(JSON.stringify(result), /"id":7|"user"|token/);
  });
}

for (const scenario of ['success', 'rejected_then_success', 'same_image', 'unknown', 'low_confidence', 'split_form', 'missing_image', 'image_changes', 'logged_out', 'late_replay', 'multiple', 'stale_signed_header']) {
  test(`Nexus scoped form and bounded submission: ${scenario}`, { skip: !browserFixtures }, async t => {
    const context = await browserContext(t), page = await context.newPage();
    const { config } = await fixture(t); let posts = 0, readCount = 0;
    const scope = createSubmissionScope(config.submissionJournalPath, { origin }, config);
    await context.route('**/*', async route => {
      if (route.request().method() === 'POST') {
        posts++;
        return route.fulfill({ contentType: 'text/plain; charset=utf-8', body: posts === 1 && ['rejected_then_success', 'same_image', 'late_replay', 'stale_signed_header'].includes(scenario)
          ? '图片代码无效' : scenario === 'unknown' ? 'PRIVATE_VALUE' : 'ok' });
      }
      const html = `${scenario === 'logged_out' ? '' : '<a href="/logout.php">退出</a>'}<div id="showup">${scenario === 'stale_signed_header' ? '已签到' : ''}</div>
        <form method="post" action="/attendance.php"><input id="imagestring" name="imagestring"><input type="hidden" name="imagehash" value="fixture">
        ${scenario === 'missing_image' ? '' : '<img id="showupimg" width="100" height="30" src="data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'100\' height=\'30\'/>">'}
        ${scenario === 'split_form' ? '</form><form method="post" action="/attendance.php">' : ''}
        <button id="showupbutton">立即签到</button></form><script>
        document.querySelectorAll('form').forEach(f=>f.onsubmit=async e=>{e.preventDefault();
          ${scenario === 'multiple' ? "fetch('/attendance.php',{method:'POST'}).catch(()=>{});" : ''}
          const text=await (await fetch('/attendance.php',{method:'POST'})).text();
          if(text==='ok'){${scenario === 'multiple' ? '' : "document.querySelector('#showup').textContent='已签到';"}}
          else if(text==='图片代码无效'){${['same_image', 'stale_signed_header'].includes(scenario) ? '' : "document.querySelector('input[name=imagehash]').value+='next';"}}
        });</script>`;
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    });
    await page.goto(origin + '/attendance.php');
    const result = await runNexusImageCaptcha(page, { origin }, config, {
      readImage: async () => { readCount++; return Buffer.from(['same_image', 'stale_signed_header'].includes(scenario) ? 'same'
        : scenario === 'image_changes' ? String(readCount) : String(posts)); },
      recognize: async () => {
        if (scenario === 'late_replay' && posts === 1) await page.evaluate(() => fetch('/attendance.php', { method: 'POST' }).catch(() => {}));
        return { code: 'ABC123', confidence: scenario === 'low_confidence' ? 59 : 80 };
      },
      reserve: () => scope.begin(), retryUsed: () => scope.imageCaptchaRetryUsed(),
      retryRejected: async (proof, receipt) => { await scope.beginAfterRejectedImageCaptcha(proof, receipt); return true; },
      rejectExhausted: receipt => scope.finishRejectedImageCaptcha(receipt),
      wait: ms => page.waitForTimeout(Math.min(ms, 80)),
    });
    assert.equal(posts, ['rejected_then_success', 'multiple'].includes(scenario) ? 2 : ['success', 'unknown', 'same_image', 'late_replay', 'stale_signed_header'].includes(scenario) ? 1 : 0, JSON.stringify(result));
    assert.equal(result.status === 'signed', ['success', 'rejected_then_success'].includes(scenario));
    assert.doesNotMatch(JSON.stringify(result), /ABC123|PRIVATE_VALUE|fixture/);
    assert.equal(page.listenerCount('response'), 0);
  });
}

for (const scenario of ['new', 'recover', 'unbound', 'active_widget']) {
  test(`PigGo native retained-page continuation: ${scenario}`, { skip: !browserFixtures }, async t => {
    const context = await browserContext(t), { config } = await fixture(t); let checked = false, posts = 0;
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    config.samePageManualCheckinRules = { [origin]: { browserMode: 'native', expectedPath: '/calendar',
      sequentialActionType: 'daily_checkin', widgetSelector: '.site-cap', responseSelector: 'input[name=cf-turnstile-response]',
      startActionBeforeChallenge: true, siteReplaysAfterChallenge: true } };
    config.sequentialActionRules = { [origin]: { steps: [{ url: origin + '/calendar', actionType: 'daily_checkin',
      dailyCheckin: true, actionTexts: ['签到'], actionTags: ['BUTTON'], acceptGenericCheckinState: false,
      completedControl: { selector: 'button', textPattern: '^已签到$' },
      dailyUnsignedControl: { selector: 'button', textPattern: '^签到$' } }] } };
    await context.route('**/*', async route => {
      const r = route.request(), u = new URL(r.url());
      if (r.method() === 'POST') { posts++; checked = true; return route.fulfill({ json: {} }); }
      if (u.pathname.startsWith('/v1/')) return route.fulfill({ headers: { date: new Date().toUTCString() },
        json: u.pathname.endsWith('/me') ? envelope({ user: { id: 7 } })
          : envelope({ cells: [], selected: date, detail: { is_today: true, ymd: date, attendance: { status: checked ? 'checked' : 'today' } } }) });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<a href="/logout.php">退出</a>
        <p>${'已登录日历页面。'.repeat(20)}</p><button>${checked ? '已签到' : '签到'}</button>
        ${scenario === 'active_widget' ? '<div class="site-cap">请验证</div>' : ''}
        <script>fetch('/v1/web/me');fetch('/v1/web/calendar');document.querySelector('button').onclick=async()=>{
          await fetch('/v1/web/calendar/attendance',{method:'POST'});document.querySelector('button').textContent='已签到';};</script>` });
    });
    if (scenario !== 'new') {
      const prior = createSubmissionScope(config.submissionJournalPath, target, config, { now: () => new Date(Date.now() - 5000) });
      await prior.begin(scenario === 'unbound' ? {} : { accountFingerprint });
    }
    const page = await context.newPage(); await page.goto(origin + '/calendar');
    const result = await continueNativeSamePage(page, { origin }, config, { waitMs: 1000,
      dismiss: async () => {}, delay: async ms => page.waitForTimeout(Math.min(ms, 100)),
      clickAction: async (page, step, allowed, reserve) => {
        await reserve();
        await page.route(origin + '/v1/web/calendar/attendance', route => {
          posts++; checked = true; return route.fulfill({ json: {} });
        });
        await page.getByRole('button', { name: '签到', exact: true }).click(); return { clicked: true };
      } });
    assert.equal(posts, ['new', 'recover'].includes(scenario) ? 1 : 0, JSON.stringify(result));
    assert.equal(['signed', 'already_signed'].includes(result.status), ['new', 'recover'].includes(scenario));
    if (scenario === 'recover') {
      const entries = (await readSubmissionJournal(config.submissionJournalPath)).entries;
      assert.deepEqual(entries.map(e => e.state), ['intent', 'confirmed']);
      assert.equal(entries[1].unsignedRecovery.originalOutcome, 'unknown');
    }
    assert.equal(context.pages().length, 1); assert.equal(page.url(), origin + '/calendar');
  });
}
