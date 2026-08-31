import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { powershellExecutable } from "./helpers/powershell.mjs";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const helperPath = path.join(root, "scripts", "ManualVerification.ps1");
const runnerPath = path.join(root, "scripts", "Run-Checkin.ps1");
const schedulerPath = path.join(root, "scripts", "Start-UserScheduler.ps1");
const closerPath = path.join(root, "scripts", "Close-ManualLogin.ps1");
const abandonmentHelperPath = path.join(root, "scripts", "ManualAbandonment.ps1");

const driverSource = String.raw`param(
    [string]$HelperPath,
    [string]$StatePath,
    [string]$ReportPath,
    [string]$RetryAt
)
. $HelperPath
$pendingBefore = Get-PendingManualVerification -Path $StatePath
$report = Get-Content -Raw -Encoding UTF8 -LiteralPath $ReportPath | ConvertFrom-Json
$update = Update-ManualVerificationState -Pending $pendingBefore -Report $report -Path $StatePath -RetryAt ([datetime]$RetryAt)
$pendingAfter = Get-PendingManualVerification -Path $StatePath
$afterOrigins = @()
if ($null -ne $pendingAfter) { $afterOrigins = @($pendingAfter.Origins) }
$handoffTargets = @(Get-ManualHandoffTargets -Report $report -Now ([datetime]$RetryAt))
$saved = Get-Content -Raw -Encoding UTF8 -LiteralPath $StatePath | ConvertFrom-Json
[ordered]@{
    beforeOrigins = @($pendingBefore.Origins)
    updated = [bool]$update.Updated
    complete = [bool]$update.Complete
    pendingOrigins = @($update.PendingOrigins)
    retryOrigins = @($update.RetryOrigins)
    afterOrigins = $afterOrigins
    handoffTargets = $handoffTargets
    saved = $saved
} | ConvertTo-Json -Depth 12 -Compress
`;

const currentDayDriverSource = String.raw`param(
    [string]$HelperPath,
    [string]$StatePath,
    [string]$Now
)
. $HelperPath
$state = Get-Content -Raw -Encoding UTF8 -LiteralPath $StatePath | ConvertFrom-Json
[ordered]@{
    current = Test-ManualVerificationCurrentDayDocument -Document $state -Now ([datetime]$Now)
} | ConvertTo-Json -Compress
`;

function pendingState(origins) {
  return {
    schemaVersion: 1,
    state: "pending_verification",
    authoritativeEvidenceRequired: true,
    targets: origins.map((origin) => ({
      origin,
      verificationStatus: "pending_verification",
    })),
  };
}

function finalReport(results) {
  return {
    runId: "20260728-130000",
    runState: "final",
    isComplete: true,
    plannedTotal: results.length,
    processedTotal: results.length,
    results,
  };
}

