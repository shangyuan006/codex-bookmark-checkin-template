import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { powershellExecutable } from "./helpers/powershell.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);
const dependencies = ["Run-Checkin", "Resolve-Runtime", "RunLock", "ManualVerification", "ResultContract",
  "ManualAbandonment", "NativeFallbackPolicy", "PreflightScope", "CheckinCycle", "TaskRetryPolicy", "TaskRuntimeBudget"];

const workerSource = String.raw`
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const observationsPath = path.join(root, 'tmp', 'observations.json');
const observations = await fs.readFile(observationsPath, 'utf8').then(JSON.parse).catch(() => []);
const handoffVisible = await fs.access(path.join(root, 'tmp', 'manual-handoff.json')).then(() => true).catch(() => false);
observations.push({ attempt: observations.length + 1, handoffVisible });
await fs.writeFile(observationsPath, JSON.stringify(observations));
const config = JSON.parse(await fs.readFile(path.join(root, 'config', 'config.json'), 'utf8'));
const status = observations.length === 1 ? 'login_required' : config.fixtureFinalStatus;
const now = new Date();
const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((value, index) => index ? String(value).padStart(2, '0') : value).join('');
const report = { runId: date + '-10000' + observations.length, planFingerprint: 'a'.repeat(64),
  runState: 'final', isComplete: true, plannedTotal: 1, processedTotal: 1, finishedAt: now.toISOString(),
  results: [{ origin: 'https://fixture.test', status, retryable: true }] };
await fs.mkdir(path.join(root, 'logs'), { recursive: true });
await fs.writeFile(path.join(root, 'logs', 'latest.json'), JSON.stringify(report));
process.exitCode = status === 'signed' ? 0 : 2;
`;

const dispatcherSource = String.raw`
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -LiteralPath (Join-Path $root 'config/config.json') | ConvertFrom-Json
$runMutex = [System.Threading.Mutex]::new($false, [string]$config.runMutexName)
$owned = $false
try {
    $owned = $runMutex.WaitOne(0)
    $observations = @(Get-Content -Raw -LiteralPath (Join-Path $root 'tmp/observations.json') | ConvertFrom-Json)
    @{ attempts = $observations.Count; wrapperLockReleased = $owned } | ConvertTo-Json -Compress |
        Set-Content -LiteralPath (Join-Path $root 'tmp/dispatch-observation.json') -Encoding utf8
}
finally {
    if ($owned) { [void]$runMutex.ReleaseMutex() }
    $runMutex.Dispose()
}
`;

