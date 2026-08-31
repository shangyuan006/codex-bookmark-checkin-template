import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { powershellExecutable } from "./helpers/powershell.mjs";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmpRoot = path.join(root, "tmp");
const reporter = path.join(root, "scripts", "Submit-UnifiedCheckinReport.ps1");
const abandonmentHelper = path.join(root, "scripts", "ManualAbandonment.ps1");

async function previewReport(report, runnerStatus = "completed", abandonedOrigins = []) {
  await fs.mkdir(tmpRoot, { recursive: true });
  const fixtureRoot = await fs.mkdtemp(path.join(tmpRoot, "report-contract-test-"));
  const scriptsDirectory = path.join(fixtureRoot, "scripts");
  const configDirectory = path.join(fixtureRoot, "config");
  const reportDirectory = path.join(fixtureRoot, "logs", "run");
  const fixtureReporter = path.join(scriptsDirectory, "Submit-UnifiedCheckinReport.ps1");
  const reportPath = path.join(reportDirectory, "report.json");
  try {
    await fs.mkdir(scriptsDirectory, { recursive: true });
    await fs.mkdir(configDirectory, { recursive: true });
    await fs.mkdir(reportDirectory, { recursive: true });
    await Promise.all([
      fs.copyFile(reporter, fixtureReporter),
      fs.copyFile(abandonmentHelper, path.join(scriptsDirectory, "ManualAbandonment.ps1")),
    ]);
    await fs.writeFile(path.join(configDirectory, "defaults.json"), JSON.stringify({ notification: { mode: "none" } }), "utf8");
    if (abandonedOrigins.length > 0) {
      const today = new Date().toLocaleDateString("en-CA", {
        year: "numeric", month: "2-digit", day: "2-digit",
      }).replaceAll("-", "");
      await fs.mkdir(path.join(fixtureRoot, "tmp"), { recursive: true });
      await fs.writeFile(path.join(fixtureRoot, "tmp", "manual-abandon.json"), JSON.stringify({
        schemaVersion: 1,
        date: today,
        origins: abandonedOrigins,
      }), "utf8");
    }
    await fs.writeFile(reportPath, JSON.stringify(report), "utf8");
    const { stdout } = await execFileAsync(powershellExecutable, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", fixtureReporter,
      "-RunnerStatus", runnerStatus,
      "-ReportPath", reportPath,
      "-Preview",
    ], { cwd: root, encoding: "utf8" });
    return JSON.parse(stdout.trim());
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

test("today's abandonment is projected into report counts without hiding real problems", async () => {
  const report = await previewReport({
    runId: "20260825-120000",
    runState: "final",
    plannedTotal: 3,
    processedTotal: 3,
    isComplete: true,
    selectedOrigins: ["https://abandoned.test", "https://problem.test"],
    selectedTotal: 2,
    selectedProcessedTotal: 2,
    results: [
      { origin: "https://signed.test", status: "signed" },
      { origin: "https://abandoned.test", status: "login_required" },
      { origin: "https://problem.test", status: "no_action" },
    ],
  }, "completed", ["https://abandoned.test"]);

  assert.equal(report.problemCount, 1);
  assert.equal(report.abandonedCount, 1);
  assert.equal(report.selectedProblemCount, 1);
  assert.equal(report.selectedAbandonedCount, 1);
  assert.deepEqual(report.selectedSummary, { abandoned: 1, no_action: 1 });
  assert.match(report.summary, /1 个今日放弃/);
  assert.match(report.summary, /problem\.test/);
  assert.doesNotMatch(report.summary, /abandoned\.test：登录失效/);
});

test("部分进度即使全部已签到也不会报告成功", async () => {
  const report = await previewReport({
    runId: "20260723-120000",
    runState: "in_progress",
    plannedTotal: 5,
    processedTotal: 2,
    isComplete: true,
    results: [
      { origin: "https://one.test", status: "signed" },
      { origin: "https://two.test", status: "already_signed" },
    ],
  });

  assert.equal(report.status, "unconfirmed");
  assert.equal(report.isComplete, false);
  assert.match(report.summary, /已处理 2\/5 站（任务未完成）/);
  assert.match(report.summary, /\n2 个签到正常/);
});

test("targeted report exposes selected scope without changing cumulative completion", async () => {
  const report = await previewReport({
    runId: "20260723-120004",
    runState: "final",
    plannedTotal: 3,
    processedTotal: 3,
    isComplete: true,
    selectedOrigins: ["https://two.test", "https://three.test"],
    selectedTotal: 2,
    selectedProcessedTotal: 2,
    selectedSummary: { signed: 1, deferred: 1 },
    results: [
      { origin: "https://one.test", status: "already_signed" },
      { origin: "https://two.test", status: "signed" },
      { origin: "https://three.test", status: "deferred", retryCause: "task_timeout" },
    ],
  }, "timeout");

  assert.equal(report.status, "timeout");
  assert.equal(report.isComplete, true);
  assert.equal(report.siteCount, 3);
  assert.equal(report.problemCount, 1);
  assert.equal(report.selectedSiteCount, 2);
  assert.equal(report.selectedProblemCount, 1);
  assert.deepEqual(report.selectedOrigins, ["https://two.test", "https://three.test"]);
  assert.equal(report.selectedTotal, 2);
  assert.equal(report.selectedProcessedTotal, 2);
  assert.deepEqual(report.selectedSummary, { deferred: 1, signed: 1 });
  assert.match(report.summary, /^本轮 2\/2 站：/);
  assert.match(report.summary, /今日累计：共 3 站/);
});

test("部分进度在运行器超时时保持超时状态", async () => {
  const report = await previewReport({
    runId: "20260723-120001",
    runState: "in_progress",
    plannedTotal: 5,
    processedTotal: 1,
    isComplete: false,
    results: [{ origin: "https://one.test", status: "signed" }],
  }, "timeout");

  assert.equal(report.status, "timeout");
  assert.match(report.summary, /已处理 1\/5 站（任务未完成）/);
});

test("只有完整的 final 报告可以映射为今日已完成", async () => {
  const report = await previewReport({
    runId: "20260723-120002",
    runState: "final",
    plannedTotal: 2,
    processedTotal: 2,
    isComplete: true,
    results: [
      { origin: "https://one.test", status: "already_signed" },
      { origin: "https://two.test", status: "already_signed" },
    ],
  });

  assert.equal(report.status, "already_done");
  assert.equal(report.isComplete, true);
  assert.match(report.summary, /^共 2 站：\n/);
});

test("通知事件键对相同状态稳定并在结果变化后更新", async () => {
  const base = {
    runId: "20260723-120003",
    runState: "final",
    plannedTotal: 1,
    processedTotal: 1,
    isComplete: true,
  };
  const deferred = await previewReport({
    ...base,
    results: [{ origin: "https://one.test", status: "deferred", retryCause: "rate_limit" }],
  });
  const repeated = await previewReport({
    ...base,
    results: [{ origin: "https://one.test", status: "deferred", retryCause: "rate_limit" }],
  });
  const completed = await previewReport({
    ...base,
    results: [{ origin: "https://one.test", status: "signed" }],
  });

  assert.equal(deferred.eventKey, repeated.eventKey);
  assert.notEqual(deferred.eventKey, completed.eventKey);
});

test("延迟重试按原因区分登录恢复和安全验证", async () => {
  const report = await previewReport({
    runId: "20260723-120003",
    runState: "final",
    plannedTotal: 2,
    processedTotal: 2,
    isComplete: true,
    results: [
      {
        origin: "https://login.example.test",
        status: "deferred",
        retryCause: "login_required",
        nextEligibleAt: "2026-07-23T11:00:00Z",
      },
      {
        origin: "https://challenge.example.test",
        status: "deferred",
        retryCause: "managed_challenge_timeout",
        nextEligibleAt: "2026-07-23T06:00:00Z",
      },
    ],
  });

  assert.equal(report.status, "skipped");
  assert.match(report.summary, /login\.example\.test：登录恢复未成功，计划/);
  assert.match(report.summary, /challenge\.example\.test：验证未自动通过，计划/);
});

test("嵌套账号逐项进入摘要但不暴露权威账号和私密结果字段", async () => {
  const report = await previewReport({
    runId: "20260723-120005",
    runState: "final",
    plannedTotal: 1,
    processedTotal: 1,
    isComplete: true,
    results: [{
      origin: "https://router.example.test/checkin/private?token=NeverShow",
      status: "signed",
      accountResults: [
        {
          accountLabel: "GitHub 主账号", provider: "GitHub", accountKey: "github",
          accountId: "authoritative-github-id", status: "signed",
          reason: "signed at https://router.example.test/private/path with balance=98765 token=SecretValue",
          balance: 98765,
        },
        {
          provider: "LinuxDO", accountKey: "linuxdo", accountId: "authoritative-linuxdo-id",
          status: "login_required", reason: "account authoritative-linuxdo-id needs login",
        },
        {
          accountKey: "backup", status: "deferred", retryCause: "managed_challenge_timeout",
          reason: "https://router.example.test/hidden/challenge timed out",
        },
      ],
    }],
  });

  assert.equal(report.status, "needs_attention");
  assert.equal(report.siteCount, 1);
  assert.equal(report.problemCount, 1);
  assert.equal(report.plannedTotal, 1);
  assert.match(report.summary, /需关注 1 个站点的账号明细：2 个账号未确认/);
  assert.match(report.summary, /账号明细：/);
  assert.match(report.summary, /router\.example\.test \/ GitHub：signed（签到成功）/);
  assert.match(report.summary, /router\.example\.test \/ LinuxDO：login_required（需要重新登录）/);
  assert.match(report.summary, /router\.example\.test \/ 账号 3：deferred（验证未自动通过，等待重试）/);
  assert.doesNotMatch(report.summary, /GitHub 主账号|backup/);
  assert.doesNotMatch(report.summary, /authoritative-|98765|NeverShow|SecretValue|\/private|\/hidden|balance/i);
});

test("嵌套账号状态改变会更新事件键且账号顺序不影响哈希", async () => {
  const base = {
    runId: "20260723-120006",
    runState: "final",
    plannedTotal: 1,
    processedTotal: 1,
    isComplete: true,
  };
  const github = { accountLabel: "GitHub", provider: "GitHub", accountKey: "github", status: "signed" };
  const linuxdo = { accountLabel: "LinuxDO", provider: "LinuxDO", accountKey: "linuxdo", status: "already_signed" };
  const initial = await previewReport({
    ...base,
    results: [{ origin: "https://router.example.test", status: "signed", accountResults: [github, linuxdo] }],
  });
  const reordered = await previewReport({
    ...base,
    results: [{ origin: "https://router.example.test", status: "signed", accountResults: [linuxdo, github] }],
  });
  const changed = await previewReport({
    ...base,
    results: [{
      origin: "https://router.example.test",
      status: "signed",
      accountResults: [github, { ...linuxdo, status: "login_required", reason: "private detail" }],
    }],
  });
  const reasonChanged = await previewReport({
    ...base,
    results: [{
      origin: "https://router.example.test",
      status: "signed",
      accountResults: [github, { ...linuxdo, reason: "a different safe operational reason" }],
    }],
  });
  const anonymousOrderA = await previewReport({
    ...base,
    results: [{
      origin: "https://router.example.test", status: "signed",
      accountResults: [{ status: "signed" }, { status: "already_signed" }],
    }],
  });
  const anonymousOrderB = await previewReport({
    ...base,
    results: [{
      origin: "https://router.example.test", status: "signed",
      accountResults: [{ status: "already_signed" }, { status: "signed" }],
    }],
  });

  assert.equal(initial.eventKey, reordered.eventKey);
  assert.equal(anonymousOrderA.eventKey, anonymousOrderB.eventKey);
  assert.notEqual(initial.eventKey, changed.eventKey);
  assert.notEqual(initial.eventKey, reasonChanged.eventKey);
  assert.equal(changed.status, "needs_attention");
  assert.equal(changed.siteCount, 1);
});

test("父级已签到但账号超时会 fail closed 且不展平站点计数", async () => {
  const report = await previewReport({
    runId: "20260723-120007",
    runState: "final",
    plannedTotal: 1,
    processedTotal: 1,
    isComplete: true,
    selectedOrigins: ["https://router.example.test"],
    selectedTotal: 1,
    selectedProcessedTotal: 1,
    results: [{
      origin: "https://router.example.test",
      status: "already_signed",
      accountResults: [
        { accountLabel: "private primary", provider: "GitHub", status: "already_signed" },
        { accountLabel: "private secondary", provider: "LinuxDO", status: "managed_challenge_timeout", reason: "private timeout detail" },
      ],
    }],
  });

  assert.equal(report.status, "needs_attention");
  assert.equal(report.siteCount, 1);
  assert.equal(report.problemCount, 1);
  assert.equal(report.selectedSiteCount, 1);
  assert.equal(report.selectedProblemCount, 1);
  assert.deepEqual(report.selectedSummary, { needs_attention: 1 });
  assert.match(report.summary, /0 个签到正常/);
  assert.match(report.summary, /LinuxDO：managed_challenge_timeout（验证超时）/);
  assert.doesNotMatch(report.summary, /private primary|private secondary/);
});

test("损坏的嵌套账号条目同样 fail closed", async () => {
  const report = await previewReport({
    runId: "20260723-120008",
    runState: "final",
    plannedTotal: 1,
    processedTotal: 1,
    isComplete: true,
    results: [{ origin: "https://router.example.test", status: "signed", accountResults: [null] }],
  });

  assert.equal(report.status, "needs_attention");
  assert.equal(report.problemCount, 1);
  assert.match(report.summary, /需关注 1 个站点的账号明细：1 个账号未确认/);
  assert.match(report.summary, /账号 1：unknown（结果未确认）/);
});

test("空的嵌套账号数组同样 fail closed", async () => {
  const report = await previewReport({
    runId: "20260723-120009",
    runState: "final",
    plannedTotal: 1,
    processedTotal: 1,
    isComplete: true,
    results: [{ origin: "https://router.example.test", status: "signed", accountResults: [] }],
  });

  assert.equal(report.status, "needs_attention");
  assert.equal(report.problemCount, 1);
  assert.match(report.summary, /需关注 1 个站点的账号明细：1 个账号未确认/);
});
