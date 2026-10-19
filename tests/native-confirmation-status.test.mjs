import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {nativePreflightProgress} from '../src/native-preflight-state.mjs';
import {bindSuccessEvidence,successEvidence} from '../src/checkin-evidence.mjs';
const exec=promisify(execFile);
const quote=value=>value.replaceAll("'","''");

test('PowerShell manual completion preserves sequential evidence through the final write',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'native-manual-evidence-'));
  try {
    const file=path.join(dir,'verification.json');
    const origin='https://one.example';
    const actionResult=bindSuccessEvidence({status:'already_signed',evidence:successEvidence('page_text','sequential_step_confirmed')},
      {origin,actionType:'daily_checkin'});
    const result=bindSuccessEvidence({status:'signed',evidence:successEvidence('page_text','native_confirmed_completion'),
      actionResults:[actionResult],requiredActionTypes:['daily_checkin'],submissionTrackedPerAction:true},{origin});
    await exec('pwsh',['-NoProfile','-NonInteractive','-Command',`
      $ErrorActionPreference='Stop'
      . ./scripts/ManualVerification.ps1
      $origin='https://one.example'
      $result='${quote(JSON.stringify(result))}' | ConvertFrom-Json
      $doc=[pscustomobject]@{state='pending_verification';authoritativeEvidenceRequired=$true;
        targets=@([pscustomobject]@{origin=$origin;verificationStatus='pending'})}
      $pending=[pscustomobject]@{Document=$doc;Origins=@($origin)}
      $report=[pscustomobject]@{runId='fixture';runState='final';isComplete=$true;plannedTotal=1;processedTotal=1;results=@($result)}
      $update=Update-ManualVerificationState $pending $report '${quote(file)}' (Get-Date)
      if (-not $update.Updated) { throw 'Manual state was not updated' }
    `],{windowsHide:true});
    const persisted=JSON.parse(await fs.readFile(file,'utf8'));
    assert.equal(persisted.targets[0].actionResults[0].actionType,'daily_checkin');
    assert.deepEqual(persisted.targets[0].requiredActionTypes,['daily_checkin']);
    assert.equal(persisted.targets[0].submissionTrackedPerAction,true);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

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
  {name:'SafeLine completion diagnostics',inspection:{status:'already_signed',actionAttempted:false,
    safeLineDiagnostics:{observed:true,submissionBlocked:true,attempted:true,probeCount:1,clickCount:1,
      outcome:'safeline_resolved',elapsedMs:500,finalStatus:'already_signed'}},expected:'already_signed',action:true},
  {name:'SafeLine handoff diagnostics',inspection:{status:'interactive_challenge',failureCode:'safeline_client_challenge',
    safeLineDiagnostics:{observed:true,submissionBlocked:true,attempted:true,probeCount:1,clickCount:1,
      outcome:'safeline_rejected',elapsedMs:500,finalStatus:'interactive_challenge'}},expected:'interactive_challenge',action:true},
  {name:'configured endpoint completion',inspection:{status:'ready',siteBodyLoaded:true,attendanceEndpoint:true},expected:'signed',endpoint:true},
  {name:'sequential completion',inspection:{status:'already_signed',actionResults:[{origin:'https://one.example',
    actionType:'daily_checkin',status:'already_signed',evidence:{source:'page_text',authoritative:true,
      confirmedAt:'2026-10-08T04:00:00Z',binding:{version:2,siteOrigin:'https://one.example',observedOrigin:'https://one.example',
        accountKey:'default',actionType:'daily_checkin',cycleId:'fixture'}}}],
    requiredActionTypes:['daily_checkin'],submissionTrackedPerAction:true},expected:'already_signed',action:true},
]) {
  test(`native production checkpoint and final result agree on ${fixture.name}`,async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'native-status-'));
    try {
      const source=await fs.readFile(new URL('../scripts/Prepare-NativeWafSession.ps1',import.meta.url),'utf8');
      const start=source.indexOf('    $inspectionLimit =');
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
      if (fixture.inspection.safeLineDiagnostics) {
        assert.deepEqual(persisted.results[0].safeLineDiagnostics,fixture.inspection.safeLineDiagnostics);
      }
      if (fixture.inspection.actionResults) {
        assert.deepEqual(persisted.results[0].actionResults,fixture.inspection.actionResults);
        assert.deepEqual(persisted.results[0].requiredActionTypes,fixture.inspection.requiredActionTypes);
        assert.equal(persisted.results[0].submissionTrackedPerAction,true);
      }
      if (fixture.expected==='already_signed') {
        const [progress]=nativePreflightProgress([{origin:'https://one.example'}],
          new Map([['https://one.example',persisted.results[0]]]));
        assert.equal(progress.status,'already_signed');
        if (fixture.inspection.safeLineDiagnostics) {
          assert.deepEqual(progress.safeLineDiagnostics,fixture.inspection.safeLineDiagnostics);
        }
      }
    } finally {await fs.rm(dir,{recursive:true,force:true});}
  });
}
