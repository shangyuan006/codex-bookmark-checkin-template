import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import {checkinCycle,isCurrentCheckinCycle,expireCycleResult} from '../src/checkin-cycle.mjs';
import {stopAtConfiguredTerminal,verifyVisitCheckin,reconcileCheckinResult,successEvidence} from '../src/checkin-evidence.mjs';
import {tryNewApiHttpFirst,apiFirstAllowed} from '../src/new-api-http.mjs';
import {processTarget} from '../src/browser.mjs';
import {quotaChangeEvidence} from '../src/quota-evidence.mjs';
import {classifyNewApiSignInObservation} from '../src/new-api-signin.mjs';
import {statusPageModel,renderStatusPage} from '../src/status-dashboard.mjs';
import {freshNativePreflightResults} from '../src/native-preflight-state.mjs';
import {reuseCycleSuccess,updateSiteState} from '../src/site-state.mjs';

const exec=promisify(execFile);
const origin='https://site.example';
const cycleConfig={siteCycleRules:{[origin]:{timeZone:'Asia/Shanghai',resetAt:'08:30'}}};
const now=new Date('2026-09-17T00:29:59Z');
test('terminal paths stop without claiming success; explicit local exception has user-rule evidence',()=>{
  const url=origin+'/finished';
  const stopped=stopAtConfiguredTerminal(url,{},'terminal_path');
  assert.equal(stopped.status,'needs_attention');assert.equal(stopped.retryable,false);
  const assumed=stopAtConfiguredTerminal(url,{preCheckinNavigationRules:{[origin]:{terminalAssumeSigned:true}}},'terminal_path');
  assert.equal(assumed.status,'already_signed');assert.equal(assumed.evidence.source,'user_rule');assert.equal(assumed.evidence.authoritative,false);
  assert.equal(reconcileCheckinResult({status:'signed'}).status,'unconfirmed');
  assert.equal(reconcileCheckinResult({status:'signed'},successEvidence('status_endpoint','checked_in_today')).status,'signed');
});

test('visit opening time is a gate, not success proof',async()=>{
  let reads=0;
  const readState=async()=>{reads++;return {status:'ready'};};
  const before=await verifyVisitCheckin({after:'08:30'},{url:origin,readState,now});
  assert.equal(before.status,'deferred');assert.equal(before.nextEligibleAt,'2026-09-17T00:30:00.000Z');assert.equal(reads,0);
  const after=await verifyVisitCheckin({after:'08:30'},{url:origin,readState,now:new Date('2026-09-17T01:00Z')});
  assert.equal(after.status,'unconfirmed');assert.equal(reads,1);
  const confirmed=await verifyVisitCheckin({after:'08:30'},{url:origin,now:new Date('2026-09-17T01:00Z'),readState:async()=>({status:'already_signed'})});
  assert.equal(confirmed.evidence.source,'page_text');
});

test('explicit visit exception requires open time, ready page and verified login',async()=>{
  const rule={after:'08:30',assumeSignedAfterVisit:true};
  const base={url:origin,now:new Date('2026-09-17T01:00Z'),readState:async()=>({status:'ready'}),verifySession:async()=>({status:'valid'})};
  const result=await verifyVisitCheckin(rule,base);
  assert.equal(result.status,'signed');assert.equal(result.evidence.source,'user_rule');
  assert.equal(result.evidence.authoritative,false);assert.equal(result.evidence.confirmedAt,base.now.toISOString());
  assert.equal((await verifyVisitCheckin(rule,{...base,now})).status,'deferred');
  assert.equal((await verifyVisitCheckin(rule,{...base,verifySession:undefined})).status,'unconfirmed');
  assert.equal((await verifyVisitCheckin(rule,{...base,verifySession:async()=>({status:'invalid'})})).status,'login_required');
  for(const status of ['login_required','interactive_challenge','managed_challenge_timeout','deferred','error','unconfirmed']){
    const blocked=await verifyVisitCheckin(rule,{...base,readState:async()=>({status})});
    assert.notEqual(blocked.status,'signed',status);
  }
  assert.equal((await verifyVisitCheckin(rule,{...base,readState:async()=>({status:'ready',unresolvedChallenge:true})})).status,'unconfirmed');
});

