import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectConfiguredDailyUnsignedForm, getConfiguredPreCheckinNavigationRule } from "../src/pre-checkin-navigation.mjs";
import { processCandidate } from "../src/browser.mjs";
import { createSubmissionScope, readSubmissionJournal, runWithSubmissionJournal, SUBMISSION_SCOPE } from "../src/submission-guard.mjs";
import { bindSuccessEvidence, successEvidence } from "../src/checkin-evidence.mjs";

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
