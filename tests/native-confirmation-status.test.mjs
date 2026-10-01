import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {nativePreflightProgress} from '../src/native-preflight-state.mjs';
const exec=promisify(execFile);
const quote=value=>value.replaceAll("'","''");

test('native confirmation status is fail-closed and distinguishes a read from a confirmed action',async()=>{
  const {stdout}=await exec('pwsh',['-NoProfile','-NonInteractive','-Command',`
    . ./scripts/NativePreflightCheckpoint.ps1
    @(
      (Get-NativePreflightConfirmationStatus ([pscustomobject]@{status='already_signed';actionAttempted=$false}) $true $false)
      (Get-NativePreflightConfirmationStatus ([pscustomobject]@{status='signed'}) $true $false)
      (Get-NativePreflightConfirmationStatus ([pscustomobject]@{status='already_signed';actionAttempted=$true;actionOutcome='clicked'}) $true $false)
      (Get-NativePreflightConfirmationStatus ([pscustomobject]@{status='already_signed';actionAttempted=$true;actionOutcome='confirmation_timeout'}) $true $false)
      (Get-NativePreflightConfirmationStatus ([pscustomobject]@{status='ready'}) $false $true)
      (Get-NativePreflightConfirmationStatus ([pscustomobject]@{status='signed'}) $false $false)
      (Get-NativePreflightConfirmationStatus ([pscustomobject]@{status='unconfirmed';actionAttempted=$true;actionOutcome='clicked'}) $true $false)
    ) | ConvertTo-Json -Compress
  `],{windowsHide:true});
  assert.deepEqual(JSON.parse(stdout.trim()),['already_signed','signed','signed','already_signed','signed',null,null]);
});

for (const fixture of [
  {name:'existing completion',inspection:{status:'already_signed',actionAttempted:false},expected:'already_signed',action:true},
  {name:'new completion signal',inspection:{status:'signed',actionAttempted:false},expected:'signed',action:false},
  {name:'confirmed click',inspection:{status:'already_signed',actionAttempted:true,actionOutcome:'clicked'},expected:'signed',action:true},
  {name:'New API no-op',inspection:{status:'already_signed',newApiAttempted:true,newApiConfirmed:true},expected:'already_signed',newApi:true},
  {name:'unconfirmed click',inspection:{status:'unconfirmed',actionAttempted:true,actionOutcome:'clicked'},expected:'unconfirmed',action:true},
  {name:'configured endpoint completion',inspection:{status:'ready',siteBodyLoaded:true,attendanceEndpoint:true},expected:'signed',endpoint:true},
]) {
  test(`native production checkpoint and final result agree on ${fixture.name}`,async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'native-status-'));
    try {
      const source=await fs.readFile(new URL('../scripts/Prepare-NativeWafSession.ps1',import.meta.url),'utf8');
      const start=source.indexOf('    for ($inspectionAttempt = 1;');
      const end=source.indexOf('\n}\n\nWrite-Output',start);
      assert.ok(start>0&&end>start);
      await fs.writeFile(path.join(dir,'Open-PlainLoginChrome.ps1'),'$global:opened=$true');
      const checkpoint=path.join(dir,'result.json');
      const {stdout}=await exec('pwsh',['-NoProfile','-NonInteractive','-Command',`
        $ErrorActionPreference='Stop'
        . ./scripts/NativePreflightCheckpoint.ps1
        $PSScriptRoot='${quote(dir)}'
        $node='Inspect-Fixture'; $inspector='unused'
        function Inspect-Fixture { $global:LASTEXITCODE=0; '${JSON.stringify(fixture.inspection)}' }
        function Start-Sleep {}
        function Close-AutomationBrowser {}
        $item=[pscustomobject]@{nativeMinimal=$true;waitSeconds=5;trustAsSigned=$${!!fixture.endpoint};maxAttempts=1}
        $profilePath='fixture'; $url='https://one.example/profile'; $origin='https://one.example'
        $hostName='one.example'; $browser=[pscustomobject]@{DisplayName='Fixture'}; $AttemptId='fixture'
        $inspection=$null; $lastInspection=$null; $config=$null
        $hasAction=$${!!fixture.action}; $hasNewApiCheckin=$${!!fixture.newApi}; $actionConfigBase64=''
        $preflightResults=@(); $preflightPath='${quote(checkpoint)}'
        ${source.slice(start,end)}
        [pscustomobject]@{finalStatus=$preflightResults[0].status;inspectionStatus=$preflightResults[0].inspectionStatus} | ConvertTo-Json -Compress
      `],{windowsHide:true});
      const finalResult=JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
      const persisted=JSON.parse(await fs.readFile(checkpoint,'utf8'));
      assert.equal(finalResult.finalStatus,fixture.expected);
      assert.equal(finalResult.inspectionStatus,fixture.inspection.status);
      assert.equal(persisted.results[0].status,fixture.expected);
      if (fixture.expected==='already_signed') {
        const [progress]=nativePreflightProgress([{origin:'https://one.example'}],
          new Map([['https://one.example',persisted.results[0]]]));
        assert.equal(progress.status,'already_signed');
      }
    } finally {await fs.rm(dir,{recursive:true,force:true});}
  });
}
