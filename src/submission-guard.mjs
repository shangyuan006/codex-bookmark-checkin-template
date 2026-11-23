import fs from 'node:fs/promises';
import { checkinCycle } from "./checkin-cycle.mjs";
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson } from './security.mjs';
import { acquireRunLock, releaseRunLock } from './run-lock.mjs';
import { evidenceBinding, reconcileCheckinResult, isConfiguredTerminalCompletion, clearResolvedFailureFields } from './checkin-evidence.mjs';
import { sequentialActionType } from './sequential-action-evidence.mjs';
import { safeErrorMessage } from './security.mjs';
import { sanitizeOAuthPageObservation } from './oauth-target-state.mjs';
import { localRunDate } from './retry-policy.mjs';
import { resultDisplayReason } from './result-presentation.mjs';
import { sanitizeSequentialClickDiagnostics, sanitizeSubmissionDiagnostics } from './sequential-click-diagnostics.mjs';
import { sequentialVerificationRecoveryKey } from './sequential-verification-recovery.mjs';
import { unsignedRecoveryReceipt, validStoredUnsignedRecovery } from './unsigned-recovery.mjs';

export const SUBMISSION_SCOPE = Symbol('submissionScope');
const pageScopes = new WeakMap();
export function attachSubmissionScope(page, scope) { if (scope) pageScopes.set(page,scope); else pageScopes.delete(page); }
export async function beforePageSubmission(page) { await pageScopes.get(page)?.begin(); }
export async function imageCaptchaRetryUsed(page) { return await pageScopes.get(page)?.imageCaptchaRetryUsed() ?? true; }
export async function retryRejectedImageCaptcha(page, proof, rejection) {
  const scope = pageScopes.get(page);
  if (!scope) return false;
  await scope.beginAfterRejectedImageCaptcha(proof, rejection);
  return true;
}
export async function finishRejectedImageCaptcha(page, rejection) {
  await pageScopes.get(page)?.finishRejectedImageCaptcha(rejection);
}

export async function guardPageSubmissions(page,target,scope,{readOnly=false}={}) {
  if (!scope && !readOnly) return;
  attachSubmissionScope(page,scope);
  const allowed = new Set(target.allowedOrigins ?? [target.origin]);
  const actionPath = /check[-_]?in|attendance|showup|lottery|draw|claim|reward|addup|bakatest|\/plugin_sign-in\.php$|\/api\/user\/sign_in/i;
  const extraPaths = new Set(target.submissionPaths ?? []);
  const actionMatches = url => actionPath.test(url.pathname) || extraPaths.has(url.pathname);
  const diagnostics = { blockedCount: 0, readOnlyBlockedCount: 0, intentBlockedCount: 0, documentBlockedCount: 0 };
  const matches = url => allowed.has(url.origin) && actionMatches(url);
  const block = async (route, reason) => {
    diagnostics.blockedCount++; diagnostics[reason]++;
    if (route.request().isNavigationRequest?.()) diagnostics.documentBlockedCount++;
    await route.abort('blockedbyclient');
  };
  const handler = async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (allowed.has(url.origin) && ['POST','PUT','PATCH','DELETE'].includes(request.method())
      && actionMatches(url)) {
      if(typeof readOnly==='function' ? readOnly() : readOnly) { await block(route, 'readOnlyBlockedCount'); return; }
      try { await (pageScopes.get(page)??scope).begin(); } catch { await block(route, 'intentBlockedCount'); return; }
    }
    await route.continue();
  };
  await page.route(matches, handler);
  return { diagnostics: () => ({ ...diagnostics }), stop: () => page.unroute(matches, handler) };
}

