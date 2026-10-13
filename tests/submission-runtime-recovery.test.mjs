import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSubmissionScope,runWithSubmissionJournal,readSubmissionJournal,SUBMISSION_SCOPE,guardPageSubmissions } from "../src/submission-guard.mjs";
import { bindSuccessEvidence,successEvidence,dailyReadinessEvidence,normalizeBoundEvidenceResult } from "../src/checkin-evidence.mjs";
import { processTarget,getConfiguredSequentialActionRule,preferCandidateResult } from "../src/browser.mjs";
import { runConfiguredDailyDashboardCheckin } from "../src/daily-dashboard-checkin.mjs";

const origin="https://daily.example";
const target={origin,candidates:[`${origin}/profile`]};
const now=new Date("2026-10-02T04:00Z"), old=new Date("2026-10-01T04:00Z");
const completion=(identity=target,source="status_endpoint")=>bindSuccessEvidence({status:"signed",evidence:successEvidence(source,"checked_in_today",now)},identity,{},now);
test("legacy historical quarantine restores only bound positive page evidence",()=>{
  for(const outcome of ["page_completion_text","native_confirmed_completion"]) {
    const original=bindSuccessEvidence({status:"already_signed",evidence:successEvidence("page_text",outcome,now)},target,{},now);
    const oldReport={...original,status:"needs_attention",failureCode:"submission_quarantined"};
    const restored=normalizeBoundEvidenceResult(oldReport,{},now);
    assert.equal(restored.status,"already_signed");assert.equal(restored.evidence.confirmedAt,original.evidence.confirmedAt);
    for(const invalid of [
      {...oldReport,evidence:{...original.evidence,confirmedAt:new Date(now.getTime()+1).toISOString()}},
      {...oldReport,evidence:{...original.evidence,source:"user_rule",authoritative:false}},
      {...oldReport,evidence:{...original.evidence,outcome:"title_only"}},
      {...oldReport,evidence:{...original.evidence,binding:{...original.evidence.binding,accountKey:"other"}}},
      {...oldReport,evidence:{...original.evidence,binding:{...original.evidence.binding,cycleId:"old-cycle"}}},
    ]) assert.equal(normalizeBoundEvidenceResult(invalid,{},now).status,"needs_attention");
  }
  const negative={...dailyReadinessEvidence(target,{}, {now}),status:"needs_attention",origin,failureCode:"submission_quarantined"};
  assert.equal(normalizeBoundEvidenceResult(negative,{},now).status,"needs_attention");
});
test("daily quota continuation rejects invalid patterns and unsafe thresholds",()=>{
  const step={url:`${origin}/draw`,actionTexts:["Draw ten"],dailyQuotaPattern:"Remaining: ([0-9]+)"};
  const config=rule=>({sequentialActionRules:{[origin]:{steps:[rule]}}});
  assert.equal(getConfiguredSequentialActionRule(target,config(step)).steps[0].dailyQuotaMinimum,10);
  for(const dailyQuotaMinimum of [0,-1,1.5,Infinity,NaN,Number.MAX_SAFE_INTEGER+1]) {
    assert.throws(()=>getConfiguredSequentialActionRule(target,config({...step,dailyQuotaMinimum})),/配额规则/);
  }
  assert.throws(()=>getConfiguredSequentialActionRule(target,config({...step,dailyQuotaPattern:"["})),/配额表达式/);
});
test("fresh unsigned readiness is not hidden by an earlier unusable candidate",()=>{
  const ready=dailyReadinessEvidence(target,{}, {now});
  assert.equal(preferCandidateResult({status:"login_required"},ready),ready);
  assert.equal(preferCandidateResult(ready,{status:"no_action"}),ready);
  assert.equal(preferCandidateResult({status:"already_signed"},ready).status,"already_signed");
});
test("read-only browser verification blocks background action requests before recording intent",async()=>{
  let handler,starts=0,aborts=0,continues=0;
  const page={route:async(filter,callback)=>{assert.equal(filter(new URL(`${origin}/api/user/checkin`)),true);handler=callback;}};
  await guardPageSubmissions(page,target,{begin:async()=>{starts++;}},{readOnly:true});
  const route=method=>({request:()=>({url:()=>`${origin}/api/user/checkin`,method:()=>method}),
    abort:async()=>{aborts++;},continue:async()=>{continues++;}});
  await handler(route("POST"));await handler(route("GET"));
  assert.equal(starts,0);assert.equal(aborts,1);assert.equal(continues,1);
});
async function fixture(t,identity=target,at=old) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"runtime-recovery-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,"journal.json");
  await createSubmissionScope(file,identity,{}, {now:()=>at}).begin();
  return {file,root};
}
test("automatic wrapper resumes only after a fresh negative observation, once",async t=>{
  const {file}=await fixture(t);let phases=[];
  const result=await runWithSubmissionJournal(file,target,{},async config=>{
    phases.push(config.checkinReadOnly);
    if(config.checkinReadOnly) return dailyReadinessEvidence(target,{}, {source:"status_endpoint",now});
    assert.equal((await readSubmissionJournal(file)).entries[1].state,"intent");
    await config[SUBMISSION_SCOPE].begin();
    return completion();
  },{now:()=>now});
  assert.deepEqual(phases,[true,false]);assert.equal(result.status,"signed");
  assert.equal(result.historicalSubmissionWarning.pendingCount,1);
  assert.deepEqual((await readSubmissionJournal(file)).entries.map(e=>e.state),["intent","confirmed"]);
});
test("current-cycle uncertainty never resubmits even with negative evidence",async t=>{
  const {file}=await fixture(t,target,now);let calls=0;
  const result=await runWithSubmissionJournal(file,target,{},async c=>{calls++;assert.equal(c.checkinReadOnly,true);return dailyReadinessEvidence(target,{}, {now});},{now:()=>now});
  assert.equal(calls,1);assert.equal(result.failureCode,"submission_quarantined");
  assert.equal((await readSubmissionJournal(file)).entries.length,1);
});
test("explicit read-only mode cannot submit or create an intent",async t=>{
  const {file}=await fixture(t);let calls=0;
  await runWithSubmissionJournal(file,target,{checkinReadOnly:true},async c=>{calls++;assert.equal(c.checkinReadOnly,true);return dailyReadinessEvidence(target,{}, {now});},{now:()=>now});
  assert.equal(calls,1);assert.equal((await readSubmissionJournal(file)).entries.length,1);
});
test("configured visits still run bounded read-only verification and retain rule provenance",async t=>{
  const {file}=await fixture(t);let calls=0;
  const result=await runWithSubmissionJournal(file,target,{visitCheckinRules:{[origin]:{after:"08:00",assumeSignedAfterVisit:true}}},async c=>{
    calls++;assert.equal(c.checkinReadOnly,true);return completion(target,"user_rule");
  },{now:()=>now});
  assert.equal(calls,1);assert.equal(result.status,"signed");assert.equal(result.evidence.authoritative,false);
  assert.equal((await readSubmissionJournal(file)).entries[0].state,"uncertain");
});
test("a visit waiting for its opening time is deferred, not falsely quarantined",async t=>{
  const {file}=await fixture(t);
  const result=await runWithSubmissionJournal(file,target,{},async()=>({status:"deferred",retryCause:"time_window"}),{now:()=>now});
  assert.equal(result.status,"deferred");assert.equal(result.historicalSubmissionWarning.pendingCount,1);
});
test("reauth continuation requires an explicit recurring rule and matching isolated account",async t=>{
  const identity={...target,accountKey:"github",actionType:"reauth"};const {file}=await fixture(t,identity);
  const config={reauthCheckinRules:{[origin]:{allowCycleContinuation:true}},agentrouterAccounts:[{origin,accountKey:"github"}]};
  const proof=dailyReadinessEvidence(identity,config,{source:"reauth_state",outcome:"configured_daily_reauth_due",authoritative:false,now});
  const result=await runWithSubmissionJournal(file,identity,config,async c=>c.checkinReadOnly?proof:completion(identity,"reauth_state"),{now:()=>now});
  assert.equal(result.status,"signed");assert.equal((await readSubmissionJournal(file)).entries.length,2);
  const denied=await fixture(t,identity);
  await assert.rejects(createSubmissionScope(denied.file,identity,{...config,agentrouterAccounts:[{origin,accountKey:"linuxdo"}]},{now:()=>now}).beginNewCycleAfterVerifiedReadiness(proof));
});
test("quota-based steps preserve their identity and remain fail-closed within the cycle",async t=>{
  const identity={...target,actionType:"daily_draw"};const {file}=await fixture(t,identity);
  const config={sequentialActionRules:{[origin]:{steps:[{url:`${origin}/draw`,actionType:"daily_draw",actionTexts:["Draw ten"],dailyQuotaPattern:"Remaining: ([0-9]+)"}]}}};
  const proof=dailyReadinessEvidence(identity,config,{outcome:"daily_quota_available",now});
  await createSubmissionScope(file,identity,config,{now:()=>now}).beginNewCycleAfterVerifiedReadiness(proof);
  await assert.rejects(createSubmissionScope(file,identity,config,{now:()=>now}).beginNewCycleAfterVerifiedReadiness(proof),/Same-cycle/);
});
test("normal processTarget API path recovers across cycles with no extra browser tab",async t=>{
  const actual=new Date(), prior=new Date(actual.getTime()-86400000);
  const {file,root}=await fixture(t,target,prior);let checked=false,posts=0;
  const context={request:{fetch:async(url,{method})=>{
    if(method==="POST") {posts++;assert.equal((await readSubmissionJournal(file)).entries.at(-1).state,"intent");checked=true;}
    const body=url.includes("/self")?{success:true,data:{id:42}}:{success:true,data:{checked_in_today:checked}};
    return {url:()=>url,status:()=>200,text:async()=>JSON.stringify(body),dispose:async()=>{}};
  }},newPage:()=>assert.fail("API recovery must not open a page")};
  const config={submissionJournalPath:file,apiFirstOrigins:[origin],newApiCheckinOrigins:[origin]};
  const result=await processTarget(context,target,config,[],root);
  assert.equal(result.status,"signed");assert.equal(posts,1);assert.equal(result.historicalSubmissionWarning.pendingCount,1);
  assert.equal((await processTarget(context,target,{...config,checkinReadOnly:true},[],root)).status,"already_signed");assert.equal(posts,1);
});
test("dashboard adapter reuses page session without exposing identity or quota",async t=>{
  let checked=false,clicks=0;
  const original=Object.getOwnPropertyDescriptor(globalThis,"dashboardRead");
  globalThis.dashboardRead=async()=>({success:true,data:{today:{checked},balance:12345,token:"private-fixture-token"}});
  t.after(()=>{if(original)Object.defineProperty(globalThis,"dashboardRead",original);else delete globalThis.dashboardRead;});
  const config={dailyDashboardCheckinRules:{[origin]:{stateFunction:"dashboardRead",stateAction:"state",checkedPath:"data.today.checked",actionSelector:"#daily"}}};
  const page={url:()=>`${origin}/profile`,evaluate:async(fn,args)=>fn(args),waitForFunction:async()=>{},waitForTimeout:async()=>{},
    locator:()=>({count:async()=>1,isVisible:async()=>true,isEnabled:async()=>true,click:async()=>{clicks++;checked=true;}})};
  assert.equal((await runConfiguredDailyDashboardCheckin(page,target,{...config,checkinReadOnly:true})).status,"not_signed");assert.equal(clicks,0);
  const result=await runConfiguredDailyDashboardCheckin(page,target,config);
  assert.equal(result.status,"signed");assert.equal(clicks,1);assert.doesNotMatch(JSON.stringify(result),/12345|private-fixture-token/);
  assert.equal((await runConfiguredDailyDashboardCheckin(page,target,config)).status,"already_signed");assert.equal(clicks,1);
});
