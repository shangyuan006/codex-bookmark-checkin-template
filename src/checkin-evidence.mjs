import { safeLogUrl } from './security.mjs';
import { checkinCycle } from './checkin-cycle.mjs';
import { CHECKIN_CONTRACT } from './checkin-contract.generated.mjs';
import { configuredSequentialActionTypes } from './sequential-action-evidence.mjs';

const success=new Set(CHECKIN_CONTRACT.successStatuses);
const sources=new Set(['page_text','status_endpoint','reward_log','user_rule','reauth_state']);
// Clear current failure presentation only; submission locks live in the journal.
export function clearResolvedFailureFields(result) {
  if (!success.has(result?.status)) return result;
  const failureKeys = ["failureCode", "quarantine", "retryCause", "nextEligibleAt", "invalidReportedStatus", "submissionObservation"];
  const accountResults = result.accountResults?.map(clearResolvedFailureFields);
  const accountsChanged = accountResults?.some((account, index) => account !== result.accountResults[index]) === true;
  if (!failureKeys.some(key => Object.hasOwn(result, key) && result[key] !== null)
    && (!Object.hasOwn(result, "retryable") || result.retryable === false) && !accountsChanged) return result;
  const clean = { ...result, ...(accountsChanged ? { accountResults } : {}) };
  for (const key of failureKeys) {
    if (Object.hasOwn(clean, key)) clean[key] = null;
  }
  if (Object.hasOwn(clean, "retryable")) clean.retryable = false;
  return clean;
}

export function isConfiguredTerminalCompletion(result, target, config = {}, now = new Date()) {
  if (result?.evidence?.source !== "user_rule" || result.evidence.authoritative !== false
    || (target.actionType ?? "checkin") !== "checkin") return false;
  const valid = reconcileCheckinResult(result, result.evidence, now, { target, config, requireBinding: true });
  if (!success.has(valid?.status)) return false;
  let url;
  try { url = new URL(result.url); } catch { return false; }
  if (url.origin !== valid.evidence.binding.observedOrigin) return false;
  const rule = config.preCheckinNavigationRules?.[url.origin];
  if (!rule || rule.enabled === false || rule.terminalAssumeSigned !== true) return false;
  if (valid.evidence.outcome === "missing_navigation_control") {
    return rule.terminalWhenNavigationControlMissing === true && rule.terminalRequireAuthenticatedPage === true
      && (rule.terminalMissingControlPaths ?? ["/", "/index.php"]).includes(url.pathname);
  }
  return ["terminal_path", "terminal_discovery_path"].includes(valid.evidence.outcome)
    && (rule.terminalPaths ?? []).includes(url.pathname);
}
// Readiness is not completion. Only adapters that have freshly observed the
// negative daily state (or an explicitly configured recurring reauth contract)
// may construct it. Never infer it from a clickable button or a cached login.
export function dailyReadinessEvidence(target, config={}, {source="page_text", outcome="daily_checkin_not_signed", authoritative=true, observedOrigin=target.origin, now=new Date()}={}) {
  return {status:"not_signed",reason:"当前周期动作尚待执行",evidence:{source,outcome,authoritative,
    confirmedAt:now.toISOString(),binding:{...evidenceBinding(target,config,now),observedOrigin}}};
}
export function successEvidence(source,outcome,now=new Date()) {
  if(!sources.has(source)) throw new Error('Unknown success evidence source');
  return {source,outcome,authoritative:source!=='user_rule',confirmedAt:now.toISOString()};
}

export function evidenceBinding(target, config={}, at=new Date(), actionType=target.actionType ?? 'checkin') {
  const origin = new URL(target.origin).origin;
  if (origin !== target.origin || !origin.startsWith('https://')) throw new Error('Evidence requires an HTTPS site origin');
  const accountKey = target.accountKey ?? 'default';
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(accountKey) || !/^[a-z][a-z0-9_-]{0,63}$/.test(actionType)) throw new Error('Evidence identity must be anonymous');
  return {version:2, siteOrigin:origin, accountKey, actionType, cycleId:checkinCycle(origin,config,at).id};
}