async function invokeStateMachine(state, report, retryAt = "2026-07-28T06:10:00Z") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "manual-verification-state-"));
  const statePath = path.join(directory, "state.json");
  const reportPath = path.join(directory, "report.json");
  const driverPath = path.join(directory, "driver.ps1");
  try {
    await fs.writeFile(statePath, JSON.stringify(state), "utf8");
    await fs.writeFile(reportPath, JSON.stringify(report), "utf8");
    await fs.writeFile(driverPath, driverSource, "utf8");
    const { stdout } = await execFileAsync(powershellExecutable, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", driverPath,
      "-HelperPath", helperPath,
      "-StatePath", statePath,
      "-ReportPath", reportPath,
      "-RetryAt", retryAt,
    ], { cwd: root, encoding: "utf8" });
    return JSON.parse(stdout.trim());
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function invokeCurrentDayCheck(state, now = "2026-08-26T04:00:00Z") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "manual-verification-date-"));
  const statePath = path.join(directory, "state.json");
  const driverPath = path.join(directory, "driver.ps1");
  try {
    await Promise.all([
      fs.writeFile(statePath, JSON.stringify(state), "utf8"),
      fs.writeFile(driverPath, currentDayDriverSource, "utf8"),
    ]);
    const { stdout } = await execFileAsync(powershellExecutable, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", driverPath,
      "-HelperPath", helperPath,
      "-StatePath", statePath,
      "-Now", now,
    ], { cwd: root, encoding: "utf8" });
    return JSON.parse(stdout.trim());
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function invokePartialAbandonment() {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "manual-partial-abandon-"));
  const scriptsDirectory = path.join(fixtureRoot, "scripts");
  const tmpDirectory = path.join(fixtureRoot, "tmp");
  try {
    await Promise.all([
      fs.mkdir(scriptsDirectory, { recursive: true }),
      fs.mkdir(tmpDirectory, { recursive: true }),
    ]);
    await Promise.all([
      fs.copyFile(closerPath, path.join(scriptsDirectory, "Close-ManualLogin.ps1")),
      fs.copyFile(abandonmentHelperPath, path.join(scriptsDirectory, "ManualAbandonment.ps1")),
      fs.writeFile(path.join(tmpDirectory, "manual-handoff.json"), "{}", "utf8"),
      fs.writeFile(path.join(tmpDirectory, "manual-session.json"), JSON.stringify({
        schemaVersion: 2,
        mode: "legacy",
        startedAt: "2026-08-25T01:00:00.000Z",
        sourceRunId: "20260825-090000",
        targetCount: 3,
        targets: [
          { origin: "https://one.example", previousStatus: "login_required" },
          { origin: "https://two.example", previousStatus: "no_action" },
          { origin: "https://three.example", previousStatus: "interactive_challenge" },
        ],
      }), "utf8"),
    ]);
    await execFileAsync(powershellExecutable, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.join(scriptsDirectory, "Close-ManualLogin.ps1"),
      "-Abandon", "-Selection", "2",
    ], { cwd: root, encoding: "utf8" });
    const [abandonment, verification, handoffPresent] = await Promise.all([
      fs.readFile(path.join(tmpDirectory, "manual-abandon.json"), "utf8").then(JSON.parse),
      fs.readFile(path.join(tmpDirectory, "manual-verification.json"), "utf8").then(JSON.parse),
      fs.access(path.join(tmpDirectory, "manual-handoff.json")).then(() => true, () => false),
    ]);
    return { abandonment, verification, handoffPresent };
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

test("部分人工复核成功后记录保持 pending，并只保留未终态 origin", async () => {
  const result = await invokeStateMachine(
    pendingState([
      "https://signed.example",
      "https://manual.example",
      "https://retry.example",
    ]),
    finalReport([
      { origin: "https://signed.example", status: "signed", reason: "authoritative" },
      { origin: "https://manual.example", status: "no_action", reason: "unresolved" },
      { origin: "https://retry.example", status: "error", reason: "retry" },
      { origin: "https://outside.example", status: "error", reason: "not selected" },
    ]),
  );

  assert.equal(result.updated, true);
  assert.equal(result.complete, false);
  assert.equal(result.saved.state, "pending_verification");
  assert.equal(result.saved.authoritativeEvidenceRequired, true);
  assert.deepEqual(result.pendingOrigins, ["https://manual.example", "https://retry.example"]);
  assert.deepEqual(result.afterOrigins, ["https://manual.example", "https://retry.example"]);
  assert.deepEqual(result.retryOrigins, ["https://retry.example"]);
});

test("只有所有人工 origin 都得到权威终态后才完成记录", async () => {
  const result = await invokeStateMachine(
    pendingState([
      "https://one.example",
      "https://two.example",
      "https://three.example",
    ]),
    finalReport([
      { origin: "https://one.example", status: "signed", reason: "signed" },
      { origin: "https://two.example", status: "already_signed", reason: "already" },
      { origin: "https://three.example", status: "not_available", reason: "authoritative absence" },
    ]),
  );

  assert.equal(result.updated, true);
  assert.equal(result.complete, true);
  assert.equal(result.saved.state, "verification_complete");
  assert.equal(result.saved.authoritativeEvidenceRequired, false);
  assert.deepEqual(result.pendingOrigins, []);
  assert.deepEqual(result.retryOrigins, []);
  assert.deepEqual(result.afterOrigins, []);
});

test("后续定向复核不会用合并报告降级已经权威确认的 origin", async () => {
  const state = pendingState([
    "https://done.example",
    "https://pending.example",
  ]);
  state.targets[0].verificationStatus = "signed";

  const result = await invokeStateMachine(
    state,
    finalReport([
      { origin: "https://done.example", status: "error", reason: "unrelated newer result" },
      { origin: "https://pending.example", status: "signed", reason: "authoritative" },
    ]),
  );

  assert.deepEqual(result.beforeOrigins, ["https://pending.example"]);
  assert.equal(result.updated, true);
  assert.equal(result.complete, true);
  assert.equal(result.saved.state, "verification_complete");
  assert.deepEqual(
    result.saved.targets.map(({ origin, verificationStatus }) => ({ origin, verificationStatus })),
    [
      { origin: "https://done.example", verificationStatus: "signed" },
      { origin: "https://pending.example", verificationStatus: "signed" },
    ],
  );
});

