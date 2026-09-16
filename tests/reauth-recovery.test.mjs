import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { reauthRecoveryAction, hasCurrentReauthEvidence, resetReauthLoginEvidence } from "../src/reauth-recovery.mjs";
import { inspectConfiguredReauthRecovery } from "../src/reauth-checkin.mjs";
import { powershellExecutable } from "./helpers/powershell.mjs";

const now = new Date("2026-09-16T04:00:00Z");
const pending = { date: "20260916", status: "logged_out", updatedAt: "2026-09-16T03:00:00Z", loginEvidenceReset: true };
const login = { valid: true, explicitLoginSuccess: true };

test("recovery distinguishes a current logout, completed day, and a pre-logout interruption", () => {
  assert.equal(reauthRecoveryAction(pending, now), "resume");
  assert.equal(hasCurrentReauthEvidence(login, pending, now), true);
  assert.equal(reauthRecoveryAction({ ...pending, status: "completed" }, now), "complete");
  for (const previous of [undefined, { ...pending, status: "started" },
    { ...pending, date: "20260915" }, { ...pending, updatedAt: "bad" },
    { ...pending, updatedAt: "2026-09-17T03:00:00Z" },
    { ...pending, updatedAt: "2026-09-15T03:00:00Z" },
    { ...pending, updatedAt: "2026-09-16T05:00:00Z" },
    { ...pending, loginEvidenceReset: false }]) {
    assert.equal(reauthRecoveryAction(previous, now), "restart");
    assert.equal(hasCurrentReauthEvidence(login, previous, now), false);
  }
  assert.equal(hasCurrentReauthEvidence(login, pending, new Date("2026-09-16T16:00:00Z")), false);
});

