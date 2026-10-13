import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readBookmarkPlan, readBookmarkPlanWithBackup } from '../src/bookmarks.mjs';
import { bindSuccessEvidence, reconcileCheckinResult, successEvidence, evidenceBinding } from '../src/checkin-evidence.mjs';
import { createSubmissionScope, runWithSubmissionJournal, readSubmissionJournal, SUBMISSION_SCOPE } from '../src/submission-guard.mjs';
import { historyModel, loadStatusHistory } from '../src/status-history.mjs';
import { createReleaseBundle, previewRelease, applyRelease, validateReleasePath } from '../src/code-release.mjs';
import { acquireRunLock, releaseRunLock } from '../src/run-lock.mjs';
import { statusPageModel, renderStatusPage } from '../src/status-dashboard.mjs';
import { processTarget, getConfiguredSequentialActionRule } from '../src/browser.mjs';
import { runConfiguredReauthCheckinForAccount } from '../src/reauth-checkin.mjs';
import { normalizeBoundEvidenceResult } from '../src/checkin-evidence.mjs';
import { isTerminalResult } from '../src/result-contract.mjs';
import { powershellExecutable } from './helpers/powershell.mjs';

const now = new Date('2026-09-30T04:00:00Z');
const origin = 'https://fixture.example';
const target = {origin,candidates:[`${origin}/profile`]};
async function fixture(t) { const root=await fs.mkdtemp(path.join(os.tmpdir(),'checkin-safety-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root; }
const completed = (identity=target,at=now,config={})=>bindSuccessEvidence({status:'signed',evidence:successEvidence('status_endpoint','checked_in_today',at)},identity,config,at);
const folders = {roots:{bar:{name:'Bookmarks bar',type:'folder',children:['one','two'].map((name,index)=>({name,type:'folder',children:[{name:'daily',id:String(index+10),guid:`guid-${index}`,type:'folder',children:[{name:'targets',type:'folder',children:[{type:'url',name:'Site',url:`https://${name}.example/checkin`}]}]}]}))}}};
const scope = {mobileFolderNames:['daily'],targetFolderNames:['targets']};

test('exact bookmark path, ID and GUID intersect and exclude same-named containers',async t=>{
  const root=await fixture(t);const file=path.join(root,'Bookmarks');await fs.writeFile(file,JSON.stringify(folders));
  for (const selector of [{path:['Bookmarks bar','one','daily']},{id:'10'},{guid:'GUID-0'},{path:'Bookmarks bar / one / daily',id:'10',guid:'guid-0'}]) {
    const plan=await readBookmarkPlan(file,{...scope,containerFolderSelectors:[selector]});
    assert.equal(plan.targetCount,1);assert.equal(plan.targets[0].origin,'https://one.example');
  }
  assert.equal((await readBookmarkPlan(file,scope)).targetCount,2,'legacy multi-container scope is preserved');
});
test('exact bookmark mismatch never resurrects the removed folder from a backup',async t=>{
  const root=await fixture(t);const file=path.join(root,'Bookmarks');await fs.writeFile(`${file}.bak`,JSON.stringify(folders));
  await fs.writeFile(file,JSON.stringify({roots:{}}));
  await assert.rejects(readBookmarkPlanWithBackup(file,{...scope,containerFolderSelectors:[{id:'10'}]}),/精确书签范围失配/);
  await fs.unlink(file);
  await assert.rejects(readBookmarkPlanWithBackup(file,{...scope,containerFolderSelectors:[{id:'10'}]}),/必要书签来源/);
});
test('empty, unknown, conflicting or duplicate exact selectors stop execution',async t=>{
  const root=await fixture(t);const file=path.join(root,'Bookmarks');await fs.writeFile(file,JSON.stringify(folders));
  for (const selectors of [[],[{}],[{unknown:'x'}],[{id:'10',guid:'guid-1'}],[{path:['']}],[{path:['daily']}]] ) {
    await assert.rejects(readBookmarkPlan(file,{...scope,containerFolderSelectors:selectors}));
  }
  const duplicate=structuredClone(folders);duplicate.roots.bar.children[1].children[0].id='10';await fs.writeFile(file,JSON.stringify(duplicate));
  await assert.rejects(readBookmarkPlan(file,{...scope,containerFolderSelectors:[{id:'10'}]}),/不唯一/);
});
test('each browser source retains its own exact scope',async t=>{
  const root=await fixture(t);const file=path.join(root,'Bookmarks');await fs.writeFile(file,JSON.stringify(folders));
  const other=path.join(root,'Other');await fs.writeFile(other,JSON.stringify(folders));
  const plan=await readBookmarkPlan([{path:file,name:'Edge',containerFolderSelectors:[{id:'10'}]},
    {path:other,name:'Chrome',containerFolderSelectors:[{id:'11'}]}],scope);
  assert.equal(plan.targetCount,2);assert.equal(plan.sources.length,2);
});
test('new synthetic bookmarks enter the exact scope without changing the real browser file',async t=>{
  const root=await fixture(t);const file=path.join(root,'Bookmarks');const document=structuredClone(folders);
  const config={...scope,containerFolderSelectors:[{id:'10'}]};await fs.writeFile(file,JSON.stringify(document));
  assert.equal((await readBookmarkPlan(file,config)).targetCount,1);
  document.roots.bar.children[0].children[0].children[0].children.push({type:'url',name:'Synthetic',url:'https://new.example/checkin'});
  await fs.writeFile(file,JSON.stringify(document));assert.equal((await readBookmarkPlan(file,config)).targetCount,2);
});

test('bound evidence rejects a wrong origin, account, action, cycle or observed source',()=>{
  const account={...target,accountKey:'isolated-a'};const result=completed(account);
  assert.equal(result.evidence.binding.accountKey,'isolated-a');
  for (const [field,value] of [['siteOrigin','https://other.example'],['accountKey','isolated-b'],['actionType','claim'],['cycleId','old'],['observedOrigin','https://other.example']]) {
    const evidence=structuredClone(result.evidence);evidence.binding[field]=value;
    assert.equal(reconcileCheckinResult(result,evidence,now).failureCode,'evidence_binding_mismatch',field);
  }
});
test('evidence binding preserves observation time and honors non-midnight cycles',()=>{
  const config={siteCycleRules:{[origin]:{timeZone:'Asia/Shanghai',resetAt:'08:30'}}};
  const result=completed(target,now,config);
  assert.equal(reconcileCheckinResult(result,result.evidence,now).status,'signed');
  assert.equal(reconcileCheckinResult(result,result.evidence,new Date('2026-10-01T00:30Z')).status,'unconfirmed');
  const rebound=bindSuccessEvidence(result,target,config,new Date('2026-10-01T00:30Z'));
  assert.equal(rebound.status,'unconfirmed');assert.equal(rebound.evidence.confirmedAt,now.toISOString());
});
test('binding never manufactures completion evidence from a click or blank success',()=>{
  assert.equal(bindSuccessEvidence({status:'clicked'},target,{},now).evidence,undefined);
  assert.equal(reconcileCheckinResult(bindSuccessEvidence({status:'signed'},target,{},now)).status,'unconfirmed');
  assert.equal(reconcileCheckinResult({status:'signed'},successEvidence('user_rule','configured_assumption',now),now,{target,requireBinding:true}).status,'unconfirmed');
  assert.throws(()=>evidenceBinding({...target,accountKey:'not an anonymous key'}, {}, now));
});
test('JavaScript and PowerShell terminal validation reject wrong-account bound proof',async t=>{
  const root=await fixture(t);const result=completed({...target,accountKey:'a'});
  result.evidence.binding.accountKey='b';
  assert.equal(isTerminalResult(result,now),false);
  const parent=normalizeBoundEvidenceResult({origin,status:'signed',accountResults:[result]}, {}, now);assert.equal(parent.status,'needs_attention');
  const file=path.join(root,'proof.json');await fs.writeFile(file,JSON.stringify(result));
  const script=". ./scripts/ResultContract.ps1; $r=Get-Content -Raw -LiteralPath $env:CHECKIN_TEST_PROOF | ConvertFrom-Json; Test-CheckinResultTerminal $r ([datetime]'2026-09-30T04:00:00Z')";
  const {stdout}=await promisify(execFile)(powershellExecutable,['-NoProfile','-Command',script],{windowsHide:true,env:{...process.env,CHECKIN_TEST_PROOF:file}});assert.equal(stdout.trim(),'False');
});

test('next-day verified completion does not release older uncertainty or erase current completion',async t=>{
  const root=await fixture(t);const file=path.join(root,'journal.json');
  const scope=createSubmissionScope(file,target,{}, {now:()=>now});await scope.begin();
  const first=(await readSubmissionJournal(file)).entries[0];assert.equal(first.state,'intent');
  const later=new Date('2026-10-01T04:00Z');let readOnly;
  const result=await runWithSubmissionJournal(file,target,{},async config=>{readOnly=config.checkinReadOnly;return completed(target,later);},{now:()=>later});
  assert.equal(readOnly,true);assert.equal(result.status,"signed");assert.equal(result.historicalSubmissionWarning.pendingCount,1);
  const entry=(await readSubmissionJournal(file)).entries[0];assert.equal(entry.id,first.id);assert.equal(entry.history.length,2);
});
test('same-cycle authoritative observation releases quarantine and keeps original history',async t=>{
  const root=await fixture(t);const file=path.join(root,'journal.json');const scope=createSubmissionScope(file,target,{}, {now:()=>now});await scope.begin();
  const result=await runWithSubmissionJournal(file,target,{},async config=>{assert.equal(config.checkinReadOnly,true);return completed();},{now:()=>now});
  assert.equal(result.status,'signed');const journal=await readSubmissionJournal(file);assert.equal(journal.entries[0].state,'confirmed');assert.equal(journal.entries[0].history[0].event,'intent');
});
test('user-rule completion and ordinary login do not release uncertain submissions',async t=>{
  const root=await fixture(t);const file=path.join(root,'journal.json');const scope=createSubmissionScope(file,target,{}, {now:()=>now});await scope.begin();
  const assumed=bindSuccessEvidence({status:'already_signed',evidence:successEvidence('user_rule','local_exception',now)},target,{},now);
  for (const result of [{status:'login_required'},assumed,{status:'ready'}]) assert.equal((await scope.observe(result)).length,1);
  await assert.rejects(createSubmissionScope(file,target,{}, {now:()=>now}).begin(),/禁止重复/);
});
test('account and action isolation does not affect other targets',async t=>{
  const root=await fixture(t);const file=path.join(root,'journal.json');
  await createSubmissionScope(file,{...target,accountKey:'a',actionType:'draw'}, {}, {now:()=>now}).begin();
  for (const identity of [{...target,accountKey:'b',actionType:'draw'},{...target,accountKey:'a',actionType:'checkin'}]) {
    assert.deepEqual(await createSubmissionScope(file,identity,{}, {now:()=>now}).pending(),[]);
  }
});
test('an explicit rejection is retained; unreadable journal fails closed',async t=>{
  const root=await fixture(t);const file=path.join(root,'journal.json');const scope=createSubmissionScope(file,target,{}, {now:()=>now});await scope.begin();await scope.reject('challenge_rejected');
  assert.equal((await readSubmissionJournal(file)).entries[0].state,'rejected');await scope.begin();assert.equal((await readSubmissionJournal(file)).entries.length,2);
  await fs.writeFile(file,'broken');await assert.rejects(runWithSubmissionJournal(file,target,{},()=>assert.fail('must not submit')),/不可读取/);
});
test('ordinary successful run without submission does not create an intent',async t=>{
  const root=await fixture(t);const file=path.join(root,'journal.json');
  const result=await runWithSubmissionJournal(file,target,{},async()=>completed(),{now:()=>now});assert.equal(result.status,'signed');assert.equal((await readSubmissionJournal(file)).entries.length,0);
});
test('HTTP runtime writes the intent before POST and a subsequent uncertain run is read-only',async t=>{
  const root=await fixture(t);const file=path.join(root,'journal.json');let posts=0;
  const context={request:{fetch:async(url,{method})=>{
    const body=url.includes('/self')?{success:true,data:{id:42}}:{success:true,data:{checked_in_today:false}};
    if(method==='POST'){posts++;assert.equal((await readSubmissionJournal(file)).entries[0].state,'intent');}
    return {url:()=>url,status:()=>200,text:async()=>JSON.stringify(body),dispose:async()=>{}};
  }},newPage:()=>assert.fail('HTTP-only test must not create a tab')};
  const config={submissionJournalPath:file,apiFirstOrigins:[origin],newApiCheckinOrigins:[origin]};
  assert.equal((await processTarget(context,target,config,[],root)).failureCode,'submission_quarantined');
  assert.equal(posts,1);
  assert.equal((await processTarget(context,target,config,[],root)).failureCode,'submission_quarantined');assert.equal(posts,1);
});
test('cached reauthentication retains its original account, action, and observation time',async t=>{
  const root=await fixture(t);const file=path.join(root,'reauth.json');const at=new Date(now.getTime()-60_000);
  await fs.writeFile(file,JSON.stringify({version:1,entries:{[`${origin}::isolated-a`]:{date:'20260930',status:'completed',updatedAt:at.toISOString()}}}));
  const result=await runConfiguredReauthCheckinForAccount(target,{}, {origin,accountKey:'isolated-a',provider:'GitHub'}, {statePath:file,now});
  assert.equal(result.status,'already_signed');assert.equal(result.evidence.confirmedAt,at.toISOString());assert.equal(result.evidence.binding.accountKey,'isolated-a');assert.equal(result.evidence.binding.actionType,'reauth');
});
test('sequential action identities remain stable when steps are reordered and reject personal labels',()=>{
  const steps=[{url:`${origin}/a`,actionTexts:['Sign']},{url:`${origin}/b`,actionTexts:['Draw']}];
  const a=getConfiguredSequentialActionRule(target,{sequentialActionRules:{[origin]:{steps}}}).steps;
  const b=getConfiguredSequentialActionRule(target,{sequentialActionRules:{[origin]:{steps:[...steps].reverse()}}}).steps;
  assert.equal(a[0].actionType,b[1].actionType);assert.notEqual(a[0].actionType,a[1].actionType);
  assert.throws(()=>getConfiguredSequentialActionRule(target,{sequentialActionRules:{[origin]:{steps:[{...steps[0],actionType:'private label'}]}}}));
});

test('history chooses latest per day, counts accounts, and separates assumptions',()=>{
  const report={runId:'20260930-120000',finishedAt:now.toISOString(),runState:'final',isComplete:true,results:[{origin,accountResults:[completed({...target,accountKey:'a'}),bindSuccessEvidence({status:'signed',evidence:successEvidence('user_rule','local_rule',now)},{...target,accountKey:'b'},{},now)]},{origin:'https://other.example',status:'unconfirmed',submissionAttempted:true}]};
  const days=historyModel([report,{...report,finishedAt:'2026-09-30T03:00Z',results:[]}],{now});
  assert.equal(days.length,1);assert.equal(days[0].accounts,3);assert.equal(days[0].counts.authoritative,1);assert.equal(days[0].counts.user_rule,1);assert.equal(days[0].counts.uncertain,1);
  assert.equal(historyModel([{...report,finishedAt:'2026-10-01T00:00Z'}],{now}).length,0);
});
test('history skips malformed reports and the status page exposes stale/missing/isolation warnings',async t=>{
  const root=await fixture(t);await fs.mkdir(path.join(root,'logs/20260930-120000'),{recursive:true});await fs.writeFile(path.join(root,'logs/20260930-120000/result.json'),'bad');
  const history=await loadStatusHistory(root,{now});assert.equal(history.unreadableReports,1);
  const html=renderStatusPage(statusPageModel({}, {}, {}, [], {}, {now,history,expectedOrigins:[origin],quarantineCount:2}));
  assert.match(html,/报告已过期/);assert.match(html,/1 个站点缺少报告/);assert.match(html,/2 次不确定提交/);assert.match(html,/每日历史/);
  assert.doesNotMatch(html,/https?:\/\//);
});
test('a later scoped retry cannot remove another account from daily history',()=>{
  const full={runId:'20260930-120000',finishedAt:now.toISOString(),isComplete:true,runState:'final',plannedTotal:2,processedTotal:2,results:[completed(),{origin:'https://other.example',status:'error'}]};
  const partial={runId:'20260930-120001',finishedAt:new Date(now.getTime()+1000).toISOString(),isComplete:false,runState:'final',results:[completed()]};
  const history=historyModel([partial,full],{now:new Date(now.getTime()+2000)});assert.equal(history[0].accounts,2);
});

async function releaseFixture(t) {
  const root=await fixture(t);const base=path.join(root,'base');const next=path.join(root,'next');
  for(const dir of [base,next])await fs.mkdir(path.join(dir,'src'),{recursive:true});
  await fs.writeFile(path.join(base,'src/example.mjs'),'old code\n');await fs.writeFile(path.join(next,'src/example.mjs'),'new code\n');await fs.writeFile(path.join(next,'src/added.mjs'),'new module\n');
  const bundle=path.join(root,'bundle');await createReleaseBundle(base,next,['src/example.mjs','src/added.mjs'],bundle);
  return {root,base,next,bundle};
}
test('release preview, apply and rollback touch only selected code; private state is preserved',async t=>{
  const {base,bundle}=await releaseFixture(t);await fs.mkdir(path.join(base,'data'));await fs.writeFile(path.join(base,'data/state.json'),'runtime marker');
  assert.equal((await previewRelease(base,bundle)).files.length,2);
  const result=await applyRelease(base,bundle);assert.equal(await fs.readFile(path.join(base,'src/example.mjs'),'utf8'),'new code\n');
  await applyRelease(base,result.backup,{rollback:true});assert.equal(await fs.readFile(path.join(base,'src/example.mjs'),'utf8'),'old code\n');
  await assert.rejects(fs.access(path.join(base,'src/added.mjs')));assert.equal(await fs.readFile(path.join(base,'data/state.json'),'utf8'),'runtime marker');
});
test('release refuses drift, package tampering, private paths, duplicates and traversal',async t=>{
  const {base,next,bundle,root}=await releaseFixture(t);
  for(const file of ['../src/a.mjs','src/../a.mjs','data/state.json','config/config.local.json','logs/result.json','src/a.local.json','src/a:stream','src/CON.mjs'])assert.throws(()=>validateReleasePath(file));
  await fs.writeFile(path.join(base,'src/example.mjs'),'local change');await assert.rejects(previewRelease(base,bundle),/Code drift/);
  await fs.writeFile(path.join(base,'src/example.mjs'),'old code\n');await fs.writeFile(path.join(bundle,'files/src/example.mjs'),'tampered');await assert.rejects(previewRelease(base,bundle),/hash mismatch/);
  await assert.rejects(createReleaseBundle(base,next,['src/example.mjs','src/example.mjs'],path.join(root,'duplicate')),/Invalid release/);
});
test('rollback tolerates files left at the original version by a partially interrupted update',async t=>{
  const {base,bundle}=await releaseFixture(t);const applied=await applyRelease(base,bundle);
  await fs.writeFile(path.join(base,'src/example.mjs'),'old code\n');
  const plan=await previewRelease(base,applied.backup,{rollback:true});assert.equal(plan.files[0].operation,'keep');
  await applyRelease(base,applied.backup,{rollback:true});
  assert.equal(await fs.readFile(path.join(base,'src/example.mjs'),'utf8'),'old code\n');await assert.rejects(fs.access(path.join(base,'src/added.mjs')));
});
test('release refuses a running task and a pending manual handoff',async t=>{
  const {base,bundle}=await releaseFixture(t);const lease=await acquireRunLock(path.join(base,'tmp/run.lock'));
  try {await assert.rejects(applyRelease(base,bundle),/正在运行/);} finally {await releaseRunLock(lease);}
  await fs.writeFile(path.join(base,'tmp/manual-verification.json'),JSON.stringify({state:'pending_verification'}));await assert.rejects(applyRelease(base,bundle),/manual handoff/);
});
test('generated JavaScript and PowerShell status contracts have no drift',async()=>{
  await promisify(execFile)(process.execPath,['scripts/generate-checkin-contract.mjs','--check'],{cwd:path.resolve('.'),windowsHide:true});
});