// Called only on a fresh, already-verified observation. Never manufacture a
// confirmation from a click or upgrade an old cache to the current cycle.
export function bindSuccessEvidence(result, target, config={}, now=new Date(), actionType) {
  if (!success.has(result?.status) || !result.evidence) return result;
  const evidence = result.evidence;
  if (evidence.binding) return reconcileCheckinResult({...result,origin:target.origin}, evidence, now, {target,config,actionType});
  const confirmed = new Date(evidence.confirmedAt);
  if (!Number.isFinite(confirmed.getTime())) return reconcileCheckinResult(result,evidence,now);
  let observedOrigin;
  try { observedOrigin = result.url ? new URL(result.url).origin : target.origin; } catch { observedOrigin = null; }
  const bound = {...evidence,binding:{...evidenceBinding(target,config,confirmed,actionType),observedOrigin}};
  return reconcileCheckinResult({...result,origin:target.origin,actionType:bound.binding.actionType,
    ...(target.accountKey ? {accountKey:target.accountKey} : {}),
    ...(target.allowedOrigins ? {allowedOrigins:target.allowedOrigins} : {}),
    cycle:checkinCycle(target.origin,config,confirmed)},bound,now,{target,config,actionType});
}

export function completionEvidenceKind(result,now=new Date()) {
  if (!success.has(result?.status)) return 'pending';
  if (reconcileCheckinResult(result,result.evidence,now).status==='unconfirmed') return 'unbound';
  if (result.evidence?.source === 'user_rule') return 'user_rule';
  return result.evidence?.authoritative === true ? 'authoritative' : 'unbound';
}

export function normalizeBoundEvidenceResult(result,config,now=new Date()) {
  if (result?.accountResults?.length) {
    const accountResults=result.accountResults.map(account=>normalizeBoundEvidenceResult({...account,origin:account.origin??result.origin},config,now));
    if (success.has(result.status)&&accountResults.some(account=>!success.has(account.status))) {
      return {...result,accountResults,status:'needs_attention',failureCode:'evidence_binding_mismatch',reason:'一个或多个账号的完成证据校验未通过'};
    }
    return clearResolvedFailureFields({...result,accountResults});
  }
  // Compatibility for reports written by the older quarantine wrapper: that
  // wrapper replaced a positive status but retained its bound completion text.
  // Negative readiness, rule assumptions and title-only observations cannot
  // enter this path; the observation time is never changed.
  if(result?.failureCode==="submission_quarantined" && result.status==="needs_attention"
    && result.evidence?.authoritative===true && result.evidence?.source==="page_text"
    && ["page_completion_text","native_confirmed_completion"].includes(result.evidence?.outcome) && result.evidence?.binding) {
    const restored=reconcileCheckinResult({...result,status:"already_signed"},result.evidence,now,{config,requireBinding:true});
    if(restored.status==="already_signed") return {...restored,failureCode:null,quarantine:null,
      historicalSubmissionWarning:result.historicalSubmissionWarning??{pendingCount:result.quarantine?.pendingCount??1,actionType:result.evidence.binding.actionType}};
  }
  const normalized = result?.evidence?.binding ? reconcileCheckinResult(result,result.evidence,now,{config}) : result;
  return success.has(normalized?.status) && normalized.evidence?.binding
    ? clearResolvedFailureFields(normalized) : normalized;
}