test("下一次任务级尝试只选择人工范围内当前可立即重试的 origin", async () => {
  const result = await invokeStateMachine(
    pendingState([
      "https://done.example",
      "https://due.example",
      "https://later.example",
    ]),
    finalReport([
      { origin: "https://done.example", status: "already_signed" },
      {
        origin: "https://due.example",
        status: "deferred",
        nextEligibleAt: "2026-07-28T06:05:00Z",
      },
      {
        origin: "https://later.example",
        status: "deferred",
        nextEligibleAt: "2026-07-28T07:00:00Z",
      },
      { origin: "https://outside.example", status: "error" },
    ]),
  );

  assert.deepEqual(result.retryOrigins, ["https://due.example"]);
  assert.deepEqual(result.pendingOrigins, ["https://due.example", "https://later.example"]);
  assert.ok(!result.retryOrigins.includes("https://done.example"));
  assert.ok(!result.retryOrigins.includes("https://outside.example"));
});

test("人工交接包含交互挑战和嵌套账号汇总的 needs_attention", async () => {
  const result = await invokeStateMachine(
    pendingState(["https://done.example"]),
    finalReport([
      { origin: "https://account.example", status: "needs_attention" },
      { origin: "https://challenge.example", status: "interactive_challenge" },
      { origin: "https://done.example", status: "signed" },
    ]),
  );

  assert.deepEqual(
    result.handoffTargets.map(({ origin, previousStatus }) => ({ origin, previousStatus })),
    [
      { origin: "https://account.example", previousStatus: "needs_attention" },
      { origin: "https://challenge.example", previousStatus: "interactive_challenge" },
    ],
  );
});

test("登录类 deferred 即使尚未到自动重试时间也会立即进入人工交接", async () => {
  const result = await invokeStateMachine(
    pendingState(["https://done.example"]),
    finalReport([
      {
        origin: "https://login.example",
        status: "deferred",
        retryCause: "login_required",
        nextEligibleAt: "2026-07-28T12:00:00Z",
      },
      {
        origin: "https://rate.example",
        status: "deferred",
        retryCause: "rate_limited",
        nextEligibleAt: "2026-07-28T12:00:00Z",
      },
      { origin: "https://done.example", status: "signed" },
    ]),
  );

  assert.deepEqual(
    result.handoffTargets.map(({ origin, previousStatus }) => ({ origin, previousStatus })),
    [{ origin: "https://login.example", previousStatus: "deferred" }],
  );
  assert.deepEqual(result.retryOrigins, []);
});

