import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildCurrentPlan, loadCurrentPlan } from "../src/current-plan.mjs";
import { powershellExecutable } from "./helpers/powershell.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const healthScript = path.join(root, "scripts", "Test-CheckinHealth.ps1");

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runHealth(fixtureRoot, { mockWindowsState = false } = {}) {
  const prelude = mockWindowsState ? [
    "function Get-ScheduledTask { [CmdletBinding()] param([string]$TaskName) [pscustomobject]@{ State = 'Ready' } }",
    "function Get-CimInstance { [CmdletBinding()] param([string]$ClassName) @() }",
    "function Get-ItemProperty { [CmdletBinding()] param([string]$Path) [pscustomobject]@{} }",
  ] : [];
  const command = [
    ...prelude,
    `& ${quotePowerShell(healthScript)} -Root ${quotePowerShell(fixtureRoot)}`,
    "exit $LASTEXITCODE",
  ].join("\r\n");
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  const result = spawnSync(powershellExecutable, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded,
  ], { cwd: root, encoding: "utf8" });
  return {
    exitCode: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    report: result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null,
  };
}

async function createFixture() {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bookmark-health-contract-"));
  const configDirectory = path.join(fixtureRoot, "config");
  const dataDirectory = path.join(fixtureRoot, "data");
  const logsDirectory = path.join(fixtureRoot, "logs");
  const automationDirectory = path.join(dataDirectory, "edge-user-data");
  await Promise.all([
    fs.mkdir(configDirectory, { recursive: true }),
    fs.mkdir(logsDirectory, { recursive: true }),
    fs.mkdir(automationDirectory, { recursive: true }),
  ]);
  const bookmarksPath = path.join(fixtureRoot, "Bookmarks");
  const browserExecutable = path.join(fixtureRoot, "msedge.exe");
  await fs.writeFile(bookmarksPath, JSON.stringify({
    roots: {
      bookmark_bar: {
        type: "folder",
        name: "Bookmarks bar",
        children: [{
          type: "folder",
          id: "100",
          name: "Daily",
          children: [{
            type: "folder",
            name: "AI",
            children: [{ type: "url", name: "One", url: "https://one.test/checkin" }],
          }],
        }],
      },
    },
  }), "utf8");
  await Promise.all([
    fs.writeFile(browserExecutable, "", "utf8"),
    fs.writeFile(path.join(automationDirectory, "Local State"), "{}", "utf8"),
    fs.writeFile(path.join(dataDirectory, "site-state.json"), "{}", "utf8"),
    fs.writeFile(path.join(dataDirectory, "scheduler-heartbeat.json"), JSON.stringify({
      phase: "idle",
      updatedAt: new Date().toISOString(),
    }), "utf8"),
  ]);
  const config = {
    browser: "edge",
    browserExecutable,
    browserProcessName: "msedge.exe",
    bookmarksPath,
    automationUserDataDir: automationDirectory,
    nodeExecutable: process.execPath,
    mobileFolderNames: ["Daily"],
    targetFolderNames: ["AI"],
    minimumBookmarkTargetCount: 1,
    schedule: "08:05",
    schedulerTaskName: "HealthContractTest",
    schedulerRunKeyName: "HealthContractTest",
    taskTimeoutMinutes: 1,
    taskRuntimeBufferMinutes: 1,
    taskRunAttempts: 1,
    reauthCheckinRules: {
      "https://one.test": { enabled: true },
    },
    agentrouterAccounts: [
      { origin: "https://one.test", accountId: "github", provider: "GitHub" },
      { origin: "https://one.test", accountId: "linuxdo", provider: "LinuxDO" },
    ],
    notification: { mode: "none" },
  };
  await fs.writeFile(path.join(configDirectory, "config.json"), JSON.stringify(config), "utf8");
  const runId = `${new Date().toLocaleDateString("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit",
  }).replaceAll("-", "")}-120000`;
  await fs.writeFile(path.join(logsDirectory, "latest.json"), JSON.stringify({
    runId,
    runState: "final",
    plannedTotal: 1,
    processedTotal: 1,
    isComplete: true,
    results: [{
      origin: "https://one.test",
      status: "signed",
      accountResults: [
        { accountId: "github", provider: "GitHub", status: "signed" },
        { accountId: "linuxdo", provider: "LinuxDO", status: "already_signed" },
      ],
    }],
  }), "utf8");
  return fixtureRoot;
}

