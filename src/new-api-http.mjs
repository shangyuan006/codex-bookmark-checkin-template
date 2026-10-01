import { runCheckinAdapter } from './checkin-adapters.mjs';
import { successEvidence } from './checkin-evidence.mjs';

export function apiFirstAllowed(target,config={}) {
  const origin=target.origin;
  return (config.apiFirstOrigins??[]).includes(origin)
    && (config.newApiCheckinOrigins??[]).includes(origin)
    && !['newApiCaptchaRules','newApiSignInRules','bearerCheckinRules','reauthCheckinRules','preCheckinNavigationRules','sequentialActionRules']
      .some(key=>config[key]?.[origin])
    && !(config.nativeChallengePreflight??[]).some(rule=>{try{return new URL(rule.url).origin===origin;}catch{return false;}});
}

function checked(body) {
  if(body?.success!==true) return null;
  const value=body?.data?.stats?.checked_in_today??body?.data?.checked_in_today??body?.data?.checkedInToday;
  return typeof value==='boolean'?value:null;
}

function disabled(body) {
  return body?.success===false&&/未启用|未啟用|not enabled/i.test(String(body.message??''));
}

export async function tryNewApiHttpFirst(context,target,config={}, {wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  if(!apiFirstAllowed(target,config)||!context?.request) return null;
  const origin=new URL(target.origin).origin;
  if(!origin.startsWith('https://')) return null;
  let requests=0;
  const read=async(path,method='GET',userId=null)=>{
    const url=new URL(path,origin);
    if(url.origin!==origin) throw new Error('API adapter attempted cross-origin request');
    let response;
    try{
      requests++;
      response=await context.request.fetch(url.href,{
        method,maxRedirects:0,timeout:8000,failOnStatusCode:false,
        headers:{Accept:'application/json',...(userId?{'New-Api-User':userId}:{})},
      });
      if(new URL(response.url()).origin!==origin) return null;
      const status=response.status();
      if(status<200||status>=300) return null;
      const text=await response.text();
      if(text.length>1024*1024) return null;
      return JSON.parse(text);
    }catch{return null;}
    finally{await response?.dispose().catch(()=>{});}
  };
  const month=new Intl.DateTimeFormat('en-CA',{timeZone:config.siteCycleRules?.[origin]?.timeZone??'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(new Date());
  const statusPath=`/api/user/checkin?month=${encodeURIComponent(month)}`;
  const signed=status=>({status,reason:'签到状态接口明确确认本周期已签到',evidence:successEvidence('status_endpoint','checked_in_today')});
  const unavailable=()=>({status:'not_available',availabilityKind:'feature_disabled',reason:'站点签到功能未启用',evidence:{source:'new_api_checkin_status',outcome:'message_not_enabled',authoritative:true,confirmedAt:new Date().toISOString()}});
  const adapter={
    id:'new_api_http',
    detect:async()=>{
      // The request context shares the isolated browser cookie jar. No cookie or
      // localStorage export, extra credential store, or caller-supplied token.
      const self=await read('/api/user/self');
      const id=self?.data?.id??self?.data?.user?.id;
      if(self?.success!==true||!/^\d{1,20}$/.test(String(id??''))) return {supported:false,requests};
      const userId=String(id);
      const status=await read(statusPath,'GET',userId);
      return {supported:checked(status)!==null||disabled(status),userId,status,requests};
    },
    execute:async(_,capability)=>{
      if(disabled(capability.status)) return {result:unavailable(),requests};
      if(checked(capability.status)===true) return {result:signed('already_signed'),requests};
      const response=await read('/api/user/checkin','POST',capability.userId);
      // Explicit WAF rejection permits the existing interactive page workflow.
      if(response?.success===false&&/turnstile|captcha|人机|人機/i.test(String(response.message??''))) return {result:null,submissionAttempted:false,requests};
      for(let attempt=0;attempt<4;attempt++){
        if(attempt) await wait(750);
        const status=await read(statusPath,'GET',capability.userId);
        if(checked(status)===true) return {result:signed('signed'),requests};
      }
      return {result:{status:'needs_attention',reason:'API 签到请求已发送，复核未取得完成信号，需人工确认',submissionAttempted:true,retryable:false,failureCode:'api_submission_unconfirmed'},submissionAttempted:true,requests};
    },
    verify:async observation=>observation.result,
  };
  const outcome=await runCheckinAdapter(adapter,{});
  return {...outcome,metrics:{...outcome.metrics,requests}};
}
