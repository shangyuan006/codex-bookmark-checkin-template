import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { inspectConfiguredDailyUnsignedForm, inspectConfiguredFormCompletion, getConfiguredPreCheckinNavigationRule } from "../src/pre-checkin-navigation.mjs";
import { processCandidate, waitForConfirmedCheckinState } from "../src/browser.mjs";
import { createSubmissionScope, readSubmissionJournal, runWithSubmissionJournal, SUBMISSION_SCOPE } from "../src/submission-guard.mjs";
import { bindSuccessEvidence, successEvidence } from "../src/checkin-evidence.mjs";
import { readCloudflareFrameEvidence } from "../src/challenge-frame-state.mjs";

const target = { origin: "https://form.example", candidates: ["https://form.example/"] };
const form = { visibleSelectors: ["#track", "#handle"], nonEmptyValueSelectors: ["input[name=daily-token]"],
  emptyValueSelectors: ["input[name=answer]"], actionText: "提交签到" };
const config = { navigationTimeoutMs: 1000, preCheckinNavigationRules: { [target.origin]: {
  expectedPath: "/daily.php", steps: [{ role: "link", name: "签到赚魔力" }], dailyUnsignedForm: form,
} } };
const snapshot = { bodyText: "拖动滑块验证，完成后提交签到", loaded: true, authenticated: true,
  hasPassword: false, challengeSelectors: false, formReady: true };

function pageFixture(initial = "/daily.php", changes = {}) {
  let url = target.origin + initial;
  const visits = [], navigationClicks = [];
  const page = { url: () => url,
    goto: async destination => { visits.push(destination); url = destination; },
    waitForLoadState: async () => {}, waitForTimeout: async () => {},
    evaluate: async () => ({ ...snapshot, ...changes }),
    getByRole: (role, options) => {
      assert.equal(role, "link"); assert.equal(options.name, "签到赚魔力");
      return { count: async () => 1, nth() { return this; }, isVisible: async () => true, isEnabled: async () => true,
        click: async () => { navigationClicks.push(url); url = `${target.origin}/daily.php`; } };
    },
    getByText: text => {
      assert.equal(text, "提交签到");
      return { count: async () => 1, isVisible: async () => true, isEnabled: async () => true,
        click: async () => assert.fail("read-only form inspection must never submit") };
    },
  };
  return { page, visits, navigationClicks };
}

test("read-only readiness follows the visible home link instead of navigating directly to the sign-in endpoint", async () => {
  const f = pageFixture("/");
  const result = await processCandidate(f.page, target, target.candidates[0], { ...config, checkinReadOnly: true }, []);
  assert.equal(result.status, "not_signed");
  assert.deepEqual(f.visits, [target.candidates[0]]);
  assert.deepEqual(f.navigationClicks, [target.candidates[0]]);
  assert.equal(result.evidence.outcome, "daily_checkin_not_signed");
  assert.equal(result.evidence.binding.observedOrigin, target.origin);
  assert.doesNotMatch(JSON.stringify(result), /daily-token|answer|bodyText/);
});

test("fresh form proof permits a new daily cycle but preserves the older uncertain entry", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "form-continuation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "journal.json"), now = new Date(), yesterday = new Date(now.getTime() - 86400000);
  await createSubmissionScope(file, target, config, { now: () => yesterday }).begin();
  const historical = structuredClone((await readSubmissionJournal(file)).entries[0]);
  let submits = 0;
  const result = await runWithSubmissionJournal(file, target, config, async active => {
    if (active.checkinReadOnly) return processCandidate(pageFixture("/").page, target, target.candidates[0], active, []);
    await active[SUBMISSION_SCOPE].begin(); submits++;
    return bindSuccessEvidence({ status: "signed", origin: target.origin, evidence: successEvidence("page_text", "page_completion_text") }, target, config);
  });
  assert.equal(result.status, "signed"); assert.equal(submits, 1);
  const journal = await readSubmissionJournal(file);
  assert.deepEqual(journal.entries[0], historical);
  assert.equal(journal.entries[1].state, "confirmed");
});

