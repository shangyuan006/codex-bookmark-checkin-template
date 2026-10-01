import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  mergeAuthoritativeDailyResults,
  repairLocalResultHistory,
  sanitizeForPersistence,
  writeRunResult,
} from "../src/logger.mjs";

const pageEvidence = (confirmedAt = "2026-07-29T04:00:00.000Z") => ({
  source: "page_text", outcome: "page_completion_text", authoritative: true, confirmedAt,
});

test("进度和嵌套候选历史中的奖励额度在落盘前统一脱敏", () => {
  const safe = sanitizeForPersistence({
    results: [{
      reason: "已通过接口完成，奖励额度 12345",
      candidateHistory: [{ reason: "獎勵額度：67.5，余额 99.5，账号 ID: 123456，联系 user@example.com" }],
    }],
  });
  assert.equal(safe.results[0].reason, "已通过接口完成，奖励额度已到账");
  assert.doesNotMatch(safe.results[0].candidateHistory[0].reason, /67\.5|99\.5|123456|user@example\.com/);
  assert.match(safe.results[0].candidateHistory[0].reason, /\[REDACTED_EMAIL\]|\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(safe), /12345|67\.5|99\.5|123456|user@example\.com/);
});

test("单站诊断结果不会覆盖完整 latest 报告", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-logger-"));
  try {
    const latest = { runId: "full", results: Array.from({ length: 40 }, (_, index) => ({ index })) };
    await fs.writeFile(path.join(root, "latest.json"), JSON.stringify(latest));
    const runDirectory = path.join(root, "single");
    await fs.mkdir(runDirectory);

    await writeRunResult(root, { directory: runDirectory }, { runId: "single", results: [{}] }, { updateLatest: false });

    assert.equal(JSON.parse(await fs.readFile(path.join(root, "latest.json"), "utf8")).runId, "full");
    assert.equal(JSON.parse(await fs.readFile(path.join(runDirectory, "result.json"), "utf8")).runId, "single");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("同日定向运行只把权威终态提升进完整 latest 报告", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-logger-reconcile-"));
  try {
    const latest = {
      runId: "20260729-080500",
      runState: "final",
      plannedTotal: 3,
      processedTotal: 3,
      isComplete: true,
      summary: { no_action: 2, already_signed: 1 },
      results: [
        { origin: "https://one.test", status: "no_action", reason: "unresolved" },
        { origin: "https://two.test", status: "already_signed", reason: "confirmed" },
        { origin: "https://three.test", status: "no_action", reason: "unresolved" },
      ],
    };
    await fs.writeFile(path.join(root, "latest.json"), JSON.stringify(latest));
    const runDirectory = path.join(root, "targeted");
    await fs.mkdir(runDirectory);
    const targeted = {
      runId: "20260729-120000",
      runState: "final",
      plannedTotal: 3,
      processedTotal: 1,
      isComplete: false,
      selectedTotal: 1,
      selectedProcessedTotal: 1,
      scopeComplete: true,
      results: [{ origin: "https://one.test", status: "signed", reason: "奖励额度 12345", evidence: pageEvidence() }],
    };

    await writeRunResult(root, { directory: runDirectory }, targeted, {
      updateLatest: false,
      reconcileLatest: true,
    });

    const reconciled = JSON.parse(await fs.readFile(path.join(root, "latest.json"), "utf8"));
    const targetedSaved = JSON.parse(await fs.readFile(path.join(runDirectory, "result.json"), "utf8"));
    assert.equal(reconciled.runId, latest.runId);
    assert.equal(reconciled.results[0].status, "signed");
    assert.equal(reconciled.results[1].status, "already_signed");
    assert.equal(reconciled.results[2].status, "no_action");
    assert.deepEqual(reconciled.summary, { signed: 1, already_signed: 1, no_action: 1 });
    assert.deepEqual(reconciled.reconciledFromRunIds, [targeted.runId]);
    assert.equal(targetedSaved.results[0].reason, "奖励额度已到账");
    assert.doesNotMatch(JSON.stringify(reconciled), /12345/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("新增书签的定向权威终态会安全扩充当天完整日报", () => {
  const latest = {
    runId: "20260729-080500",
    runState: "final",
    plannedTotal: 2,
    processedTotal: 2,
    isComplete: true,
    summary: { signed: 1, no_action: 1 },
    bookmarkSummary: {
      targetCount: 2,
      targets: [
        { origin: "https://one.test" },
        { origin: "https://two.test" },
      ],
    },
    results: [
      { origin: "https://one.test", status: "signed" },
      { origin: "https://two.test", status: "no_action" },
    ],
  };
  const bookmarkSummary = {
    targetCount: 3,
    targets: [
      { origin: "https://one.test" },
      { origin: "https://two.test" },
      { origin: "https://new.test" },
    ],
  };
  const incoming = {
    runId: "20260729-140000",
    runState: "final",
    plannedTotal: 3,
    processedTotal: 1,
    isComplete: false,
    selectedTotal: 1,
    selectedProcessedTotal: 1,
    scopeComplete: true,
    bookmarkSummary,
    results: [{ origin: "https://new.test", status: "already_signed", evidence: pageEvidence("2026-07-29T06:00:00.000Z") }],
  };

  const reconciled = mergeAuthoritativeDailyResults(latest, incoming, new Date("2026-07-29T06:05:00.000Z"));
  assert.equal(reconciled.plannedTotal, 3);
  assert.equal(reconciled.processedTotal, 3);
  assert.equal(reconciled.isComplete, true);
  assert.equal(reconciled.scopeComplete, true);
  assert.deepEqual(reconciled.bookmarkSummary, bookmarkSummary);
  assert.deepEqual(reconciled.results.map(({ origin, status }) => ({ origin, status })), [
    { origin: "https://one.test", status: "signed" },
    { origin: "https://two.test", status: "no_action" },
    { origin: "https://new.test", status: "already_signed" },
  ]);
  assert.deepEqual(reconciled.summary, { signed: 1, no_action: 1, already_signed: 1 });
  assert.deepEqual(reconciled.selectedSummary, { already_signed: 1 });
  assert.equal(reconciled.selectedTotal, 1);
  assert.equal(reconciled.selectedProcessedTotal, 1);
});

test("新增书签只有非权威结果或当前计划移除旧来源时拒绝扩充日报", () => {
  const latest = {
    runId: "20260729-080500",
    runState: "final",
    plannedTotal: 1,
    processedTotal: 1,
    isComplete: true,
    results: [{ origin: "https://old.test", status: "signed" }],
  };
  const incoming = {
    runId: "20260729-140000",
    runState: "final",
    plannedTotal: 2,
    scopeComplete: true,
    bookmarkSummary: {
      targetCount: 2,
      targets: [{ origin: "https://old.test" }, { origin: "https://new.test" }],
    },
    results: [{ origin: "https://new.test", status: "needs_attention" }],
  };
  assert.equal(mergeAuthoritativeDailyResults(latest, incoming), null);

  assert.equal(mergeAuthoritativeDailyResults(latest, {
    ...incoming,
    plannedTotal: 1,
    bookmarkSummary: { targetCount: 1, targets: [{ origin: "https://new.test" }] },
    results: [{ origin: "https://new.test", status: "signed" }],
  }), null);
});

test("定向非终态、跨日结果和已确认结果都不会降级 latest", () => {
  const latest = {
    runId: "20260729-080500",
    runState: "final",
    plannedTotal: 1,
    processedTotal: 1,
    isComplete: true,
    results: [{ origin: "https://one.test", status: "signed" }],
  };
  assert.equal(mergeAuthoritativeDailyResults(latest, {
    runId: "20260729-120000",
    runState: "final",
    results: [{ origin: "https://one.test", status: "error" }],
  }), null);
  assert.equal(mergeAuthoritativeDailyResults(latest, {
    runId: "20260730-080000",
    runState: "final",
    results: [{ origin: "https://one.test", status: "already_signed" }],
  }), null);
  assert.equal(mergeAuthoritativeDailyResults(latest, {
    runId: "20260729-120100",
    runState: "final",
    results: [{ origin: "https://one.test", status: "not_available" }],
  }), null);
});

test("相同成功状态的页面证据会替换人工确认且不改变日报完成度", () => {
  const now = new Date("2026-09-29T03:00:00.000Z");
  const current = {
    origin: "https://one.test", status: "already_signed", confirmationSource: "operator_confirmation",
    evidence: { source: "user_rule", outcome: "operator_confirmed", authoritative: false, confirmedAt: "2026-09-29T02:00:00.000Z" },
  };
  const latest = { runId: "20260929-100000", runState: "final", isComplete: true,
    plannedTotal: 1, processedTotal: 1, results: [current] };
  const incoming = { runId: "20260929-110000", runState: "final", results: [{ ...current,
    confirmationSource: undefined,
    evidence: { source: "page_text", outcome: "page_completion_text", authoritative: true, confirmedAt: now.toISOString() } }] };
  for (const withPlan of [false, true]) {
    const report = withPlan ? { ...incoming, scopeComplete: true, plannedTotal: 1,
      bookmarkSummary: { targetCount: 1, targets: [{ origin: current.origin }] } } : incoming;
    const merged = mergeAuthoritativeDailyResults(latest, report, now);
    assert.equal(merged.results[0].evidence.source, "page_text");
    assert.equal(merged.results[0].confirmationSource, undefined);
    assert.equal(merged.results[0].status, "already_signed");
    assert.equal(merged.isComplete, true);
    assert.equal(merged.plannedTotal, 1);
    assert.deepEqual(merged.summary, { already_signed: 1 });
  }
  const signed = mergeAuthoritativeDailyResults({ ...latest, results: [{ ...current, status: "signed" }] }, incoming, now);
  assert.equal(signed.results[0].status, "signed");
  assert.equal(signed.results[0].evidence.source, "page_text");
  const observedRule = mergeAuthoritativeDailyResults(latest, { ...incoming, results: [{ ...current,
    confirmationSource: undefined,
    evidence: { source: "user_rule", outcome: "missing_navigation_control", authoritative: false, confirmedAt: now.toISOString() } }] }, now);
  assert.equal(observedRule.results[0].evidence.outcome, "missing_navigation_control");
  assert.equal(observedRule.results[0].evidence.authoritative, false);
  assert.equal(observedRule.results[0].confirmationSource, undefined);
});

test("无效、较旧、弱证据和非成功结果不能覆盖已有页面成功证据", () => {
  const now = new Date("2026-09-29T03:00:00.000Z");
  const current = { origin: "https://one.test", status: "already_signed",
    evidence: { source: "user_rule", outcome: "operator_confirmed", authoritative: false, confirmedAt: "2026-09-29T02:00:00.000Z" } };
  const latest = { runId: "20260929-100000", runState: "final", isComplete: true,
    plannedTotal: 1, processedTotal: 1, results: [current] };
  const evidence = { source: "page_text", outcome: "page_completion_text", authoritative: true, confirmedAt: now.toISOString() };
  for (const invalid of [
    { ...evidence, source: "unknown" }, { ...evidence, authoritative: false },
    { ...evidence, confirmedAt: "invalid" }, { ...evidence, confirmedAt: "2026-09-29T04:00:00Z" },
    { ...evidence, confirmedAt: "2026-09-29T01:00:00Z" },
  ]) {
    assert.equal(mergeAuthoritativeDailyResults(latest, { runId: "20260929-110000", runState: "final",
      results: [{ ...current, evidence: invalid }] }, now), null);
  }
  const strongLatest = { ...latest, results: [{ ...current, evidence }] };
  assert.equal(mergeAuthoritativeDailyResults(strongLatest, { runId: "20260929-110000", runState: "final",
    results: [current] }, now), null);
  const promotedStatus = mergeAuthoritativeDailyResults(strongLatest, { runId: "20260929-110001", runState: "final",
    results: [{ ...current, status: "signed" }] }, now);
  assert.equal(promotedStatus.results[0].status, "signed");
  assert.deepEqual(promotedStatus.results[0].evidence, evidence);
});

test("invalid completion evidence cannot promote unresolved or already-completed daily results", () => {
  const now = new Date("2026-09-29T03:00:00.000Z");
  const valid = pageEvidence(now.toISOString());
  const invalidEvidence = [undefined, { ...valid, source: "unknown" }, { ...valid, authoritative: false },
    { ...valid, confirmedAt: "invalid" }, { ...valid, confirmedAt: "2026-09-29T04:00:00Z" }];
  for (const status of ["unconfirmed", "no_action", "already_signed"]) {
    const latest = { runId: "20260929-100000", runState: "final", isComplete: true,
      plannedTotal: 1, processedTotal: 1, results: [{ origin: "https://one.test", status, evidence: valid }] };
    for (const evidence of invalidEvidence) {
      for (const incomingStatus of ["signed", "already_signed"]) {
        assert.equal(mergeAuthoritativeDailyResults(latest, { runId: "20260929-110000", runState: "final",
          results: [{ origin: "https://one.test", status: incomingStatus, evidence }] }, now), null);
      }
    }
  }
  const latest = { runId: "20260929-100000", runState: "final", isComplete: true,
    plannedTotal: 1, processedTotal: 1, results: [{ origin: "https://old.test", status: "signed", evidence: valid }] };
  for (const evidence of invalidEvidence) {
    assert.equal(mergeAuthoritativeDailyResults(latest, { runId: "20260929-110000", runState: "final",
      scopeComplete: true, plannedTotal: 2,
      bookmarkSummary: { targetCount: 2, targets: [{ origin: "https://old.test" }, { origin: "https://new.test" }] },
      results: [{ origin: "https://new.test", status: "signed", evidence }] }, now), null);
  }
  const success = mergeAuthoritativeDailyResults({ ...latest,
    results: [{ origin: "https://old.test", status: "unconfirmed" }] },
  { runId: "20260929-110000", runState: "final", results: [{ origin: "https://old.test", status: "signed", evidence: valid }] }, now);
  assert.equal(success.results[0].status, "signed");
});

test("本地历史修复会脱敏旧结果并合并同日权威补跑", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-history-repair-"));
  const siteStatePath = path.join(root, "site-state.json");
  try {
    const full = {
      runId: "20260729-080500",
      runState: "final",
      plannedTotal: 2,
      processedTotal: 2,
      isComplete: true,
      results: [
        { origin: "https://one.test", status: "no_action" },
        { origin: "https://two.test", status: "signed", reason: "奖励额度 999" },
      ],
    };
    await fs.writeFile(path.join(root, "latest.json"), JSON.stringify(full));
    const fullDirectory = path.join(root, full.runId);
    const targetedDirectory = path.join(root, "20260729-120000");
    await fs.mkdir(fullDirectory);
    await fs.mkdir(targetedDirectory);
    await fs.writeFile(path.join(fullDirectory, "result.json"), JSON.stringify(full));
    await fs.writeFile(path.join(targetedDirectory, "result.json"), JSON.stringify({
      runId: "20260729-120000",
      runState: "final",
      results: [{ origin: "https://one.test", status: "already_signed", evidence: pageEvidence() }],
    }));
    await fs.writeFile(siteStatePath, JSON.stringify({
      sites: { "https://two.test": { lastReason: "奖励额度：999" } },
    }));

    const repaired = await repairLocalResultHistory(root, siteStatePath);
    const latest = JSON.parse(await fs.readFile(path.join(root, "latest.json"), "utf8"));
    const siteState = JSON.parse(await fs.readFile(siteStatePath, "utf8"));
    assert.ok(repaired.sanitizedFiles >= 2);
    assert.deepEqual(repaired.reconciledRunIds, ["20260729-120000"]);
    assert.equal(latest.results[0].status, "already_signed");
    assert.equal(latest.results[1].reason, "奖励额度已到账");
    assert.equal(siteState.sites["https://two.test"].lastReason, "奖励额度已到账");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
