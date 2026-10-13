import fs from 'node:fs/promises';
import { checkinCycle } from "./checkin-cycle.mjs";
import { randomUUID } from 'node:crypto';
import { atomicWriteJson } from './security.mjs';
import { acquireRunLock, releaseRunLock } from './run-lock.mjs';
import { evidenceBinding, reconcileCheckinResult, isConfiguredTerminalCompletion, clearResolvedFailureFields } from './checkin-evidence.mjs';
import { sequentialActionType } from './sequential-action-evidence.mjs';
import { safeErrorMessage } from './security.mjs';
import { sanitizeOAuthPageObservation } from './oauth-target-state.mjs';

export const SUBMISSION_SCOPE = Symbol('submissionScope');
const pageScopes = new WeakMap();
export function attachSubmissionScope(page, scope) { if (scope) pageScopes.set(page,scope); else pageScopes.delete(page); }
export async function beforePageSubmission(page) { await pageScopes.get(page)?.begin(); }

export async function guardPageSubmissions(page,target,scope,{readOnly=false}={}) {
  if (!scope && !readOnly) return;
  attachSubmissionScope(page,scope);
  const allowed = new Set(target.allowedOrigins ?? [target.origin]);
  const actionPath = /check[-_]?in|attendance|showup|lottery|draw|claim|reward|addup|bakatest|\/api\/user\/sign_in/i;
  await page.route(url=>allowed.has(url.origin)&&actionPath.test(url.pathname),async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (allowed.has(url.origin) && ['POST','PUT','PATCH','DELETE'].includes(request.method())
      && actionPath.test(url.pathname)) {
      if(typeof readOnly==='function' ? readOnly() : readOnly) { await route.abort('blockedbyclient'); return; }
      try { await (pageScopes.get(page)??scope).begin(); } catch { await route.abort('blockedbyclient'); return; }
    }
    await route.continue();
  });
}

const pending = entry => ['intent','uncertain'].includes(entry.state);
export function outstandingSubmissions(journal, identity) {
  return journal.entries.filter(entry => pending(entry) && entry.identity.siteOrigin === identity.siteOrigin
    && entry.identity.accountKey === identity.accountKey && entry.identity.actionType === identity.actionType);
}

export async function readSubmissionJournal(file) {
  try {
    const journal = JSON.parse(await fs.readFile(file,'utf8'));
    if (journal?.version !== 1 || !Array.isArray(journal.entries)
      || new Set(journal.entries.map(entry=>entry?.id)).size!==journal.entries.length
      || journal.entries.some(entry => {
        try { evidenceBinding({origin:entry.identity.siteOrigin,accountKey:entry.identity.accountKey,actionType:entry.identity.actionType}); }
        catch { return true; }
        return !/^[a-f0-9-]{36}$/.test(entry?.id??'') || typeof entry.cycleId!=='string' || entry.cycleId.length>200
          || !entry.cycleId || !Number.isFinite(Date.parse(entry.startedAt??''))
          || !Array.isArray(entry.history)||!entry.history.length
          || entry.history.some(event=>!event?.event||!Number.isFinite(Date.parse(event.at??'')))
          || !['intent','uncertain','confirmed','rejected'].includes(entry.state);
      })) throw new Error('invalid journal');
    return journal;
  } catch (error) {
    if (error.code === 'ENOENT') return {version:1,entries:[]};
    throw new Error('提交隔离记录不可读取，拒绝继续提交');
  }
}

export function quarantineResult(entries) {
  return {status:'needs_attention',reason:'存在尚未确认的提交；仅允许只读核验，不自动重复动作',
    submissionAttempted:true,retryable:false,failureCode:'submission_quarantined',
    quarantine:{pendingCount:entries.length,actionType:entries[0]?.identity.actionType,firstAttemptAt:entries[0]?.startedAt}};
}

