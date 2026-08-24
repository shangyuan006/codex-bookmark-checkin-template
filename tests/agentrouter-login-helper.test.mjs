import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
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
  assert.match(open, /\$providerSessionStatus -ne 'valid'/);
  assert.match(open, /\$ProviderOnly/);
  assert.match(open, /\$AgentRouterOnly/);
  assert.match(open, /https:\/\/linux\.do\/login/);
  assert.match(open, /\$loginUrls/);
  assert.match(open, /https:\/\/agentrouter\.org\/login/);
  assert.match(open, /\$arguments \+= \$loginUrls/);
  assert.doesNotMatch(open, /\$loginUrls = @\('https:\/\/linux\.do\/login',\s*'https:\/\/agentrouter\.org\/login'\)/);
  assert.match(close, /agentrouter-linuxdo-provider-state\.json/);
  assert.match(readme, /必须严格分两阶段/);
  assert.match(readme, /-ProviderOnly/);
  assert.match(readme, /-AgentRouterOnly/);
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
