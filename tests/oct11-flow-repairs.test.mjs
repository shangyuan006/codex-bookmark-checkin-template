import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {readNativeCheckinState, waitForNativeReadOnlyCompletion, resumeNativeDailyCycle} from '../src/native-checkin-state.mjs';
import {normalizeNativeCheckinActionRule} from '../src/native-checkin-action.mjs';
import {createSubmissionScope, readSubmissionJournal, reconcileSubmissionResult, guardPageSubmissions} from '../src/submission-guard.mjs';
import {dailyReadinessEvidence, bindSuccessEvidence, successEvidence, clearResolvedFailureFields} from '../src/checkin-evidence.mjs';
import {loginHelperOutcome, loginHelperOutcomeFromStreams} from '../src/login-recovery.mjs';
import {reauthLoginFailureResult} from '../src/reauth-checkin.mjs';
import {sanitizeOAuthFlowDiagnostic, writeOAuthFlowDiagnostic} from '../src/oauth-flow-diagnostics.mjs';
import {nativePreflightProgress} from '../src/native-preflight-state.mjs';
import {createNativeSafeLineReader} from '../src/native-safeline-recovery.mjs';

const origin='https://daily.example';
const target={origin};
const unsignedRule=normalizeNativeCheckinActionRule({actionTexts:['签到'],dailyUnsignedTextPattern:'今日未签到'});
function pageSnapshot(overrides={}) {
  return {url:()=>origin+'/',title:async()=>'',evaluate:async()=>({
    bodyText:'今日未签到 '+'.'.repeat(100),loaded:true,authenticated:true,hasPassword:false,
    controlTexts:['签到'],challengeEvidence:[],...overrides,
  })};
}
const stateOptions={readFrames:async()=>[],verifySession:async()=>null,unsignedRule};

test('native daily readiness requires explicit unsigned text, a loaded authenticated page, and no blocker',async()=>{
  const result=await readNativeCheckinState(pageSnapshot(),origin,{},stateOptions);
  assert.equal(result.state.status,'ready');
  assert.equal(result.dailyReadiness.status,'not_signed');
  assert.equal(result.dailyReadiness.evidence.authoritative,true);
  assert.equal(result.dailyReadiness.evidence.binding.siteOrigin,origin);
  for (const overrides of [
    {bodyText:'立即签到 '+'.'.repeat(100)}, {loaded:false}, {authenticated:false}, {hasPassword:true},
    {controlTexts:['今日已签到']},
    {challengeEvidence:[{visible:true,resolvedState:false,responsePresent:false}]},
  ]) assert.equal((await readNativeCheckinState(pageSnapshot(overrides),origin,{},stateOptions)).dailyReadiness,undefined);
  assert.equal((await readNativeCheckinState(pageSnapshot(),origin,{}, {...stateOptions,unsignedRule:null})).dailyReadiness,undefined);
  const invalid={savedLoginSessionRules:{[origin]:{type:'new_api'}}};
  assert.equal((await readNativeCheckinState(pageSnapshot(),origin,invalid,
    {...stateOptions,verifySession:async()=>({status:'invalid'})})).dailyReadiness,undefined);
});

test('native negative evidence ends passive waiting without declaring completion',async()=>{
  const current={state:{status:'ready'},dailyReadiness:dailyReadinessEvidence(target)};
  const result=await waitForNativeReadOnlyCompletion({waitForTimeout:async()=>assert.fail('no extra wait')},origin,{},
    {readState:async()=>current});
  assert.equal(result,current);
  assert.equal(result.state.status,'ready');
});

test('native cycle recovery preserves an older intent, allows one new action, and blocks a restarted same-cycle intent',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'native-cycle-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'journal.json');
  const now=new Date(), yesterday=new Date(now.getTime()-86400_000);
  await createSubmissionScope(file,target,{}, {now:()=>yesterday}).begin();
  const old=structuredClone((await readSubmissionJournal(file)).entries[0]);
  const scope=createSubmissionScope(file,target,{});
  const current={state:{status:'ready'},dailyReadiness:dailyReadinessEvidence(target)};
  let allowed=false, posts=0, aborted=0, route;
  await guardPageSubmissions({route:async(_match,handler)=>{route=handler;}},target,scope,{readOnly:()=>!allowed});
  const submit=()=>route({request:()=>({url:()=>origin+'/attendance.php',method:()=> 'POST'}),
    abort:async()=>{aborted++;},continue:async()=>{posts++;}});
  await submit(); assert.equal(aborted,1); assert.equal(posts,0);
  allowed=await resumeNativeDailyCycle(scope,current,origin,{});
  assert.equal(allowed,true);
  await submit(); assert.equal(posts,1);
  const restarted=createSubmissionScope(file,target,{});
  assert.equal(await resumeNativeDailyCycle(restarted,current,origin,{}),false);
  const completion=bindSuccessEvidence({status:'signed',evidence:successEvidence('page_text','page_completion_text')},target,{});
  await scope.observe(completion);
  const entries=(await readSubmissionJournal(file)).entries;
  assert.deepEqual(entries[0],old);
  assert.equal(entries.length,2);
  assert.equal(entries[1].state,'confirmed');
  assert.equal(reconcileSubmissionResult(completion,await scope.allPending(),target).status,'signed');
});

