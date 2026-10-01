import { safeLogUrl } from './security.mjs';
import { checkinCycle } from './checkin-cycle.mjs';

const success=new Set(['signed','already_signed']);
const sources=new Set(['page_text','status_endpoint','reward_log','user_rule','reauth_state']);
export function successEvidence(source,outcome,now=new Date()) {
  if(!sources.has(source)) throw new Error('Unknown success evidence source');
  return {source,outcome,authoritative:source!=='user_rule',confirmedAt:now.toISOString()};
}

export function reconcileCheckinResult(result, evidence=result?.evidence, now=new Date()) {
  if(!result||!success.has(result.status)) return result;
  const at=Date.parse(evidence?.confirmedAt??'');
  const valid=sources.has(evidence?.source)&&Number.isFinite(at)&&at<=now.getTime()
    && (evidence.authoritative===true||evidence.source==='user_rule');
  if(valid) return {...result,evidence};
  return {...result,status:'unconfirmed',reason:'成功结论缺少可审计完成证据',failureCode:'missing_success_evidence',invalidReportedStatus:result.status};
}

export function stopAtConfiguredTerminal(url,config,outcome,now=new Date()) {
  const rule=config.preCheckinNavigationRules?.[new URL(url).origin];
  if(rule?.terminalAssumeSigned===true){
    return reconcileCheckinResult({status:'already_signed',reason:'按用户明确配置的终止条件视为今日已签到，停止重试',url:safeLogUrl(url)},successEvidence('user_rule',outcome,now),now);
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
