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
const helperPath = path.join(root, "scripts", "TaskRuntimeBudget.ps1");

async function inspectBudget(config, attempts = 0) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-runtime-budget-"));
  const scriptPath = path.join(directory, "inspect.ps1");
  const escapedHelper = helperPath.replace(/'/g, "''");
  const source = [
    "$ErrorActionPreference = 'Stop'",
    `. '${escapedHelper}'`,
    "$config = @'",
    JSON.stringify(config),
    "'@ | ConvertFrom-Json",
    `[pscustomobject]@{ preflightSeconds = Get-CheckinPreflightWaitSeconds $config; budgetMinutes = Get-CheckinTaskRuntimeBudgetMinutes $config ${attempts} } | ConvertTo-Json -Compress`,
  ].join("\r\n");
  try {
    await fs.writeFile(scriptPath, source, "utf8");
    const { stdout } = await execFileAsync(powershellExecutable, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
    ], { cwd: root, encoding: "utf8" });
    return JSON.parse(stdout.trim());
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const config = {
  taskTimeoutMinutes: 25,
  taskRunAttempts: 2,
  taskRetryDelayMinutes: 3,
  taskRuntimeBufferMinutes: 10,
  nativeWafPreflightUrls: [{ url: "https://one.example", waitSeconds: 35 }, { url: "https://two.example", waitSeconds: 15 }],
  nativeChallengePreflight: [{ url: "https://three.example", waitSeconds: 20 }, { url: "https://four.example", waitSeconds: 30 }],
};

test("运行时间预算覆盖重试、预热和收尾缓冲", async () => {
  const result = await inspectBudget(config);
  assert.deepEqual(result, { preflightSeconds: 200, budgetMinutes: 70 });
});

test("单轮调试运行仍按实际尝试次数计算预算", async () => {
  const result = await inspectBudget(config, 1);
  assert.deepEqual(result, { preflightSeconds: 200, budgetMinutes: 39 });
});

test("被动原生等待只计算一次，主动检查按内部双尝试计入预算", async () => {
  const result = await inspectBudget({
    ...config,
    nativeWafPreflightUrls: [{ url: "https://passive.example", waitSeconds: 30, passiveOnly: true }],
    nativeChallengePreflight: [{ url: "https://active.example", waitSeconds: 20 }],
  }, 1);
  assert.deepEqual(result, { preflightSeconds: 70, budgetMinutes: 37 });
});