function submissionObservation(result) {
  if (result?.failureCode === 'submission_quarantined') return result.submissionObservation ?? null;
  const code = value => typeof value==='string' && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : undefined;
  return {
    status:code(result?.status) ?? 'unknown',
    ...sanitizeOAuthPageObservation(result),
    ...(result?.reason ? {reason:safeErrorMessage(result.reason).slice(0,500)} : {}),
    ...(code(result?.failureCode) ? {failureCode:result.failureCode} : {}),
    ...(code(result?.oauthStage) ? {oauthStage:result.oauthStage} : {}),
    ...(code(result?.authorizationOutcome) ? {authorizationOutcome:result.authorizationOutcome} : {}),
    ...(typeof result?.retryable==='boolean' ? {retryable:result.retryable} : {}),
  };
}

function retainedSubmissionObservation(result, entries) {
  const observed=submissionObservation(result);
  const detailed=value=>value?.failureCode || value?.oauthStage && !['helper_failed','timeout'].includes(value.oauthStage);
  if (detailed(observed)) return observed;
  const recorded=entries.flatMap(entry=>entry.history??[]).map(event=>event.submissionObservation)
    .filter(Boolean).reverse();
  return recorded.find(detailed) ?? observed ?? recorded[0] ?? null;
}

export function partitionSubmissions(entries,target,config={},now=new Date()) {
  const cycle = checkinCycle(target.origin,config,now);
  const historical=[], current=[];
  for (const entry of entries) {
    const started=new Date(entry.startedAt);
    const older=Number.isFinite(started.getTime()) && started.getTime()<Date.parse(cycle.startAt)
      && entry.cycleId===checkinCycle(target.origin,config,started).id;
    (older ? historical : current).push(entry);
  }
  return {historical,current};
}

function recurringPolicy(target,config) {
  const action=target.actionType??"checkin";
  if(action==="checkin") return "daily_checkin";
  if(action==="reauth") {
    const rule=config.reauthCheckinRules?.[target.origin];
    const accounts=(config.agentrouterAccounts??[]).filter(a=>a.origin===target.origin);
    const allowed=accounts.length ? accounts.some(a=>(a.accountKey??a.accountId??a.id)===(target.accountKey??"default")) : (target.accountKey??"default")==="default";
    return rule?.enabled!==false && rule?.allowCycleContinuation===true && allowed ? "daily_reauth" : null;
  }
  for (const step of config.sequentialActionRules?.[target.origin]?.steps??[]) {
    const key=sequentialActionType(step);
    if(key===action) return step.dailyCheckin===true ? "daily_checkin" : (step.dailyQuotaPattern ? "daily_quota" : null);
  }
  return null;
}

// Completion and unresolved historical actions are different facts. Never
// clear an older entry using today's evidence, or erase today's valid result.
export function reconcileSubmissionResult(result,remaining,target,config={},now=new Date()) {
  const {historical,current}=partitionSubmissions(remaining,target,config,now);
  const warning=historical.length ? {historicalSubmissionWarning:{pendingCount:historical.length,
    actionType:historical[0].identity.actionType,firstAttemptAt:historical[0].startedAt}} : {};
  // Older reports could overwrite an explicitly configured terminal completion
  // with quarantine while retaining its original bound observation. Restore
  // only that exact rule; never manufacture evidence or release the journal.
  const legacyCompletion = result?.status === "needs_attention" && result.failureCode === "submission_quarantined"
    && result.evidence?.source === "user_rule" && result.evidence.authoritative === false
    ? { ...result, status: "already_signed" } : null;
  const completion = legacyCompletion && isConfiguredTerminalCompletion(legacyCompletion, target, config, now)
    ? { ...legacyCompletion, reason: "按用户明确配置的终止条件视为今日已签到，停止重试", configuredTerminalStop: true } : result;
  const valid=reconcileCheckinResult(completion,completion?.evidence,now,{target,config,requireBinding:true});
  if (current.length && isConfiguredTerminalCompletion(valid, target, config, now)) {
    return { ...clearResolvedFailureFields(valid), configuredTerminalStop: true, ...warning,
      submissionLockWarning: { pendingCount: current.length, actionType: current[0].identity.actionType,
        firstAttemptAt: current[0].startedAt, submissionBlocked: true, currentCycle: true } };
  }
  if(current.length) return {...result,...quarantineResult(current),submissionObservation:retainedSubmissionObservation(result,current),...warning};
  if(["signed","already_signed"].includes(valid?.status)) return {...clearResolvedFailureFields(valid),...warning};
  if(!historical.length) return result;
  if(["deferred","login_required","interactive_challenge","managed_challenge","managed_challenge_timeout","not_available","error"].includes(result?.status)) {
    return {...result,...warning};
  }
  return {...result,...quarantineResult(historical),submissionAttempted:false,submissionObservation:retainedSubmissionObservation(result,historical),...warning};
}

