import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "./security.mjs";
import { acquireRunLock, releaseRunLock } from "./run-lock.mjs";
import { reconcileCheckinResult } from "./checkin-evidence.mjs";
import { isTerminalResult } from "./result-contract.mjs";

function dayKey(at) {
  return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(at).replaceAll("-","");
}
function sameDayDocument(document,report,now) {
  const day=dayKey(now);
  return String(document.sourceRunId??"").startsWith(`${day}-`)
    && String(report.runId??"").startsWith(`${day}-`)
    && Number.isFinite(Date.parse(document.createdAt??""))
    && dayKey(new Date(document.createdAt))===day;
}
export function validManualCompletion(result,now=new Date(),config={}) {
  if(result?.accountResults?.length) return ["signed","already_signed"].includes(result.status) && result.accountResults.every(account=>validManualCompletion({...account,origin:account.origin??result.origin},now,config));
  if(!isTerminalResult(result,now)) return false;
  if(!["signed","already_signed"].includes(result.status)) return true;
  return ["signed","already_signed"].includes(reconcileCheckinResult(result,result.evidence,now,{requireBinding:true,config}).status);
}
function completionForTarget(target,result,now,config) {
  if(!result || result.origin!==target.origin) return null;
  const accountKeys=target.accountKeys?.length ? target.accountKeys : (target.accountKey ? [target.accountKey] : null);
  if(accountKeys) {
    const accounts=accountKeys.map(key=>(result.accountResults??[result]).find(a=>a.accountKey===key));
    if(accounts.some(a=>!a || !validManualCompletion({...a,origin:result.origin},now,config))) return null;
    // Legacy multi-account handoffs use reauth as their whole daily action.
    // A sequence step must still not consume an unspecified whole-site task.
    const actionType=target.actionType ?? (accounts.every(a=>a.actionType==="reauth") ? "reauth" : "checkin");
    if(accounts.some(a=>(a.actionType??"checkin")!==actionType)) return null;
    return {...result,status:accounts.every(a=>a.status==="already_signed")?"already_signed":"signed",accountResults:accounts};
  }
  if((result.actionType??"checkin")!==(target.actionType??"checkin")) return null;
  return validManualCompletion(result,now,config) ? result : null;
}
export function reconcileManualDocument(document,report,kind,{now=new Date(),config={}}={}) {
  if(report?.runState!=="final" || report?.isComplete!==true || !Array.isArray(report.results)
    || !sameDayDocument(document,report,now)) return {document,changed:false};
  if(kind==="verification" && document.state!=="pending_verification") return {document,changed:false};
  if(kind==="handoff" && document.state!=="awaiting_manual_handoff") return {document,changed:false};
  const updated=structuredClone(document);
  const results=new Map(report.results.map(result=>[result.origin,result]));
  let changed=false;
  if(kind==="verification") {
    for (const target of updated.targets??[]) {
      const result=completionForTarget(target,results.get(target.origin),now,config);
      if(!result) continue;
      if(target.verificationStatus===result.status && JSON.stringify(target.evidence)===JSON.stringify(result.evidence)) continue;
      Object.assign(target,{verificationStatus:result.status,verificationReason:result.reason,evidence:result.evidence,
        cycle:result.cycle,actionType:result.actionType,accountKey:result.accountKey,accountResults:result.accountResults,
        allowedOrigins:result.allowedOrigins,actionResults:result.actionResults,requiredActionTypes:result.requiredActionTypes,
        availabilityKind:result.availabilityKind,disabledByConfig:result.disabledByConfig===true,
        temporarilyUnavailable:result.temporarilyUnavailable===true,nextEligibleAt:null});
      changed=true;
    }
    if(changed) {
      const complete=(updated.targets??[]).every(t=>validManualCompletion({...t,status:t.verificationStatus},now,config));
      updated.state=complete ? "verification_complete" : "pending_verification";
      updated.authoritativeEvidenceRequired=!complete;
      updated.verificationRunId=report.runId;
      updated.verifiedAt=now.toISOString();
    }
  } else if(kind==="handoff") {
    const completed=[];
    updated.targets=(updated.targets??[]).filter(target=>{
      const result=completionForTarget(target,results.get(target.origin),now,config);
      if(!result) return true;
      completed.push({...target,verificationStatus:result.status,evidence:result.evidence,cycle:result.cycle,
        accountResults:result.accountResults,actionType:result.actionType,accountKey:result.accountKey,
        allowedOrigins:result.allowedOrigins,actionResults:result.actionResults,requiredActionTypes:result.requiredActionTypes});
      return false;
    });
    if(completed.length) {
      changed=true;
      updated.completedTargets=[...(updated.completedTargets??[]),...completed];
      updated.state=updated.targets.length ? "awaiting_manual_handoff" : "handoff_complete";
      updated.reconciledFromRunId=report.runId;
      updated.reconciledAt=now.toISOString();
    }
  }
  return {document:updated,changed};
}

// Use the same durable path for all final reports, including scoped supplements.
// Merge only verified selected targets; never clear unrelated human work.
export async function syncManualCompletion(projectRoot,report,{now=new Date()}={}) {
  const updates=[];
  const config=await fs.readFile(path.join(projectRoot,"config","config.json"),"utf8").then(JSON.parse).catch(error=>{
    if(error.code==="ENOENT") return {};
    throw error;
  });
  for(const [kind,name] of [["verification","manual-verification.json"],["handoff","manual-handoff.json"]]) {
    const file=path.join(projectRoot,"tmp",name);
    try { await fs.access(file); } catch(error) { if(error.code==="ENOENT") continue; throw error; }
    const lease=await acquireRunLock(`${file}.lock`);
    try {
      const existing=JSON.parse(await fs.readFile(file,"utf8"));
      const update=reconcileManualDocument(existing,report,kind,{now,config});
      if(update.changed) { await atomicWriteJson(file,update.document); updates.push(kind); }
    } finally { await releaseRunLock(lease); }
  }
  return updates;
}