const pending = entry => ['intent','uncertain'].includes(entry.state);
function frozenVerificationRejection(value) {
  return value?.submissionsFrozen === true && value.allRejected === true && value.requestFailed === false
    && Number.isInteger(value.requestCount) && value.requestCount > 0 && value.requestCount <= 10000
    && value.rejectionCount === value.requestCount && Number.isInteger(value.verificationRejectionCount)
    && value.verificationRejectionCount > 0 && value.verificationRejectionCount <= value.requestCount
    && value.pendingResponseCount === 0;
}
export function submissionProfileBinding(target, config = {}) {
  const account = (config.agentrouterAccounts ?? []).find(entry => entry.origin === target.origin
    && (entry.accountKey ?? entry.accountId ?? entry.id) === (target.accountKey ?? 'default'));
  const native = (config.nativeChallengePreflight ?? []).find(entry => {
    try { return new URL(entry.url).origin === target.origin; } catch { return false; }
  });
  const profile = target.automationUserDataDir ?? account?.automationUserDataDir ?? config.automationUserDataDir ?? native?.automationUserDataDir;
  if (typeof profile !== 'string' || !profile) return null;
  let absolute = path.resolve(path.dirname(path.dirname(fileURLToPath(import.meta.url))), profile);
  if (process.platform === 'win32') absolute = absolute.toLowerCase();
  // Include any alternate native profile too: a change to either execution
  // profile must invalidate the receipt, even when the fallback mode changes.
  let nativeProfile = typeof native?.automationUserDataDir === 'string'
    ? path.resolve(path.dirname(path.dirname(fileURLToPath(import.meta.url))), native.automationUserDataDir) : null;
  if (nativeProfile && process.platform === 'win32') nativeProfile = nativeProfile.toLowerCase();
  return createHash('sha256').update(JSON.stringify([absolute, nativeProfile, config.browser ?? null, target.accountKey ?? 'default',
    config.newApiAccountRules?.[target.origin] ?? null, config.ptPassiveReadRules?.[target.origin] ?? null,
    account?.authoritativeAccountId ?? account?.siteAccountId ?? null,
    ...(config.piggoCalendarRules?.[target.origin] ? [config.piggoCalendarRules[target.origin]] : [])])).digest('hex');
}

function confirmationEvidence(evidence) {
  const binding = evidence.binding;
  return { source: evidence.source, authoritative: true, confirmedAt: evidence.confirmedAt,
    ...(typeof evidence.outcome === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(evidence.outcome) ? { outcome: evidence.outcome } : {}),
    binding: Object.fromEntries(['version','siteOrigin','accountKey','actionType','cycleId','observedOrigin'].map(key => [key,binding[key]])) };
}

