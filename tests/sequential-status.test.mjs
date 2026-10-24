import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright-core';
import { normalizeSequentialStatusCheck, readSequentialStatus } from '../src/sequential-status.mjs';
import { tryConfiguredSequentialActions } from '../src/browser.mjs';
import { createSubmissionScope, readSubmissionJournal } from '../src/submission-guard.mjs';

const origin = 'https://daily.example';
const endpoint = `${origin}/api/me/attendance`;
const statusCheck = { url: endpoint, signedField: 'claimed_today', readOnly: true };
const target = { origin };
const step = { url: origin + '/', actionTexts: ['签到'], actionTags: ['BUTTON'],
  actionType: 'daily_checkin', dailyCheckin: true, acceptGenericCheckinState: false,
  waitMs: 1000, statusCheck, responseEvidence: [{ urlIncludes: '/api/me/attendance', methods: ['GET', 'POST'],
    successAny: [{ path: 'claimed_today', equals: true }] }] };
const config = { navigationTimeoutMs: 1000, checkinStatePollMs: 100,
  sequentialActionRules: { [origin]: { steps: [step] } } };

test('status checks require an explicitly reviewed same-origin passive GET and a bounded field', () => {
  const credentialed = new URL(endpoint);
  credentialed.username = 'fixture';
  assert.equal(normalizeSequentialStatusCheck(null, origin), null);
  assert.deepEqual(normalizeSequentialStatusCheck(statusCheck, origin), statusCheck);
  for (const invalid of [
    { readOnly: false }, { url: 'http://daily.example/state' }, { url: 'https://outside.example/state' },
    { url: '/state' }, { url: `${endpoint}?token=private` }, { url: endpoint + '#part' },
    { url: credentialed.href }, { url: origin + '/logout' },
    { url: origin + '/%6cogout' },
    { signedField: '' }, { signedField: 'a'.repeat(121) }, { signedField: 'a[0]' },
  ]) assert.throws(() => normalizeSequentialStatusCheck({ ...statusCheck, ...invalid }, origin));
});

test('status reads accept only strict booleans from an exact non-redirecting 200 JSON response', async () => {
  for (const [body, code, expected, url] of [
    ['{"claimed_today":true,"private":"must-stay-private"}', 200, 'already_signed'],
    ['{"claimed_today":false}', 200, 'not_signed'],
    ['{"claimed_today":"true"}', 200, 'unconfirmed'], ['{"claimed_today":1}', 200, 'unconfirmed'],
    ['{}', 200, 'unconfirmed'], ['<html>must-stay-private</html>', 200, 'unconfirmed'],
    ['x'.repeat(65537), 200, 'unconfirmed'], ['{}', 401, 'login_required'],
    ['{}', 403, 'unconfirmed'], ['{}', 302, 'unconfirmed'],
    ['{"claimed_today":true}', 200, 'unconfirmed', origin + '/other'],
  ]) {
    let disposed = false;
    const result = await readSequentialStatus({ get: async (requestUrl, options) => {
      assert.equal(requestUrl, endpoint); assert.equal(options.maxRedirects, 0);
      assert.equal(options.timeout, 5000); assert.equal(options.headers['Cache-Control'], 'no-cache');
      return { url: () => url ?? endpoint, status: () => code, text: async () => body,
        dispose: async () => { disposed = true; } };
    } }, statusCheck);
    assert.equal(result.status, expected); assert.equal(disposed, true);
    assert.doesNotMatch(JSON.stringify(result), /must-stay-private/);
  }
  assert.equal((await readSequentialStatus({ get: async () => { throw Error('private'); } }, statusCheck)).status, 'unconfirmed');
});

function fixture({ values = [false, true], httpStatus = 200, mutationStatus = 200, method = 'POST' } = {}) {
  const page = new EventEmitter(); let clicks = 0, reads = 0;
  Object.assign(page, {
    url: () => origin + '/', title: async () => '', frames: () => [],
    goto: async () => {}, waitForLoadState: async () => {},
    request: { get: async () => {
      const value = values[Math.min(reads++, values.length - 1)];
      return { url: () => endpoint, status: () => httpStatus,
        text: async () => JSON.stringify({ claimed_today: value }), dispose: async () => {} };
    } },
    evaluate: async (_fn, argument) => typeof argument === 'string'
      ? { bodyText: '签到', passwordInputs: false, challengeEvidence: [] }
      : { completedControls: [], completedTextPresent: false, successTextPresent: false,
        bodyLines: ['签到'], loaded: true, busy: false, disabledActionPresent: false },
    locator: () => ({ elementHandles: async () => [{
      evaluate: async () => ({ tagName: 'BUTTON', text: '签到', visible: true, disabled: false, href: null, formAction: null }),
      click: async ({ trial }) => {
        if (trial) return;
        clicks++;
        const request = { url: () => endpoint, method: () => method };
        page.emit('request', request);
        page.emit('response', { request: () => request, url: () => endpoint, status: () => mutationStatus,
          json: async () => ({ error: 'private-server-detail' }) });
      }, dispose: async () => {},
    }] }),
  });
  return { page, counts: () => ({ clicks, reads }) };
}

