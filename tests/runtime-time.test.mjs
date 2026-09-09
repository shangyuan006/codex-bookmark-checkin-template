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
const runtimePath = path.join(root, "scripts", "Resolve-Runtime.ps1");

const driverSource = String.raw`param([string]$RuntimePath)
. $RuntimePath
$fromUtcJson = '{"value":"2026-09-01T02:35:31.0000000Z"}' | ConvertFrom-Json
$fromOffsetJson = '{"value":"2026-09-01T10:35:31.0000000+08:00"}' | ConvertFrom-Json
$expected = [datetime]::Parse(
    '2026-09-01T02:35:31.0000000Z',
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::RoundtripKind
)
$process = [pscustomobject]@{ StartTime = $expected }
[ordered]@{
    utc = (ConvertTo-CheckinUtcDateTime $fromUtcJson.value).ToString('o')
    offset = (ConvertTo-CheckinUtcDateTime $fromOffsetJson.value).ToString('o')
    identity = Test-CheckinProcessStartIdentity -Process $process -RecordedStart $fromUtcJson.value -ToleranceSeconds 2
    invalid = $null -eq (ConvertTo-CheckinUtcDateTime 'not-a-time')
} | ConvertTo-Json -Compress
`;

test("PowerShell runtime preserves UTC identity after ConvertFrom-Json in UTC+8", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-time-"));
  const driverPath = path.join(directory, "driver.ps1");
  try {
    await fs.writeFile(driverPath, driverSource, "utf8");
    const { stdout } = await execFileAsync(powershellExecutable, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", driverPath,
      "-RuntimePath", runtimePath,
    ], { cwd: root, encoding: "utf8" });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.utc, "2026-09-01T02:35:31.0000000Z");
    assert.equal(result.offset, result.utc);
    assert.equal(result.identity, true);
    assert.equal(result.invalid, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("manual close scripts use the shared UTC process identity check", async () => {
  const [agentRouter, manual] = await Promise.all([
    fs.readFile(path.join(root, "scripts", "Close-AgentRouterLogin.ps1"), "utf8"),
    fs.readFile(path.join(root, "scripts", "Close-ManualLogin.ps1"), "utf8"),
  ]);
  assert.match(agentRouter, /Test-CheckinProcessStartIdentity/);
  assert.match(manual, /Test-CheckinProcessStartIdentity/);
  assert.doesNotMatch(agentRouter, /\[datetime\]::TryParse\(\[string\]\$state\.processStartedAt/);
  assert.doesNotMatch(manual, /\$recordedStartText/);
});