test('native cycle recovery refuses button-only and stale negative evidence',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'native-unsigned-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'journal.json');
  await createSubmissionScope(file,target,{}, {now:()=>new Date(Date.now()-86400_000)}).begin();
  const scope=createSubmissionScope(file,target,{});
  assert.equal(await resumeNativeDailyCycle(scope,{state:{status:'ready'}},origin,{}),false);
  await assert.rejects(resumeNativeDailyCycle(scope,{state:{status:'ready'},dailyReadiness:dailyReadinessEvidence(target,{},
    {now:new Date(Date.now()-31_000)})},origin,{}),/Fresh bound/);
  assert.equal((await readSubmissionJournal(file)).entries.length,1);
  for (const pattern of ['', 'a*', '[', 123]) {
    assert.throws(()=>normalizeNativeCheckinActionRule({actionTexts:['签到'],dailyUnsignedTextPattern:pattern}));
  }
});

test('native inspector executes the recovered daily action with its durable intent and confirms the new cycle only',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'native-inspector-cycle-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'journal.json');
  await createSubmissionScope(file,target,{}, {now:()=>new Date(Date.now()-86400_000)}).begin();
  const old=structuredClone((await readSubmissionJournal(file)).entries[0]);
  const scope=createSubmissionScope(file,target,{});
  let clicked=0, closed=0;
  const page={url:()=>origin+'/',waitForLoadState:async()=>{},waitForTimeout:async()=>{},route:async()=>{}};
  const readState=async()=>clicked ? {state:{status:'already_signed'}}
    : {state:{status:'ready'},dailyReadiness:dailyReadinessEvidence(target)};
  const source=await fs.readFile(new URL('../src/native-browser-inspect.mjs',import.meta.url),'utf8');
  const start=source.indexOf('async function inspectWithPlaywright() {');
  const end=source.indexOf('\nif (executeNewApiCheckin)',start);
  const outputs=[];
  const noChallenge=async()=>assert.fail('confirmed state must not trigger a challenge click');
  const deps={
    connectOverCdpWithRetry:async()=>({contexts:()=>[{pages:()=>[page]}],close:async()=>{closed++;}}),
    chromium:{},port:12345,maxWaitSeconds:30,expectedOrigin:origin,scope,
    attachSubmissionScope:()=>{},guardPageSubmissions,executeCheckin:true,forceReadOnly:false,mayExecuteCheckin:false,
    selectNewestOriginPage:()=>page,pagesForOrigin:()=>[page],readPageState:readState,config:{},
    actionRule:{clickChallenge:false},retryableChallengeOutcomes:new Set(),allowEndpointReady:false,
    waitForNativeReadOnlyCompletion,resumeNativeDailyCycle,createNativeSafeLineReader,
    waitForNativeCheckinAction:async()=>{
      await scope.begin();
      const entries=(await readSubmissionJournal(file)).entries;
      assert.equal(entries.length,2); assert.equal(entries[1].state,'intent');
      clicked++; return {clicked:true,outcome:'clicked'};
    },
    clickVisibleNativeSafeLineControl:noChallenge,clickVisibleNativeChallengeControl:noChallenge,
    nativeEvidence:async value=>bindSuccessEvidence({...value,evidence:successEvidence('page_text','page_completion_text')},target,{}),
    reconcileSubmissionResult,console:{log:value=>outputs.push(JSON.parse(value))},
  };
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  await new AsyncFunction(...Object.keys(deps),source.slice(start,end)+'\nawait inspectWithPlaywright();')(...Object.values(deps));
  assert.equal(clicked,1); assert.equal(closed,1); assert.equal(outputs[0].status,'already_signed');
  assert.equal(outputs[0].historicalSubmissionWarning.pendingCount,1);
  const entries=(await readSubmissionJournal(file)).entries;
  assert.deepEqual(entries[0],old); assert.equal(entries[1].state,'confirmed');
});

