import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { clickConfiguredSequentialAction, tryConfiguredSequentialActions, processCandidate, getConfiguredSequentialActionRule } from "../src/browser.mjs";
import { navigateConfiguredPreCheckinPage } from "../src/pre-checkin-navigation.mjs";
import { createSubmissionScope, readSubmissionJournal, runWithSubmissionJournal } from "../src/submission-guard.mjs";
import { bindSuccessEvidence, successEvidence, reconcileCheckinResult } from "../src/checkin-evidence.mjs";
import { reconcileManualDocument } from "../src/manual-result-reconciliation.mjs";
import { mergeAuthoritativeDailyResults } from "../src/logger.mjs";
import { mergeAttentionEvidence } from "../src/attention-urls.mjs";

const origin = "https://sequence.example";
const target = { origin, candidates: [`${origin}/home`] };
const rawSteps = [{ url: `${origin}/home`, actionType: "daily_checkin", actionTexts: ["签到"], dailyCheckin: true, completedTexts: ["已签到"] },
  { url: `${origin}/draw`, actionType: "daily_draw", actionTexts: ["连抽 x10"], dailyQuotaPattern: "今日剩余\\s*(\\d+)", dailyQuotaMinimum: 10,
    dailyQuotaZeroIsComplete: true, acceptGenericCheckinState: false, responseEvidence: [{ urlIncludes: "/draw", methods: ["POST"], successAny: [{ path: "success", equals: true }] }] }];
const config = { navigationTimeoutMs: 1000, sequentialActionRules: { [origin]: { steps: rawSteps } } };
const steps = getConfiguredSequentialActionRule(target, config).steps;

function handle(text, events = [], options = {}) {
  let changed = false;
  return { evaluate: async () => ({ tagName: "BUTTON", text: changed ? "其他动作" : text, visible: true, disabled: false, href: null, formAction: null }),
    click: async ({ trial } = {}) => {
      events.push(trial ? `trial:${text}` : `click:${text}`);
      if (trial && options.failTrial) throw new Error("Control is covered by a loading overlay");
      if (trial && options.changeAfterTrial) changed = true;
      if (!trial && options.onClick) await options.onClick();
    }, dispose: async () => {} };
}

test("sequential click retains the chosen element when unrelated controls move, and reserves only after trial", async () => {
  const events = [], desired = handle("连抽 x10", events), unrelated = handle("其他", events);
  const page = { locator: () => ({ elementHandles: async () => [unrelated, desired] }) };
  const result = await clickConfiguredSequentialAction(page, steps[1], [origin], async () => events.push("reserve"));
  assert.equal(result.clicked, true); assert.deepEqual(events, ["trial:连抽 x10", "reserve", "click:连抽 x10"]);
  for (const options of [{ failTrial: true }, { changeAfterTrial: true }]) {
    const calls = [], changed = { locator: () => ({ elementHandles: async () => [handle("连抽 x10", calls, options)] }) };
    const run = () => clickConfiguredSequentialAction(changed, steps[1], [origin], async () => calls.push("reserve"));
    if (options.failTrial) await assert.rejects(run); else assert.equal((await run()).clicked, false);
    assert.deepEqual(calls, ["trial:连抽 x10"]);
  }
  const ambiguous = { locator: () => ({ elementHandles: async () => [handle("连抽 x10"), handle("连抽 x10")] }) };
  assert.equal((await clickConfiguredSequentialAction(ambiguous, steps[1], [origin], () => assert.fail("must not reserve"))).outcome, "action_not_unique");
});

