import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { powershellExecutable } from "./helpers/powershell.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const helperPath = path.join(root, "scripts", "AgentRouterAccount.ps1");
const openPath = path.join(root, "scripts", "Open-AgentRouterLogin.ps1");
const closePath = path.join(root, "scripts", "Close-AgentRouterLogin.ps1");
const completePath = path.join(root, "scripts", "Complete-AgentRouterLogin.ps1");
const providerRefreshPath = path.join(root, "scripts", "Refresh-AgentRouterProviderSession.ps1");
const runnerPath = path.join(root, "scripts", "Run-Checkin.ps1");
const indexPath = path.join(root, "src", "index.mjs");
const manualPath = path.join(root, "scripts", "Open-ManualLogin.ps1");
const nativeLauncherPath = path.join(root, "scripts", "Open-PlainLoginChrome.ps1");

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function resolveAccount(accounts, accountKey) {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${quotePowerShell(helperPath)}`,
    `$accounts = ${quotePowerShell(JSON.stringify(accounts))} | ConvertFrom-Json`,
    `$resolved = Resolve-AgentRouterAccountConfig -Accounts @($accounts) -AccountKey ${quotePowerShell(accountKey)}`,
    "Write-Output ([string]$resolved.marker)",
  ].join("\r\n");
  return spawnSync(powershellExecutable, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64"),
  ], { cwd: root, encoding: "utf8" });
}

test("Agent Router login helper accepts accountKey-only configuration and normalized origin", () => {
  const result = resolveAccount([{
    origin: "https://agentrouter.org/",
    accountKey: "GitHub Primary",
    marker: "account-key",
  }], "github-primary");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "account-key");
});

test("Agent Router login helper preserves legacy accountId normalization", () => {
  const result = resolveAccount([{
    origin: "https://agentrouter.org",
    accountId: "Linux.DO",
    marker: "legacy-id",
  }], "linux-do");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "legacy-id");
});

test("Agent Router login helper rejects duplicate normalized keys", () => {
  const result = resolveAccount([
    { origin: "https://agentrouter.org", accountKey: "Linux.DO", marker: "first" },
    { origin: "https://agentrouter.org/", accountId: "linux-do", marker: "second" },
  ], "linux-do");

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.trim(), "");
});

test("Agent Router login helper rejects account URLs that are not canonical origins", () => {
  const result = resolveAccount([{
    origin: "https://agentrouter.org/private?account=github",
    accountKey: "github",
    marker: "must-not-match",
  }], "github");

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.trim(), "");
});

test("Agent Router manual login scripts track, verify, close, and resume one account", async () => {
  const fs = await import("node:fs/promises");
  const [open, close, complete, runner, index] = await Promise.all([
    fs.readFile(openPath, "utf8"),
    fs.readFile(closePath, "utf8"),
    fs.readFile(completePath, "utf8"),
    fs.readFile(runnerPath, "utf8"),
    fs.readFile(indexPath, "utf8"),
  ]);
  assert.match(open, /agentrouter-manual-state\.json/);
  assert.match(open, /processStartedAt/);
  assert.match(open, /launchMarker/);
  assert.match(open, /--checkin-launch=/);
  assert.doesNotMatch(open, /about:blank/i);
  assert.match(close, /processStartedAt/);
  assert.match(close, /Get-CheckinManualSessionBrowserProcesses/);
  assert.match(close, /rebound/);
  assert.match(close, /CloseMainWindow/);
  assert.match(close, /potentially reused PID/);
  assert.match(open, /\[switch\]\$ProviderOnly/);
  assert.match(open, /\[switch\]\$AgentRouterOnly/);
  assert.match(open, /ProviderOnly and AgentRouterOnly cannot be used together/);
  assert.match(open, /LinuxDO recovery is two-stage/);
  assert.match(open, /stage = if \(\$ProviderOnly\) \{ 'provider' \} else \{ 'agentrouter' \}/);
  assert.match(close, /agentrouter-linuxdo-provider-state\.json/);
  assert.match(complete, /Run-Checkin\.ps1/);
  assert.match(complete, /-ReauthAccountKey/);
  assert.match(complete, /state\.stage/);
  assert.match(runner, /-not \$ReauthAccountKey/);
  assert.match(runner, /Test-ReauthAccountAuthoritativelyComplete/);
  assert.match(runner, /if \(-not \$ReauthAccountKey[\s\S]*?Test-NeedsNativeFallbackRetry/);
  assert.match(index, /!listPreflightTargets && !reauthAccountKey/);
});

test("LinuxDO manual recovery uses explicit provider and Agent Router stages", async () => {
  const fs = await import("node:fs/promises");
  const [open, close, readme] = await Promise.all([
    fs.readFile(openPath, "utf8"),
    fs.readFile(closePath, "utf8"),
    fs.readFile(path.join(root, "README.md"), "utf8"),
  ]);
  assert.match(open, /\$provider -eq 'LinuxDO'/);
  assert.match(open, /oauth-provider-session\.mjs/);
  assert.match(open, /function Get-LinuxDoProviderSessionProbe/);
  assert.match(open, /function Write-LinuxDoProviderProbeLog/);
  assert.match(open, /function Write-LinuxDoProviderStage/);
  assert.match(open, /\$existingProviderProbe\.Status -eq 'valid'/);
  assert.match(open, /no visible provider page was opened/);
  assert.match(open, /provider session is indeterminate/);
  assert.match(open, /\$providerSessionProbe\.Status -ne 'valid'/);
  assert.match(open, /\$ProviderOnly/);
  assert.match(open, /\$AgentRouterOnly/);
  assert.match(open, /https:\/\/linux\.do\/login/);
  assert.match(open, /\$loginUrls/);
  assert.match(open, /https:\/\/agentrouter\.org\/login/);
  assert.match(open, /\$arguments \+= \$loginUrls/);
  assert.doesNotMatch(open, /\$loginUrls = @\('https:\/\/linux\.do\/login',\s*'https:\/\/agentrouter\.org\/login'\)/);
  assert.match(open, /oauth-login\.mjs/);
  assert.match(open, /'--agent-router-only'/);
  assert.match(open, /'--provider-session-confirmed'/);
  assert.doesNotMatch(open, /'--interactive-attention'/);
  assert.match(open, /Opening one native no-CDP Edge window for manual completion/);
  assert.match(open, /\[string\]\$automaticResult\.status -eq 'logged_in'/);
  assert.match(open, /authorizationOutcome/);
  assert.match(open, /authorization_click_failed/);
  assert.match(open, /stage=\$failedStage, authorization=\$failedAuthorization/);
  assert.match(open, /-ReauthAccountKey \$requestedAccountKey/);
  assert.match(open, /-PostOAuthVerify/);
  assert.match(open, /-Attempts 1/);
  assert.match(open, /Opening one native no-CDP Edge window for manual completion/);
  assert.match(open, /refusing to open a second window/);
  assert.match(close, /agentrouter-linuxdo-provider-state\.json/);
  assert.match(readme, /无 CDP、无 Playwright 的原生 Edge 窗口/);
  assert.match(readme, /必须严格分两阶段/);
  assert.match(readme, /三次通过浏览器请求探测/);
  assert.match(readme, /一个后台页面中导航到该固定端点/);
  assert.match(readme, /只有两种探针都明确无效才打开登录页/);
  assert.match(readme, /同一个 OAuth 页面内最多三次重进 Agent Router/);
  assert.match(readme, /复核阶段不会发起第二次 OAuth/);
  assert.match(readme, /最终账号结果必须为 `signed` 或 `already_signed`/);
  assert.match(readme, /-ProviderOnly/);
  assert.match(readme, /-AgentRouterOnly/);
});

test("LinuxDO Agent Router stage tolerates private OAuth progress on stderr", async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentrouter-stderr-progress-"));
  const scriptsDirectory = path.join(fixtureRoot, "scripts");
  const sourceDirectory = path.join(fixtureRoot, "src");
  const configDirectory = path.join(fixtureRoot, "config");
  const tmpDirectory = path.join(fixtureRoot, "tmp");
  const profile = path.join(fixtureRoot, "data", "edge-agentrouter-linuxdo");
  try {
    await Promise.all([
      fs.mkdir(scriptsDirectory, { recursive: true }),
      fs.mkdir(sourceDirectory, { recursive: true }),
      fs.mkdir(configDirectory, { recursive: true }),
      fs.mkdir(tmpDirectory, { recursive: true }),
      fs.mkdir(profile, { recursive: true }),
    ]);
    await Promise.all([
      fs.copyFile(openPath, path.join(scriptsDirectory, "Open-AgentRouterLogin.ps1")),
      fs.copyFile(helperPath, path.join(scriptsDirectory, "AgentRouterAccount.ps1")),
      fs.writeFile(path.join(scriptsDirectory, "Resolve-Runtime.ps1"), [
        "function Resolve-CheckinNode { param($Config) return " + quotePowerShell(process.execPath) + " }",
        "function Resolve-CheckinBrowser { param($Config) return [pscustomobject]@{ Executable = 'unused.exe'; ProcessName = 'codex-agentrouter-test-never.exe'; DisplayName = 'Test Edge' } }",
        "function Get-CimInstance { param($ClassName) return @() }",
      ].join("\r\n"), "utf8"),
      fs.writeFile(path.join(scriptsDirectory, "Run-Checkin.ps1"), [
        "param([string]$ReauthAccountKey, [switch]$PostOAuthVerify, [int]$Attempts, [switch]$SuppressReport)",
        "if ($ReauthAccountKey -ne 'linuxdo') { exit 9 }",
        "if (-not $PostOAuthVerify -or $Attempts -ne 1) { exit 8 }",
        "exit 0",
      ].join("\r\n"), "utf8"),
      fs.writeFile(path.join(sourceDirectory, "prepare-native-browser-profile.mjs"), "process.exitCode = 0;\n", "utf8"),
      fs.writeFile(path.join(sourceDirectory, "oauth-provider-session.mjs"), [
        "process.stdout.write(JSON.stringify({ status: 'valid' }) + '\\n');",
      ].join("\n"), "utf8"),
      fs.writeFile(path.join(sourceDirectory, "oauth-login.mjs"), [
        "process.stderr.write(JSON.stringify({ oauthStage: 'target_login' }) + '\\n');",
        "process.stdout.write(JSON.stringify({ status: 'logged_in', oauthStage: 'completed' }) + '\\n');",
      ].join("\n"), "utf8"),
      fs.writeFile(path.join(configDirectory, "config.json"), JSON.stringify({
        agentrouterAccounts: [{
          origin: "https://agentrouter.org",
          accountKey: "linuxdo",
          provider: "LinuxDO",
          automationUserDataDir: "data/edge-agentrouter-linuxdo",
        }],
      }), "utf8"),
      fs.writeFile(path.join(tmpDirectory, "agentrouter-linuxdo-provider-state.json"), JSON.stringify({
        accountKey: "linuxdo",
        profile,
      }), "utf8"),
    ]);

    const result = spawnSync(powershellExecutable, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.join(scriptsDirectory, "Open-AgentRouterLogin.ps1"),
      "-AccountKey", "linuxdo", "-AgentRouterOnly",
    ], { cwd: fixtureRoot, encoding: "utf8", timeout: 30_000 });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Executed one Agent Router OAuth for accountKey 'linuxdo'/);
    await assert.rejects(
      fs.access(path.join(tmpDirectory, "agentrouter-linuxdo-provider-state.json")),
      { code: "ENOENT" },
    );
    await assert.rejects(
      fs.access(path.join(tmpDirectory, "agentrouter-manual-state.json")),
      { code: "ENOENT" },
    );
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("LinuxDO provider helper skips the visible page when the existing session is valid", async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentrouter-provider-reuse-"));
  const scriptsDirectory = path.join(fixtureRoot, "scripts");
  const sourceDirectory = path.join(fixtureRoot, "src");
  const configDirectory = path.join(fixtureRoot, "config");
  const tmpDirectory = path.join(fixtureRoot, "tmp");
  const profile = path.join(fixtureRoot, "data", "edge-agentrouter-linuxdo");
  try {
    await Promise.all([
      fs.mkdir(scriptsDirectory, { recursive: true }),
      fs.mkdir(sourceDirectory, { recursive: true }),
      fs.mkdir(configDirectory, { recursive: true }),
      fs.mkdir(tmpDirectory, { recursive: true }),
      fs.mkdir(profile, { recursive: true }),
    ]);
    await Promise.all([
      fs.copyFile(openPath, path.join(scriptsDirectory, "Open-AgentRouterLogin.ps1")),
      fs.copyFile(helperPath, path.join(scriptsDirectory, "AgentRouterAccount.ps1")),
      fs.writeFile(path.join(scriptsDirectory, "Resolve-Runtime.ps1"), [
        "function Resolve-CheckinNode { param($Config) return " + quotePowerShell(process.execPath) + " }",
        "function Resolve-CheckinBrowser { param($Config) return [pscustomobject]@{ Executable = 'must-not-start.exe'; ProcessName = 'codex-agentrouter-test-never.exe'; DisplayName = 'Test Edge' } }",
        "function Get-CimInstance { param($ClassName) return @() }",
      ].join("\r\n"), "utf8"),
      fs.writeFile(path.join(sourceDirectory, "prepare-native-browser-profile.mjs"), "process.exitCode = 0;\n", "utf8"),
      fs.writeFile(path.join(sourceDirectory, "oauth-provider-session.mjs"), "process.stdout.write(JSON.stringify({ status: 'valid' }) + '\\n');\n", "utf8"),
      fs.writeFile(path.join(configDirectory, "config.json"), JSON.stringify({
        agentrouterAccounts: [{
          origin: "https://agentrouter.org",
          accountKey: "linuxdo",
          provider: "LinuxDO",
          automationUserDataDir: "data/edge-agentrouter-linuxdo",
        }],
      }), "utf8"),
    ]);

    const result = spawnSync(powershellExecutable, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.join(scriptsDirectory, "Open-AgentRouterLogin.ps1"),
      "-AccountKey", "linuxdo", "-ProviderOnly",
    ], { cwd: fixtureRoot, encoding: "utf8", timeout: 30_000 });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no visible provider page was opened/);
    const providerStage = JSON.parse(await fs.readFile(
      path.join(tmpDirectory, "agentrouter-linuxdo-provider-state.json"),
      "utf8",
    ));
    assert.equal(providerStage.accountKey, "linuxdo");
    await assert.rejects(
      fs.access(path.join(tmpDirectory, "agentrouter-manual-state.json")),
      { code: "ENOENT" },
    );
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("LinuxDO provider helper does not open a visible page for an indeterminate session", async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentrouter-provider-unknown-"));
  const scriptsDirectory = path.join(fixtureRoot, "scripts");
  const sourceDirectory = path.join(fixtureRoot, "src");
  const configDirectory = path.join(fixtureRoot, "config");
  const tmpDirectory = path.join(fixtureRoot, "tmp");
  const profile = path.join(fixtureRoot, "data", "edge-agentrouter-linuxdo");
  try {
    await Promise.all([
      fs.mkdir(scriptsDirectory, { recursive: true }),
      fs.mkdir(sourceDirectory, { recursive: true }),
      fs.mkdir(configDirectory, { recursive: true }),
      fs.mkdir(tmpDirectory, { recursive: true }),
      fs.mkdir(profile, { recursive: true }),
    ]);
    await Promise.all([
      fs.copyFile(openPath, path.join(scriptsDirectory, "Open-AgentRouterLogin.ps1")),
      fs.copyFile(helperPath, path.join(scriptsDirectory, "AgentRouterAccount.ps1")),
      fs.writeFile(path.join(scriptsDirectory, "Resolve-Runtime.ps1"), [
        "function Resolve-CheckinNode { param($Config) return " + quotePowerShell(process.execPath) + " }",
        "function Resolve-CheckinBrowser { param($Config) return [pscustomobject]@{ Executable = 'must-not-start.exe'; ProcessName = 'codex-agentrouter-test-never.exe'; DisplayName = 'Test Edge' } }",
        "function Get-CimInstance { param($ClassName) return @() }",
      ].join("\r\n"), "utf8"),
      fs.writeFile(path.join(sourceDirectory, "prepare-native-browser-profile.mjs"), "process.exitCode = 0;\n", "utf8"),
      fs.writeFile(path.join(sourceDirectory, "oauth-provider-session.mjs"), [
        "process.stdout.write(JSON.stringify({ status: 'unknown', attempts: 3 }) + '\\n');",
        "process.exitCode = 2;",
      ].join("\n"), "utf8"),
      fs.writeFile(path.join(configDirectory, "config.json"), JSON.stringify({
        agentrouterAccounts: [{
          origin: "https://agentrouter.org",
          accountKey: "linuxdo",
          provider: "LinuxDO",
          automationUserDataDir: "data/edge-agentrouter-linuxdo",
        }],
      }), "utf8"),
    ]);

    const result = spawnSync(powershellExecutable, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.join(scriptsDirectory, "Open-AgentRouterLogin.ps1"),
      "-AccountKey", "linuxdo", "-ProviderOnly",
    ], { cwd: fixtureRoot, encoding: "utf8", timeout: 30_000 });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /session is indeterminate after 3 bounded probe attempt/);
    const probeLog = JSON.parse(await fs.readFile(
      path.join(tmpDirectory, "agentrouter-linuxdo-provider-probe.json"),
      "utf8",
    ));
    assert.deepEqual(
      { stage: probeLog.stage, status: probeLog.status, attempts: probeLog.attempts },
      { stage: "provider", status: "unknown", attempts: 3 },
    );
    await assert.rejects(
      fs.access(path.join(tmpDirectory, "agentrouter-manual-state.json")),
      { code: "ENOENT" },
    );
    await assert.rejects(
      fs.access(path.join(tmpDirectory, "agentrouter-linuxdo-provider-state.json")),
      { code: "ENOENT" },
    );
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("LinuxDO provider helper opens the manual page only after definitive invalid probes", async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentrouter-provider-invalid-"));
  const scriptsDirectory = path.join(fixtureRoot, "scripts");
  const sourceDirectory = path.join(fixtureRoot, "src");
  const configDirectory = path.join(fixtureRoot, "config");
  const tmpDirectory = path.join(fixtureRoot, "tmp");
  const profile = path.join(fixtureRoot, "data", "edge-agentrouter-linuxdo");
  const launchRecordPath = path.join(tmpDirectory, "launch.json");
  try {
    await Promise.all([
      fs.mkdir(scriptsDirectory, { recursive: true }),
      fs.mkdir(sourceDirectory, { recursive: true }),
      fs.mkdir(configDirectory, { recursive: true }),
      fs.mkdir(tmpDirectory, { recursive: true }),
      fs.mkdir(profile, { recursive: true }),
    ]);
    await Promise.all([
      fs.copyFile(openPath, path.join(scriptsDirectory, "Open-AgentRouterLogin.ps1")),
      fs.copyFile(helperPath, path.join(scriptsDirectory, "AgentRouterAccount.ps1")),
      fs.writeFile(path.join(scriptsDirectory, "Resolve-Runtime.ps1"), [
        "function Resolve-CheckinNode { param($Config) return " + quotePowerShell(process.execPath) + " }",
        "function Resolve-CheckinBrowser { param($Config) return [pscustomobject]@{ Executable = 'mock-edge.exe'; ProcessName = 'codex-agentrouter-test-never.exe'; DisplayName = 'Test Edge' } }",
        "function Get-CimInstance { param($ClassName) return @() }",
        "function Start-Process { param($FilePath, $ArgumentList, [switch]$PassThru) [System.IO.File]::WriteAllText(" + quotePowerShell(launchRecordPath) + ", ($ArgumentList | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false)); return [pscustomobject]@{ Id = 4242; StartTime = [datetime]::UtcNow } }",
      ].join("\r\n"), "utf8"),
      fs.writeFile(path.join(sourceDirectory, "prepare-native-browser-profile.mjs"), "process.exitCode = 0;\n", "utf8"),
      fs.writeFile(path.join(sourceDirectory, "oauth-provider-session.mjs"), "process.stdout.write(JSON.stringify({ status: 'invalid', attempts: 3 }) + '\\n');\n", "utf8"),
      fs.writeFile(path.join(configDirectory, "config.json"), JSON.stringify({
        agentrouterAccounts: [{
          origin: "https://agentrouter.org",
          accountKey: "linuxdo",
          provider: "LinuxDO",
          automationUserDataDir: "data/edge-agentrouter-linuxdo",
        }],
      }), "utf8"),
    ]);

    const result = spawnSync(powershellExecutable, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.join(scriptsDirectory, "Open-AgentRouterLogin.ps1"),
      "-AccountKey", "linuxdo", "-ProviderOnly",
    ], { cwd: fixtureRoot, encoding: "utf8", timeout: 30_000 });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Opened only the LinuxDO provider login/);
    const launchArguments = JSON.parse(await fs.readFile(launchRecordPath, "utf8"));
    assert.ok(launchArguments.includes("https://linux.do/login"));
    assert.ok(!launchArguments.includes("https://agentrouter.org/login"));
    const manualState = JSON.parse(await fs.readFile(
      path.join(tmpDirectory, "agentrouter-manual-state.json"),
      "utf8",
    ));
    assert.equal(manualState.stage, "provider");
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("普通人工入口拒绝 Agent Router，避免误用非账号隔离会话", async () => {
  const fs = await import("node:fs/promises");
  const manual = await fs.readFile(manualPath, "utf8");
  const nativeLauncher = await fs.readFile(nativeLauncherPath, "utf8");
  assert.match(manual, /Agent Router 必须使用专用入口/);
  assert.match(manual, /Open-AgentRouterLogin\.ps1/);
  assert.match(manual, /Complete-AgentRouterLogin\.ps1/);
  assert.match(manual, /agentrouterAccounts/);
  assert.match(nativeLauncher, /selectedAgentRouterItems/);
  assert.match(nativeLauncher, /Agent Router 必须使用专用入口/);
  assert.match(nativeLauncher, /普通待处理窗口将跳过该站点/);
  assert.match(nativeLauncher, /\$agentRouterOrigins -notcontains \$itemOrigin/);
});

test("LinuxDO native session refresh is isolated, offscreen, bounded, and passive", async () => {
  const refresh = await fs.readFile(providerRefreshPath, "utf8");
  assert.match(refresh, /Resolve-AgentRouterAccountConfig/);
  assert.match(refresh, /\$account\.provider -ne 'LinuxDO'/);
  assert.match(refresh, /StartsWith\(\$dataRoot/);
  assert.match(refresh, /https:\/\/linux\.do\//);
  assert.match(refresh, /--window-position=-32000,-32000/);
  assert.match(refresh, /ValidateRange\(5, 30\)/);
  assert.match(refresh, /CloseMainWindow\(\)/);
  assert.doesNotMatch(refresh, /WindowStyle\s+Hidden/i);
  assert.doesNotMatch(refresh, /remote-debugging-port|native-cdp|click\(/i);
});
