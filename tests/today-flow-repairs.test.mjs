import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bindSuccessEvidence, successEvidence, isConfiguredTerminalCompletion, normalizeBoundEvidenceResult } from "../src/checkin-evidence.mjs";
import { createSubmissionScope, readSubmissionJournal, runWithSubmissionJournal, reconcileSubmissionResult } from "../src/submission-guard.mjs";
import { mergeAuthoritativeDailyResults } from "../src/logger.mjs";
import { reconcileManualDocument } from "../src/manual-result-reconciliation.mjs";
import { readSequentialDailyQuota, sequentialCompletionKind } from "../src/sequential-action-evidence.mjs";
import { getConfiguredSequentialActionRule } from "../src/browser.mjs";
import { configuredLinuxDoSessionStrategy, runTargetFirstLinuxDoOAuthWithRetry } from "../src/reauth-checkin.mjs";

const now = new Date("2026-10-04T10:00:00Z");
const target = { origin: "https://daily.example", allowedOrigins: ["https://daily.example"], candidates: ["https://daily.example/index.php"] };
const config = { preCheckinNavigationRules: { [target.origin]: {
  expectedPath: "/daily.php", steps: [{ role: "link", name: "Daily check-in" }],
  terminalWhenNavigationControlMissing: true, terminalRequireAuthenticatedPage: true,
  terminalMissingControlPaths: ["/", "/index.php"], terminalAssumeSigned: true,
  terminalPaths: ["/closed.php"],
} } };
const completion = (source = "user_rule", outcome = "missing_navigation_control", url = target.candidates[0]) => bindSuccessEvidence({
  status: "already_signed", url, evidence: successEvidence(source, outcome, now),
}, target, config, now);
const currentEntry = { state: "uncertain", cycleId: completion().evidence.binding.cycleId,
  startedAt: now.toISOString(), identity: { siteOrigin: target.origin, accountKey: "default", actionType: "checkin" } };

test("configured stop-only completion preserves same-cycle isolation but stops manual re-opening", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-flow-repairs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "journal.json");
  await createSubmissionScope(file, target, config, { now: () => now }).begin();
  let calls = 0;
  const result = await runWithSubmissionJournal(file, target, config, async active => {
    calls++;
    assert.equal(active.checkinReadOnly, true);
    return completion();
  }, { now: () => now });
  assert.equal(calls, 1);
  assert.equal(result.status, "already_signed");
  assert.equal(result.evidence.authoritative, false);
  assert.equal(result.configuredTerminalStop, true);
  assert.equal(result.submissionLockWarning.submissionBlocked, true);
  const entries = (await readSubmissionJournal(file)).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].state, "uncertain");
  await assert.rejects(createSubmissionScope(file, target, config, { now: () => now }).begin(), /禁止重复/);
  const doc = { state: "awaiting_manual_handoff", sourceRunId: "20261004-170000", createdAt: now.toISOString(), targets: [{ origin: target.origin }] };
  const report = { runId: "20261004-180000", runState: "final", isComplete: true, results: [result] };
  assert.equal(reconcileManualDocument(doc, report, "handoff", { now }).document.state, "handoff_complete");
});

test("unconfigured, disabled, stale, wrong-path and generic assumptions never bypass current isolation", () => {
  const cases = [
    [completion(), {}],
    [completion(), { preCheckinNavigationRules: { [target.origin]: { ...config.preCheckinNavigationRules[target.origin], enabled: false } } }],
    [completion("user_rule", "sequential_step_confirmed"), config],
    [completion("user_rule", "missing_navigation_control", `${target.origin}/profile`), config],
    [completion("user_rule", "terminal_path", `${target.origin}/profile`), config],
  ];
  for (const [result, active] of cases) {
    assert.equal(isConfiguredTerminalCompletion(result, target, active, now), false);
    assert.equal(reconcileSubmissionResult(result, [currentEntry], target, active, now).status, "needs_attention");
  }
  const wrong = completion(); wrong.evidence.binding.accountKey = "other";
  assert.equal(isConfiguredTerminalCompletion(wrong, target, config, now), false);
  assert.equal(isConfiguredTerminalCompletion(completion(), target, config, new Date("2026-10-05T10:00Z")), false);
  const unbound = completion(); delete unbound.evidence.binding;
  assert.equal(isConfiguredTerminalCompletion(unbound, target, config, now), false);
});

