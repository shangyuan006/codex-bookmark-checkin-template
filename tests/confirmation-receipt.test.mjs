import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSubmissionScope,readSubmissionJournal,recoverConfirmedSubmission,runWithSubmissionJournal,submissionProfileBinding } from '../src/submission-guard.mjs';
import { bindSuccessEvidence,successEvidence,normalizeBoundEvidenceResult } from '../src/checkin-evidence.mjs';

const target={origin:'https://receipt.example',accountKey:'primary'},now=new Date('2026-10-13T04:00Z');
const config={automationUserDataDir:'data/fixture-profile',browser:'edge',reuseConfirmedSubmissionReceipts:true};
const completed=(source='status_endpoint',settings=config)=>bindSuccessEvidence({status:'signed',evidence:successEvidence(source,'checked_in_today',now)},target,settings,now);
async function fixture(t,settings=config,source='status_endpoint') {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'receipt-proof-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'journal.json'),scope=createSubmissionScope(file,target,settings,{now:()=>now});
  await scope.begin();await scope.observe(completed(source,settings));return {file,scope};
}

test('durable receipt survives restart and reuses its original confirmation time only when enabled',async t=>{
  const {file}=await fixture(t);
  let runs=0;
  const result=await runWithSubmissionJournal(file,target,config,async()=>{runs++;return {status:'error'};},{now:()=>now});
  assert.equal(runs,0);assert.equal(result.status,'already_signed');assert.equal(result.cached,true);
  assert.equal(result.evidence.confirmedAt,now.toISOString());assert.equal(result.observedAt,now.toISOString());
  const journal=await readSubmissionJournal(file);
  assert.equal(journal.entries[0].receipt.profileBinding,submissionProfileBinding(target,config));
  assert.doesNotMatch(JSON.stringify(journal),/fixture-profile/);
  await runWithSubmissionJournal(file,target,{...config,reuseConfirmedSubmissionReceipts:false},async()=>{runs++;return {status:'error'};},{now:()=>now});
  assert.equal(runs,1);
});

test('receipt rejects profile, account, browser, private rule and cycle drift',async t=>{
  const {file}=await fixture(t),journal=await readSubmissionJournal(file);
  for(const settings of [{...config,automationUserDataDir:'data/other-profile'},{...config,browser:'chrome'},
    {...config,newApiAccountRules:{[target.origin]:{expectedAccountId:'12345'}}},
    {...config,ptPassiveReadRules:{[target.origin]:{selector:'#changed'}}}]) {
    assert.equal(recoverConfirmedSubmission(journal,target,settings,now),null);
  }
  assert.equal(recoverConfirmedSubmission(journal,{...target,accountKey:'secondary'},config,now),null);
  assert.equal(recoverConfirmedSubmission(journal,target,config,new Date('2026-10-14T04:00Z')),null);
});

test('custom-cycle receipt retains cycle metadata for later status-page validation',async t=>{
  const settings={...config,siteCycleRules:{[target.origin]:{resetAt:'13:00'}}};
  const {file}=await fixture(t,settings);
  const result=recoverConfirmedSubmission(await readSubmissionJournal(file),target,settings,now);
  assert.equal(result.status,'already_signed');assert.equal(result.cycle.resetAt,'13:00');
  assert.equal(normalizeBoundEvidenceResult(result,undefined,now).status,'already_signed');
});

test('a fixed native fallback profile cannot hide a change to the ordinary execution profile',()=>{
  const settings={...config,nativeChallengePreflight:[{url:target.origin+'/index.php',automationUserDataDir:'data/native-fixture'}]};
  assert.notEqual(submissionProfileBinding(target,settings),submissionProfileBinding(target,{...settings,automationUserDataDir:'data/changed-profile'}));
  assert.notEqual(submissionProfileBinding(target,settings),submissionProfileBinding(target,{...settings,
    nativeChallengePreflight:[{url:target.origin+'/index.php',automationUserDataDir:'data/changed-native'}]}));
});

test('new uncertain intent or user-rule completion cannot be bypassed with an older receipt',async t=>{
  const {file}=await fixture(t);
  await createSubmissionScope(file,target,config,{now:()=>now}).begin();
  assert.equal(recoverConfirmedSubmission(await readSubmissionJournal(file),target,config,now),null);
  const other=await fixture(t,config,'user_rule'),journal=await readSubmissionJournal(other.file);
  assert.equal(journal.entries[0].state,'uncertain');assert.equal(journal.entries[0].receipt,undefined);
  assert.equal(recoverConfirmedSubmission(journal,target,config,now),null);
});

test('changed profile cannot release an uncertainty or create a confirmation receipt',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'receipt-profile-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'journal.json');await createSubmissionScope(file,target,config,{now:()=>now}).begin();
  await createSubmissionScope(file,target,{...config,automationUserDataDir:'data/other-profile'},{now:()=>now}).observe(completed());
  const journal=await readSubmissionJournal(file);assert.equal(journal.entries[0].state,'uncertain');
  assert.equal(journal.entries[0].receipt,undefined);
});

test('explicit read-only, New API and sequential tasks always perform live verification',async t=>{
  const {file}=await fixture(t);let runs=0;
  for(const settings of [{...config,checkinReadOnly:true},{...config,newApiCheckinOrigins:[target.origin]},
    {...config,sequentialActionRules:{[target.origin]:{steps:[]}}}]) {
    await runWithSubmissionJournal(file,target,settings,async()=>{runs++;return {status:'error'};},{now:()=>now});
  }
  assert.equal(runs,3);
});