test("partial, unauthenticated, loading, completed and externally challenged forms cannot release isolation", async () => {
  for (const change of [{ formReady: false }, { authenticated: false }, { loaded: false }, { hasPassword: true },
    { challengeSelectors: true }, { bodyText: "今日已签到" }, { bodyText: "签到功能已关闭" }]) {
    assert.equal(await inspectConfiguredDailyUnsignedForm(pageFixture("/daily.php", change).page, target, target.origin, config), null);
  }
  assert.equal(await inspectConfiguredDailyUnsignedForm(pageFixture("/").page, target, target.origin, config), null);
  assert.equal(await inspectConfiguredDailyUnsignedForm(pageFixture().page, target, target.origin, {}), null);
});

test("form configuration cannot accept missing or unbounded required controls", () => {
  for (const bad of [{ ...form, visibleSelectors: [] }, { ...form, actionText: "" }, { ...form, emptyValueSelectors: [""] }]) {
    assert.throws(() => getConfiguredPreCheckinNavigationRule(target, target.origin, {
      preCheckinNavigationRules: { [target.origin]: { ...config.preCheckinNavigationRules[target.origin], dailyUnsignedForm: bad } },
    }));
  }
});

test("form inspection checks actual unique field values but returns no field content", async t => {
  const names = ["HTMLInputElement", "HTMLTextAreaElement", "document", "getComputedStyle"];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => { for (const name of names) {
    const descriptor = previous.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
  } });
  class Input { constructor(value) { this.value = value; } }
  globalThis.HTMLInputElement = Input; globalThis.HTMLTextAreaElement = class {};
  const control = { getBoundingClientRect: () => ({ width: 30, height: 30 }) };
  const token = new Input("PRIVATE-FIXTURE-VALUE"), answer = new Input("");
  const nodes = new Map([["#track", [control]], ["#handle", [control]], ["input[name=daily-token]", [token]],
    ["input[name=answer]", [answer]], ["a", [{ ...control, getAttribute: () => "/logout.php" }]]]);
  globalThis.document = { readyState: "complete", body: { innerText: "拖动滑块验证，完成后提交签到" },
    querySelectorAll: selector => nodes.get(selector) ?? [] };
  globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible" });
  const page = pageFixture().page; page.evaluate = async (fn, args) => fn(args);
  const result = await inspectConfiguredDailyUnsignedForm(page, target, target.origin, config);
  assert.equal(result.status, "not_signed");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-FIXTURE-VALUE|daily-token|bodyText/);
  token.value = "";
  assert.equal(await inspectConfiguredDailyUnsignedForm(page, target, target.origin, config), null);
  token.value = "PRIVATE-FIXTURE-VALUE"; nodes.get("input[name=daily-token]").push(token);
  assert.equal(await inspectConfiguredDailyUnsignedForm(page, target, target.origin, config), null);
});