test("Run-Checkin 每轮落盘状态并用 RetryOrigins 缩小下一轮参数", async () => {
  const runner = await fs.readFile(runnerPath, "utf8");
  assert.match(runner, /Update-ManualVerificationState[\s\S]*?-RetryAt/);
  assert.match(runner, /\$manualVerification\.Origins = @\(\$manualAttemptUpdate\.RetryOrigins\)/);
  assert.match(runner, /--consume-manual-verification-subset/);
  assert.match(runner, /if \(\$null -ne \$manualVerification\)[\s\S]*?elseif \(\$null -ne \$resumeCandidate/);
});

test("Run-Checkin persists explicit origin-scoped authoritative verification", async () => {
  const runner = await fs.readFile(runnerPath, "utf8");
  assert.match(runner, /\[string\[\]\]\$Origins = @\(\)/);
  assert.match(runner, /function Resolve-RequestedCheckinOrigins/);
  assert.match(runner, /定向签到只接受无路径、查询参数或凭据的规范 HTTPS origin/);
  assert.match(runner, /Origins 不能与 Agent Router 的 ReauthAccountKey 同时使用/);
  assert.match(runner, /elseif \(\$requestedOrigins\.Count -gt 0\)[\s\S]*?'--origins', \(\$requestedOrigins -join ','\)/);
  assert.match(runner, /function Test-RequestedOriginsAuthoritativelyComplete/);
  assert.match(runner, /'signed', 'already_signed'/);
  assert.match(runner, /个定向站点已取得权威签到结果/);
});

test("manual verification blocks handoff only when all source evidence belongs to today in Shanghai", async () => {
  const current = await invokeCurrentDayCheck({
    sourceRunId: "20260826-110000",
    createdAt: "2026-08-26T03:05:00Z",
    sourceFinishedAt: "2026-08-26T03:00:00Z",
  });
  const stale = await invokeCurrentDayCheck({
    sourceRunId: "20260825-235900",
    createdAt: "2026-08-25T15:59:30Z",
    sourceFinishedAt: "2026-08-25T15:59:00Z",
  });
  const mismatchedRun = await invokeCurrentDayCheck({
    sourceRunId: "20260825-235900",
    createdAt: "2026-08-26T03:05:00Z",
    sourceFinishedAt: "2026-08-26T03:00:00Z",
  });

  assert.equal(current.current, true);
  assert.equal(stale.current, false);
  assert.equal(mismatchedRun.current, false);
});

test("automatic phase leaves a durable manual handoff and the scheduler consumes it", async () => {
  const runner = await fs.readFile(runnerPath, "utf8");
  const helper = await fs.readFile(helperPath, "utf8");
  const scheduler = await fs.readFile(schedulerPath, "utf8");
  assert.match(helper, /function Get-ManualHandoffTargets\(\$Report/);
  assert.match(runner, /manual-handoff\.json/);
  assert.match(runner, /Write-ManualHandoff \$freshCandidate\.Report/);
  assert.match(runner, /state = 'awaiting_manual_handoff'/);
  assert.match(runner, /if \(Test-Path -LiteralPath \$manualSessionPath\)/);
  assert.doesNotMatch(runner, /Test-PendingManualVerificationFile/);
  assert.doesNotMatch(runner, /Test-Path -LiteralPath \$manualSessionPath -or/);
  assert.match(scheduler, /manual-session\.json/);
  assert.match(scheduler, /manual-verification\.json/);
  assert.match(scheduler, /ManualVerification\.ps1/);
  assert.match(scheduler, /Test-ManualVerificationCurrentDayDocument \$verification \$Now/);
  assert.match(scheduler, /Mode = 'verification_ready'/);
  assert.match(scheduler, /Test-SchedulerWaiting \$state \$now \$config \$manualHandoff/);
  assert.match(scheduler, /lastManualVerificationChangedAt/);
});

test("manual abandonment closes without verification and suppresses only today's scheduled retry", async () => {
  const closer = await fs.readFile(closerPath, "utf8");
  const scheduler = await fs.readFile(schedulerPath, "utf8");
  assert.match(closer, /\[string\[\]\]\$Origins = @\(\)/);
  assert.match(closer, /\[int\[\]\]\$Selection = @\(\)/);
  assert.match(closer, /manual-abandon\.json/);
  assert.match(closer, /Write-ManualAbandonment/);
  assert.match(closer, /Set-ManualAbandonmentContinuation/);
  assert.match(scheduler, /ManualAbandonment\.ps1/);
  assert.match(scheduler, /Get-TodayAbandonedOrigins -Path \$manualAbandonPath -Now \$now/);
  assert.match(scheduler, /ConvertTo-ManualAbandonmentOrigin \$_\.origin/);
  assert.match(scheduler, /-not \$abandonedOrigins\.ContainsKey\(\$resultOrigin\)/);
});

test("partial abandonment keeps unselected manual targets pending verification", async () => {
  const result = await invokePartialAbandonment();
  assert.deepEqual(result.abandonment.origins, ["https://two.example"]);
  assert.equal(result.verification.state, "pending_verification");
  assert.deepEqual(
    result.verification.targets.map((target) => target.origin),
    ["https://one.example", "https://three.example"],
  );
  assert.equal(result.handoffPresent, false);
});

test("Run-Checkin 不会在人工复核目标已移出书签时静默成功", async () => {
  const runner = await fs.readFile(runnerPath, "utf8");
  const guardStart = runner.indexOf("if ($null -ne $manualVerification `");
  const successBreak = runner.indexOf("if ($nodeExitCode -eq 0) { break }", guardStart);
  const staleManualGuard = guardStart >= 0 && successBreak > guardStart
    ? runner.slice(guardStart, successBreak)
    : "";

  assert.match(staleManualGuard, /\$null -ne \$manualVerification/);
  assert.match(staleManualGuard, /Test-IsCompleteFinalReport \$freshCandidate\.Report/);
  assert.match(staleManualGuard, /-not \$manualAttemptUpdate\.Updated/);
  assert.match(staleManualGuard, /if \(\$nodeExitCode -eq 0\) \{ \$nodeExitCode = 2 \}/);
  assert.match(staleManualGuard, /\$runnerStatus = 'failed'/);
  assert.match(staleManualGuard, /可能有复核目标已移出书签范围/);
});
