import { runCheckinAdapter } from './checkin-adapters.mjs';
import { dailyReadinessEvidence } from './checkin-evidence.mjs';
import { SUBMISSION_SCOPE } from './submission-guard.mjs';
import { runNewApiProtocol } from './new-api-protocol.mjs';
import { newApiCheckinOptions } from './new-api-policy.mjs';

export function apiFirstAllowed(target,config={}) {
  const origin=target.origin;
  return (config.apiFirstOrigins??[]).includes(origin)
    && (config.newApiCheckinOrigins??[]).includes(origin)
    && !['newApiCaptchaRules','newApiSignInRules','bearerCheckinRules','reauthCheckinRules','preCheckinNavigationRules','sequentialActionRules']
      .some(key=>config[key]?.[origin])
    && !(config.nativeChallengePreflight??[]).some(rule=>{try{return new URL(rule.url).origin===origin;}catch{return false;}});
}

export async function tryNewApiHttpFirst(context,target,config={}, {wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  if(!apiFirstAllowed(target,config)||!context?.request) return null;
  const origin=new URL(target.origin).origin;
  if(!origin.startsWith('https://')) return null;
  let requests=0, lastFailure=null;
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
      if(new URL(response.url()).origin!==origin) return {httpStatus:response.status(),blockedRedirect:true};
      const status=response.status();
      const text=await response.text();
      const headers=response.headers?.()??{};
      return {httpStatus:status,bodyText:text,contentType:headers['content-type']??'',cfMitigated:headers['cf-mitigated']??''};
    }catch{return null;}
    finally{await response?.dispose().catch(()=>{});}
  };
  const adapter={
    id:'new_api_http',
    detect:async()=>({supported:true}),
    execute:async()=>{
      let result=await runNewApiProtocol({...newApiCheckinOptions(target,config),readOnly:config.checkinReadOnly===true,
        request:read,wait,fallbackOnChallenge:true,onFailure:observation=>{lastFailure=observation;},
        beforeSubmit:()=>config[SUBMISSION_SCOPE]?.begin(),
        rejectSubmission:code=>config[SUBMISSION_SCOPE]?.reject(code)});
      if(result?.status==='not_signed') result=dailyReadinessEvidence(target,config,{source:'status_endpoint'});
      return {result,requests,submissionAttempted:result?.submissionAttempted===true};
    },
    verify:async observation=>observation.result,
  };
  const outcome=await runCheckinAdapter(adapter,{});
  return {...outcome,metrics:{...outcome.metrics,requests,
    ...(lastFailure?{failureKind:lastFailure.kind,failurePhase:lastFailure.phase}:{})}};
}