test("current plan keeps Agent Router accounts nested under one planned bookmark target", () => {
  const current = buildCurrentPlan({
    targets: [
      { origin: "https://router.test" },
      { origin: "https://other.test" },
    ],
  }, {
    reauthCheckinRules: {
      "https://router.test": { enabled: true },
    },
    agentrouterAccounts: [
      { origin: "https://router.test", accountId: "github", provider: "GitHub" },
      { origin: "https://router.test", accountId: "Linux.DO", provider: "LinuxDO" },
    ],
  });

  assert.equal(current.targetCount, 2);
  assert.deepEqual(current.identities, [
    "https://other.test",
    "https://router.test",
  ]);
  assert.equal(current.accountGroupCount, 1);
  assert.equal(current.accountIdentityCount, 2);
  assert.deepEqual(current.accountGroups, [{
    origin: "https://router.test",
    identities: [
      "https://router.test#account=github",
      "https://router.test#account=linux-do",
    ],
    accounts: [
      { identity: "https://router.test#account=github", provider: "GitHub" },
      { identity: "https://router.test#account=linux-do", provider: "LinuxDO" },
    ],
  }]);
});

test("current plan rejects duplicate account identities", () => {
  assert.throws(() => buildCurrentPlan({
    targets: [{ origin: "https://router.test" }],
  }, {
    reauthCheckinRules: { "https://router.test": { enabled: true } },
    agentrouterAccounts: [
      { origin: "https://router.test", accountId: "github" },
      { origin: "https://router.test", accountId: "github" },
    ],
  }), /duplicate accountKey/);
});

test("current plan includes the runner's default nested reauth account", () => {
  const current = buildCurrentPlan({
    targets: [{ origin: "https://router.test" }],
  }, {
    reauthCheckinRules: { "https://router.test": { enabled: true, provider: "GitHub" } },
    agentrouterAccounts: [],
  });

  assert.equal(current.targetCount, 1);
  assert.deepEqual(current.accountGroups, [{
    origin: "https://router.test",
    identities: ["https://router.test#account=default"],
    accounts: [{ identity: "https://router.test#account=default", provider: "GitHub" }],
  }]);
});

test("health contract returns exit 2 when setup is missing", async (context) => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bookmark-health-missing-"));
  context.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  const result = runHealth(fixtureRoot);

  assert.equal(result.exitCode, 2, result.stderr);
  assert.equal(result.report.schemaVersion, 1);
  assert.equal(result.report.healthy, false);
  assert.equal(result.report.reason, "not_initialized");
  assert.deepEqual(result.report.failedChecks, ["configPresent"]);
  assert.ok(Number.isFinite(Date.parse(result.report.checkedAt)));
});

test("health contract returns exit 3 for execution failures without exposing the exception", async (context) => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bookmark-health-error-"));
  context.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(fixtureRoot, "config"), { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, "config", "config.json"), "{invalid", "utf8");
  const result = runHealth(fixtureRoot);

  assert.equal(result.exitCode, 3, result.stderr);
  assert.equal(result.report.schemaVersion, 1);
  assert.equal(result.report.reason, "health_check_error");
  assert.deepEqual(result.report.failedChecks, ["healthCheckExecution"]);
  assert.equal(Object.hasOwn(result.report, "error"), false);
});

test("health contract returns exit 0 only for today's complete result matching the active Edge bookmark plan", async (context) => {
  const fixtureRoot = await createFixture();
  context.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  const result = runHealth(fixtureRoot, { mockWindowsState: true });

  assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.report.schemaVersion, 1);
  assert.equal(result.report.healthy, true);
  assert.equal(result.report.reason, "ok");
  assert.deepEqual(result.report.failedChecks, []);
  assert.equal(result.report.browser, "edge");
  assert.equal(result.report.browserProcessName, "msedge.exe");
  assert.equal(result.report.currentPlanMatchesLatest, true);
  assert.equal(result.report.currentPlannedTotal, 1);
  assert.equal(result.report.latestPlannedTotal, 1);
  assert.equal(result.report.currentAccountIdentityCount, 2);
  assert.equal(result.report.latestAccountIdentityCount, 2);
  assert.equal(result.report.checks.latestRunToday, true);
  assert.equal(result.report.checks.latestResultComplete, true);
  assert.equal(result.report.checks.latestAccountResultsConfirmed, true);
  assert.equal(result.report.checks.latestResultConfirmed, true);
});

