import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSubmissionScope, readSubmissionJournal } from "../src/submission-guard.mjs";
import { evidenceBinding, bindSuccessEvidence, successEvidence } from "../src/checkin-evidence.mjs";

const target = { origin: "https://daily.example" };
const yesterday = new Date("2026-10-01T04:00:00Z");
const today = new Date("2026-10-02T04:00:00Z");
function unsigned(identity = target, at = today) {
  return { status: "not_signed", evidence: { source: "status_endpoint", outcome: "daily_checkin_not_signed",
    authoritative: true, confirmedAt: at.toISOString(),
    binding: { ...evidenceBinding(identity, {}, at), observedOrigin: identity.origin } } };
}
async function fixture(t, identity = target, at = yesterday) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "daily-continuation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "journal.json");
  await createSubmissionScope(file, identity, {}, { now: () => at }).begin();
  return { file, scope: createSubmissionScope(file, identity, {}, { now: () => today }) };
}
test("verified daily continuation preserves old uncertainty and confirms only the new intent", async t => {
  const { file, scope } = await fixture(t);
  const old = structuredClone((await readSubmissionJournal(file)).entries[0]);
  await scope.beginNewCycleAfterVerifiedReadiness(unsigned());
  assert.equal((await scope.pending()).length, 1);
  const result = bindSuccessEvidence({ status: "signed", evidence: successEvidence("status_endpoint", "checked_in_today", today) }, target, {}, today);
  assert.deepEqual(await scope.observe(result), []);
  const entries = (await readSubmissionJournal(file)).entries;
  assert.deepEqual(entries[0], old);
  assert.equal(entries[1].state, "confirmed");
  assert.equal(entries[1].history[1].event, "verified_daily_cycle_continuation");
});
test("crashed daily continuation stays blocked even with fresh readiness", async t => {
  const { file, scope } = await fixture(t);
  await scope.beginNewCycleAfterVerifiedReadiness(unsigned());
  const restarted = createSubmissionScope(file, target, {}, { now: () => today });
  await assert.rejects(restarted.beginNewCycleAfterVerifiedReadiness(unsigned()), /Same-cycle/);
  await assert.rejects(restarted.begin(), /禁止重复/);
  assert.equal((await readSubmissionJournal(file)).entries.length, 2);
});
test("same-day uncertainty is never bypassed", async t => {
  const { scope } = await fixture(t, target, today);
  await assert.rejects(scope.beginNewCycleAfterVerifiedReadiness(unsigned()), /Same-cycle/);
});
test("stale, assumed, unbound, cross-account, and future evidence fail closed", async t => {
  const { file, scope } = await fixture(t);
  const bad = [unsigned(target, new Date(today.getTime()-31_000)), unsigned(target, new Date(today.getTime()+1)),
    unsigned({ ...target, accountKey: "other" }), { status: "ready" }];
  const assumed = unsigned(); assumed.evidence.source = "user_rule"; bad.push(assumed);
  const unbound = unsigned(); delete unbound.evidence.binding; bad.push(unbound);
  const crossOrigin = unsigned(); crossOrigin.evidence.binding.observedOrigin = "https://other.example"; bad.push(crossOrigin);
  for (const result of bad) await assert.rejects(scope.beginNewCycleAfterVerifiedReadiness(result), /Fresh bound/);
  assert.equal((await readSubmissionJournal(file)).entries.length, 1);
});
test("draw and reauthentication are excluded from daily continuation", async t => {
  for (const actionType of ["draw", "reauth"]) {
    const identity = { ...target, actionType };
    const { scope } = await fixture(t, identity);
    await assert.rejects(scope.beginNewCycleAfterVerifiedReadiness(unsigned(identity)), /Fresh bound/);
  }
});