test("the actual disabled pre-slider control proves a fresh unsigned form without enabling submission", async t => {
  const names = ["HTMLInputElement", "HTMLTextAreaElement", "document", "getComputedStyle"];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => { for (const name of names) {
    const descriptor = previous.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
  } });
  class Input { constructor(value) { this.value = value; } }
  globalThis.HTMLInputElement = Input; globalThis.HTMLTextAreaElement = class {};
  const box = { getBoundingClientRect: () => ({ width: 30, height: 30 }) };
  const button = { ...box, tagName: "BUTTON", disabled: true, innerText: "请先完成滑块", getAttribute: () => null };
  const token = new Input("PRIVATE-FIXTURE-VALUE");
  const nodes = new Map([["#track", [box]], ["#handle", [box]], ["input[name=daily-token]", [token]],
    ["input[name=answer]", [new Input("")]], ["#submit", [button]], ["a", [{ ...box, getAttribute: () => "/logout.php" }]]]);
  globalThis.document = { readyState: "complete", body: { innerText: "拖动滑块验证" }, querySelectorAll: selector => nodes.get(selector) ?? [] };
  globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible" });
  const local = { preCheckinNavigationRules: { [target.origin]: { ...config.preCheckinNavigationRules[target.origin],
    dailyUnsignedForm: { ...form, pendingAction: { selector: "#submit", text: "请先完成滑块", disabled: true } } } } };
  const page = pageFixture().page; page.evaluate = async (fn, args) => fn(args);
  page.getByText = () => ({ count: async () => 0 });
  const read = () => inspectConfiguredDailyUnsignedForm(page, target, target.origin, local);
  const result = await read(); assert.equal(result.status, "not_signed");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-FIXTURE-VALUE|submit|bodyText/);
  button.disabled = false; assert.equal(await read(), null); button.disabled = true;
  button.innerText = "加载中"; assert.equal(await read(), null); button.innerText = "请先完成滑块";
  nodes.get("#submit").push(button); assert.equal(await read(), null); nodes.get("#submit").pop();
  token.value = ""; assert.equal(await read(), null);
  assert.throws(() => getConfiguredPreCheckinNavigationRule(target, target.origin, { preCheckinNavigationRules: {
    [target.origin]: { ...local.preCheckinNavigationRules[target.origin], dailyUnsignedForm: { ...form,
      pendingAction: { selector: "#submit", text: "请先完成滑块", disabled: false } } },
  } }), /exact disabled control/);
});

const turnstileConfig = { ...config, preCheckinNavigationRules: { [target.origin]: {
  ...config.preCheckinNavigationRules[target.origin],
  completedTextPattern: '连续签到\\s*\\d+\\s*天[\\s\\S]{0,120}获得[\\s\\S]{0,30}魔力',
  dailyUnsignedForm: { visibleSelectors: ['form button[type=submit]'],
    nonEmptyValueSelectors: ['input[name=sign_token]', 'input[name=sign_submit]'],
    emptyValueSelectors: ['input[name=cf-turnstile-response]'], actionText: '提交签到', pendingChallenge: 'turnstile' },
} } };

test('pending Turnstile proves only unsigned readiness for one explicitly bound unresolved frame', async () => {
  for (const scenario of [
    { expected: 'not_signed' },
    { frames: 0 }, { frames: 2 }, { resolved: true }, { responsePresent: true },
    { pendingTurnstile: false, challengeSelectors: false },
    { otherChallengeSelectors: true }, { authenticated: false }, { loaded: false }, { formReady: false },
  ]) {
    const page = pageFixture().page;
    page.evaluate = async (_fn, argument) => argument
      ? { ...snapshot, challengeSelectors: true, pendingTurnstile: true, ...scenario }
      : Boolean(scenario.responsePresent);
    page.frames = () => Array.from({ length: scenario.frames ?? 1 }, () => ({
      url: () => 'https://challenges.cloudflare.com/turnstile/fixture',
      frameElement: async () => ({ isVisible: async () => true, boundingBox: async () => ({ width: 300, height: 65 }) }),
      evaluate: async () => ({ resolvedState: Boolean(scenario.resolved), failed: false, loading: false, checkboxReady: !scenario.resolved }),
    }));
    const result = await inspectConfiguredDailyUnsignedForm(page, target, target.origin, turnstileConfig);
    assert.equal(result?.status ?? null, scenario.expected ?? null, JSON.stringify(scenario));
    if (result) assert.equal(result.evidence.outcome, 'daily_checkin_not_signed');
  }
});

