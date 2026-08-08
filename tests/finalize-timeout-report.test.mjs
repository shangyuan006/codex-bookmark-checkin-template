import assert from "node:assert/strict";
import test from "node:test";
import { buildTimeoutReport, finalizeTimedOutResults } from "../src/finalize-timeout-report.mjs";

const targets = [
  { origin: "https://one.example", title: "One", folderNames: ["targets"], candidates: ["https://one.example/"] },
  { origin: "https://two.example", title: "Two", folderNames: ["targets"], candidates: ["https://two.example/"] },
];
const now = new Date("2026-07-31T03:00:00.000Z");

test("任务级超时保留已有结果并把未处理站点转为可续跑状态", () => {
  const results = finalizeTimedOutResults(targets, [{
    origin: "https://one.example",
    status: "signed",
    reason: "已确认",
    attempt: 1,
  }], now);
  assert.deepEqual(results, [
    {
      origin: "https://one.example",
      title: "One",
      folderNames: ["targets"],
      status: "signed",
      reason: "已确认",
      attempt: 1,
    },
    {
      origin: "https://two.example",
      title: "Two",
      folderNames: ["targets"],
      status: "deferred",
      retryCause: "task_timeout",
      reason: "任务级超时，尚未处理，等待后续定向重试",
      nextEligibleAt: now.toISOString(),
      attempt: 0,
      durationMs: 0,
    },
  ]);
});

test("超时补全报告保持完整合同但不把待续跑站点计为成功", () => {
  const plan = {
    generatedAt: now.toISOString(),
    recoveredFromBackup: false,
    targetCount: 2,
    exactUrlCount: 2,
    comparison: {},
    targets,
    sources: [],
  };
  const report = buildTimeoutReport(plan, {
    runId: "20260731-080500",
    results: [{ origin: "https://one.example", status: "already_signed", reason: "今日已签到" }],
  }, now);
  assert.equal(report.runState, "final");
  assert.equal(report.isComplete, true);
  assert.equal(report.plannedTotal, 2);
  assert.equal(report.processedTotal, 2);
  assert.deepEqual(report.summary, { already_signed: 1, deferred: 1 });
  assert.equal(report.results[1].retryCause, "task_timeout");
  assert.equal(report.nextRetryAt, null);
});

test("targeted timeout preserves cumulative results and reports selected scope", () => {
  const targetedTargets = [
    ...targets,
    { origin: "https://three.example", title: "Three", folderNames: ["targets"], candidates: ["https://three.example/"] },
  ];
  const plan = {
    generatedAt: now.toISOString(),
    recoveredFromBackup: false,
    targetCount: 3,
    exactUrlCount: 3,
    comparison: {},
    targets: targetedTargets,
    sources: [],
  };
  const report = buildTimeoutReport(plan, {
    runId: "20260731-080500",
    selectedOrigins: ["https://two.example", "https://three.example"],
    selectedResults: [{ origin: "https://two.example", status: "signed" }],
    results: [
      { origin: "https://one.example", status: "already_signed" },
      { origin: "https://two.example", status: "signed" },
    ],
  }, now);

  assert.equal(report.plannedTotal, 3);
  assert.equal(report.processedTotal, 3);
  assert.equal(report.isComplete, true);
  assert.deepEqual(report.selectedOrigins, ["https://two.example", "https://three.example"]);
  assert.equal(report.selectedTotal, 2);
  assert.equal(report.selectedProcessedTotal, 2);
  assert.deepEqual(report.selectedSummary, { signed: 1, deferred: 1 });
  assert.deepEqual(report.summary, { already_signed: 1, signed: 1, deferred: 1 });
  assert.equal(report.results[0].status, "already_signed");
  assert.equal(report.results[2].retryCause, "task_timeout");
});

test("targeted timeout without cumulative history remains a partial daily report", () => {
  const targetedTargets = [
    ...targets,
    { origin: "https://three.example", title: "Three", folderNames: ["targets"], candidates: ["https://three.example/"] },
  ];
  const report = buildTimeoutReport({
    generatedAt: now.toISOString(),
    recoveredFromBackup: false,
    targetCount: 3,
    exactUrlCount: 3,
    comparison: {},
    targets: targetedTargets,
    sources: [],
  }, {
    runId: "20260731-080501",
    selectedOrigins: ["https://three.example"],
    selectedResults: [],
    results: [],
  }, now);

  assert.equal(report.plannedTotal, 3);
  assert.equal(report.processedTotal, 1);
  assert.equal(report.isComplete, false);
  assert.equal(report.scopeComplete, true);
  assert.deepEqual(report.selectedSummary, { deferred: 1 });
  assert.deepEqual(report.results.map((result) => result.origin), ["https://three.example"]);
});
