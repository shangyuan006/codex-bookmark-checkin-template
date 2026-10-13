import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reconcileManualDocument,syncManualCompletion } from "../src/manual-result-reconciliation.mjs";
import { bindSuccessEvidence,successEvidence } from "../src/checkin-evidence.mjs";
import { writeRunResult } from "../src/logger.mjs";

const now=new Date("2026-10-02T04:00Z");
const a="https://a.example", b="https://b.example";
const complete=(origin=a,at=now,extra={})=>bindSuccessEvidence({status:"signed",reason:"Site confirmed completion",evidence:successEvidence("page_text","completed",at)}, {origin,...extra},{},at);
function document(kind="verification") {return {state:kind==="verification"?"pending_verification":"awaiting_manual_handoff",sourceRunId:"20261002-110000",createdAt:now.toISOString(),authoritativeEvidenceRequired:true,targets:[a,b].map(origin=>({origin,verificationStatus:"needs_attention"}))};}
const report=results=>({runId:"20261002-120000",runState:"final",isComplete:true,results});
test("partial supplements update only confirmed targets and preserve other human work",()=>{
  const update=reconcileManualDocument(document(),report([complete()]),"verification",{now});
  assert.equal(update.changed,true);assert.equal(update.document.targets[0].verificationStatus,"signed");
  assert.equal(update.document.targets[1].verificationStatus,"needs_attention");assert.equal(update.document.state,"pending_verification");
});
test("handoff archive removes only completed targets and never reopens them",()=>{
  const first=reconcileManualDocument(document("handoff"),report([complete()]),"handoff",{now});
  assert.deepEqual(first.document.targets.map(t=>t.origin),[b]);assert.equal(first.document.completedTargets[0].origin,a);
  const second=reconcileManualDocument(first.document,report([complete(b)]),"handoff",{now});
  assert.equal(second.document.state,"handoff_complete");assert.equal(second.document.completedTargets.length,2);
});
test("wrong-day, future, stale-cycle and unbound signals cannot clear records",()=>{
  const wrong=complete();wrong.evidence.binding.accountKey="other";
  for(const result of [wrong,complete(a,new Date("2026-10-01T04:00Z")),complete(a,new Date("2026-10-02T04:00:01Z")),{origin:a,status:"signed"}]) {
    assert.equal(reconcileManualDocument(document(),report([result]),"verification",{now}).changed,false);
  }
  const older=document();older.sourceRunId="20261001-120000";
  assert.equal(reconcileManualDocument(older,report([complete()]),"verification",{now}).changed,false);
});
test("one reauth account cannot clear the other account handoff",()=>{
  const doc=document("handoff");doc.targets=[{origin:a,accountKeys:["github"]}];
  const incoming={origin:a,status:"signed",accountResults:[complete(a,now,{accountKey:"linuxdo",actionType:"reauth"})]};
  assert.equal(reconcileManualDocument(doc,report([incoming]),"handoff",{now}).changed,false);
});
test("account-scoped whole-site tasks reject sequence steps and retain legacy reauth completion",()=>{
  const doc=document("handoff");doc.targets=[{origin:a,accountKeys:["github"]}];
  const draw=complete(a,now,{accountKey:"github",actionType:"daily_draw"});
  assert.equal(reconcileManualDocument(doc,report([draw]),"handoff",{now}).changed,false);
  const nested={origin:a,status:"signed",accountResults:[draw]};
  assert.equal(reconcileManualDocument(doc,report([nested]),"handoff",{now}).changed,false);
  const scoped=structuredClone(doc);scoped.targets[0].actionType="daily_draw";
  assert.equal(reconcileManualDocument(scoped,report([draw]),"handoff",{now}).document.state,"handoff_complete");
  const reauth={origin:a,status:"signed",accountResults:[complete(a,now,{accountKey:"github",actionType:"reauth"})]};
  assert.equal(reconcileManualDocument(doc,report([reauth]),"handoff",{now}).document.state,"handoff_complete");
});
test("explicit single-account and action identities cannot consume another task",()=>{
  const doc=document("handoff");doc.targets=[{origin:a,accountKey:"github",actionType:"reauth"}];
  assert.equal(reconcileManualDocument(doc,report([complete(a,now,{accountKey:"linuxdo",actionType:"reauth"})]),"handoff",{now}).changed,false);
  assert.equal(reconcileManualDocument(doc,report([complete(a,now,{accountKey:"github",actionType:"checkin"})]),"handoff",{now}).changed,false);
  assert.equal(reconcileManualDocument(doc,report([complete(a,now,{accountKey:"github",actionType:"reauth"})]),"handoff",{now}).changed,true);
});
test("all verified results complete the document without erasing history",()=>{
  const update=reconcileManualDocument(document(),report([complete(),complete(b)]),"verification",{now});
  assert.equal(update.document.state,"verification_complete");assert.equal(update.document.authoritativeEvidenceRequired,false);
  assert.equal(update.document.targets.length,2);
});
test("writing a scoped final report synchronizes real handoff files",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"manual-report-reconcile-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const logs=path.join(root,"logs"),runLog={runId:"20261002-120000",directory:path.join(logs,"20261002-120000")};
  await fs.mkdir(runLog.directory,{recursive:true});await fs.mkdir(path.join(root,"tmp"));
  for(const [name,kind] of [["manual-verification.json","verification"],["manual-handoff.json","handoff"]]) await fs.writeFile(path.join(root,"tmp",name),JSON.stringify(document(kind)));
  const result={...report([complete()]),finishedAt:now.toISOString(),plannedTotal:1,processedTotal:1};
  await writeRunResult(logs,runLog,result,{updateLatest:false,now});
  const verification=JSON.parse(await fs.readFile(path.join(root,"tmp/manual-verification.json"),"utf8"));
  const handoff=JSON.parse(await fs.readFile(path.join(root,"tmp/manual-handoff.json"),"utf8"));
  assert.equal(verification.targets[0].verificationStatus,"signed");assert.deepEqual(handoff.targets.map(t=>t.origin),[b]);
  assert.deepEqual(await syncManualCompletion(root,result,{now}),[]);
});
test("writing an archived final report never substitutes its date for the current day",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"manual-archive-reconcile-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const logs=path.join(root,"logs"),runLog={runId:"20261002-120000",directory:path.join(logs,"20261002-120000")};
  await fs.mkdir(runLog.directory,{recursive:true});await fs.mkdir(path.join(root,"tmp"));
  const file=path.join(root,"tmp/manual-handoff.json");await fs.writeFile(file,JSON.stringify(document("handoff")));
  await writeRunResult(logs,runLog,{...report([complete()]),finishedAt:now.toISOString(),plannedTotal:1,processedTotal:1},
    {updateLatest:false,now:new Date("2026-10-03T04:00Z")});
  assert.deepEqual(JSON.parse(await fs.readFile(file,"utf8")),document("handoff"));
});