test("health contract returns exit 2 when the latest result no longer matches bookmarks", async (context) => {
  const fixtureRoot = await createFixture();
  context.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  const latestPath = path.join(fixtureRoot, "logs", "latest.json");
  const latest = JSON.parse(await fs.readFile(latestPath, "utf8"));
  latest.results = [{ origin: "https://removed.test", status: "signed" }];
  await fs.writeFile(latestPath, JSON.stringify(latest), "utf8");
  const result = runHealth(fixtureRoot, { mockWindowsState: true });

  assert.equal(result.exitCode, 2, result.stderr);
  assert.equal(result.report.reason, "checks_failed");
  assert.equal(result.report.currentPlanMatchesLatest, false);
  assert.ok(result.report.failedChecks.includes("latestMatchesCurrentPlan"));
  assert.ok(result.report.failedChecks.includes("latestResultConfirmed"));
});

test("health contract rejects a missing nested Agent Router account result", async (context) => {
  const fixtureRoot = await createFixture();
  context.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  const latestPath = path.join(fixtureRoot, "logs", "latest.json");
  const latest = JSON.parse(await fs.readFile(latestPath, "utf8"));
  latest.results[0].accountResults.pop();
  await fs.writeFile(latestPath, JSON.stringify(latest), "utf8");
  const result = runHealth(fixtureRoot, { mockWindowsState: true });

  assert.equal(result.exitCode, 2, result.stderr);
  assert.equal(result.report.currentPlannedTotal, 1);
  assert.equal(result.report.currentPlanMatchesLatest, false);
  assert.equal(result.report.checks.latestAccountResultsConfirmed, false);
  assert.ok(result.report.failedChecks.includes("latestMatchesCurrentPlan"));
  assert.ok(result.report.failedChecks.includes("latestAccountResultsConfirmed"));
});

test("health contract rejects a top-level status inconsistent with nested accounts", async (context) => {
  const fixtureRoot = await createFixture();
  context.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  const latestPath = path.join(fixtureRoot, "logs", "latest.json");
  const latest = JSON.parse(await fs.readFile(latestPath, "utf8"));
  latest.results[0].status = "already_signed";
  await fs.writeFile(latestPath, JSON.stringify(latest), "utf8");
  const result = runHealth(fixtureRoot, { mockWindowsState: true });

  assert.equal(result.exitCode, 2, result.stderr);
  assert.equal(result.report.latestProblemCount, 0);
  assert.equal(result.report.latestAccountAggregateMismatchCount, 1);
  assert.equal(result.report.currentPlanMatchesLatest, false);
  assert.equal(result.report.checks.latestAccountResultsConfirmed, false);
});

test("health contract rejects a nested account result from a different OAuth provider", async (context) => {
  const fixtureRoot = await createFixture();
  context.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  const latestPath = path.join(fixtureRoot, "logs", "latest.json");
  const latest = JSON.parse(await fs.readFile(latestPath, "utf8"));
  latest.results[0].accountResults[0].provider = "LinuxDO";
  await fs.writeFile(latestPath, JSON.stringify(latest), "utf8");

  const result = runHealth(fixtureRoot, { mockWindowsState: true });
  assert.equal(result.exitCode, 2, result.stderr);
  assert.equal(result.report.latestAccountPlanMismatchCount, 1);
  assert.equal(result.report.currentPlanMatchesLatest, false);
  assert.equal(result.report.checks.latestAccountResultsConfirmed, false);
});

