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
const helperPath = path.join(root, "scripts", "ManualAbandonment.ps1");

const driverSource = String.raw`param(
    [string]$HelperPath,
    [string]$StatePath,
    [string]$Now
)
. $HelperPath
$origins = Get-TodayAbandonedOrigins -Path $StatePath -Now ([datetime]$Now)
[ordered]@{ origins = @($origins.Keys | Sort-Object) } | ConvertTo-Json -Compress
`;

async function readAbandonment(contents, now = "2026-08-25T08:00:00+08:00") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "manual-abandonment-"));
  const statePath = path.join(directory, "manual-abandon.json");
  const driverPath = path.join(directory, "driver.ps1");
  try {
    await Promise.all([
      fs.writeFile(statePath, contents, "utf8"),
      fs.writeFile(driverPath, driverSource, "utf8"),
    ]);
    const { stdout } = await execFileAsync(powershellExecutable, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", driverPath,
      "-HelperPath", helperPath,
      "-StatePath", statePath,
      "-Now", now,
    ], { cwd: root, encoding: "utf8" });
    return JSON.parse(stdout.trim()).origins;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("manual abandonment accepts only today's canonical HTTPS origins", async () => {
  const origins = await readAbandonment(JSON.stringify({
    schemaVersion: 1,
    date: "20260825",
    origins: ["https://ONE.example/", "https://two.example:8443"],
  }));
  assert.deepEqual(origins, ["https://one.example", "https://two.example:8443"]);
});

test("manual abandonment ignores stale, malformed, or unsafe state", async () => {
  assert.deepEqual(await readAbandonment(JSON.stringify({
    schemaVersion: 1,
    date: "20260824",
    origins: ["https://one.example"],
  })), []);
  assert.deepEqual(await readAbandonment("{invalid"), []);
  assert.deepEqual(await readAbandonment(JSON.stringify({
    schemaVersion: 1,
    date: "20260825",
    origins: ["https://one.example", "https://two.example/private?token=hidden"],
  })), []);
  assert.deepEqual(await readAbandonment(JSON.stringify({
    schemaVersion: 1,
    date: "20260825",
    origins: ["http://one.example"],
  })), []);
});