async function journal(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sequential-status-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'journal.json');
}

test('a delayed authoritative read confirms one click even when the UI never updates', async t => {
  const file = await journal(t), view = fixture({ values: [false, false, true] });
  const result = await tryConfiguredSequentialActions(view.page, target, { ...config, submissionJournalPath: file,
    sequentialActionRules: { [origin]: { steps: [{ ...step, waitMs: 3000 }] } } });
  assert.equal(result.status, 'signed'); assert.equal(view.counts().clicks, 1);
  assert.ok(view.counts().reads >= 3);
  assert.equal(result.actionResults[0].evidence.source, 'status_endpoint');
  assert.equal((await readSubmissionJournal(file)).entries[0].state, 'confirmed');
});

test('an already signed endpoint prevents a click despite an outdated unsigned UI', async () => {
  const view = fixture({ values: [true] });
  const result = await tryConfiguredSequentialActions(view.page, target, config);
  assert.equal(result.status, 'already_signed'); assert.equal(view.counts().clicks, 0);
});

test('unknown and expired sessions stop before intent; read-only mode cannot submit', async t => {
  for (const options of [{ values: ['true'] }, { httpStatus: 401 }]) {
    const file = await journal(t), view = fixture(options);
    const result = await tryConfiguredSequentialActions(view.page, target, { ...config, submissionJournalPath: file });
    assert.ok(['needs_attention', 'login_required'].includes(result.status));
    assert.equal(view.counts().clicks, 0); assert.equal((await readSubmissionJournal(file)).entries.length, 0);
  }
  const view = fixture({ values: [false] });
  assert.equal((await tryConfiguredSequentialActions(view.page, target, { ...config, checkinReadOnly: true })).status, 'unconfirmed');
  assert.equal(view.counts().clicks, 0);
});

test('a rejected mutation records its status and keeps isolation without a second click', async t => {
  const file = await journal(t), view = fixture({ values: [false], mutationStatus: 500 });
  const cfg = { ...config, submissionJournalPath: file };
  const result = await tryConfiguredSequentialActions(view.page, target, cfg);
  assert.equal(result.status, 'needs_attention'); assert.equal(result.submissionRequestObserved, true);
  assert.equal(result.submissionResponseStatus, 500); assert.equal(result.submissionEvidenceConfigured, true);
  assert.doesNotMatch(JSON.stringify(result), /private-server-detail/);
  assert.equal((await readSubmissionJournal(file)).entries[0].state, 'uncertain');
  const retry = await tryConfiguredSequentialActions(view.page, target, cfg);
  assert.equal(retry.failureCode, 'submission_quarantined'); assert.equal(view.counts().clicks, 1);
});

test('GET evidence requests never count as mutations and unknown status preserves existing isolation', async t => {
  const view = fixture({ values: [false], method: 'GET', mutationStatus: 500 });
  const result = await tryConfiguredSequentialActions(view.page, target, config);
  assert.equal(result.submissionRequestObserved, false); assert.equal(result.submissionResponseStatus, undefined);
  const file = await journal(t);
  await createSubmissionScope(file, { ...target, actionType: 'daily_checkin' }, config).begin();
  const unknown = fixture({ values: ['invalid'] });
  const blocked = await tryConfiguredSequentialActions(unknown.page, target, { ...config, submissionJournalPath: file });
  assert.equal(blocked.failureCode, 'submission_quarantined'); assert.equal(unknown.counts().clicks, 0);
  assert.equal((await readSubmissionJournal(file)).entries[0].state, 'intent');
});

test('offline Edge waits for the delayed status endpoint while the real button remains pending', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 15000,
}, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let posts = 0, signed = false, signedAt = Infinity;
  await page.route(origin + '/**', async route => {
    if (route.request().method() === 'POST') {
      posts++; signedAt = Date.now() + 500;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body:
      `<button onclick="this.disabled=true;this.textContent='签到中';fetch('/api/me/attendance',{method:'POST'})">签到</button>` });
  });
  const request = { get: async () => {
    signed ||= Date.now() >= signedAt;
    return { url: () => endpoint, status: () => 200,
      text: async () => JSON.stringify({ claimed_today: signed }), dispose: async () => {} };
  } };
  const view = new Proxy(page, { get(object, key) {
    if (key === 'request') return request;
    const value = Reflect.get(object, key, object);
    return typeof value === 'function' ? value.bind(object) : value;
  } });
  const result = await tryConfiguredSequentialActions(view, target, { ...config,
    sequentialActionRules: { [origin]: { steps: [{ ...step, waitMs: 3000 }] } } });
  assert.equal(result.status, 'signed'); assert.equal(posts, 1);
  assert.equal(result.actionResults[0].evidence.source, 'status_endpoint');
  assert.equal(await page.getByRole('button').textContent(), '签到中');
});
