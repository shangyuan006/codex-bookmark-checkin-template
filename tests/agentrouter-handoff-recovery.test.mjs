import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { powershellExecutable } from "./helpers/powershell.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scripts = path.join(root, "scripts");

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runPowerShell(command, cwd = root) {
  return spawnSync(powershellExecutable, ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(command, "utf16le").toString("base64")], { cwd, encoding: "utf8", timeout: 30_000 });
}

async function schedulerScenario(body) {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "agentrouter-dispatch-"));
  try {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      `. ${quote(path.join(scripts, "AgentRouterAccount.ps1"))}`,
      `$schedulerScripts = ${quote(scripts)}`,
      `$agentRouterManualStatePath = ${quote(path.join(fixture, "manual.json"))}`,
      `$agentRouterProviderStagePath = ${quote(path.join(fixture, "provider.json"))}`,
      `$ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(path.join(scripts, "Start-UserScheduler.ps1"))}, [ref]$null, [ref]$null)`,
      "foreach ($name in @('Get-AgentRouterOrigins', 'Get-AgentRouterManualAction', 'Start-AgentRouterManualAction')) {",
      "  $definition = $ast.Find({ param($entry) $entry -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $entry.Name -eq $name }, $false)",
      "  Invoke-Expression ($definition.Extent.Text.Replace('$PSScriptRoot', '$schedulerScripts'))",
      "}",
      "function ConvertTo-ManualAbandonmentOrigin($Value) { return [string]$Value }",
      "function Get-CheckinProfileBrowserProcesses { return @() }",
      "function Test-AgentRouterHelperRunning { return $false }",
      "function Write-SchedulerLog { }",
      "$script:launches = @()",
      "function Start-Process { param($FilePath, $ArgumentList, $WindowStyle) $script:launches += ,@($ArgumentList) }",
      "$config = [pscustomobject]@{ agentrouterAccounts = @(",
      "  [pscustomobject]@{ origin = 'https://agentrouter.org'; accountKey = 'github'; provider = 'GitHub' },",
      "  [pscustomobject]@{ origin = 'https://agentrouter.org'; accountId = 'linuxdo'; provider = 'LinuxDO' }",
      ") }",
      "$handoff = [pscustomobject]@{ Mode = 'awaiting_manual_handoff'; Targets = @([pscustomobject]@{ origin = 'https://agentrouter.org'; accountKeys = @('linuxdo') }) }",
      body,
    ].join("\r\n");
    const result = runPowerShell(command);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
}

test("scheduler dispatches GitHub single-stage and LinuxDO provider-stage parameters", async () => {
  const scenarios = await schedulerScenario([
    "$results = @()",
    "foreach ($key in @('github', 'linuxdo')) {",
    "  $handoff.Targets[0].accountKeys = @($key)",
    "  $action = Get-AgentRouterManualAction $handoff $config",
    "  [void](Start-AgentRouterManualAction $action 'fixture')",
    "  $arguments = $script:launches[-1]",
    "  $results += [pscustomobject]@{ action = $action.Action; key = $action.AccountKey; providerOnly = $arguments -contains '-ProviderOnly'; continueTarget = $arguments -contains '-ContinueToAgentRouter'; targetOnly = $arguments -contains '-AgentRouterOnly'; script = [System.IO.Path]::GetFileName($arguments[6]) }",
    "}",
    "ConvertTo-Json -InputObject $results -Compress",
  ].join("\r\n"));
  assert.deepEqual(scenarios, [
    { action: "github", key: "github", providerOnly: false, continueTarget: false, targetOnly: false, script: "Open-AgentRouterLogin.ps1" },
    { action: "provider", key: "linuxdo", providerOnly: true, continueTarget: true, targetOnly: false, script: "Open-AgentRouterLogin.ps1" },
  ]);
});

