import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {freshNativePreflightResults, nativePreflightProgress} from '../src/native-preflight-state.mjs';
const exec=promisify(execFile);
test('per-site checkpoint survives a later failure and atomically replaces prior JSON',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'checkin-checkpoint-'));
  const file=path.join(dir,'native.json');
  try {
    const escaped=file.replaceAll("'","''");
    await assert.rejects(exec('pwsh',['-NoProfile','-Command',`
      . ./scripts/NativePreflightCheckpoint.ps1
      $results=@([pscustomobject]@{origin='https://one.example';status='signed'})
      Write-NativePreflightCheckpoint '${escaped}' $results
      $first=Get-Content -Raw '${escaped}'|ConvertFrom-Json
      $results[0].observedAt=$first.results[0].observedAt
      $results+=@([pscustomobject]@{origin='https://two.example';status='signed'})
      Write-NativePreflightCheckpoint '${escaped}' $results
      try { throw 'later browser launch failed' } catch { exit 17 }
    `],{windowsHide:true}),error=>error.code===17);
    const report=JSON.parse(await fs.readFile(file,'utf8'));
    assert.deepEqual(report.results.map(r=>r.origin),['https://one.example','https://two.example']);
    assert.ok(report.results.every(r=>r.status==='signed'&&Number.isFinite(Date.parse(r.observedAt))));
    assert.deepEqual(await fs.readdir(dir),['native.json']);
    const script=await fs.readFile(new URL('../scripts/Prepare-NativeWafSession.ps1',import.meta.url),'utf8');
    const immediate=script.indexOf('$confirmedResult =');
    const persist=script.indexOf('Write-NativePreflightCheckpoint',immediate);
    assert.ok(persist>immediate&&persist<script.indexOf('Close-AutomationBrowser $profilePath',immediate));
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('confirmations last for their local day, without admitting future or previous-day evidence',()=>{
  const now=new Date(2026,8,14,0,5);
  const origin='https://one.example';
  const allowed=new Set([origin]);
  const report=observedAt=>({generatedAt:now.toISOString(),results:[{origin,status:'signed',observedAt}]});
  assert.equal(freshNativePreflightResults(report(new Date(2026,8,14,0,4).toISOString()),allowed,now).size,1);
  for(const observed of [new Date(2026,8,13,23,59),new Date(2026,8,13,23,45),new Date(2026,8,14,0,6)]){
    assert.equal(freshNativePreflightResults(report(observed.toISOString()),allowed,now).size,0);
  }
  assert.equal(freshNativePreflightResults(report(now.toISOString()),new Set(),now).size,0);
  const afternoon=new Date(2026,8,14,16,0);
  const morning=new Date(2026,8,14,8,0).toISOString();
  assert.equal(freshNativePreflightResults({generatedAt:morning,results:[{origin,status:'signed',observedAt:morning}]},allowed,afternoon).size,1);
  for (const status of ['prepared','unconfirmed','clicked']) {
    assert.equal(freshNativePreflightResults({generatedAt:morning,results:[{origin,status,observedAt:morning}]},allowed,afternoon).size,0);
  }
});

test('a new invocation preserves same-day confirmations across scope changes and failed retries',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'checkin-checkpoint-'));
  const file=path.join(dir,'native.json');
  try {
    const escaped=file.replaceAll("'","''");
    const observedAt=new Date().toISOString();
    await fs.writeFile(file,JSON.stringify({generatedAt:observedAt,results:[
      {origin:'https://one.example',status:'signed',observedAt},
      {origin:'https://old.example',status:'signed',observedAt:new Date(Date.now()-86400000).toISOString()},
      {origin:'https://future.example',status:'signed',observedAt:new Date(Date.now()+86400000).toISOString()},
      {origin:'https://pending.example',status:'prepared',observedAt},
    ]}));
    await exec('pwsh',['-NoProfile','-Command',`
      . ./scripts/NativePreflightCheckpoint.ps1
      Write-NativePreflightCheckpoint '${escaped}' @([pscustomobject]@{origin='https://two.example';status='signed'})
    `],{windowsHide:true});
    await exec('pwsh',['-NoProfile','-Command',`
      . ./scripts/NativePreflightCheckpoint.ps1
      Write-NativePreflightCheckpoint '${escaped}' @([pscustomobject]@{origin='https://one.example';status='unconfirmed'})
    `],{windowsHide:true});
    const report=JSON.parse(await fs.readFile(file,'utf8'));
    assert.deepEqual(report.results.map(r=>r.origin),['https://one.example','https://two.example']);
    assert.equal(report.results[0].status,'signed');
    assert.equal(Date.parse(report.results[0].observedAt),Date.parse(observedAt));
    assert.deepEqual(await fs.readdir(dir),['native.json']);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('native progress contains selected confirmations before OAuth and browser startup',async()=>{
  const one={origin:'https://one.example',title:'Example',folderNames:['test']};
  const confirmations=new Map([
    [one.origin,{status:'signed',url:`${one.origin}/profile`,observedAt:'2026-09-14T00:00:00Z'}],
    ['https://outside.example',{status:'signed'}],
  ]);
  const results=nativePreflightProgress([one,{origin:'https://pending.example'}],confirmations);
  assert.equal(results.length,1);
  assert.equal(results[0].origin,one.origin);
  assert.equal(results[0].nativePreflight,true);
  assert.equal(results[0].observedAt,'2026-09-14T00:00:00Z');
  const index=await fs.readFile(new URL('../src/index.mjs',import.meta.url),'utf8');
  const seed=index.indexOf('results.push(...nativeCompletedResults)');
  const progress=index.indexOf('await writeProgress("initial")');
  assert.ok(seed>0&&seed<progress&&progress<index.indexOf('for (let index = 0; index < configuredReauthTargets.length'));
  assert.ok(index.includes('selectedTargets.filter(target => !getConfiguredReauthRule(target, config)'));
  assert.ok(index.includes('if (precompletedOrigins.has(target.origin)) continue;'));
  assert.ok(!index.includes('fs.rm(nativeWafPreflightPath'));
});

for (const failure of ['launch','persist','persist-and-close','close']) {
  test(`native attempt closes its browser and retains the primary error on ${failure} failure`,async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'checkin-checkpoint-'));
    try {
      // Execute the production attempt loop with only browser I/O replaced by fixtures.
      const script=await fs.readFile(new URL('../scripts/Prepare-NativeWafSession.ps1',import.meta.url),'utf8');
      const start=script.indexOf('    for ($inspectionAttempt = 1;');
      const end=script.indexOf('    $explicitlyConfirmed =',start);
      assert.ok(start>0&&end>start);
      await fs.writeFile(path.join(dir,'Open-PlainLoginChrome.ps1'),failure==='launch'?"throw 'launch failed'":"$global:opened = $true");
      const {stdout}=await exec('pwsh',['-NoProfile','-Command',`
        $ErrorActionPreference='Stop'
        . ./scripts/NativePreflightCheckpoint.ps1
        $PSScriptRoot='${dir.replaceAll("'","''")}'
        $node='Inspect-Fixture'
        function Inspect-Fixture { $global:LASTEXITCODE=0; '{"status":"signed","actionAttempted":true}' }
        function Start-Sleep {}
        function Write-NativePreflightCheckpoint { ${failure.startsWith('persist')?"throw 'persist failed'":"$global:persisted=$true"} }
        function Close-AutomationBrowser { $global:closed++; ${failure.includes('close')?"throw 'close failed'":''} }
        $global:closed=0
        $item=[pscustomobject]@{nativeMinimal=$true;waitSeconds=5;trustAsSigned=$false;maxAttempts=2}
        $profilePath='fixture'; $url='https://one.example/profile'; $origin='https://one.example'
        $inspection=$null; $hasAction=$true; $hasNewApiCheckin=$false; $preflightResults=@()
        try { ${script.slice(start,end)}; throw 'expected failure was not raised' }
        catch { [pscustomobject]@{message=$_.Exception.Message;closed=$global:closed;cleanupFailed=[bool]$_.Exception.Data['BrowserCleanupFailed']} | ConvertTo-Json -Compress }
      `],{windowsHide:true});
      const result=JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
      assert.equal(result.message,failure.startsWith('persist')?'persist failed':`${failure} failed`);
      assert.equal(result.closed,1);
      assert.equal(result.cleanupFailed,failure==='persist-and-close');
    } finally {await fs.rm(dir,{recursive:true,force:true});}
  });
}