test('quarantine preserves the original OAuth failure while retaining the submission lock',()=>{
  const diagnostics=loginHelperOutcome(JSON.stringify({status:'needs_attention',oauthStage:'linuxdo_provider_login_required',
    authorizationOutcome:'provider_login_required'}));
  const failure=reauthLoginFailureResult('LinuxDO',diagnostics.oauthStage,{diagnostics});
  const entry={identity:{siteOrigin:origin,accountKey:'default',actionType:'checkin'},startedAt:new Date().toISOString(),
    cycleId:dailyReadinessEvidence(target).evidence.binding.cycleId};
  const result=reconcileSubmissionResult(failure,[entry],target);
  assert.equal(result.failureCode,'submission_quarantined');
  assert.equal(result.retryable,false);
  assert.equal(result.submissionObservation.failureCode,'oauth_linuxdo_provider_login_required');
  assert.equal(result.submissionObservation.oauthStage,'linuxdo_provider_login_required');
  assert.equal(result.submissionObservation.authorizationOutcome,'provider_login_required');
  assert.match(result.submissionObservation.reason,/授权跳回提供方登录表单/);
  assert.deepEqual(reconcileSubmissionResult(result,[entry],target).submissionObservation,result.submissionObservation);
  assert.equal(clearResolvedFailureFields({...result,status:'signed'}).submissionObservation,null);
  const native=nativePreflightProgress([target],new Map([[origin,result]]))[0];
  assert.deepEqual(native.quarantine,result.quarantine);
  assert.deepEqual(native.submissionObservation,result.submissionObservation);
});

test('subsequent read-only observations retain the original fixed failure from the submission journal',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'submission-diagnostic-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'journal.json');
  const scope=createSubmissionScope(file,target,{});
  await scope.begin();
  const failure=reauthLoginFailureResult('LinuxDO','linuxdo_provider_login_required',
    {diagnostics:{oauthStage:'linuxdo_provider_login_required',authorizationOutcome:'provider_login_required'}});
  await scope.observe(failure);
  const resumed=createSubmissionScope(file,target,{});
  const generic={status:'needs_attention',reason:'不确定提交仅允许只读复核'};
  await resumed.observe(generic);
  const result=reconcileSubmissionResult(generic,await resumed.allPending(),target);
  assert.equal(result.failureCode,'submission_quarantined');
  assert.equal(result.submissionObservation.oauthStage,'linuxdo_provider_login_required');
  assert.equal(result.submissionObservation.authorizationOutcome,'provider_login_required');
  assert.equal((await readSubmissionJournal(file)).entries[0].state,'uncertain');
});

test('OAuth diagnostics keep fixed stages and authorization outcomes without raw identity, URL, tokens, or body',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'oauth-diagnostic-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const entry={flow:'automatic_target',provider:'LinuxDO',status:'needs_attention',oauthStage:'linuxdo_provider_login_required',
    stages:['target_login','provider_transition','private-fixture-token','linuxdo_provider_login_required'],
    authorizationOutcome:'provider_login_required',providerAuthorizationChallengeOutcome:'not_observed',
    providerAuthorizationChallengeClicks:0,elapsedMs:1234,
    url:'https://provider.example/?code=private-fixture-token',account:'private-user@example.com',cookie:'<TEST_COOKIE>',
    body:'private-page-content',balance:123456};
  assert.equal(await writeOAuthFlowDiagnostic(entry,{logsRoot:directory}),true);
  const [file]=await fs.readdir(directory);
  const persisted=await fs.readFile(path.join(directory,file),'utf8');
  const safe=JSON.parse(persisted);
  assert.deepEqual(safe.stages,['target_login','provider_transition','linuxdo_provider_login_required']);
  assert.equal(safe.authorizationOutcome,'provider_login_required');
  assert.doesNotMatch(persisted,/private-|TEST_COOKIE|example\.com|123456|https:/);
  assert.equal(sanitizeOAuthFlowDiagnostic({...entry,flow:'unknown'}),null);
  assert.deepEqual(sanitizeOAuthFlowDiagnostic({...entry,stages:'private'}).stages,[]);
  assert.equal(loginHelperOutcomeFromStreams('',JSON.stringify({oauthStage:'linuxdo_provider_login_required'})).oauthStage,
    'linuxdo_provider_login_required');
});