export function recoverConfirmedSubmission(journal, target, config = {}, now = new Date()) {
  const identity = evidenceBinding(target,config,now);
  if (outstandingSubmissions(journal,identity).length) return null;
  const profileBinding = submissionProfileBinding(target,config);
  if (!profileBinding) return null;
  for (const entry of [...journal.entries].reverse()) {
    const receipt = entry.receipt;
    if (entry.state !== 'confirmed' || entry.cycleId !== identity.cycleId || entry.profileBinding !== profileBinding || receipt?.profileBinding !== profileBinding
      || entry.identity.siteOrigin !== identity.siteOrigin || entry.identity.accountKey !== identity.accountKey || entry.identity.actionType !== identity.actionType
      || receipt?.evidence?.authoritative !== true || receipt.evidence.source === 'user_rule') continue;
    const result = reconcileCheckinResult({origin:target.origin,accountKey:target.accountKey ?? 'default',
      actionType:target.actionType ?? 'checkin',status:'already_signed',evidence:receipt.evidence},receipt.evidence,now,{target,config,requireBinding:true});
    if (result.status === 'already_signed') return {...result,cycle:checkinCycle(target.origin,config,now),
      ...(target.allowedOrigins?{allowedOrigins:target.allowedOrigins}:{}),cached:true,observedAt:receipt.evidence.confirmedAt,
      reason:'当前隔离配置已有本周期的权威确认回执，保留原始观察时间'};
  }
  return null;
}
export function outstandingSubmissions(journal, identity) {
  const entries = journal.entries.filter(entry => entry.identity.siteOrigin === identity.siteOrigin
    && entry.identity.accountKey === identity.accountKey && entry.identity.actionType === identity.actionType);
  return entries.filter(entry => pending(entry) && !entries.some(recovery =>
    validStoredUnsignedRecovery(recovery) && recovery.unsignedRecovery.originalIntentIds.includes(entry.id)
    && recovery.cycleId === entry.cycleId && recovery.profileBinding === entry.profileBinding
    && recovery.accountFingerprint === entry.accountFingerprint
    && entry.history.some(event => event.event === 'unsigned_recovery_reserved' && event.recoveryIntentId === recovery.id)));
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
          || !['intent','uncertain','confirmed','rejected'].includes(entry.state)
          || (entry.accountFingerprint != null && !/^[a-f0-9]{64}$/.test(entry.accountFingerprint))
          || (entry.unsignedRecovery != null && (!validStoredUnsignedRecovery(entry)
            || !/^[a-f0-9]{64}$/.test(entry.unsignedRecovery.receipt.id ?? '')
            || !Array.isArray(entry.unsignedRecovery.originalIntentIds) || entry.unsignedRecovery.originalIntentIds.length !== 1
            || !journal.entries.some(prior => prior.id === entry.unsignedRecovery.originalIntentIds[0]
              && prior.id !== entry.id && prior.cycleId === entry.cycleId && prior.profileBinding === entry.profileBinding
              && prior.accountFingerprint === entry.accountFingerprint
              && prior.history?.some(event => event.event === 'unsigned_recovery_reserved' && event.recoveryIntentId === entry.id))))
          || (entry.profileBinding != null && !/^[a-f0-9]{64}$/.test(entry.profileBinding));
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
  if (result?.failureCode === 'submission_quarantined') result = result.submissionObservation;
  if (!result || typeof result !== 'object') return null;
  const code = value => typeof value==='string' && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : undefined;
  const diagnostics = sanitizeSubmissionDiagnostics(result.submissionDiagnostics);
  const recovery = sanitizeSubmissionDiagnostics(result.verificationRecoveryDiagnostics);
  const first = result.firstSubmissionFailure;
  const firstAction = sanitizeSequentialClickDiagnostics(first?.action);
  return {
    status:code(result?.status) ?? 'unknown',
    ...sanitizeOAuthPageObservation(result),
    ...(result?.reason ? {reason:safeErrorMessage(result.reason).slice(0,500)} : {}),
    ...(code(result?.failureCode) ? {failureCode:result.failureCode} : {}),
    ...(code(result?.oauthStage) ? {oauthStage:result.oauthStage} : {}),
    ...(code(result?.authorizationOutcome) ? {authorizationOutcome:result.authorizationOutcome} : {}),
    ...(typeof result?.retryable==='boolean' ? {retryable:result.retryable} : {}),
    ...(diagnostics ? { submissionDiagnostics: diagnostics } : {}),
    ...(recovery ? { verificationRecoveryDiagnostics: recovery } : {}),
    ...(code(first?.failureCode) ? { firstSubmissionFailure: { failureCode: first.failureCode,
      ...(firstAction ? { action: firstAction } : {}) } } : {}),
  };
}

function retainedSubmissionObservation(result, entries) {
  const observed=submissionObservation(result);
  const recorded=entries.flatMap(entry=>entry.history??[]).map(event=>submissionObservation(event.submissionObservation))
    .filter(Boolean).reverse();
  const withDiagnostics = value => {
    if (!value) return value;
    const merged = { ...value };
    for (const key of ['submissionDiagnostics', 'verificationRecoveryDiagnostics', 'firstSubmissionFailure']) {
      if (!merged[key]) {
        const previous = recorded.find(item => item[key]);
        if (previous) merged[key] = previous[key];
      }
    }
    return merged;
  };
  const detailed=value=>value?.failureCode || value?.oauthStage && !['helper_failed','timeout'].includes(value.oauthStage);
  if (detailed(observed)) return withDiagnostics(observed);
  // Fresh daily state supersedes a stale CF blocker only in presentation.
  // The journal lock and the earlier observation remain intact.
  if (['ready','not_signed'].includes(result?.status) && (result.siteBodyLoaded === true
    || result.evidence?.source === 'status_endpoint' && result.evidence.authoritative === true)) return withDiagnostics(observed);
  return withDiagnostics(recorded.find(detailed) ?? observed ?? recorded[0] ?? null);
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
  if(current.length) {
    const guarded = {...result,...quarantineResult(current),submissionObservation:retainedSubmissionObservation(result,current),...warning};
    return {...guarded,reason:resultDisplayReason(guarded)};
  }
  if(["signed","already_signed"].includes(valid?.status)) return {...clearResolvedFailureFields(valid),...warning};
  if(!historical.length) return result;
  if(["deferred","login_required","interactive_challenge","managed_challenge","managed_challenge_timeout","not_available","error"].includes(result?.status)) {
    return {...result,...warning};
  }
  const guarded = {...result,...quarantineResult(historical),submissionAttempted:false,submissionObservation:retainedSubmissionObservation(result,historical),...warning};
  return {...guarded,reason:resultDisplayReason(guarded)};
}

