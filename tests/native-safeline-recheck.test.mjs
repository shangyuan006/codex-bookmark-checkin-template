import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const quote = value => `'${value.replaceAll("'", "''")}'`;

for (const recovered of [true, false]) test(`SafeLine ${recovered ? 'resolution allows exactly one read-only renderer retry' : 'failure cannot reopen the verification window'}`, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'safeline-recheck-'));
  try {
    await fs.writeFile(path.join(dir, 'Open-PlainLoginChrome.ps1'), 'param([switch]$Offscreen,[switch]$NativeMinimal,$RemoteDebuggingPort,$UserDataDirOverride,$Urls)');
    const inspector = path.join(dir, 'inspect.mjs'), records = path.join(dir, 'modes.txt');
    await fs.writeFile(inspector, `
import fs from 'node:fs';
const mode=process.argv[5];
fs.appendFileSync(${JSON.stringify(records)},mode+'\\n');
console.log(JSON.stringify(mode==='verify-checkin'
 ? {status:'already_signed',safeLineDiagnostics:null,readOnlyDiagnostics:{outcome:'completed',polls:1}}
 : {status:'needs_attention',failureCode:'submission_quarantined',safeLineDiagnostics:{outcome:'${recovered ? 'safeline_resolved' : 'safeline_rejected'}',clickCount:1}}));
`);
    const source = await fs.readFile(new URL('../scripts/Prepare-NativeWafSession.ps1', import.meta.url), 'utf8');
    const start = source.indexOf('    $inspectionLimit =');
    const end = source.indexOf('\n    $explicitlyConfirmed =', start);
    assert.ok(start > 0 && end > start);
    const { stdout } = await exec('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference='Stop'
$PSScriptRoot=${quote(dir)}; $root=$PSScriptRoot
$node=${quote(process.execPath)}; $inspector=${quote(inspector)}
$item=[pscustomobject]@{maxAttempts=1;nativeMinimal=$true;waitSeconds=90}
$inspection=$null;$lastInspection=$null;$hasAction=$true;$hasNewApiCheckin=$false
$inspectionMode='execute-checkin';$actionConfigBase64='';$origin='https://checkin.example';$url=$origin+'/'
$profilePath='fixture';$preflightPath='fixture';$preflightResults=@();$config=@{}
function Start-Sleep {}
function Close-AutomationBrowser {param($ProfilePath)}
function Complete-NativePreflightAttempt {param($Cleanup,$Failure) & $Cleanup}
function Write-NativePreflightCheckpoint {param($Path,$Results,$Config)}
function Get-NativePreflightConfirmationStatus {param($Inspection,$Explicit,$Endpoint) $Inspection.status}
${source.slice(start, end)}
[pscustomobject]@{attempted=$readOnlyRecheckAttempted;status=$lastInspection.status;safeLine=$lastInspection.safeLineDiagnostics;readOnly=$lastInspection.readOnlyDiagnostics}|ConvertTo-Json -Compress
`], { windowsHide: true, timeout: 20000 });
    const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(result.attempted, recovered);
    assert.equal((await fs.readFile(records, 'utf8')).trim(), recovered ? 'execute-checkin\nverify-checkin' : 'execute-checkin');
    assert.equal(result.safeLine.clickCount, 1);
    assert.equal(result.status, recovered ? 'already_signed' : 'needs_attention');
    if (recovered) assert.equal(result.readOnly.outcome, 'completed');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