async function runFixture(finalStatus, manualOpen = false) {
  const tmpRoot = path.join(root, "tmp");
  await fs.mkdir(tmpRoot, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(tmpRoot, "handoff-order-"));
  try {
    for (const folder of ["scripts", "src", "config", "tmp"]) await fs.mkdir(path.join(fixture, folder));
    for (const name of dependencies) {
      await fs.copyFile(path.join(root, "scripts", `${name}.ps1`), path.join(fixture, "scripts", `${name}.ps1`));
    }
    await fs.writeFile(path.join(fixture, "src", "index.mjs"), workerSource);
    await fs.writeFile(path.join(fixture, "src", "current-plan.mjs"),
      "import fs from 'node:fs'; fs.writeFileSync('tmp/plan-invoked.json', 'true'); console.log(JSON.stringify({planFingerprint:'a'.repeat(64)}));");
    await fs.writeFile(path.join(fixture, "scripts", "Start-UserScheduler.ps1"), dispatcherSource);
    await fs.writeFile(path.join(fixture, "config", "config.json"), JSON.stringify({
      nodeExecutable: process.execPath, runMutexName: `Local\\CheckinFixture-${randomUUID()}`,
      taskTimeoutMinutes: 5, taskRunAttempts: 2, taskRetryDelayMinutes: 0,
      nativeWafPreflightUrls: [], nativeChallengePreflight: [], syncBookmarkSavedLogins: false,
      fixtureFinalStatus: finalStatus,
    }));
    if (manualOpen) await fs.writeFile(path.join(fixture, "tmp", "manual-session.json"), "{}");
    const execution = await execFileAsync(powershellExecutable, ["-NoProfile", "-NonInteractive", "-File",
      path.join(fixture, "scripts", "Run-Checkin.ps1"), "-Attempts", "2", "-SuppressReport", "-DispatchManualHandoff"],
    { cwd: fixture, encoding: "utf8", timeout: 20_000 }).catch((error) => {
      if (error.code !== 2) throw error;
      return { stdout: error.stdout };
    });
    const read = (name) => fs.readFile(path.join(fixture, "tmp", name), "utf8").then(JSON.parse).catch(() => null);
    let dispatch = null;
    if (!manualOpen && finalStatus !== "signed") {
      const deadline = Date.now() + 5_000;
      do {
        dispatch = await read("dispatch-observation.json");
        if (dispatch) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
    }
    return { observations: await read("observations.json"), handoff: await read("manual-handoff.json"),
      planInvoked: await read("plan-invoked.json"), dispatch, stdout: execution.stdout };
  } finally {
    await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("automatic retries finish before creating or dispatching manual handoff", async () => {
  const result = await runFixture("login_required");
  assert.equal(result.planInvoked, true);
  assert.deepEqual(result.observations, [{ attempt: 1, handoffVisible: false }, { attempt: 2, handoffVisible: false }]);
  assert.equal(result.handoff.sourceRunId.endsWith("100002"), true);
  assert.deepEqual(result.dispatch, { attempts: 2, wrapperLockReleased: true });
});

test("successful automatic retry does not dispatch the first attempt's stale handoff", async () => {
  const result = await runFixture("signed");
  assert.equal(result.observations.length, 2);
  assert.equal(result.observations[1].handoffVisible, false);
  assert.equal(result.handoff, null);
  assert.equal(result.dispatch, null);
});

test("an active manual browser session blocks automatic attempts without replacing reports", async () => {
  const result = await runFixture("signed", true);
  assert.equal(result.planInvoked, null);
  assert.equal(result.observations, null);
  assert.equal(result.handoff, null);
  assert.equal(result.dispatch, null);
});

const launchDriverSource = String.raw`
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$fixtureScripts = Join-Path $root 'scripts'
. (Join-Path $fixtureScripts 'ManualVerification.ps1')
$config = Get-Content -Raw -LiteralPath (Join-Path $root 'config/config.json') | ConvertFrom-Json
$manualSessionPath = Join-Path $root 'tmp/manual-session.json'
$manualLaunchPath = Join-Path $root 'tmp/manual-handoff-launch.json'
$schedulerAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $fixtureScripts 'Start-UserScheduler.ps1'), [ref]$null, [ref]$null)
$dispatcher = $schedulerAst.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Start-ManualHandoffActions' }, $false)
Invoke-Expression ($dispatcher.Extent.Text.Replace('$PSScriptRoot', '$fixtureScripts'))
function Get-AgentRouterManualAction { return $null }
function Test-ManualHandoffHasNonAgentTargets { return $true }
function Write-SchedulerLog { }
function Wait-FixtureFile([string]$Path) {
    $deadline = (Get-Date).AddSeconds(10)
    while (-not (Test-Path -LiteralPath $Path)) {
        if ((Get-Date) -ge $deadline) { throw 'fixture startup timeout' }
        Start-Sleep -Milliseconds 25
    }
}
$handoff = [pscustomobject]@{ Mode = 'awaiting_manual_handoff'; SourceRunId = 'fixture'; Targets = @() }
$launchProcess = $null
try {
    Start-ManualHandoffActions $handoff $config
    $reservation = Get-Content -Raw -LiteralPath $manualLaunchPath | ConvertFrom-Json
    $launchProcess = Get-Process -Id $reservation.processId
    $reservedActive = Test-ManualHandoffLaunchActive $manualLaunchPath
    $shell = (Get-Command pwsh,powershell | Select-Object -First 1).Source
    $guardOutput = @(& $shell -NoProfile -NonInteractive -File (Join-Path $fixtureScripts 'Run-Checkin.ps1') -SuppressReport)
    Start-ManualHandoffActions $handoff $config
    $sameReservation = [string](Get-Content -Raw -LiteralPath $manualLaunchPath | ConvertFrom-Json).launchId -eq [string]$reservation.launchId
    [System.IO.File]::WriteAllText((Join-Path $root 'tmp/launch-permit.signal'), 'true')
    Wait-FixtureFile (Join-Path $root 'tmp/helper-ready.signal')
    $probeMutex = [System.Threading.Mutex]::new($false, [string]$config.runMutexName)
    $owned = $false
    try {
        $owned = $probeMutex.WaitOne(0)
        $helperOwnsMutex = -not $owned
    }
    finally {
        if ($owned) { [void]$probeMutex.ReleaseMutex() }
        $probeMutex.Dispose()
    }
    & $shell -NoProfile -NonInteractive -File (Join-Path $fixtureScripts 'Run-Checkin.ps1') -SuppressReport | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $root 'tmp/helper-release.signal'), 'true')
    if (-not $launchProcess.WaitForExit(10000)) { throw 'fixture exit timeout' }
    $reservationCleared = -not (Test-Path -LiteralPath $manualLaunchPath)
    $manualSessionReady = Test-Path -LiteralPath $manualSessionPath
    $automaticPlanStarted = Test-Path -LiteralPath (Join-Path $root 'tmp/plan-invoked.json')
    $probeMutex = [System.Threading.Mutex]::new($false, [string]$config.runMutexName)
    $released = $probeMutex.WaitOne(0)
    if ($released) { [void]$probeMutex.ReleaseMutex() }
    $probeMutex.Dispose()
    $id = [guid]::NewGuid().ToString('N')
    Write-ManualHandoffLaunch $manualLaunchPath $id
    $selfActive = Test-ManualHandoffLaunchActive $manualLaunchPath
    Remove-ManualHandoffLaunch $manualLaunchPath ([guid]::NewGuid().ToString('N'))
    $differentLaunchPreserved = Test-Path -LiteralPath $manualLaunchPath
    $stale = Get-Content -Raw -LiteralPath $manualLaunchPath | ConvertFrom-Json
    $stale.processStartedAt = ([datetime]$stale.processStartedAt).AddSeconds(-10).ToString('o')
    [System.IO.File]::WriteAllText($manualLaunchPath, ($stale | ConvertTo-Json -Compress))
    $reusedPidActive = Test-ManualHandoffLaunchActive $manualLaunchPath
    $stale.processId = 2147483647
    [System.IO.File]::WriteAllText($manualLaunchPath, ($stale | ConvertTo-Json -Compress))
    $deadProcessActive = Test-ManualHandoffLaunchActive $manualLaunchPath
    [System.IO.File]::WriteAllText($manualLaunchPath, '{')
    $malformedActive = Test-ManualHandoffLaunchActive $manualLaunchPath
    [ordered]@{ reservedActive = $reservedActive; guardWarned = ($guardOutput -join '') -match '人工浏览器';
        sameReservation = $sameReservation; helperOwnsMutex = $helperOwnsMutex; reservationCleared = $reservationCleared;
        manualSessionReady = $manualSessionReady; automaticPlanStarted = $automaticPlanStarted; mutexReleased = $released;
        selfActive = $selfActive; differentLaunchPreserved = $differentLaunchPreserved;
        reusedPidActive = $reusedPidActive; deadProcessActive = $deadProcessActive; malformedActive = $malformedActive } |
        ConvertTo-Json -Compress
}
finally {
    if ($launchProcess -and -not $launchProcess.HasExited) {
        $launchProcess.Kill()
        [void]$launchProcess.WaitForExit(5000)
    }
}
`;

async function runLaunchFixture(fail = false) {
  const tmpRoot = path.join(root, "tmp");
  await fs.mkdir(tmpRoot, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(tmpRoot, "handoff-launch-"));
  try {
    for (const folder of ["scripts", "src", "config", "tmp"]) await fs.mkdir(path.join(fixture, folder));
    for (const name of [...dependencies, "Start-UserScheduler"]) {
      await fs.copyFile(path.join(root, "scripts", `${name}.ps1`), path.join(fixture, "scripts", `${name}.ps1`));
    }
    const manual = await fs.readFile(path.join(root, "scripts", "Open-ManualLogin.ps1"), "utf8");
    await fs.writeFile(path.join(fixture, "scripts", "Open-ManualLogin.ps1"), manual.replace("$ErrorActionPreference = 'Stop'",
      "$ErrorActionPreference = 'Stop'\nwhile (-not (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'tmp/launch-permit.signal'))) { Start-Sleep -Milliseconds 25 }"));
    await fs.writeFile(path.join(fixture, "scripts", "Resolve-Runtime.ps1"), String.raw`
function Resolve-CheckinNode($Config) { return $Config.nodeExecutable }
function Get-CheckinAutomationBrowserProcesses { return @() }
`);
    await fs.writeFile(path.join(fixture, "scripts", "Open-PlainLoginChrome.ps1"), String.raw`
param([switch]$NativeMinimal, [switch]$TrackManualSession)
$root = Split-Path -Parent $PSScriptRoot
[System.IO.File]::WriteAllText((Join-Path $root 'tmp/helper-ready.signal'), 'true')
while (-not (Test-Path -LiteralPath (Join-Path $root 'tmp/helper-release.signal'))) { Start-Sleep -Milliseconds 25 }
$config = Get-Content -Raw -LiteralPath (Join-Path $root 'config/config.json') | ConvertFrom-Json
if ($config.fixtureFail) { throw 'expected simulated launch failure' }
[System.IO.File]::WriteAllText((Join-Path $root 'tmp/manual-session.json'), '{}')
`);
    await fs.writeFile(path.join(fixture, "src", "current-plan.mjs"),
      "import fs from 'node:fs'; fs.writeFileSync('tmp/plan-invoked.json', 'true'); console.log('{}');");
    await fs.writeFile(path.join(fixture, "config", "config.json"), JSON.stringify({
      nodeExecutable: process.execPath, runMutexName: `Local\\CheckinLaunchFixture-${randomUUID()}`, fixtureFail: fail,
    }));
    await fs.writeFile(path.join(fixture, "driver.ps1"), launchDriverSource);
    const { stdout } = await execFileAsync(powershellExecutable, ["-NoProfile", "-NonInteractive", "-File", path.join(fixture, "driver.ps1")],
      { cwd: fixture, encoding: "utf8", timeout: 30_000 });
    return JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
  } finally {
    await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

for (const fail of [false, true]) {
  test(`manual launch reservation blocks automatic work and releases after ${fail ? "failure" : "session creation"}`, async () => {
    assert.deepEqual(await runLaunchFixture(fail), {
      reservedActive: true, guardWarned: true, sameReservation: true, helperOwnsMutex: true,
      reservationCleared: true, manualSessionReady: !fail, automaticPlanStarted: false, mutexReleased: true,
      selfActive: true, differentLaunchPreserved: true, reusedPidActive: false, deadProcessActive: false, malformedActive: true,
    });
  });
}