test('completion patterns and pending challenge types require valid explicit configuration', () => {
  for (const completedTextPattern of ['', '.*', '[', 123, 'x'.repeat(301)]) {
    assert.throws(() => getConfiguredPreCheckinNavigationRule(target, target.origin, {
      preCheckinNavigationRules: { [target.origin]: { ...turnstileConfig.preCheckinNavigationRules[target.origin], completedTextPattern } },
    }));
  }
  assert.throws(() => getConfiguredPreCheckinNavigationRule(target, target.origin, {
    preCheckinNavigationRules: { [target.origin]: { ...config.preCheckinNavigationRules[target.origin],
      dailyUnsignedForm: { ...form, pendingChallenge: 'arbitrary' } } },
  }), /pending challenge/);
});

test('offline Edge binds the pending widget to the form and waits for authoritative result text', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 20000,
}, async t => {
  const { chromium } = createRequire(import.meta.url)('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
    new URL(route.request().url()).origin === target.origin ? `<a href="/logout.php">退出</a>
      <form id="daily"><input type="hidden" name="sign_token" value="PRIVATE-FIXTURE-VALUE">
      <input type="hidden" name="sign_submit" value="1"><input type="hidden" name="cf-turnstile-response" value="">
      <div class="cf-turnstile"><iframe src="https://challenges.cloudflare.com/turnstile/fixture"></iframe></div>
      <button type="submit">提交签到</button></form>` : '<p>Offline verification fixture</p>' }));
  await page.goto(`${target.origin}/daily.php`);
  assert.deepEqual(await readCloudflareFrameEvidence(page, target.origin), [
    { visible: true, challengeLike: true, resolvedState: false, failed: false, loading: false, checkboxReady: false, inspectionState: 'not_ready', responsePresent: false },
  ]);
  const read = () => inspectConfiguredDailyUnsignedForm(page, target, target.origin, turnstileConfig);
  const unsigned = await read();
  assert.equal(unsigned.status, 'not_signed');
  assert.doesNotMatch(JSON.stringify(unsigned), /PRIVATE-FIXTURE-VALUE|sign_token|bodyText/);
  await page.evaluate(() => {
    const other = document.createElement('form'); other.id = 'other'; document.body.append(other);
    other.append(document.querySelector('input[name="cf-turnstile-response"]'));
  });
  assert.equal(await read(), null, 'widget in another form cannot release isolation');
  await page.evaluate(() => document.querySelector('#daily').append(document.querySelector('input[name="cf-turnstile-response"]')));
  await page.locator('input[name=cf-turnstile-response]').evaluate(el => { el.value = 'PRIVATE-FIXTURE-RESPONSE'; });
  assert.equal((await read()).status, 'not_signed', 'a verified, enabled, server-issued form is still unsigned');
  await page.locator('input[name=cf-turnstile-response]').evaluate(el => { el.value = ''; });
  await page.locator('form').first().evaluate(el => {
    const block = document.createElement('div'); block.id = 'sl-check'; block.textContent = 'Other verification'; el.append(block);
  });
  assert.equal(await read(), null, 'another challenge still blocks readiness');
  await page.locator('#sl-check').evaluate(el => el.remove());
  assert.equal((await read()).status, 'not_signed');

  const complete = () => inspectConfiguredFormCompletion(page, turnstileConfig);
  await page.locator('body').evaluate(el => {
    el.innerHTML = '<a href="/logout.php">退出</a><p>连续签到 12 天，获得 100 魔力</p>';
  });
  assert.equal((await complete()).status, 'signed');
  assert.doesNotMatch((await complete()).reason, /\d|魔力/);
  assert.doesNotMatch(JSON.stringify(await complete()), /bodyText|PRIVATE-FIXTURE/);
  for (const blocker of [
    '<button type="submit">提交签到</button>', '<input type="password">', '<p>今日尚未签到</p>',
    '<div class="cf-turnstile">Verification</div>', '<p>签到功能已关闭</p>',
    '<iframe src="https://challenges.cloudflare.com/turnstile/fixture"></iframe>',
  ]) {
    await page.locator('body').evaluate((el, html) => { el.innerHTML = '<a href="/logout.php">退出</a><p>连续签到 12 天，获得 100 魔力</p>' + html; }, blocker);
    assert.equal(await complete(), null, blocker);
  }
  await page.locator('body').evaluate(el => { el.innerHTML = '<p>连续签到 12 天，获得 100 魔力</p>'; });
  assert.equal(await complete(), null, 'authentication is required');
  await page.goto(`${target.origin}/other.php`);
  assert.equal(await complete(), null, 'only the exact configured endpoint can confirm');
  await page.goto(`${target.origin}/daily.php`);
  await page.evaluate(() => setTimeout(() => {
    document.body.innerHTML = '<a href="/logout.php">退出</a><p>连续签到 12 天，获得 100 魔力</p>';
  }, 100));
  const confirmed = await waitForConfirmedCheckinState(page, { ...turnstileConfig, checkinStatePollMs: 20 }, 2000);
  assert.equal(confirmed.status, 'signed');
  assert.equal(confirmed.evidence.outcome, 'configured_form_completion');
});