export function createSubmissionScope(file, target, config={}, {now=()=>new Date()}={}) {
  const base = evidenceBinding(target,config,now());
  const identity = {siteOrigin:base.siteOrigin,accountKey:base.accountKey,actionType:base.actionType};
  const profileBinding = submissionProfileBinding(target,config);
  let intentId = null;
  let continuation = null;
  let reauthRecoveryPrepared = false;
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
    async confirmedReceipt() { return recoverConfirmedSubmission(await readSubmissionJournal(file),target,config,now()); },
    // Explicit daily continuation only: a fresh negative observation permits a
    // new cycle, never repeats an uncertain action in its original cycle. Old
    // entries remain unresolved and unchanged in the journal.
    async prepareNewCycleAfterVerifiedReadiness(result) {
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
        return { cycleId: cycle.id, evidenceSource: evidence.source, priorIds: outstanding.map(entry => entry.id) };
      });
      continuation = reservation;
      for (const id of reservation.priorIds) priorCycleEntries.add(id);
    },
    async beginNewCycleAfterVerifiedReadiness(result) {
      await this.prepareNewCycleAfterVerifiedReadiness(result);
      return this.begin();
    },
    // Reuse the original durable reauth intent only after the account state
    // machine has reverified a reset marker and the current logged-out page.
    async prepareReauthenticationRecovery(checkpoint) {
      if (identity.actionType !== 'reauth' || recurringPolicy(target, config) !== 'daily_reauth'
        || checkpoint?.origin !== identity.siteOrigin || checkpoint?.accountKey !== identity.accountKey
        || checkpoint?.status !== 'logged_out' || checkpoint.loginEvidenceReset !== true || checkpoint.logoutConfirmed !== true) {
        throw new Error('Verified reauthentication logout checkpoint is required');
      }
      const resumed = await change(journal => {
        const at = now(), cycle = checkinCycle(target.origin, config, at);
        const verifiedAt = Date.parse(checkpoint.updatedAt ?? '');
        const entries = outstandingSubmissions(journal, identity);
        const { historical, current } = partitionSubmissions(entries, target, config, at);
        if (checkpoint.date !== localRunDate(at) || !Number.isFinite(verifiedAt) || verifiedAt > at.getTime()
          || at.getTime() - verifiedAt > 30_000 || current.length !== 1
          || current[0].cycleId !== cycle.id || Date.parse(current[0].startedAt) > verifiedAt) {
          throw new Error('Current account reauthentication intent is not recoverable');
        }
        return { id: current[0].id, priorIds: historical.map(entry => entry.id) };
      });
      intentId = resumed.id;
      for (const id of resumed.priorIds) priorCycleEntries.add(id);
      reauthRecoveryPrepared = true;
    },
    reauthenticationRecoveryPrepared() { return reauthRecoveryPrepared; },
    // Persist the negative proof and reserve its one replacement intent under
    // the journal lock. Original outcomes remain uncertain in their audit rows.
    async reserveUnsignedRecovery(result, { documentStartedAt } = {}) {
      if (intentId) throw new Error('A submission is already active');
      const id = await change(journal => {
        const at = now(), receipt = unsignedRecoveryReceipt(result, target, config, profileBinding, at);
        const entries = blockingEntries(journal);
        if (!receipt || entries.length !== 1 || !Number.isFinite(documentStartedAt)
          || entries.some(entry => entry.cycleId !== receipt.identity.cycleId
            || entry.profileBinding !== profileBinding || entry.accountFingerprint !== receipt.accountFingerprint
            || entry.history.some(event => Date.parse(event.at) > Date.parse(receipt.observedAt))
            || !Number.isFinite(Date.parse(entry.startedAt)) || documentStartedAt <= Date.parse(entry.startedAt)
            || documentStartedAt > Date.parse(receipt.observedAt)
            || receipt.documentStartedAt <= Date.parse(entry.startedAt))
          || journal.entries.some(entry => entry.cycleId === receipt.identity.cycleId
            && Object.keys(identity).every(key => entry.identity[key] === identity[key]) && entry.unsignedRecovery)) {
          throw new Error('Fresh account-bound evidence from a newer document and an unused recovery are required');
        }
        const recoveryId = randomUUID();
        for (const entry of entries) entry.history.push({ event: 'unsigned_recovery_reserved',
          recoveryIntentId: recoveryId, receiptId: receipt.id, at: at.toISOString() });
        journal.entries.push({ id: recoveryId, identity, cycleId: receipt.identity.cycleId, profileBinding,
          accountFingerprint: receipt.accountFingerprint, startedAt: at.toISOString(), state: 'intent',
          unsignedRecovery: { receipt, originalIntentIds: entries.map(entry => entry.id), originalOutcome: 'unknown' },
          history: [{ event: 'intent', at: at.toISOString() }, { event: 'verified_unsigned_recovery',
            receiptId: receipt.id, at: at.toISOString() }] });
        return recoveryId;
      });
      intentId = id;
      return id;
    },
    async imageCaptchaRetryUsed() {
      const cycle = evidenceBinding(target, config, now()).cycleId;
      return (await readSubmissionJournal(file)).entries.some(entry => entry.cycleId === cycle
        && Object.keys(identity).every(key => entry.identity[key] === identity[key])
        && entry.history.some(event => event.event === 'verified_image_captcha_retry'));
    },
    async beginAfterRejectedImageCaptcha(result, rejection) {
      if (!intentId || identity.actionType !== 'checkin' || !profileBinding
        || !frozenVerificationRejection(rejection) || rejection.requestCount !== 1
        || rejection.verificationRejectionCount !== 1) throw new Error('A live exact image captcha rejection is required');
      intentId = await change(journal => {
        const at = now(), expected = evidenceBinding(target, config, at), proof = result?.evidence;
        const observedAt = Date.parse(proof?.confirmedAt ?? ''), entries = blockingEntries(journal), entry = entries[0];
        if (entries.length !== 1 || entry.id !== intentId || entry.profileBinding !== profileBinding
          || entry.cycleId !== expected.cycleId || result?.status !== 'not_signed'
          || proof?.source !== 'page_text' || proof.authoritative !== true || proof.outcome !== 'daily_checkin_not_signed'
          || !Number.isFinite(observedAt) || observedAt < Date.parse(entry.startedAt)
          || observedAt > at.getTime() || at.getTime() - observedAt > 30000
          || ['version', 'siteOrigin', 'accountKey', 'actionType', 'cycleId'].some(key => proof.binding?.[key] !== expected[key])
          || proof.binding?.observedOrigin !== target.origin
          || journal.entries.some(item => item.cycleId === expected.cycleId
            && Object.keys(identity).every(key => item.identity[key] === identity[key])
            && item.history.some(event => event.event === 'verified_image_captcha_retry'))) {
          throw new Error('Fresh unsigned evidence and an unused image captcha retry are required');
        }
        entry.state = 'rejected';
        entry.history.push({ event: 'rejected', reasonCode: 'image_captcha_rejected', at: at.toISOString() });
        const id = randomUUID();
        journal.entries.push({ id, identity, cycleId: expected.cycleId, profileBinding,
          ...(entry.accountFingerprint ? { accountFingerprint: entry.accountFingerprint } : {}),
          startedAt: at.toISOString(), state: 'intent', history: [{ event: 'intent', at: at.toISOString() },
            { event: 'verified_image_captcha_retry', previousIntentId: entry.id, at: at.toISOString() }] });
        return id;
      });
    },
    async finishRejectedImageCaptcha(rejection) {
      if (!intentId || !frozenVerificationRejection(rejection) || rejection.requestCount !== 1
        || rejection.verificationRejectionCount !== 1 || !await this.imageCaptchaRetryUsed()) {
        throw new Error('An exhausted live image captcha retry must be explicitly rejected');
      }
      await this.reject('image_captcha_retry_exhausted');
    },
    async beginAfterRejectedSequentialVerification(result, ruleKey, rejection) {
      if (!intentId || !profileBinding || !ruleKey || ruleKey !== sequentialVerificationRecoveryKey(target, config)
        || !frozenVerificationRejection(rejection) || rejection.verificationRejectionCount !== rejection.requestCount) {
        throw new Error('An active explicitly rejected daily verification is required');
      }
      intentId = await change(journal => {
        const at = now(), expected = evidenceBinding(target, config, at), proof = result?.evidence;
        const observedAt = Date.parse(proof?.confirmedAt ?? '');
        const entries = blockingEntries(journal), entry = entries[0];
        if (entries.length !== 1 || entry.id !== intentId || entry.cycleId !== expected.cycleId
          || entry.profileBinding !== profileBinding || result?.status !== 'not_signed'
          || !['page_text', 'status_endpoint'].includes(proof?.source) || proof.authoritative !== true
          || proof.outcome !== 'daily_checkin_not_signed' || !Number.isFinite(observedAt)
          || observedAt < Date.parse(entry.startedAt) || observedAt > at.getTime() || at.getTime() - observedAt > 30000
          || ['siteOrigin', 'accountKey', 'actionType', 'cycleId', 'version'].some(key => proof.binding?.[key] !== expected[key])
          || proof.binding?.observedOrigin !== target.origin
          || journal.entries.some(item => item.cycleId === expected.cycleId && item.profileBinding === profileBinding
            && Object.keys(identity).every(key => item.identity[key] === identity[key])
            && item.history.some(event => event.event === 'verified_verification_retry'))) {
          throw new Error('Fresh bound unsigned evidence and an unused verification retry are required');
        }
        entry.state = 'rejected';
        entry.history.push({ event: 'rejected', reasonCode: 'exact_verification_required', ruleKey,
          requestCount: rejection.requestCount, at: at.toISOString() });
        const id = randomUUID();
        journal.entries.push({ id, identity, cycleId: expected.cycleId, profileBinding,
          startedAt: at.toISOString(), state: 'intent', history: [{ event: 'intent', at: at.toISOString() },
            { event: 'verified_verification_retry', ruleKey, previousIntentId: entry.id,
              evidenceSource: proof.source, at: at.toISOString() }],
          ...(entry.accountFingerprint ? { accountFingerprint: entry.accountFingerprint } : {}) });
        return id;
      });
      return intentId;
    },
    // A frozen response batch is useful after a process restart only when it
    // belongs to this exact durable intent. Persist counts and a rule hash,
    // never response bodies, credentials or verification tokens.
    async recordVerificationRejection(ruleKey, rejection) {
      if (!intentId || identity.actionType !== 'checkin' || !/^[a-f0-9]{64}$/.test(ruleKey)
        || !frozenVerificationRejection(rejection)) throw new Error('Frozen bound verification rejection is required');
      await change(journal => {
        const entry = journal.entries.find(item => item.id === intentId);
        const at = now(), expected = evidenceBinding(target, config, at);
        if (!entry || !pending(entry) || entry.cycleId !== expected.cycleId
          || (entry.profileBinding ?? null) !== profileBinding) throw new Error('Verification rejection intent changed');
        entry.verificationRejection = { version: 1, ruleKey, recordedAt: at.toISOString(),
          requestCount: rejection.requestCount, rejectionCount: rejection.rejectionCount,
          verificationRejectionCount: rejection.verificationRejectionCount,
          requestFailed: false, pendingResponseCount: 0, submissionsFrozen: true, allRejected: true };
        entry.history.push({ event: 'verification_rejection_recorded', at: at.toISOString() });
      });
    },
    async releaseRecordedVerificationRejections(result, ruleKey, { documentStartedAt } = {}) {
      if (intentId || identity.actionType !== 'checkin' || !profileBinding || !/^[a-f0-9]{64}$/.test(ruleKey)
        || !Number.isFinite(documentStartedAt)) return 0;
      return change(journal => {
        const at = now(), expected = evidenceBinding(target, config, at), proof = result?.evidence;
        const observedAt = Date.parse(proof?.confirmedAt ?? '');
        if (result?.status !== 'not_signed' || proof?.source !== 'status_endpoint' || proof.authoritative !== true
          || proof.outcome !== 'daily_checkin_not_signed' || !Number.isFinite(observedAt)
          || observedAt > at.getTime() || at.getTime() - observedAt > 30000
          || ['siteOrigin','accountKey','actionType','cycleId','version'].some(key => proof.binding?.[key] !== expected[key])
          || !(target.allowedOrigins ?? [target.origin]).includes(proof.binding?.observedOrigin)) return 0;
        const { current } = partitionSubmissions(outstandingSubmissions(journal, identity), target, config, at);
        if (!current.length || current.some(entry => {
          const receipt = entry.verificationRejection, recordedAt = Date.parse(receipt?.recordedAt ?? '');
          return entry.cycleId !== expected.cycleId || entry.profileBinding !== profileBinding
            || receipt?.version !== 1 || receipt.ruleKey !== ruleKey || !frozenVerificationRejection(receipt)
            || !Number.isFinite(recordedAt) || recordedAt < Date.parse(entry.startedAt) || recordedAt > observedAt
            || documentStartedAt <= recordedAt || documentStartedAt > observedAt;
        })) return 0;
        for (const entry of current) {
          entry.state = 'rejected';
          entry.history.push({ event: 'rejected', reasonCode: 'recorded_verification_required',
            evidenceSource: 'status_endpoint', at: at.toISOString() });
        }
        return current.length;
      });
    },
    // A live caller must first freeze submissions and verify that every action
    // request was explicitly rejected. Fresh server-negative evidence is also
    // required; a timeout or an enabled button cannot release this intent.
    async rejectAfterVerifiedReadiness(result, rejection) {
      if (!intentId || identity.actionType !== 'checkin') throw new Error('An active check-in intent is required');
      if (rejection?.submissionsFrozen !== true || rejection.allRejected !== true || rejection.requestFailed !== false
        || !Number.isInteger(rejection.requestCount) || rejection.requestCount < 1
        || rejection.rejectionCount !== rejection.requestCount || !(rejection.verificationRejectionCount > 0)) {
        throw new Error('Frozen explicitly rejected submissions are required');
      }
      await change(journal => {
        const at = now(), expected = evidenceBinding(target, config, at), proof = result?.evidence;
        const observedAt = Date.parse(proof?.confirmedAt ?? '');
        const entry = journal.entries.find(item => item.id === intentId);
        if (!entry || !pending(entry) || entry.cycleId !== expected.cycleId
          || result?.status !== 'not_signed' || proof?.source !== 'status_endpoint' || proof.authoritative !== true
          || proof.outcome !== 'daily_checkin_not_signed' || !Number.isFinite(observedAt)
          || observedAt < Date.parse(entry.startedAt) || observedAt > at.getTime() || at.getTime() - observedAt > 30000
          || ['siteOrigin','accountKey','actionType','cycleId','version'].some(key => proof.binding?.[key] !== expected[key])
          || !(target.allowedOrigins ?? [target.origin]).includes(proof.binding?.observedOrigin)
          || (entry.profileBinding && entry.profileBinding !== profileBinding)) {
          throw new Error('Fresh authoritative unsigned evidence is required after rejection');
        }
        entry.state = 'rejected';
        entry.history.push({ event: 'rejected', reasonCode: 'verification_required', evidenceSource: 'status_endpoint', at: at.toISOString() });
      });
      intentId = null;
    },
    async begin({ accountFingerprint } = {}) {
      if (intentId) return intentId;
      if (accountFingerprint != null && !/^[a-f0-9]{64}$/.test(accountFingerprint)) throw new Error('Invalid anonymous account binding');
      const reserved = await change(journal => {
        const at = now();
        if (continuation) {
          const entries = outstandingSubmissions(journal, identity);
          if (checkinCycle(target.origin, config, at).id !== continuation.cycleId
            || entries.length !== continuation.priorIds.length
            || entries.some(entry => !continuation.priorIds.includes(entry.id))) {
            throw new Error('Daily continuation changed before submission');
          }
        }
        const outstanding = blockingEntries(journal);
        if (outstanding.length) throw new Error('存在不确定提交，禁止重复动作');
        const id = randomUUID();
        journal.entries.push({id,identity,cycleId:evidenceBinding(target,config,at).cycleId,
          startedAt:at.toISOString(),state:'intent',...(profileBinding?{profileBinding}:{}),
          ...(accountFingerprint ? { accountFingerprint } : {}),history:[{event:'intent',at:at.toISOString()},
            ...(continuation ? [{event:'verified_daily_cycle_continuation',at:at.toISOString(),evidenceSource:continuation.evidenceSource,
              priorCyclePendingCount:continuation.priorIds.length}] : [])]});
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
            && verified.evidence?.authoritative === true
            && (!entry.accountFingerprint || entry.accountFingerprint === result?.accountFingerprint)
            && (!entry.profileBinding || entry.profileBinding === profileBinding);
          entry.state = confirmed ? 'confirmed' : 'uncertain';
          if (confirmed && profileBinding) entry.receipt = {
            profileBinding, status:verified.status, evidence:confirmationEvidence(verified.evidence),
          };
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
    // Reuse is private opt-in; explicit read-only verification always rereads
    // the site, and New API retains its live account/API verification.
    if (config.reuseConfirmedSubmissionReceipts === true && config.checkinReadOnly !== true
      && !config.sequentialActionRules?.[target.origin]
      && !(config.newApiCheckinOrigins ?? []).includes(target.origin)) {
      const recovered = await scope.confirmedReceipt();
      if (recovered) return recovered;
    }
    let result = await run({...config,checkinReadOnly:config.checkinReadOnly===true || previous.length>0,[SUBMISSION_SCOPE]:scope});
    if(previous.length && config.checkinReadOnly!==true && result?.status==="not_signed") {
      const {current}=partitionSubmissions(previous,target,config,now());
      if(!current.length) {
        await scope.prepareNewCycleAfterVerifiedReadiness(result);
        result=await run({...config,checkinReadOnly:false,[SUBMISSION_SCOPE]:scope});
      }
    } else if (previous.length && config.checkinReadOnly !== true && scope.reauthenticationRecoveryPrepared()) {
      result = await run({...config,checkinReadOnly:false,[SUBMISSION_SCOPE]:scope});
    }
    // Preserve ambiguous submissions reported by legacy/native adapters too.
    if (config.checkinReadOnly!==true && !previous.length && result?.submissionAttempted === true && result.submissionTracked !== true && result.submissionTrackedPerAction !== true && !result.quarantine?.actionType && !(await scope.pending()).length) await scope.begin();
    await scope.observe(result);
    const remaining = await scope.allPending();
    return reconcileSubmissionResult(result,remaining,target,config,now());
  } catch (error) {
    const remaining = await scope.observe({status:'error'});
    if (remaining.length) return reconcileSubmissionResult({status:"error",reason:"签到处理未完成，保留提交记录"},remaining,target,config,now());
    throw error;
  }
}
