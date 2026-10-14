import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordStatusHistory,loadStatusHistoryArchive } from '../src/status-history-store.mjs';
import { loadStatusHistory,historyModel } from '../src/status-history.mjs';
import { statusPageModel,renderStatusPage,generateStatusPage } from '../src/status-dashboard.mjs';
import { writeRunResult } from '../src/logger.mjs';
import { atomicWriteText } from '../src/security.mjs';
import { bindSuccessEvidence,successEvidence } from '../src/checkin-evidence.mjs';

const now=new Date(2026,9,13,12),origin='https://history.example';
const done=bindSuccessEvidence({status:'signed',submissionAttempted:true,evidence:successEvidence('status_endpoint','checked_in_today',now)},{origin},{},now);
const report={runId:'20261013-120000',runState:'final',isComplete:true,finishedAt:now.toISOString(),results:[done]};
const day=()=>historyModel([report],{now})[0];
async function fixture(t) {const root=await fs.mkdtemp(path.join(os.tmpdir(),'status-archive-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}

test('history persists only aggregate counters and dates after raw log removal',async t=>{
  const root=await fixture(t),logs=path.join(root,'logs'),directory=path.join(logs,report.runId);
  await fs.mkdir(directory,{recursive:true});
  await writeRunResult(logs,{directory},report,{now});
  assert.equal(day().counts.uncertain,0);
  await fs.rm(logs,{recursive:true,force:true});
  const history=await loadStatusHistory(root,{now});
  assert.equal(history.days.length,1);assert.equal(history.days[0].counts.authoritative,1);
  assert.doesNotMatch(await fs.readFile(path.join(root,'data/status-history.json'),'utf8'),/history\.example|accountKey|status_endpoint/);
});

test('a later partial report cannot shrink an archived complete day',async t=>{
  const root=await fixture(t);await recordStatusHistory(root,day());
  await recordStatusHistory(root,{...day(),finishedAt:new Date(now.getTime()+1000).toISOString(),complete:false,
    accounts:0,counts:{authoritative:0,user_rule:0,unbound:0,pending:0,unavailable:0,uncertain:0}});
  assert.deepEqual((await loadStatusHistoryArchive(root)).days,[day()]);
});

test('history recovers its previous valid generation and reports corruption',async t=>{
  const root=await fixture(t);await recordStatusHistory(root,day());
  await recordStatusHistory(root,{...day(),finishedAt:new Date(now.getTime()+1000).toISOString()});
  await fs.writeFile(path.join(root,'data/status-history.json'),'{broken');
  const archive=await loadStatusHistoryArchive(root);
  assert.equal(archive.recovered,true);assert.equal(archive.unreadable,true);assert.deepEqual(archive.days,[day()]);
  const history=await loadStatusHistory(root,{now});
  assert.equal(history.archiveRecovered,true);
  assert.match(renderStatusPage(statusPageModel(report,{}, {},[],{}, {now,history})),/已读取上一份有效摘要/);
});

test('unrecoverable history is preserved and never silently overwritten',async t=>{
  const root=await fixture(t),file=path.join(root,'data/status-history.json');await fs.mkdir(path.dirname(file));
  await fs.writeFile(file,'{broken');await assert.rejects(recordStatusHistory(root,day()),/preserve/);
  assert.equal(await fs.readFile(file,'utf8'),'{broken');
  await assert.rejects(recordStatusHistory(root,{...day(),counts:{...day().counts,pending:1}}),/Invalid/);
});

test('history does not exclude unavailable claims without an authoritative disabled signal',()=>{
  const counts=historyModel([{...report,results:[{origin,status:'not_available'}]}],{now})[0].counts;
  assert.equal(counts.unavailable,0);assert.equal(counts.pending,1);
});

test('status page detects yesterday and future reports without invalidating a current site cycle',()=>{
  const custom={siteCycleRules:{[origin]:{resetAt:'13:00'}}},yesterday=new Date(2026,9,12,23);
  const current=bindSuccessEvidence({status:'signed',evidence:successEvidence('page_text','checked_in_today',yesterday)},{origin},custom,yesterday);
  const model=statusPageModel({...report,runId:'20261012-230000',finishedAt:yesterday.toISOString(),results:[current]}, {},{},[],{}, {now});
  assert.equal(model.stale,true);assert.equal(model.rows[0].evidenceKind,'authoritative');
  assert.equal(statusPageModel({...report,finishedAt:new Date(now.getTime()+1000).toISOString()}, {},{},[],{}, {now}).stale,true);
});

test('completion rates keep site faults, unverified unavailability and missing targets in the denominator',()=>{
  const unavailable={origin:'https://disabled.example',status:'not_available',availabilityKind:'feature_disabled',
    evidence:{source:'new_api_checkin_status',outcome:'enabled_false',authoritative:true,confirmedAt:now.toISOString()}};
  const model=statusPageModel({...report,results:[done,unavailable,{origin:'https://fault.example',status:'deferred',failureCode:'site_server_error'},
    {origin:'https://unknown.example',status:'not_available'},{origin:'https://skip.example',status:'abandoned'}]}, {},{},[],{},
    {now,expectedOrigins:[origin,unavailable.origin,'https://fault.example','https://unknown.example','https://skip.example','https://missing.example'],quarantineCount:'<unsafe>'});
  const html=renderStatusPage(model);
  assert.match(html,/16\.7%（1\/6）/);assert.match(html,/25\.0%（1\/4）/);
  assert.match(html,/站点服务异常/);assert.match(html,/&lt;unsafe&gt;/);assert.doesNotMatch(html,/<unsafe>/);
});

test('atomic HTML publication preserves the old page if Windows rename retries all fail',async()=>{
  const files=new Map([['status.html','old snapshot']]);
  const io={mkdir:async()=>{},writeFile:async(file,text)=>{files.set(file,text);},rename:async()=>{throw Object.assign(new Error('busy'),{code:'EPERM'});},unlink:async file=>{files.delete(file);}};
  await assert.rejects(atomicWriteText('status.html','new snapshot',{io,platform:'win32',wait:async()=>{}}),/busy/);
  assert.deepEqual([...files],[['status.html','old snapshot']]);
});

test('generated status page remains a local escaped snapshot using the shared status labels',async t=>{
  t.mock.timers.enable({apis:['Date'],now:now.getTime()});
  const root=await fixture(t);await fs.mkdir(path.join(root,'logs'));
  await fs.writeFile(path.join(root,'logs/latest.json'),JSON.stringify(report));
  const {output}=await generateStatusPage(root),html=await fs.readFile(output,'utf8');
  assert.match(html,/签到状态/);assert.match(html,/已签到/);assert.match(html,/default-src 'none'/);
  assert.deepEqual((await fs.readdir(path.dirname(output))),['status.html']);
});