test('cycles cross midnight but expire exactly at the configured boundary',()=>{
  assert.equal(checkinCycle(origin,cycleConfig,now).startAt,'2026-09-16T00:30:00.000Z');
  assert.equal(isCurrentCheckinCycle(origin,'2026-09-16T12:00Z',cycleConfig,now),true);
  const next=new Date('2026-09-17T00:30Z');
  assert.equal(isCurrentCheckinCycle(origin,'2026-09-16T12:00Z',cycleConfig,next),false);
  assert.equal(isCurrentCheckinCycle(origin,'2026-09-18T00:00Z',cycleConfig,next),false);
  assert.equal(expireCycleResult({origin,status:'signed',observedAt:'2026-09-16T12:00Z'},cycleConfig,next).status,'unconfirmed');
  const report={generatedAt:'2026-09-16T12:00Z',results:[{origin,status:'signed',observedAt:'2026-09-16T12:00Z'}]};
  assert.equal(freshNativePreflightResults(report,new Set([origin]),now,cycleConfig).size,1);
  assert.equal(freshNativePreflightResults(report,new Set([origin]),next,cycleConfig).size,0);
});

test('cycle cache does not restamp observation time or change reauthentication accounts',()=>{
  const at=new Date('2026-09-16T12:00Z');
  const state=updateSiteState({sites:{}},[{origin,status:'signed',reason:'confirmed'}],at);
  const cached=reuseCycleSuccess({origin},state,cycleConfig,now);
  assert.equal(cached.observedAt,at.toISOString());
  assert.equal(reuseCycleSuccess({origin},state,{...cycleConfig,reauthCheckinRules:{[origin]:{}}},now),null);
});

test('timezone cycle respects DST and rejects invalid reset times',()=>{
  const config={siteCycleRules:{[origin]:{timeZone:'America/New_York',resetAt:'08:30'}}};
  const cycle=checkinCycle(origin,config,new Date('2026-03-08T11:00Z'));
  assert.equal(Date.parse(cycle.endAt)-Date.parse(cycle.startAt),23*3600000);
  assert.throws(()=>checkinCycle(origin,{siteCycleRules:{[origin]:{resetAt:'25:99'}}}),/HH:mm/);
  assert.throws(()=>checkinCycle(origin,{siteCycleRules:{[origin]:{timeZone:'Invalid/Zone'}}}));
});

test('PowerShell checkpoint and wrapper use the same cycle boundary',async()=>{
  const {stdout}=await exec('pwsh',['-NoProfile','-Command',`
    . ./scripts/CheckinCycle.ps1
    $c=[pscustomobject]@{siteCycleRules=[pscustomobject]@{'${origin}'=[pscustomobject]@{timeZone='Asia/Shanghai';resetAt='08:30'}}}
    $r=[pscustomobject]@{origin='${origin}';status='signed';observedAt='2026-09-16T12:00:00Z'}
    @((Test-CheckinCycleCurrent $r $c ([datetimeoffset]'2026-09-17T00:29:59Z')),(Test-CheckinCycleCurrent $r $c ([datetimeoffset]'2026-09-17T00:30:00Z'))) | ConvertTo-Json -Compress
  `],{windowsHide:true});
  assert.deepEqual(JSON.parse(stdout),[true,false]);
});

test('scheduler can revisit a newly due cycle while preserving manual pause and daily attempt limits',async()=>{
  const source=await fs.readFile(new URL('../scripts/Start-UserScheduler.ps1',import.meta.url),'utf8');
  const start=source.indexOf('function Test-SchedulerWaiting('),end=source.indexOf('function Write-SchedulerClaim(',start);
  const {stdout}=await exec('pwsh',['-NoProfile','-Command',`
    ${source.slice(start,end)}
    $now=[datetime]'2026-09-17T10:00:00';$config=[pscustomobject]@{schedulerMaxDailyAttempts=5}
    $state=[pscustomobject]@{lastRunDate='2026-09-17';reportComplete=$true;lastAttemptDate='2026-09-17';attemptsToday=1}
    $handoff=[pscustomobject]@{Mode='none'};$latest=[pscustomobject]@{Valid=$true;DueOrigins=@('${origin}')}
    $due=Test-SchedulerWaiting $state $now $config $handoff $latest
    $handoff.Mode='manual_session';$manual=Test-SchedulerWaiting $state $now $config $handoff $latest
    $handoff.Mode='none';$state.attemptsToday=5;$limited=Test-SchedulerWaiting $state $now $config $handoff $latest
    [pscustomobject]@{due=$due;manual=$manual;limited=$limited}|ConvertTo-Json -Compress
  `],{windowsHide:true});
  assert.deepEqual(JSON.parse(stdout),{due:false,manual:true,limited:true});
});