export function reconcileCheckinResult(result, evidence=result?.evidence, now=new Date(), context={}) {
  if(!result||!success.has(result.status)) return result;
  const at=Date.parse(evidence?.confirmedAt??'');
  const valid=sources.has(evidence?.source)&&Number.isFinite(at)&&at<=now.getTime()
    && (evidence.authoritative===true||evidence.source==='user_rule');
  if (valid && evidence.binding) {
    const target = context.target ?? result;
    const binding = evidence.binding;
    let expected;
    const config = context.config ?? (result.cycle ? {siteCycleRules:{[target.origin]:result.cycle}} : {});
    try { expected = evidenceBinding(target,config,now,context.actionType); } catch { expected = null; }
    const allowed = target.allowedOrigins ?? [target.origin];
    if (!expected || binding.version !== 2 || binding.siteOrigin !== expected.siteOrigin
      || binding.accountKey !== expected.accountKey || binding.actionType !== expected.actionType
      || binding.cycleId !== (context.cycleId ?? expected.cycleId)
      || (!context.cycleId && checkinCycle(target.origin,config,new Date(at)).id!==binding.cycleId)
      || !allowed.includes(binding.observedOrigin)) {
      return {...result,status:'unconfirmed',reason:'完成证据与站点、账号、动作或签到周期不一致',failureCode:'evidence_binding_mismatch',invalidReportedStatus:result.status};
    }
  }
  if(valid && (!context.requireBinding || evidence.binding)) {
    const target = context.target ?? result;
    const config = context.config ?? {};
    const action = context.actionType ?? target.actionType ?? "checkin";
    const required = action === "checkin" && !result.accountResults?.length
      ? configuredSequentialActionTypes(target.origin, config) ?? result.requiredActionTypes : null;
    if (required != null) {
      const steps = result.actionResults;
      const matched = Array.isArray(required) && required.length > 0 && required.length <= 8
        && new Set(required).size === required.length && required.every(type => /^[a-z][a-z0-9_-]{0,63}$/.test(type))
        && Array.isArray(steps) && steps.length === required.length
        && new Set(steps.map(step => step.actionType)).size === required.length
        && required.every(type => {
          const step = steps.find(entry => entry.actionType === type);
          return step && step.origin === target.origin
            && (step.accountKey ?? "default") === (target.accountKey ?? "default")
            && step.evidence?.binding?.cycleId === evidence.binding?.cycleId
            && success.has(reconcileCheckinResult(step, step.evidence, now, {
              ...context, target: { ...target, actionType: type }, config, actionType: type, requireBinding: true,
            }).status);
        });
      if (!matched) return {...result,status:"unconfirmed",reason:"顺序动作尚未全部取得匹配的完成证据",
        failureCode:"incomplete_sequential_evidence",invalidReportedStatus:result.status};
    }
    return {...result,evidence};
  }
  return {...result,status:'unconfirmed',reason:'成功结论缺少可审计完成证据',failureCode:'missing_success_evidence',invalidReportedStatus:result.status};
}

export function stopAtConfiguredTerminal(url,config,outcome,now=new Date()) {
  const rule=config.preCheckinNavigationRules?.[new URL(url).origin];
  if(rule?.terminalAssumeSigned===true){
    return reconcileCheckinResult({status:'already_signed',reason:'按用户明确配置的终止条件视为今日已签到，停止重试',configuredTerminalStop:true,url:safeLogUrl(url)},successEvidence('user_rule',outcome,now),now);
  }
  return {status:'needs_attention',reason:'已到达配置的终止条件，停止操作；尚无签到完成证据',retryable:false,failureCode:'terminal_without_success_evidence',url:safeLogUrl(url)};
}

export async function verifyVisitCheckin(rule,{url,readState,verifySession,now=new Date()}) {
  const origin=new URL(url).origin;
  const cycle=checkinCycle(origin,{siteCycleRules:{[origin]:{timeZone:rule.timeZone??'Asia/Shanghai',resetAt:rule.after}}},now);
  const local=new Intl.DateTimeFormat('en-GB',{timeZone:cycle.timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now);
  if(local<rule.after) return {status:'deferred',retryCause:'time_window',reason:`等待站点 ${rule.after} 开放签到`,nextEligibleAt:cycle.endAt,url:safeLogUrl(url)};
  const observed=await readState();
  if(success.has(observed?.status)) return reconcileCheckinResult({...observed,url:safeLogUrl(url)},successEvidence('page_text','visit_confirmed',now),now);
  if(observed&&['login_required','interactive_challenge','managed_challenge_timeout','deferred'].includes(observed.status)) return observed;
  if(rule.assumeSignedAfterVisit===true && observed?.status==='ready' && !observed.unresolvedChallenge) {
    const session=await verifySession?.();
    if(session?.status==='valid') return reconcileCheckinResult({
      status:'signed',reason:'开放时间内已确认登录并访问，按用户明确配置的访问签到规则完成',url:safeLogUrl(url),
    },successEvidence('user_rule','authenticated_visit_after_opening',now),now);
    if(session?.status==='invalid') return {status:'login_required',reason:'访问签到前未能确认有效登录，请恢复登录',url:safeLogUrl(url)};
    return {status:'unconfirmed',reason:'访问签到规则已启用，但登录态尚未确认',failureCode:'visit_session_unconfirmed',url:safeLogUrl(url)};
  }
  return {status:'unconfirmed',reason:'已在开放时间访问，但页面未确认签到完成',failureCode:'visit_without_success_evidence',url:safeLogUrl(url)};
}
