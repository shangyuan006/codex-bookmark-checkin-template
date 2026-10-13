import test from "node:test";
import assert from "node:assert/strict";
import { continueCheckinOnSamePage, getSamePageManualRule, readSamePageReadiness } from "../src/same-page-checkin.mjs";
import { selectSamePageManualTarget } from "../src/live-checkin-session.mjs";

const target = { origin: "https://verify.example" };
const rule = { expectedPath: "/attendance.php", widgetSelector: ".verification", responseSelector: "input[name=response]", actionName: "Check in" };
const config = { samePageManualCheckinRules: { [target.origin]: rule } };

function session(overrides = {}) {
  let tick = 0, clicks = 0;
  const stages = [];
  const options = {
    isClosed: () => false, shouldClose: async () => tick >= 8,
    readState: async () => ({ status: "interactive_challenge" }),
    readReady: async () => ({ widgetPresent: true, responseReady: false, buttonReady: true }),
    submit: async () => { clicks++; return true; },
    onStage: async state => stages.push(state), delay: async () => { tick++; },
    now: () => tick * 500, attentionAfterMs: 1000, ...overrides,
  };
  return { options, stages, get clicks() { return clicks; } };
}

test("verification timeout keeps the session alive and closes only on an explicit request", async () => {
  const s = session();
  const result = await continueCheckinOnSamePage(s.options);
  assert.equal(s.clicks, 0);
  assert.equal(result.status, "unconfirmed");
  assert.deepEqual(s.stages.map(s => s.stage), ["waiting_for_verification", "verification_wait_timeout"]);
});

test("a ready verification response continues once on the same page and waits for real completion", async () => {
  let reads = 0;
  const s = session({ readState: async () => ({ status: ++reads >= 4 ? "signed" : "interactive_challenge" }),
    readReady: async () => ({ responseReady: true, buttonReady: true }) });
  const result = await continueCheckinOnSamePage(s.options);
  assert.equal(s.clicks, 1);
  assert.equal(result.status, "signed");
  assert.equal(result.submissionAttempted, true);
  assert.equal(s.stages.at(-1).stage, "completed");
});

test("human completion is read before waiting for a response that disappears after check-in", async () => {
  const s = session({ readState: async () => ({ status: "already_signed" }),
    readReady: async () => assert.fail("completed page must not wait for a removed verification response") });
  assert.equal((await continueCheckinOnSamePage(s.options)).status, "already_signed");
  assert.equal(s.clicks, 0);
});

test("ambiguous submit failures do not repeat clicks or close the window", async () => {
  let submissions = 0;
  const s = session({ readReady: async () => ({ responseReady: true, buttonReady: true }),
    submit: async () => { submissions++; throw new Error("simulated uncertain submission"); } });
  const result = await continueCheckinOnSamePage(s.options);
  assert.equal(submissions, 1);
  assert.equal(result.status, "unconfirmed");
  assert.equal(result.submissionAttempted, true);
  assert.ok(s.stages.some(s => s.stage === "needs_attention"));
  assert.ok(s.stages.some(s => s.stage === "completion_wait_timeout"));
});

test("a close request wins over ready controls", async () => {
  const s = session({ shouldClose: async () => true, readState: async () => assert.fail("do not read after requested stop") });
  assert.equal((await continueCheckinOnSamePage(s.options)).submissionAttempted, false);
  assert.equal(s.clicks, 0);
});

test("expiry before intent is reserved can wait for a fresh response without reporting a submission", async () => {
  let ready = true;
  const s = session({ readReady: async () => ({ responseReady: ready, buttonReady: true }),
    submit: async () => { ready = false; return false; } });
  assert.equal((await continueCheckinOnSamePage(s.options)).submissionAttempted, false);
});

test("same-page manual routing is opt-in and leaves unrelated origins in the handoff", () => {
  const other = { origin: "https://other.example" };
  const handoff = { targets: [other, target] }, before = structuredClone(handoff);
  assert.equal(selectSamePageManualTarget(handoff, config), target);
  assert.deepEqual(handoff, before);
  assert.equal(selectSamePageManualTarget(handoff, {}), null);
  assert.equal(getSamePageManualRule(other, config), null);
  assert.throws(() => getSamePageManualRule(target, { samePageManualCheckinRules: { [target.origin]: { ...rule, expectedPath: "//outside.example/" } } }));
});

test("same-page readiness rejects a different path or foreign origin before reading controls", async () => {
  const page = { url: () => `${target.origin}/`, evaluate: async () => assert.fail("wrong path") };
  assert.equal((await readSamePageReadiness(page, target, rule)).responseReady, false);
  page.url = () => "https://other.example/attendance.php";
  await assert.rejects(readSamePageReadiness(page, target, rule), /跨站/);
});