test("health contract rejects a result URL masquerading as a canonical origin", async (context) => {
  const fixtureRoot = await createFixture();
  context.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  const latestPath = path.join(fixtureRoot, "logs", "latest.json");
  const latest = JSON.parse(await fs.readFile(latestPath, "utf8"));
  latest.results[0].origin = "https://one.test/private?account=github";
  await fs.writeFile(latestPath, JSON.stringify(latest), "utf8");

  const result = runHealth(fixtureRoot, { mockWindowsState: true });
  assert.equal(result.exitCode, 2, result.stderr);
  assert.equal(result.report.currentPlanMatchesLatest, false);
  assert.equal(result.report.checks.latestMatchesCurrentPlan, false);
  assert.equal(result.report.checks.latestAccountResultsConfirmed, false);
});

test("health rejects nested account results left after reauth is removed", async (context) => {
  const fixtureRoot = await createFixture();
  context.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  const configPath = path.join(fixtureRoot, "config", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.reauthCheckinRules = {};
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");

  const result = runHealth(fixtureRoot, { mockWindowsState: true });
  assert.equal(result.exitCode, 2, result.stderr);
  assert.equal(result.report.currentAccountIdentityCount, 0);
  assert.equal(result.report.latestAccountIdentityCount, 2);
  assert.equal(result.report.currentPlanMatchesLatest, false);
  assert.equal(result.report.checks.latestAccountResultsConfirmed, false);
  assert.ok(result.report.failedChecks.includes("latestMatchesCurrentPlan"));
});

test("health rejects accountResults on an ordinary target even when the array is empty", async (context) => {
  const fixtureRoot = await createFixture();
  context.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  const configPath = path.join(fixtureRoot, "config", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.configuredTargets = [{
    title: "Plain",
    url: "https://plain.test/checkin",
    folderName: "AI",
  }];
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");

  const latestPath = path.join(fixtureRoot, "logs", "latest.json");
  const latest = JSON.parse(await fs.readFile(latestPath, "utf8"));
  latest.plannedTotal = 2;
  latest.processedTotal = 2;
  latest.results.push({
    origin: "https://plain.test",
    status: "signed",
    accountResults: [],
  });
  await fs.writeFile(latestPath, JSON.stringify(latest), "utf8");

  const result = runHealth(fixtureRoot, { mockWindowsState: true });
  assert.equal(result.exitCode, 2, result.stderr);
  assert.equal(result.report.currentPlannedTotal, 2);
  assert.equal(result.report.latestPlannedTotal, 2);
  assert.equal(result.report.latestAccountProblemCount, 0);
  assert.equal(result.report.currentPlanMatchesLatest, false);
  assert.equal(result.report.checks.latestAccountResultsConfirmed, false);
});

test("health rejects duplicate top-level results even when identities deduplicate", async (context) => {
  const fixtureRoot = await createFixture();
  context.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  const latestPath = path.join(fixtureRoot, "logs", "latest.json");
  const latest = JSON.parse(await fs.readFile(latestPath, "utf8"));
  latest.results.push(structuredClone(latest.results[0]));
  await fs.writeFile(latestPath, JSON.stringify(latest), "utf8");

  const result = runHealth(fixtureRoot, { mockWindowsState: true });
  assert.equal(result.exitCode, 2, result.stderr);
  assert.equal(result.report.checks.latestResultComplete, false);
  assert.equal(result.report.checks.latestMatchesCurrentPlan, false);
  assert.equal(result.report.checks.latestResultConfirmed, false);
});

test("health validates every required bookmark source and accepts an independent backup", async (context) => {
  const fixtureRoot = await createFixture();
  context.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  const secondPath = path.join(fixtureRoot, "SecondBookmarks");
  await fs.writeFile(`${secondPath}.bak`, JSON.stringify({
    roots: {
      bookmark_bar: {
        type: "folder",
        name: "Second Root",
        children: [{
          type: "folder",
          id: "200",
          name: "Second Daily",
          children: [{ type: "url", name: "Two", url: "https://two.test/checkin" }],
        }],
      },
    },
  }), "utf8");

  const configPath = path.join(fixtureRoot, "config", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.additionalBookmarkSources = [{
    name: "Second",
    path: secondPath,
    mobileFolderNames: ["Second Root"],
    targetFolderNames: ["Second Daily"],
  }, {
    name: "Optional",
    path: path.join(fixtureRoot, "OptionalMissing"),
    optional: true,
    mobileFolderNames: ["Optional Root"],
    targetFolderNames: ["Optional Daily"],
  }];
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");

  const latestPath = path.join(fixtureRoot, "logs", "latest.json");
  const latest = JSON.parse(await fs.readFile(latestPath, "utf8"));
  latest.plannedTotal = 2;
  latest.processedTotal = 2;
  latest.results.push({ origin: "https://two.test", status: "already_signed" });
  await fs.writeFile(latestPath, JSON.stringify(latest), "utf8");

  const directPlan = await loadCurrentPlan(fixtureRoot);
  assert.equal(directPlan.targetCount, 2);
  const healthy = runHealth(fixtureRoot, { mockWindowsState: true });
  assert.equal(healthy.exitCode, 0, `${healthy.stdout}\n${healthy.stderr}`);
  assert.equal(healthy.report.checks.bookmarksReadable, true);

  await fs.unlink(`${secondPath}.bak`);
  const missingRequired = runHealth(fixtureRoot, { mockWindowsState: true });
  assert.equal(missingRequired.exitCode, 2, missingRequired.stderr);
  assert.equal(missingRequired.report.checks.bookmarksReadable, false);
  assert.ok(missingRequired.report.failedChecks.includes("bookmarksReadable"));
});

test("health accepts bookmarksPath source arrays with per-source scope", async (context) => {
  const fixtureRoot = await createFixture();
  context.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  const configPath = path.join(fixtureRoot, "config", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const primaryPath = config.bookmarksPath;
  const secondPath = path.join(fixtureRoot, "ArraySecondBookmarks");
  await fs.writeFile(`${secondPath}.bak`, JSON.stringify({
    roots: {
      bookmark_bar: {
        type: "folder",
        name: "Array Root",
        children: [{
          type: "folder",
          id: "300",
          name: "Array Daily",
          children: [{ type: "url", name: "Array", url: "https://array.test/checkin" }],
        }],
      },
    },
  }), "utf8");
  config.bookmarksPath = [{
    name: "Primary",
    path: primaryPath,
    mobileFolderNames: ["Daily"],
    targetFolderNames: ["AI"],
  }, {
    name: "Second",
    path: secondPath,
    mobileFolderNames: ["Array Root"],
    targetFolderNames: ["Array Daily"],
  }, {
    name: "Optional",
    path: path.join(fixtureRoot, "ArrayOptionalMissing"),
    optional: true,
    mobileFolderNames: ["Optional Root"],
    targetFolderNames: ["Optional Daily"],
  }];
  config.additionalBookmarkSources = [];
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");

  const latestPath = path.join(fixtureRoot, "logs", "latest.json");
  const latest = JSON.parse(await fs.readFile(latestPath, "utf8"));
  latest.plannedTotal = 2;
  latest.processedTotal = 2;
  latest.results.push({ origin: "https://array.test", status: "already_signed" });
  await fs.writeFile(latestPath, JSON.stringify(latest), "utf8");

  const result = runHealth(fixtureRoot, { mockWindowsState: true });
  assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.report.checks.bookmarksReadable, true);
  assert.equal(result.report.currentPlannedTotal, 2);
});

test("health implementation keeps the runtime budget and browser-neutral contract", async () => {
  const [source, packageJson] = await Promise.all([
    fs.readFile(healthScript, "utf8"),
    fs.readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
  ]);
  assert.match(source, /TaskRuntimeBudget\.ps1/);
  assert.match(source, /Get-CheckinTaskRuntimeBudgetMinutes/);
  assert.match(source, /browserExecutable/);
  assert.match(source, /browserProcessName/);
  assert.doesNotMatch(source, /chromeExecutablePresent/);
  assert.doesNotMatch(source, /SHA256\]::HashData/);
  assert.match(source, /windows_task_disabled/);
  assert.match(source, /schedulerStatus/);
  assert.equal(packageJson.scripts.health, "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Test-CheckinHealth.ps1");
});