function sequencePage(options = {}) {
  const page = new EventEmitter(); let url = `${origin}/home`; const events = [];
  Object.assign(page, { url: () => url, title: async () => "", frames: () => [], waitForLoadState: async () => {},
    goto: async destination => { if (options.failSecondNavigation && destination.endsWith("/draw")) throw new Error("Navigation failed"); url = destination; },
    evaluate: async args => {
      const home = url.endsWith("/home");
      if (typeof args === "function") return { controls: [], completedTextPresent: home, successTextPresent: false,
        bodyLines: home ? ["今日已签到"] : ["今日剩余 10"], loaded: true, busy: false, disabledActionPresent: false, explicitDailyUnsigned: !home };
      return { bodyText: home ? "今日已签到" : "今日剩余 10", passwordInputs: false, challengeEvidence: [] };
    },
    locator: () => ({ elementHandles: async () => [handle("连抽 x10", events, { failTrial: options.failTrial, onClick: async () => {
      if (options.requestObserved) page.emit("request", { url: () => `${origin}/api/draw`, method: () => "POST" });
      throw new Error("Timeout after the click began");
    } })] }),
  });
  // snapshotState passes a string into evaluate; sequential evidence passes an object.
  const evaluate = page.evaluate;
  page.evaluate = async (fn, args) => typeof args === "string"
    ? { bodyText: url.endsWith("/home") ? "今日已签到" : "今日剩余 10", passwordInputs: false, challengeEvidence: [] }
    : evaluate(fn);
  return { page, events };
}

test("an incomplete or failed second page retains the first step's completion evidence", async () => {
  for (const options of [{}, { failSecondNavigation: true }]) {
    const result = await tryConfiguredSequentialActions(sequencePage(options).page, target, { ...config, checkinReadOnly: true });
    assert.ok(!["signed", "already_signed"].includes(result.status));
    assert.deepEqual(result.requiredActionTypes, ["daily_checkin", "daily_draw"]);
    assert.equal(result.actionResults.length, 2);
    assert.equal(result.actionResults[0].status, "already_signed");
    assert.equal(result.actionResults[0].evidence.authoritative, true);
  }
});

test("a covered draw control does not reserve today's intent or rewrite a historical submission", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sequence-preflight-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "journal.json"), yesterday = new Date(Date.now() - 86400000);
  await createSubmissionScope(file, { ...target, actionType: "daily_draw" }, config, { now: () => yesterday }).begin();
  const initial = await readSubmissionJournal(file);
  const result = await tryConfiguredSequentialActions(sequencePage({ failTrial: true }).page, target, { ...config, submissionJournalPath: file });
  assert.equal(result.submissionAttempted, false); assert.equal(result.failureCode, "sequential_action_not_ready");
  assert.deepEqual(await readSubmissionJournal(file), initial);
  assert.equal(result.actionResults[0].status, "already_signed");
});

test("a click timeout retains per-action isolation, reports observed requests, and cannot create a redundant site intent", async t => {
  for (const observed of [true, false]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sequence-dispatch-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const file = path.join(root, "journal.json"), cfg = { ...config, submissionJournalPath: file };
    const fixture = sequencePage({ requestObserved: observed });
    const result = await runWithSubmissionJournal(file, target, cfg, active => tryConfiguredSequentialActions(fixture.page, target, active));
    assert.equal(result.status, "needs_attention"); assert.equal(result.submissionAttempted, true);
    assert.equal(result.submissionRequestObserved, observed);
    const entries = (await readSubmissionJournal(file)).entries;
    assert.equal(entries.length, 1); assert.equal(entries[0].identity.actionType, "daily_draw"); assert.equal(entries[0].state, "uncertain");
    const retry = await runWithSubmissionJournal(file, target, cfg, active => tryConfiguredSequentialActions(fixture.page, target, active));
    assert.equal(retry.failureCode, "submission_quarantined"); assert.equal(fixture.events.filter(e => e === "click:连抽 x10").length, 1);
  }
});

const now = new Date("2026-10-06T05:00:00Z");
function complete(type) { return bindSuccessEvidence({ status: "already_signed", evidence: successEvidence("page_text", "confirmed", now) }, { origin, actionType: type }, {}, now); }
function composite() { return bindSuccessEvidence({ status: "signed", actionResults: [complete("daily_checkin"), complete("daily_draw")],
  requiredActionTypes: ["daily_checkin", "daily_draw"], evidence: successEvidence("page_text", "all_sequential_steps_confirmed", now) }, target, config, now); }
const report = result => ({ runId: "20261006-130000", runState: "final", isComplete: true, plannedTotal: 1, processedTotal: 1, results: [result] });
const document = () => ({ sourceRunId: "20261006-120000", createdAt: now.toISOString(), state: "pending_verification", targets: [{ origin }] });