test("legacy quarantine reports restore only a configured bound terminal completion without releasing locks", () => {
  const legacy = { ...completion(), status: "needs_attention", failureCode: "submission_quarantined", quarantine: { pendingCount: 1 } };
  const result = reconcileSubmissionResult(legacy, [currentEntry], target, config, now);
  assert.equal(result.status, "already_signed");
  assert.equal(result.failureCode, null);
  assert.equal(result.quarantine, null);
  assert.equal(result.submissionLockWarning.submissionBlocked, true);
  assert.deepEqual(result.evidence, legacy.evidence);
  assert.equal(reconcileSubmissionResult(legacy, [currentEntry], target, {}, now).status, "needs_attention");
  assert.equal(reconcileSubmissionResult({ ...legacy, url: `${target.origin}/profile` }, [currentEntry], target, config, now).status, "needs_attention");
  assert.equal(reconcileSubmissionResult(legacy, [currentEntry], target, config, new Date("2026-10-05T10:00Z")).status, "needs_attention");
  assert.equal(reconcileSubmissionResult({ ...legacy, evidence: completion("user_rule", "sequential_step_confirmed").evidence }, [currentEntry], target, config, now).status, "needs_attention");
});

test("explicit forbidden terminal paths can stop without confirming an uncertain submission", () => {
  const result = reconcileSubmissionResult(completion("user_rule", "terminal_path", `${target.origin}/closed.php`), [currentEntry], target, config, now);
  assert.equal(result.status, "already_signed");
  assert.equal(result.submissionLockWarning.pendingCount, 1);
});

test("success promotion clears current failure fields but keeps separate historical and lock warnings", () => {
  const warning = { pendingCount: 1, actionType: "daily_draw" };
  const incoming = { ...completion("page_text", "page_completion_text"), status: "signed", historicalSubmissionWarning: warning };
  const latest = { runId: "20261004-100000", runState: "final", isComplete: true, plannedTotal: 1, processedTotal: 1,
    results: [{ origin: target.origin, status: "needs_attention", failureCode: "submission_quarantined", quarantine: { pendingCount: 1 }, retryable: true, retryCause: "network", nextEligibleAt: now.toISOString() }] };
  const merged = mergeAuthoritativeDailyResults(latest, { runId: "20261004-180000", runState: "final", results: [incoming] }, now);
  const result = merged.results[0];
  assert.equal(result.status, "signed");
  assert.equal(result.failureCode, null);
  assert.equal(result.quarantine, null);
  assert.equal(result.retryable, false);
  assert.equal(result.retryCause, null);
  assert.equal(result.nextEligibleAt, null);
  assert.deepEqual(result.historicalSubmissionWarning, warning);
  const locked = { ...completion(), submissionLockWarning: { submissionBlocked: true }, failureCode: "submission_quarantined" };
  assert.equal(normalizeBoundEvidenceResult(locked, config, now).failureCode, null);
  assert.equal(normalizeBoundEvidenceResult(locked, config, now).submissionLockWarning.submissionBlocked, true);
});

test("successful account aggregates clear parent and nested failures without changing account evidence", () => {
  const accountTarget = { ...target, accountKey: "linuxdo", actionType: "reauth" };
  const child = bindSuccessEvidence({ status: "signed", failureCode: "oauth_failed", retryable: true,
    evidence: successEvidence("reauth_state", "quota_reward_confirmed", now) }, accountTarget, config, now);
  const root = { origin: target.origin, status: "signed", failureCode: "oauth_failed", quarantine: { pendingCount: 1 }, accountResults: [child] };
  const normalized = normalizeBoundEvidenceResult(root, config, now);
  assert.equal(normalized.failureCode, null);
  assert.equal(normalized.quarantine, null);
  assert.equal(normalized.accountResults[0].failureCode, null);
  assert.equal(normalized.accountResults[0].evidence, child.evidence);
  const latest = { runId: "20261004-100000", runState: "final", isComplete: true, plannedTotal: 1, processedTotal: 1, results: [root] };
  const incoming = { runId: "20261004-180000", runState: "final", results: [] };
  const merged = mergeAuthoritativeDailyResults(latest, incoming, now);
  assert.equal(merged.results[0].accountResults[0].failureCode, null);
  assert.equal(mergeAuthoritativeDailyResults(merged, incoming, now), null);
});

test("equal-strength completion merges clear stale failures without replacing evidence or changing clean results", () => {
  const result = { ...completion("page_text", "page_completion_text"), status: "signed", failureCode: "submission_quarantined", quarantine: { pendingCount: 1 }, retryable: true,
    submissionLockWarning: { submissionBlocked: true }, historicalSubmissionWarning: { pendingCount: 2 } };
  const latest = { runId: "20261004-100000", runState: "final", isComplete: true, plannedTotal: 1, processedTotal: 1, results: [result] };
  const incoming = { runId: "20261004-180000", runState: "final", results: [completion("page_text", "page_completion_text")] };
  const merged = mergeAuthoritativeDailyResults(latest, incoming, now);
  assert.equal(merged.results[0].failureCode, null);
  assert.equal(merged.results[0].retryable, false);
  assert.equal(merged.results[0].evidence, result.evidence);
  assert.equal(merged.results[0].submissionLockWarning, result.submissionLockWarning);
  assert.equal(merged.results[0].historicalSubmissionWarning, result.historicalSubmissionWarning);
  assert.equal(mergeAuthoritativeDailyResults(merged, incoming, now), null);
  const unverified = { ...latest, results: [{ ...result, evidence: undefined }] };
  assert.equal(mergeAuthoritativeDailyResults(unverified, { ...incoming, results: [] }, now), null);
});

