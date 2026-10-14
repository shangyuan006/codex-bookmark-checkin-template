import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { clickUniqueNativeCheckinAction, waitForNativeCheckinAction } from '../src/native-checkin-action.mjs';
import { dismissConfiguredPreCheckinOverlay } from '../src/browser.mjs';
import { attachSubmissionScope, createSubmissionScope, readSubmissionJournal } from '../src/submission-guard.mjs';
import { bindSuccessEvidence, successEvidence } from '../src/checkin-evidence.mjs';
import { readNativeCheckinState } from '../src/native-checkin-state.mjs';

const origin = 'https://example.test';
const target = { origin };
const rule = { actionTexts: ['立即签到'] };

async function journalFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-action-submission-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'journal.json');
  return { file, scope: createSubmissionScope(file, target) };
}

function actionPage(click, url = () => `${origin}/profile`) {
  const action = { click, dispose: async () => {} };
  return { url, locator: () => ({
    evaluateAll: async () => [{ index: 0, text: '立即签到', visible: true, disabled: false }],
    nth: () => ({ elementHandle: async () => action }),
  }) };
}

test('a blocked native trial neither clicks nor creates a durable submission intent', async t => {
  const { file, scope } = await journalFixture(t);
  let actualClicks = 0;
  const page = actionPage(async options => {
    if (!options.trial) actualClicks++;
    throw new Error('Private page text from an intercepting announcement');
  });
  attachSubmissionScope(page, scope);
  const result = await clickUniqueNativeCheckinAction(page, origin, rule);
  assert.deepEqual(result, { clicked: false, outcome: 'action_not_actionable' });
  assert.equal(actualClicks, 0);
  assert.equal((await readSubmissionJournal(file)).entries.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /Private page text/);
});

test('a failure after a successful trial keeps its intent and blocks a later retry', async t => {
  const { file, scope } = await journalFixture(t);
  let trials = 0, actualClicks = 0;
  const page = actionPage(async options => {
    if (options.trial) {
      trials++;
      assert.equal((await readSubmissionJournal(file)).entries.length, 0);
      return;
    }
    actualClicks++;
    assert.equal((await readSubmissionJournal(file)).entries[0].state, 'intent');
    throw new Error('Connection lost after the click started');
  });
  attachSubmissionScope(page, scope);
  await assert.rejects(clickUniqueNativeCheckinAction(page, origin, rule), /Connection lost/);
  await scope.observe({ status: 'unconfirmed' });
  assert.equal(trials, 1);
  assert.equal(actualClicks, 1);
  const entries = (await readSubmissionJournal(file)).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].state, 'uncertain');

  attachSubmissionScope(page, createSubmissionScope(file, target));
  // Existing quarantine is preserved even when the next trial is actionable.
  page.locator = () => ({
    evaluateAll: async () => [{ index: 0, text: '立即签到', visible: true }],
    nth: () => ({ elementHandle: async () => ({
      click: async options => { if (!options.trial) assert.fail('quarantined action must not click'); },
      dispose: async () => {},
    }) }),
  });
  await assert.rejects(clickUniqueNativeCheckinAction(page, origin, rule), /存在不确定提交，禁止重复动作/);
  assert.deepEqual((await readSubmissionJournal(file)).entries, entries);
});

test('a navigation during trial is rejected before recording any submission', async t => {
  const { file, scope } = await journalFixture(t);
  let url = `${origin}/profile`, actualClicks = 0;
  const page = actionPage(async options => {
    if (options.trial) url = 'https://outside.test/';
    else actualClicks++;
  }, () => url);
  attachSubmissionScope(page, scope);
  await assert.rejects(clickUniqueNativeCheckinAction(page, origin, rule));
  assert.equal(actualClicks, 0);
  assert.equal((await readSubmissionJournal(file)).entries.length, 0);
});

test('offline Edge closes a real announcement before one recorded native check-in', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 35_000,
}, async t => {
  const { file, scope } = await journalFixture(t);
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  await context.route('**/*', route => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8', body: `
      <button id="daily" onclick="window.checkinClicks++;this.disabled=true;this.textContent='已签到'">立即签到</button>
      <div data-slot="dialog-portal" style="position:fixed;inset:0;z-index:100">
        <div data-slot="dialog-overlay" style="position:absolute;inset:0;background:white"></div>
        <div data-slot="dialog-content" style="position:relative;margin:100px">
          <button data-slot="button" onclick="this.closest('[data-slot=dialog-portal]').remove()">我已知晓</button>
        </div>
      </div>
      <script>window.checkinClicks=0;window.unrelatedClicks=0;</script>`,
  }));
  await page.goto(`${origin}/profile`);
  attachSubmissionScope(page, scope);
  const blocked = await clickUniqueNativeCheckinAction(page, origin, rule);
  assert.equal(blocked.outcome, 'action_not_actionable');
  assert.equal((await readSubmissionJournal(file)).entries.length, 0);
  assert.equal(await page.evaluate(() => window.checkinClicks), 0);

  const selector = '[data-slot="dialog-portal"] button:text-is("我已知晓")';
  const nativeRule = { ...rule, dismissButtonTexts: ['我已知晓'], dismissSelectors: [selector],
    dismissWaitMs: 250, maxDismissals: 3 };
  // Inserting another button while persisting the intent must not retarget the
  // element whose trial just succeeded.
  attachSubmissionScope(page, { begin: async () => {
    await scope.begin();
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.textContent = 'Unrelated action';
      button.onclick = () => window.unrelatedClicks++;
      document.body.prepend(button);
    });
  } });
  const result = await waitForNativeCheckinAction(page, origin, nativeRule, {
    timeoutMs: 1000, readState: async () => ({ status: 'ready' }),
  });
  assert.deepEqual(result, { clicked: true, outcome: 'clicked' });
  assert.equal(await page.locator(selector).count(), 0);
  assert.equal(await page.evaluate(() => window.checkinClicks), 1);
  assert.equal(await page.evaluate(() => window.unrelatedClicks), 0);
  assert.equal((await readSubmissionJournal(file)).entries.length, 1);
  const state = await readNativeCheckinState(page, origin);
  assert.equal(state.state.status, 'already_signed');
  await scope.observe(bindSuccessEvidence({ status: state.state.status,
    evidence: successEvidence('page_text', 'page_completion_text') }, target));
  assert.equal((await readSubmissionJournal(file)).entries[0].state, 'confirmed');

  // The ordinary browser fallback uses the same bounded private selector.
  await page.goto(`${origin}/profile`);
  const dismissed = await dismissConfiguredPreCheckinOverlay(page, target, origin, {
    actionWaitMs: 1, preCheckinDismissRules: { [origin]: {
      selectors: [selector], buttonTexts: ['我已知晓'], waitMs: 250, maxDismissals: 3,
    } },
  });
  assert.equal(dismissed, true);
  assert.equal(await page.locator(selector).count(), 0);
  assert.equal(await page.evaluate(() => window.checkinClicks), 0);
});