test("pending LinuxDO verification respects backoff without blocking GitHub", async () => {
  const scenarios = await schedulerScenario([
    "$results = @()",
    "foreach ($scenario in @('waiting', 'github', 'due', 'invalid-time')) {",
    "  $nextProbeAt = if ($scenario -eq 'due') { [datetimeoffset]::UtcNow.AddMinutes(-1).ToString('o') } elseif ($scenario -eq 'invalid-time') { 'invalid' } else { [datetimeoffset]::UtcNow.AddMinutes(10).ToString('o') }",
    "  Write-AgentRouterProviderState $agentRouterProviderStagePath ([ordered]@{ stage = 'provider_pending'; accountKey = 'linuxdo'; nextProbeAt = $nextProbeAt })",
    "  $handoff.Targets[0].accountKeys = if ($scenario -eq 'github') { @('linuxdo', 'github') } else { @('linuxdo') }",
    "  $before = $script:launches.Count",
    "  $action = Get-AgentRouterManualAction $handoff $config",
    "  [void](Start-AgentRouterManualAction $action 'fixture')",
    "  $launched = $script:launches.Count -gt $before",
    "  $arguments = if ($launched) { $script:launches[-1] } else { @() }",
    "  $results += [pscustomobject]@{ scenario = $scenario; action = $action.Action; launched = $launched; closeOnly = $launched -and [System.IO.Path]::GetFileName($arguments[6]) -eq 'Close-AgentRouterLogin.ps1'; providerOnly = $arguments -contains '-ProviderOnly' }",
    "}",
    "ConvertTo-Json -InputObject $results -Compress",
  ].join("\r\n"));
  assert.deepEqual(scenarios, [
    { scenario: "waiting", action: "waiting", launched: false, closeOnly: false, providerOnly: false },
    { scenario: "github", action: "github", launched: true, closeOnly: false, providerOnly: false },
    { scenario: "due", action: "provider_recheck", launched: true, closeOnly: true, providerOnly: false },
    { scenario: "invalid-time", action: "waiting", launched: false, closeOnly: false, providerOnly: false },
  ]);
});

test("provider backoff is bounded and timestamp handling works for JSON and PowerShell dates", () => {
  const result = runPowerShell([
    "$ErrorActionPreference = 'Stop'",
    `. ${quote(path.join(scripts, "AgentRouterAccount.ps1"))}`,
    "$delays = @(1, 2, 3, 4, 5, 20 | ForEach-Object { Get-AgentRouterProviderProbeBackoffMinutes $_ })",
    "$due = @()",
    "$now = [datetimeoffset]::UtcNow",
    "foreach ($stamp in @($now.AddMinutes(-1), $now.AddMinutes(-1).UtcDateTime, $now.AddMinutes(-1).ToString('o'), $now.AddMinutes(1).UtcDateTime, 'invalid')) {",
    "  $due += Test-AgentRouterProviderProbeDue ([pscustomobject]@{ nextProbeAt = $stamp }) $now",
    "}",
    "[pscustomobject]@{ delays = $delays; rateLimitedDelay = (Get-AgentRouterProviderProbeBackoffMinutes 1 $true); due = $due } | ConvertTo-Json -Compress",
  ].join("\r\n"));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    delays: [2, 4, 8, 16, 30, 30], rateLimitedDelay: 10, due: [true, true, true, false, false],
  });
});