const step = { dailyQuotaPattern: "今日剩余\\s*[:：]?\\s*(\\d+)", dailyQuotaMinimum: 10,
  dailyQuotaZeroIsComplete: true, acceptGenericCheckinState: false, disabledActionIsComplete: true };
test("actual daily-remaining label supports split DOM lines without exposing counts in results", () => {
  assert.deepEqual(readSequentialDailyQuota("今日剩余\n10", step), { matched: true, eligible: true, empty: false });
  assert.deepEqual(readSequentialDailyQuota("今日剩余：0", step), { matched: true, eligible: false, empty: true });
  for (const text of ["每日抽奖次数上限为 10 次", "今日剩余10 今日剩余10", "今日剩余-1", "今日剩余99999999999999999999999"]) {
    assert.equal(readSequentialDailyQuota(text, step).matched, false);
  }
});
test("disabled after clicking does not finish the sequence while an authoritative response does", () => {
  const loading = { disabledActionPresent: true, stateStatus: "unknown", loaded: true, busy: false, quota: { matched: true, empty: false } };
  assert.equal(sequentialCompletionKind(loading, step, "after"), null);
  assert.equal(sequentialCompletionKind(loading, step, "before"), "disabled_user_rule");
  assert.equal(sequentialCompletionKind(loading, step, "after", true), "response");
});
test("zero quota completion requires an explicit rule, loaded page, no loading and no challenge", () => {
  const evidence = { stateStatus: "unknown", loaded: true, busy: false, quota: { matched: true, empty: true } };
  assert.equal(sequentialCompletionKind(evidence, step, "after"), "daily_quota_zero");
  for (const change of [{ loaded: false }, { busy: true }, { stateStatus: "login_required" }, { stateStatus: "interactive_challenge" }, { quota: { matched: false, empty: true } }]) {
    assert.equal(sequentialCompletionKind({ ...evidence, ...change }, step, "after"), null);
  }
  assert.equal(sequentialCompletionKind(evidence, { ...step, dailyQuotaZeroIsComplete: false }, "after"), null);
  assert.equal(sequentialCompletionKind({ ...evidence, stateStatus: "already_signed" }, step, "after"), "daily_quota_zero");
});
test("quota completion configuration needs a real quota expression and keeps stable action identity", () => {
  const raw = { url: `${target.origin}/draw`, actionTexts: ["Draw ten"], ...step };
  const read = value => getConfiguredSequentialActionRule(target, { sequentialActionRules: { [target.origin]: { steps: [value] } } }).steps[0];
  assert.equal(read(raw).dailyQuotaZeroIsComplete, true);
  assert.equal(read(raw).actionType, read({ ...raw, dailyQuotaPattern: "Remaining: ([0-9]+)" }).actionType);
  assert.throws(() => read({ ...raw, dailyQuotaPattern: null }), /配额完成规则/);
});
test("target-first LinuxDO OAuth is opt-in and cannot change the GitHub provider", () => {
  assert.equal(configuredLinuxDoSessionStrategy(undefined, "LinuxDO"), "provider_probe");
  assert.equal(configuredLinuxDoSessionStrategy("target_oauth", "LinuxDO"), "target_oauth");
  assert.throws(() => configuredLinuxDoSessionStrategy("target_oauth", "GitHub"), /Invalid/);
  assert.throws(() => configuredLinuxDoSessionStrategy("other", "LinuxDO"), /Invalid/);
});
test("target-first OAuth uses the selected profile and ordinary callback flow, not a provider probe or fake confirmation", async () => {
  const account = { provider: "LinuxDO", linuxDoSessionStrategy: "target_oauth", accountKey: "linuxdo", automationUserDataDir: "data/isolated-provider", oauthAttempts: 1 };
  let calls = 0;
  const result = await runTargetFirstLinuxDoOAuthWithRetry(account, {}, account, { runHelper: async (rule, _config, active, args) => {
    calls++;
    assert.equal(rule, account); assert.equal(active, account); assert.deepEqual(args, []);
    return { succeeded: true, oauthStage: "completed" };
  } });
  assert.equal(calls, 1); assert.equal(result.succeeded, true);
  await assert.rejects(runTargetFirstLinuxDoOAuthWithRetry({ ...account, linuxDoSessionStrategy: "provider_probe" }, {}, account), /not enabled/);
});
test("settled provider challenges stop target-first retries rather than spawning more windows", async () => {
  const account = { provider: "LinuxDO", linuxDoSessionStrategy: "target_oauth", oauthAttempts: 3 };
  let calls = 0;
  const result = await runTargetFirstLinuxDoOAuthWithRetry(account, {}, account, { runHelper: async () => {
    calls++; return { succeeded: false, oauthStage: "linuxdo_session_challenge" };
  } });
  assert.equal(calls, 1); assert.equal(result.succeeded, false);
});