test("storage evidence is reset before reauth without removing other login fields", async () => {
  const values = new Map([["test", JSON.stringify({ result: { checked: true }, retained: "fixture" })]]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const page = { evaluate: (fn, args) => vm.runInNewContext(`(${fn.toString()})(args)`, { args, localStorage: storage }) };
  const rule = { loginSuccessStorageEvidence: { storage: "localStorage", key: "test", field: "result.checked", expected: true } };
  assert.equal(await resetReauthLoginEvidence(page, rule), true);
  assert.deepEqual(JSON.parse(values.get("test")), { result: { checked: false }, retained: "fixture" });
  values.clear();
  assert.equal(await resetReauthLoginEvidence(page, rule), true);
  values.set("test", "bad json");
  await assert.rejects(async () => resetReauthLoginEvidence(page, rule));
  assert.equal(await resetReauthLoginEvidence(page, {}), false);
});

test("recovery reads only the selected account checkpoint and rejects corrupt state", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reauth-state-"));
  const statePath = path.join(directory, "state.json");
  const rule = { origin: "https://example.test", accountKey: "linuxdo", statePath };
  try {
    assert.equal((await inspectConfiguredReauthRecovery(rule, now)).action, "restart");
    await fs.writeFile(statePath, JSON.stringify({ entries: {
      "https://example.test": pending,
      "https://example.test::github": pending,
    } }));
    assert.equal((await inspectConfiguredReauthRecovery(rule, now)).action, "restart");
    await fs.writeFile(statePath, JSON.stringify({ entries: { "https://example.test::linuxdo": pending } }));
    assert.equal((await inspectConfiguredReauthRecovery(rule, now)).action, "resume");
    await fs.writeFile(statePath, "bad json");
    await assert.rejects(inspectConfiguredReauthRecovery(rule, now));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function quote(value) { return `'${String(value).replaceAll("'", "''")}'`; }

for (const scenario of ["restart", "complete", "fallback-write-failure", "restart-manual"]) {
  test(`manual recovery dispatch: ${scenario}`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reauth-dispatch-"));
    const scripts = path.join(directory, "scripts");
    const src = path.join(directory, "src");
    const tmp = path.join(directory, "tmp");
    const profile = path.join(directory, "data", "edge-test");
    const calls = path.join(tmp, "calls.txt");
    const providerState = path.join(tmp, "agentrouter-linuxdo-provider-state.json");
    try {
      for (const folder of [scripts, src, tmp, profile, path.join(directory, "config")]) await fs.mkdir(folder, { recursive: true });
      for (const file of ["Open-AgentRouterLogin.ps1", "AgentRouterAccount.ps1"]) {
        await fs.copyFile(new URL(`../scripts/${file}`, import.meta.url), path.join(scripts, file));
      }
      await fs.writeFile(path.join(scripts, "Resolve-Runtime.ps1"), [
        `function Resolve-CheckinNode { return ${quote(process.execPath)} }`,
        "function Resolve-CheckinBrowser { return [pscustomobject]@{ Executable='mock-edge.exe'; ProcessName='never-a-browser.exe' } }",
        "function Get-CimInstance { return @() }",
        `function Start-Process { [System.IO.File]::AppendAllText(${quote(calls)}, "manual\n"); return [pscustomobject]@{ Id=4242 } }`,
        "function Wait-CheckinVisibleBrowserWindow { return [pscustomobject]@{ ProcessId=4242; ProcessStartedAt=[datetime]::UtcNow.ToString('o') } }",
      ].join("\n"));
      await fs.writeFile(path.join(scripts, "Run-Checkin.ps1"), [
        "param([string]$ReauthAccountKey,[switch]$PostOAuthVerify,[int]$Attempts,[switch]$SuppressReport)",
        "if ($ReauthAccountKey -ne 'linuxdo' -or $Attempts -ne 1 -or -not $SuppressReport) { exit 99 }",
        `$mode=if($PostOAuthVerify){'verify'}else{'full'}`,
        `[System.IO.File]::AppendAllText(${quote(calls)}, "$mode\n")`,
        `exit ${scenario.includes("failure") || scenario === "restart-manual" ? 1 : 0}`,
      ].join("\n"));
      await fs.writeFile(path.join(src, "prepare-native-browser-profile.mjs"), "");
      await fs.writeFile(path.join(src, "oauth-provider-session.mjs"), `console.log(JSON.stringify({status:'valid'}));`);
      await fs.writeFile(path.join(src, "oauth-login.mjs"), `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(calls)},'oauth\\n'); console.log(JSON.stringify({status:'needs_attention',oauthStage:'target_callback'}));`);
      await fs.writeFile(path.join(src, "probe-agentrouter-session.mjs"), [
        "import fs from 'node:fs';",
        `const calls=${JSON.stringify(calls)};`,
        `const scenario=${JSON.stringify(scenario)};`,
        "const action=scenario==='restart-manual' ? (fs.existsSync(calls) ? 'resume' : 'restart') : scenario==='fallback-write-failure' ? 'resume' : scenario;",
        "console.log(JSON.stringify(process.argv.includes('--recovery-state') ? {action} : {status:scenario==='restart-manual' ? 'needs_attention' : 'already_signed'}));",
      ].join("\n"));
      await fs.writeFile(path.join(directory, "config", "config.json"), JSON.stringify({ agentrouterAccounts: [{
        origin: "https://agentrouter.org", accountKey: "linuxdo", provider: "LinuxDO", automationUserDataDir: profile,
      }] }));
      if (scenario !== "complete") await fs.writeFile(providerState, JSON.stringify({ accountKey: "linuxdo", profile }));
      const result = spawnSync(powershellExecutable, ["-NoProfile", "-File", path.join(scripts, "Open-AgentRouterLogin.ps1"), "-AccountKey", "linuxdo", "-AgentRouterOnly"], { encoding: "utf8", timeout: 30000 });
      assert.equal(result.status, scenario === "fallback-write-failure" ? 1 : 0, result.stderr + result.stdout);
      assert.equal(await fs.readFile(calls, "utf8"), scenario === "fallback-write-failure" ? "oauth\nverify\n" : scenario === "restart-manual" ? "full\nmanual\n" : "full\n");
      if (scenario === "fallback-write-failure") {
        await fs.access(providerState);
        assert.doesNotMatch(result.stdout, /authoritatively confirms today's check-in/);
      }
      if (scenario === "restart-manual") {
        const state = JSON.parse(await fs.readFile(path.join(tmp, "agentrouter-manual-state.json"), "utf8"));
        assert.equal(state.stage, "agentrouter");
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}