test('offline automatic flow follows the home link, verifies before submitting, and observes delayed completion without reload', {
  skip: process.env.CHECKIN_BROWSER_FIXTURES !== '1', timeout: 20000,
}, async t => {
  const { chromium } = createRequire(import.meta.url)('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const visits = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    visits.push(url.pathname);
    const home = '<a href="/logout.php">退出</a><a href="/daily.php">签到赚魔力</a>';
    const daily = `<a href="/logout.php">退出</a><form onsubmit="event.preventDefault();
      window.submissions=(window.submissions||0)+1;
      window.verifiedAtSubmit=Boolean(this.querySelector('[name=cf-turnstile-response]').value);
      if(window.verifiedAtSubmit){this.remove();setTimeout(()=>document.body.insertAdjacentHTML('beforeend','<p>连续签到 12 天，获得 100 魔力</p>'),300);}">
      <input type="hidden" name="sign_token" value="PRIVATE-FIXTURE-VALUE">
      <input type="hidden" name="sign_submit" value="1"><input type="hidden" name="cf-turnstile-response" value="">
      <div class="cf-turnstile"><input type="checkbox" onclick="document.querySelector('[name=cf-turnstile-response]').value='fixture';this.parentElement.remove();">
      <iframe src="https://challenges.cloudflare.com/turnstile/fixture"></iframe></div>
      <button type="submit">提交签到</button></form>`;
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: url.origin !== target.origin
      ? '<p>Offline challenge frame</p>' : url.pathname === '/' ? home : daily });
  });
  const active = { ...turnstileConfig, navigationTimeoutMs: 5000, actionWaitMs: 1,
    checkinStateWaitMs: 1000, checkinStatePollMs: 20, challengeInteractionRules: {
      [target.origin]: { type: 'click', phase: 'before', waitMs: 1000, settleMs: 50, retryAction: false },
    } };
  const unsigned = await processCandidate(page, target, target.candidates[0], { ...active, checkinReadOnly: true }, []);
  assert.equal(unsigned.status, 'not_signed');
  assert.equal(await page.evaluate(() => window.submissions ?? 0), 0);
  visits.length = 0;
  const result = await processCandidate(page, target, target.candidates[0], active, []);
  assert.equal(result.status, 'signed');
  assert.equal(result.evidence.outcome, 'configured_form_completion');
  assert.deepEqual(await page.evaluate(() => ({ submissions: window.submissions, verified: window.verifiedAtSubmit })),
    { submissions: 1, verified: true });
  assert.equal(visits.filter(url => url === '/daily.php').length, 1, 'result confirmation must not reload the one-time endpoint');
  await page.route(`${target.origin}/daily.php`, route => route.fulfill({ contentType: 'text/html; charset=utf-8',
    body: '<a href="/logout.php">退出</a><p>连续签到 12 天，获得 100 魔力</p>' }));
  const readOnly = await processCandidate(page, target, `${target.origin}/daily.php`, { ...active, checkinReadOnly: true }, []);
  assert.equal(readOnly.status, 'signed', 'later read-only verification also recognizes the result text');
});