function httpFixture(responses){
  const calls=[];
  const context={request:{fetch:async(url,options)=>{
    calls.push({url,options});const next=responses.shift();
    if(next instanceof Error)throw next;
    return {url:()=>url,status:()=>next?.httpStatus??200,text:async()=>JSON.stringify(next?.body??next),dispose:async()=>{}};
  }}};
  return {calls,context};
}
const apiConfig={apiFirstOrigins:[origin],newApiCheckinOrigins:[origin]};
const self={success:true,data:{id:123}};
const checked=value=>({success:true,data:{checked_in_today:value}});
test('HTTP fast path confirms without creating a browser tab or exporting credentials',async()=>{
  const {context,calls}=httpFixture([self,checked(true)]);
  context.newPage=()=>{throw new Error('must not open a page');};
  const result=await processTarget(context,{origin,candidates:[origin]},apiConfig,[],null);
  assert.equal(result.status,'already_signed');assert.equal(result.evidence.source,'status_endpoint');
  assert.equal(result.metrics.pageLoads,0);assert.equal(result.metrics.requests,2);
  assert.ok(calls.every(call=>call.options.maxRedirects===0));
  assert.equal(JSON.stringify(result).includes('123'),false);
});

test('HTTP fast path falls back before submission when initialization is missing',async()=>{
  const fixture=httpFixture([{httpStatus:403,body:{}}]);
  const result=await tryNewApiHttpFirst(fixture.context,{origin},apiConfig);
  assert.equal(result.fallback,true);assert.equal(fixture.calls.length,1);
  assert.equal(apiFirstAllowed({origin},{...apiConfig,newApiCaptchaRules:{[origin]:{}}}),false);
  assert.equal(await tryNewApiHttpFirst(fixture.context,{origin},{}),null);
});

test('HTTP submission is sent once and uncertainty cannot cause a page resubmission',async()=>{
  const fixture=httpFixture([self,checked(false),new Error('lost response'),checked(false),checked(false),checked(false),checked(false)]);
  const result=await tryNewApiHttpFirst(fixture.context,{origin},apiConfig,{wait:async()=>{}});
  assert.equal(result.fallback,false);assert.equal(result.result.retryable,false);assert.equal(result.result.submissionAttempted,true);
  assert.equal(fixture.calls.filter(c=>c.options.method==='POST').length,1);
});

test('HTTP response alone is insufficient; status reread confirms the action',async()=>{
  const fixture=httpFixture([self,checked(false),{success:true},checked(true)]);
  const result=await tryNewApiHttpFirst(fixture.context,{origin},apiConfig,{wait:async()=>{}});
  assert.equal(result.result.status,'signed');assert.equal(fixture.calls.length,4);
});

test('consumption-aware evidence rejects counter resets and total changes without corroboration',()=>{
  const evidence=quotaChangeEvidence({quota:10,usedQuota:20},{quota:10,usedQuota:45},25);
  assert.equal(evidence.balanceIncreased,false);assert.equal(evidence.totalRewardMatched,true);
  assert.equal(quotaChangeEvidence({quota:10,usedQuota:20},{quota:50,usedQuota:5},25).totalRewardMatched,false);
  const rule={rewardAmount:25,quotaIncludesUsage:true};
  const observation={state:'called',totalRewardMatched:true,responseSuccess:false};
  assert.equal(classifyNewApiSignInObservation(observation,rule).status,'unconfirmed');
  assert.equal(classifyNewApiSignInObservation({...observation,responseSuccess:true},rule).status,'signed');
  assert.equal(classifyNewApiSignInObservation({...observation,responseSuccess:true},{...rule,quotaIncludesUsage:false}).status,'unconfirmed');
});

test('status page omits credentials and raw balances, escapes markup, and disallows network requests',()=>{
  const model=statusPageModel({runState:'final',isComplete:true,results:[{origin:origin+'/profile?token=secret',status:'signed',reason:'<img src=x onerror=alert(1)>',cookie:'{fixture-cookie}',quota:123456,evidence:{source:'status_endpoint'},accountResults:[{provider:'GitHub',status:'signed',email:'person@example.com'}]}]});
  const html=renderStatusPage(model);
  assert.equal(html.includes('<img src=x'),false);assert.ok(html.includes('&lt;img'));
  for(const value of ['{fixture-cookie}','123456','person@example.com','token=secret'])assert.equal(html.includes(value),false);
  assert.ok(html.includes("default-src 'none'"));assert.equal(html.includes('fetch('),false);
  assert.equal(model.rows[0].host,'site.example');
});
