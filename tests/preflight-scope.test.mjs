import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
test('preflight scope excludes unrelated, abandoned and disabled targets', async()=>{
  const {stdout}=await exec('pwsh',['-NoProfile','-Command',`
    . ./scripts/PreflightScope.ps1
    $targets=@('https://account.example','https://cancelled.example','https://closed.example','https://other.example') | ForEach-Object { [pscustomobject]@{origin=$_} }
    $account=@(Select-CheckinPreflightTargets $targets @('https://account.example') @('https://cancelled.example','https://closed.example'))
    $all=@(Select-CheckinPreflightTargets $targets @() @('https://cancelled.example','https://closed.example'))
    $cancelled=@(Select-CheckinPreflightTargets $targets @('https://cancelled.example') @('https://cancelled.example'))
    [pscustomobject]@{account=@($account.origin);all=@($all.origin);cancelled=$cancelled.Count}|ConvertTo-Json -Compress
  `],{windowsHide:true});
  const result=JSON.parse(stdout);
  assert.deepEqual(result.account,['https://account.example']);
  assert.deepEqual(result.all,['https://account.example','https://other.example']);
  assert.equal(result.cancelled,0);
});

test('second-attempt preflight follows the actual fallback origins in runner arguments',async()=>{
  const {stdout}=await exec('pwsh',['-NoProfile','-Command',`
    . ./scripts/PreflightScope.ps1
    $targets=@('https://fallback.example','https://unresolved.example') | ForEach-Object { [pscustomobject]@{origin=$_} }
    $runArguments=@('src/index.mjs','--resume-report','prior.json','--origins','https://fallback.example')
    $scope=@(Get-CheckinRunOrigins $runArguments)
    $selected=@(Select-CheckinPreflightTargets $targets $scope)
    [pscustomobject]@{scope=$scope;origins=@($selected.origin)}|ConvertTo-Json -Compress
  `],{windowsHide:true});
  const result=JSON.parse(stdout);
  assert.deepEqual(result.scope,['https://fallback.example']);
  assert.deepEqual(result.origins,result.scope);
});
