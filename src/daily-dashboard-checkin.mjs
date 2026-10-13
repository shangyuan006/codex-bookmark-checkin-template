import { assertBookmarkNavigation, safeLogUrl } from "./security.mjs";
import { successEvidence, dailyReadinessEvidence } from "./checkin-evidence.mjs";
import { beforePageSubmission } from "./submission-guard.mjs";

export function configuredDailyDashboardRule(target,config={}) {
  const raw=config.dailyDashboardCheckinRules?.[target.origin];
  if(!raw || raw.enabled===false) return null;
  if(!/^[a-zA-Z_$][\w$]{0,79}$/.test(raw.stateFunction??"")
    || !/^[a-z][a-z0-9_]{0,79}$/i.test(raw.stateAction??"")
    || !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/i.test(raw.checkedPath??"")
    || typeof raw.actionSelector!=="string" || raw.actionSelector.length>200 || !raw.actionSelector.trim()) {
    throw new Error("Invalid daily dashboard check-in rule");
  }
  return {...raw,waitMs:Math.max(1000,Math.min(60000,Number(raw.waitMs)||35000))};
}

export async function runConfiguredDailyDashboardCheckin(page,target,config={}) {
  const rule=configuredDailyDashboardRule(target,config);
  if(!rule) return null;
  const allowed=target.allowedOrigins??[target.origin];
  const read=async()=>{
    assertBookmarkNavigation(page.url(),allowed);
    return page.evaluate(async({stateFunction,stateAction,checkedPath})=>{
      const handler=globalThis[stateFunction];
      if(typeof handler!=="function") return null;
      try {
        const response=await handler(stateAction,{});
        const checked=checkedPath.split(".").reduce((value,key)=>value?.[key],response);
        return response?.success===true && typeof checked==="boolean" ? checked : null;
      } catch { return null; }
    },rule);
  };
  const success=status=>({status,reason:"每日签到状态接口明确确认今日已签到",url:safeLogUrl(page.url()),
    evidence:successEvidence("status_endpoint","checked_in_today")});
  await page.waitForFunction(name=>typeof globalThis[name]==="function",rule.stateFunction,{timeout:20000}).catch(()=>{});
  const before=await read();
  if(before===true) return success("already_signed");
  if(before!==false) return null;
  if(config.checkinReadOnly) return dailyReadinessEvidence(target,config,{source:"status_endpoint",observedOrigin:new URL(page.url()).origin});
  const action=page.locator(rule.actionSelector);
  if(await action.count()!==1 || !await action.isVisible() || !await action.isEnabled()) return {status:"needs_attention",reason:"每日签到动作尚未就绪"};
  if(await read()!==false) return {status:"unconfirmed",reason:"提交前每日签到状态发生变化，未点击"};
  await beforePageSubmission(page);
  await action.click({timeout:10000});
  const deadline=Date.now()+rule.waitMs;
  do {
    await page.waitForTimeout(1000);
    if(await read()===true) return success("signed");
  } while(Date.now()<deadline);
  return {status:"needs_attention",reason:"每日签到已提交，但状态接口尚未确认完成",submissionAttempted:true,retryable:false,failureCode:"dashboard_submission_unconfirmed"};
}