export function createSubmissionScope(file, target, config={}, {now=()=>new Date()}={}) {
  const base = evidenceBinding(target,config,now());
  const identity = {siteOrigin:base.siteOrigin,accountKey:base.accountKey,actionType:base.actionType};
  let intentId = null;
  const priorCycleEntries = new Set();
  const blockingEntries = journal => outstandingSubmissions(journal,identity)
    .filter(entry => !priorCycleEntries.has(entry.id));
  async function change(operation) {
    const lease = await acquireRunLock(`${file}.lock`);
    try {
      const journal = await readSubmissionJournal(file);
      const outcome = await operation(journal);
      await atomicWriteJson(file,journal);
      return outcome;
    } finally { await releaseRunLock(lease); }
  }
  return {
    async isPending() { return (await this.pending()).length>0; },
    async pending() { return blockingEntries(await readSubmissionJournal(file)); },
    async allPending() { return outstandingSubmissions(await readSubmissionJournal(file),identity); },
    // Explicit daily continuation only: a fresh negative observation permits a
    // new cycle, never repeats an uncertain action in its original cycle. Old
    // entries remain unresolved and unchanged in the journal.
    async beginNewCycleAfterVerifiedReadiness(result) {
      if (intentId) throw new Error("A submission is already active");
      const reservation = await change(journal => {
        const at = now();
        const cycle = checkinCycle(target.origin,config,at);
        const expected = evidenceBinding(target,config,at);
        const evidence = result?.evidence;
        const observedAt = Date.parse(evidence?.confirmedAt ?? "");
        const binding = evidence?.binding;
        const policy=recurringPolicy(target,config);
        const reauth=policy==="daily_reauth";
        const expectedOutcome=reauth ? "configured_daily_reauth_due" : (policy==="daily_quota" ? "daily_quota_available" : "daily_checkin_not_signed");
        if (!policy || result?.status !== "not_signed"
          || evidence?.outcome !== expectedOutcome
          || (reauth ? evidence?.source!=="reauth_state" || evidence?.authoritative!==false : evidence?.authoritative!==true || !["page_text","status_endpoint"].includes(evidence?.source))
          || !Number.isFinite(observedAt) || observedAt > at.getTime() || at.getTime()-observedAt > 30_000
          || observedAt < Date.parse(cycle.startAt) || binding?.version !== 2
          || ["siteOrigin","accountKey","actionType","cycleId"].some(key => binding?.[key] !== expected[key])
          || !(target.allowedOrigins ?? [target.origin]).includes(binding?.observedOrigin)) {
          throw new Error("Fresh bound daily unsigned evidence is required");
        }
        const outstanding = outstandingSubmissions(journal,identity);
        if (!outstanding.length || outstanding.some(entry => entry.cycleId === cycle.id
          || Date.parse(entry.startedAt) >= Date.parse(cycle.startAt)
          || entry.cycleId !== checkinCycle(target.origin,config,new Date(entry.startedAt)).id)) {
          throw new Error("Same-cycle or non-historical submissions remain blocked");
        }
        const id = randomUUID();
        journal.entries.push({id,identity,cycleId:cycle.id,startedAt:at.toISOString(),state:"intent",
          history:[{event:"intent",at:at.toISOString()},{event:"verified_daily_cycle_continuation",
            at:at.toISOString(),evidenceSource:evidence.source,priorCyclePendingCount:outstanding.length}]});
        return { id, priorIds: outstanding.map(entry => entry.id) };
      });
      intentId = reservation.id;
      for (const id of reservation.priorIds) priorCycleEntries.add(id);
      return intentId;
    },
    async begin() {
      if (intentId) return intentId;
      const reserved = await change(journal => {
        const outstanding = blockingEntries(journal);
        if (outstanding.length) throw new Error('存在不确定提交，禁止重复动作');
        const at = now();
        const id = randomUUID();
        journal.entries.push({id,identity,cycleId:evidenceBinding(target,config,at).cycleId,
          startedAt:at.toISOString(),state:'intent',history:[{event:'intent',at:at.toISOString()}]});
        return id;
      });
      intentId = reserved;
      return intentId;
    },
    // Only an explicit server rejection (not a timeout or a login page) proves
    // that this request did not apply. It remains in the append-only history.
    async reject(reasonCode='explicit_rejection') {
      if (!/^[a-z][a-z0-9_]{0,79}$/.test(reasonCode)) throw new Error('Rejection needs a non-private reason code');
      if (!intentId) return;
      await change(journal => {
        const entry = journal.entries.find(entry => entry.id === intentId);
        entry.state = 'rejected';
        entry.history.push({event:'rejected',reasonCode,at:now().toISOString()});
      });
      intentId = null;
    },
    async observe(result) {
      if (!(await this.pending()).length) return [];
      return change(journal => {
        const outstanding = blockingEntries(journal);
        for (const entry of outstanding) {
          const verified = reconcileCheckinResult(result,result?.evidence,now(),
            {target,config,cycleId:entry.cycleId,requireBinding:true});
          const confirmed = ['signed','already_signed'].includes(verified?.status)
            && verified.evidence?.authoritative === true;
          entry.state = confirmed ? 'confirmed' : 'uncertain';
          entry.history.push({event:confirmed?'confirmed':'read_only_unconfirmed',at:now().toISOString(),
            status:/^[a-z_]{1,64}$/.test(result?.status??'')?result.status:'unknown',
            ...(!confirmed && !['signed','already_signed'].includes(result?.status) && result?.failureCode!=='submission_quarantined'
              ? {submissionObservation:submissionObservation(result)} : {}),
            evidenceSource:['page_text','status_endpoint','reward_log','user_rule','reauth_state'].includes(result?.evidence?.source)?result.evidence.source:null});
        }
        return outstanding.filter(pending);
      });
    },
  };
}