async function providerFixture(probes) {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "agentrouter-closed-probe-"));
  const directory = (name) => path.join(fixture, name);
  const statePath = directory("tmp/agentrouter-linuxdo-provider-state.json");
  const countPath = directory("tmp/probe-count.txt");
  const continuedPath = directory("tmp/continued.txt");
  for (const name of ["scripts", "src", "config", "tmp"]) {
    await fs.mkdir(directory(name), { recursive: true });
  }
  for (const name of ["AgentRouterAccount.ps1", "Close-AgentRouterLogin.ps1", "Open-AgentRouterLogin.ps1"]) {
    await fs.copyFile(path.join(scripts, name), directory(`scripts/${name}`));
  }
  await fs.writeFile(directory("scripts/Resolve-Runtime.ps1"), [
    `function Resolve-CheckinNode { param($Config) return ${quote(process.execPath)} }`,
    "function Resolve-CheckinBrowser { return [pscustomobject]@{ Executable = 'never.exe'; ProcessName = 'never.exe' } }",
    "function Get-CimInstance { return @() }",
    "function Get-CheckinManualSessionBrowserProcesses { return @() }",
    `function Get-CheckinProfileBrowserProcesses { if (Test-Path -LiteralPath ${quote(directory("tmp/busy.txt"))}) { return [pscustomobject]@{ ProcessId = 123 } }; return @() }`,
    "function Start-Process { throw 'No real browser may be launched by this fixture.' }",
  ].join("\r\n"), "utf8");
  await fs.writeFile(directory("src/oauth-provider-session.mjs"), [
    "import fs from 'node:fs';",
    `const file = ${JSON.stringify(countPath)};`,
    "const count = Number(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 0);",
    "fs.writeFileSync(file, String(count + 1));",
    `const probes = ${JSON.stringify(probes)};`,
    "const probe = probes[Math.min(count, probes.length - 1)];",
    "console.log(JSON.stringify({ attempts: 1, ...probe }));",
    "process.exitCode = probe.status === 'unknown' ? 2 : 0;",
  ].join("\n"), "utf8");
  await fs.writeFile(directory("src/prepare-native-browser-profile.mjs"),
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(directory("tmp/prepared.txt"))}, 'prepared');\n`, "utf8");
  await fs.writeFile(directory("src/probe-agentrouter-session.mjs"), "console.log(JSON.stringify({ action: 'resume' }));\n", "utf8");
  await fs.writeFile(directory("src/oauth-login.mjs"), "console.log(JSON.stringify({ status: 'logged_in', oauthStage: 'completed' }));\n", "utf8");
  await fs.writeFile(directory("scripts/Run-Checkin.ps1"), [
    "param([string]$ReauthAccountKey, [switch]$PostOAuthVerify, [int]$Attempts, [switch]$SuppressReport)",
    "if ($ReauthAccountKey -ne 'linuxdo' -or -not $PostOAuthVerify -or $Attempts -ne 1) { exit 9 }",
    `[System.IO.File]::WriteAllText(${quote(continuedPath)}, 'verified')`,
    "exit 0",
  ].join("\r\n"), "utf8");
  await fs.writeFile(directory("config/config.json"), JSON.stringify({ agentrouterAccounts: [{
    origin: "https://agentrouter.org", accountKey: "linuxdo", provider: "LinuxDO",
    automationUserDataDir: "data/fixture-provider",
  }] }), "utf8");
  await fs.writeFile(directory("tmp/agentrouter-manual-state.json"), JSON.stringify({
    accountKey: "linuxdo", profile: directory("data/fixture-provider"), pid: 123,
    stage: "provider", continueToAgentRouter: true,
  }), "utf8");
  return {
    fixture, directory, statePath, countPath, continuedPath,
    readState: async () => JSON.parse(await fs.readFile(statePath, "utf8")),
    invoke: (name, extra = []) => spawnSync(powershellExecutable, ["-NoProfile", "-NonInteractive", "-File",
      directory(`scripts/${name}.ps1`), "-AccountKey", "linuxdo", ...extra],
    { cwd: fixture, encoding: "utf8", timeout: 30_000 }),
    expire: async () => {
      const state = JSON.parse(await fs.readFile(statePath, "utf8"));
      state.nextProbeAt = new Date(Date.now() - 60_000).toISOString();
      await fs.writeFile(statePath, JSON.stringify(state), "utf8");
    },
  };
}

test("closed-stage retries do not reopen LinuxDO and later valid evidence resumes target verification", async () => {
  const ctx = await providerFixture([{ status: "unknown", challengeObserved: true }, { status: "unknown" }, { status: "valid" }]);
  try {
    const first = ctx.invoke("Close-AgentRouterLogin");
    assert.notEqual(first.status, 0);
    assert.equal((await ctx.readState()).verificationFailures, 1);
    await assert.rejects(fs.access(ctx.directory("tmp/agentrouter-manual-state.json")), { code: "ENOENT" });
    for (const [name, extra] of [
      ["Close-AgentRouterLogin", []],
      ["Open-AgentRouterLogin", ["-ProviderOnly", "-ContinueToAgentRouter"]],
      ["Open-AgentRouterLogin", ["-AgentRouterOnly"]],
    ]) {
      const waiting = ctx.invoke(name, extra);
      assert.equal(waiting.status, 0, waiting.stderr);
      assert.match(waiting.stdout, /waiting for its next bounded probe/);
    }
    assert.equal(await fs.readFile(ctx.countPath, "utf8"), "1");
    await assert.rejects(fs.access(ctx.directory("tmp/prepared.txt")), { code: "ENOENT" });
    await ctx.expire();
    const second = ctx.invoke("Close-AgentRouterLogin");
    assert.notEqual(second.status, 0);
    const pending = await ctx.readState();
    assert.equal(pending.verificationFailures, 2);
    assert.ok(Date.parse(pending.nextProbeAt) >= Date.parse(pending.checkedAt) + 240_000);
    await ctx.expire();
    const completed = ctx.invoke("Close-AgentRouterLogin");
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(await fs.readFile(ctx.continuedPath, "utf8"), "verified");
    assert.equal(await fs.readFile(ctx.countPath, "utf8"), "4");
    await assert.rejects(fs.access(ctx.statePath), { code: "ENOENT" });
  } finally {
    await fs.rm(ctx.fixture, { recursive: true, force: true });
  }
});

test("rate-limited close probes wait at least ten minutes and only confirmed invalid resets login", async () => {
  const ctx = await providerFixture([{ status: "unknown", rateLimited: true }, { status: "invalid" }]);
  try {
    assert.notEqual(ctx.invoke("Close-AgentRouterLogin").status, 0);
    const state = await ctx.readState();
    assert.equal(state.rateLimited, true);
    assert.ok(Date.parse(state.nextProbeAt) >= Date.parse(state.checkedAt) + 600_000);
    assert.equal(ctx.invoke("Close-AgentRouterLogin").status, 0);
    assert.equal(await fs.readFile(ctx.countPath, "utf8"), "1");
    await ctx.expire();
    const invalid = ctx.invoke("Close-AgentRouterLogin");
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /confirmed invalid/);
    await assert.rejects(fs.access(ctx.statePath), { code: "ENOENT" });
    await assert.rejects(fs.access(ctx.continuedPath), { code: "ENOENT" });
  } finally {
    await fs.rm(ctx.fixture, { recursive: true, force: true });
  }
});

test("probe startup failure retains closed recovery before removing the manual window marker", async () => {
  const ctx = await providerFixture([{ status: "valid" }]);
  try {
    await fs.writeFile(ctx.directory("scripts/Resolve-Runtime.ps1"), [
      "function Get-CheckinManualSessionBrowserProcesses { return @() }",
      "function Get-CheckinProfileBrowserProcesses { return @() }",
      "function Resolve-CheckinNode { throw 'Fixture runtime unavailable.' }",
    ].join("\r\n"), "utf8");
    assert.notEqual(ctx.invoke("Close-AgentRouterLogin").status, 0);
    const state = await ctx.readState();
    assert.equal(state.stage, "provider_pending");
    assert.equal(state.probeStatus, "unknown");
    assert.ok(Date.parse(state.nextProbeAt) > Date.now());
    await assert.rejects(fs.access(ctx.countPath), { code: "ENOENT" });
    await assert.rejects(fs.access(ctx.directory("tmp/agentrouter-manual-state.json")), { code: "ENOENT" });
  } finally {
    await fs.rm(ctx.fixture, { recursive: true, force: true });
  }
});

test("pending close rechecks refuse busy or mismatched isolated profiles", async () => {
  const ctx = await providerFixture([{ status: "unknown" }]);
  try {
    assert.notEqual(ctx.invoke("Close-AgentRouterLogin").status, 0);
    await ctx.expire();
    await fs.writeFile(ctx.directory("tmp/busy.txt"), "busy", "utf8");
    const busy = ctx.invoke("Close-AgentRouterLogin");
    assert.notEqual(busy.status, 0);
    assert.match(busy.stderr, /dedicated profile is still in use/);
    const state = await ctx.readState();
    state.profile = ctx.directory("data/wrong-profile");
    await fs.writeFile(ctx.statePath, JSON.stringify(state), "utf8");
    const mismatch = ctx.invoke("Close-AgentRouterLogin");
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /does not match the account configuration/);
    assert.equal(await fs.readFile(ctx.countPath, "utf8"), "1");
  } finally {
    await fs.rm(ctx.fixture, { recursive: true, force: true });
  }
});