test("a step report cannot finish an origin-only task through any result merge path", () => {
  const draw = complete("daily_draw"), pending = { origin, status: "needs_attention" };
  assert.equal(reconcileManualDocument(document(), report(draw), "verification", { now, config }).changed, false);
  const merged = mergeAuthoritativeDailyResults(report(pending), report(draw), now);
  assert.equal(merged, null);
  assert.equal(mergeAttentionEvidence(report(pending), [report(draw)]).results[0].status, "needs_attention");
  const scoped = document(); scoped.targets[0].actionType = "daily_draw";
  assert.equal(reconcileManualDocument(scoped, report(draw), "verification", { now, config }).document.state, "verification_complete");
});

test("site completion requires every configured step exactly once with the correct day and identity", () => {
  const whole = composite(); assert.equal(whole.status, "signed");
  assert.equal(reconcileManualDocument(document(), report(whole), "verification", { now, config }).document.state, "verification_complete");
  const handoff=document();handoff.state="awaiting_manual_handoff";
  const archived=reconcileManualDocument(handoff,report(whole),"handoff",{now,config}).document.completedTargets[0];
  assert.deepEqual(archived.actionResults,whole.actionResults);
  assert.deepEqual(archived.requiredActionTypes,whole.requiredActionTypes);
  for (const mutate of [
    x => x.actionResults.pop(),
    x => x.actionResults[1] = structuredClone(x.actionResults[0]),
    x => x.actionResults[1].evidence.binding.accountKey = "other",
    x => x.actionResults[1].evidence.binding.cycleId = "older",
    x => x.actionResults[1].status = "needs_attention",
  ]) {
    const bad = structuredClone(whole); mutate(bad);
    assert.equal(reconcileCheckinResult(bad, bad.evidence, now, { target, config, requireBinding: true }).failureCode, "incomplete_sequential_evidence");
    assert.equal(reconcileManualDocument(document(), report(bad), "verification", { now, config }).changed, false);
  }
});

function resultPageFixture({ authenticated = true, signed = true } = {}) {
  let url = `${origin}/`; const visits = [];
  const page = { url: () => url, title: async () => "", frames: () => [], goto: async destination => { url = destination; visits.push(destination); },
    getByRole: () => ({ count: async () => 0 }), waitForTimeout: async () => {}, waitForLoadState: async () => {},
    evaluate: async (fn, args) => typeof args === "string" ? { bodyText: signed ? "[签到已得1000]" : "今日未签到", passwordInputs: false, challengeEvidence: [] }
      : { loaded: true, authenticated, hasPassword: false, challengeSelectors: false, bodyText: "主页" },
  };
  return { page, visits };
}
const navigationConfig = { navigationTimeoutMs: 1000, checkinReadOnly: true, preCheckinNavigationRules: { [origin]: {
  expectedPath: "/result.php", steps: [{ role: "link", name: "签到入口" }], readOnlyFallbackToExpectedPath: true, waitMs: 500, afterClickWaitMs: 100,
} } };
test("missing entry can read an explicitly configured result page, and success still needs actual text", async () => {
  for (const signed of [true, false]) {
    const f = resultPageFixture({ signed });
    const result = await processCandidate(f.page, target, `${origin}/`, navigationConfig, []);
    assert.deepEqual(f.visits, [`${origin}/`, `${origin}/result.php`]);
    assert.equal(result.status, signed ? "already_signed" : "ready");
    assert.equal(result.evidence?.source, signed ? "page_text" : undefined);
  }
});
test("result-page fallback cannot bypass login, normal entry navigation, or a missing-entry terminal rule", async () => {
  const unauthenticated = resultPageFixture({ authenticated: false });
  await navigateConfiguredPreCheckinPage(unauthenticated.page, target, origin, navigationConfig); assert.deepEqual(unauthenticated.visits, []);
  await assert.rejects(navigateConfiguredPreCheckinPage(resultPageFixture().page, target, origin, { ...navigationConfig, checkinReadOnly: false }), /not found/);
  const terminal = { ...navigationConfig, preCheckinNavigationRules: { [origin]: { ...navigationConfig.preCheckinNavigationRules[origin], terminalWhenNavigationControlMissing: true } } };
  const f = resultPageFixture(); assert.equal((await navigateConfiguredPreCheckinPage(f.page, target, origin, terminal)).terminalNoAction, true); assert.deepEqual(f.visits, []);
});