// No isolated browser operation may be submitted until its intent is durable.
// Old-cycle isolation remains active even when today's login is successful.
export async function runWithSubmissionJournal(file,target,config,run,{now=()=>new Date()}={}) {
  const scope = createSubmissionScope(file,target,config,{now});
  const previous = await scope.pending();
  try {
    let result = await run({...config,checkinReadOnly:config.checkinReadOnly===true || previous.length>0,[SUBMISSION_SCOPE]:scope});
    if(previous.length && config.checkinReadOnly!==true && result?.status==="not_signed") {
      const {current}=partitionSubmissions(previous,target,config,now());
      if(!current.length) {
        await scope.beginNewCycleAfterVerifiedReadiness(result);
        result=await run({...config,checkinReadOnly:false,[SUBMISSION_SCOPE]:scope});
      }
    }
    // Preserve ambiguous submissions reported by legacy/native adapters too.
    if (config.checkinReadOnly!==true && !previous.length && result?.submissionAttempted === true && result.submissionTrackedPerAction !== true && !result.quarantine?.actionType && !(await scope.pending()).length) await scope.begin();
    await scope.observe(result);
    const remaining = await scope.allPending();
    return reconcileSubmissionResult(result,remaining,target,config,now());
  } catch (error) {
    const remaining = await scope.observe({status:'error'});
    if (remaining.length) return reconcileSubmissionResult({status:"error",reason:"签到处理未完成，保留提交记录"},remaining,target,config,now());
    throw error;
  }
}
