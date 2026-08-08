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
$saved = Get-Content -Raw -Encoding UTF8 -LiteralPath $StatePath | ConvertFrom-Json
[ordered]@{
    beforeOrigins = @($pendingBefore.Origins)
    updated = [bool]$update.Updated
    complete = [bool]$update.Complete
    pendingOrigins = @($update.PendingOrigins)
    retryOrigins = @($update.RetryOrigins)
    afterOrigins = $afterOrigins
    saved = $saved
} | ConvertTo-Json -Depth 12 -Compress
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

test("Run-Checkin 每轮落盘状态并用 RetryOrigins 缩小下一轮参数", async () => {
  const runner = await fs.readFile(runnerPath, "utf8");
  assert.match(runner, /Update-ManualVerificationState[\s\S]*?-RetryAt/);
  assert.match(runner, /\$manualVerification\.Origins = @\(\$manualAttemptUpdate\.RetryOrigins\)/);
  assert.match(runner, /if \(\$null -ne \$manualVerification\)[\s\S]*?elseif \(\$null -ne \$resumeCandidate/);
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
