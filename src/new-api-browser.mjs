import { successEvidence, reconcileCheckinResult } from './checkin-evidence.mjs';
import { runCheckinAdapter } from './checkin-adapters.mjs';

export async function runNewApiCheckinInBrowser() {
    const normalizeUserId = (value) => {
      const text = String(value ?? "").trim();
      return /^\d{1,20}$/.test(text) ? text : null;
    };
    const extractUserId = (value, key = "") => {
      if (/^(?:uid|user[_-]?id)$/i.test(key)) {
        const direct = normalizeUserId(value);
        if (direct) return direct;
      }
      if (!value || typeof value !== "object") return normalizeUserId(value?.id);
      return normalizeUserId(
        value.id
          ?? value.user?.id
          ?? value.state?.user?.id
          ?? value.data?.id
          ?? value.data?.user?.id,
      );
    };
    const hasVisibleCheckinControl = () => [...(document?.querySelectorAll?.("button, [role=button], input[type=submit], a") ?? [])]
      .some((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) return false;
        return /立即签到|立即簽到|每日签到|每日簽到|check.?in|attendance/i.test(
          String(element.innerText || element.value || element.getAttribute("aria-label") || ""),
        );
      });
    const hasVisibleCompletedCheckinControl = () => [...(document?.querySelectorAll?.("button, [role=button], input[type=button], input[type=submit], a") ?? [])]
      .some((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) return false;
        const text = String(element.innerText || element.value || element.getAttribute("aria-label") || element.title || "")
          .replace(/\s+/g, " ").trim();
        return /^(?:(?:今日|今天|当日|當日)\s*)?已\s*(?:签到|簽到)$|签到成功|簽到成功/i.test(text);
      });
    const sessionFailure = () => {
      if (hasVisibleCompletedCheckinControl()) {
        return { status: "already_signed", reason: "页面签到控件确认已签到，接口登录探测不可用" };
      }
      const passwordVisible = [...(document?.querySelectorAll?.('input[type="password"]') ?? [])]
        .some(element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        });
      if (!passwordVisible && hasVisibleCheckinControl()) return null;
      return { status: "login_required", reason: "签到接口显示登录状态无效" };
    };
    const disabledFeature = (source) => ({
      status: "not_available", reason: "站点签到功能未启用", availabilityKind: "feature_disabled",
      evidence: { authoritative: true, source, outcome: "message_not_enabled", confirmedAt: new Date().toISOString() },
    });
    let userId = null;
    const storages = [localStorage, sessionStorage];
    for (const storage of storages) {
      for (let index = 0; index < storage.length; index += 1) {
        try {
          const key = storage.key(index) || "";
          const raw = storage.getItem(key) || "";
          let value = null;
          try { value = JSON.parse(raw); } catch { value = raw; }
          userId = extractUserId(value, key);
          if (userId != null) break;
        } catch { /* continue */ }
      }
      if (userId != null) break;
    }
    if (userId == null) {
      const visibleId = String(document.body?.innerText || "").match(/(?:用户|使用者)?\s*ID\s*[:：]?\s*(\d+)/i);
      userId = normalizeUserId(visibleId?.[1]);
    }
    if (userId == null) {
      try {
        const response = await fetch("/api/user/self", { credentials: "include", headers: { Accept: "application/json" } });
        if ([401, 403].includes(response.status)) {
          return sessionFailure();
        }
        const body = await response.json();
        userId = body?.data?.id ?? body?.data?.user?.id ?? null;
      } catch { /* not a compatible API */ }
    }
    if (userId == null) return null;

    const headers = { Accept: "application/json", "New-Api-User": String(userId) };
    const currentDate = new Date();
    const month = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, "0")}`;
    const readStatus = async () => {
      let response;
      try {
        response = await fetch(`/api/user/checkin?month=${month}`, { credentials: "include", headers });
      } catch {
        return null;
      }
      if (response.status === 404) return { unavailable: true };
      if ([401, 403].includes(response.status)) return { loginRequired: true };
      let body;
      try { body = await response.json(); } catch { return null; }
      return { body };
    };
    const initialStatus = await readStatus();
    if (!initialStatus || initialStatus.unavailable) return null;
    if (initialStatus.loginRequired) {
      return sessionFailure();
    }
    const statusBody = initialStatus.body;
    const message = String(statusBody?.message || "");
    if (!statusBody?.success) {
      if (/未启用|未啟用|not enabled/i.test(message)) {
        return disabledFeature("new_api_checkin_status");
      }
      if (/turnstile|captcha|人机|人機/i.test(message)) {
        return { status: "interactive_challenge", reason: "站点签到接口要求人机验证" };
      }
      return null;
    }
    const checked = (
      statusBody?.data?.stats?.checked_in_today
      ?? statusBody?.data?.checked_in_today
      ?? statusBody?.data?.checkedInToday
    );
    if (checked === true) return { status: "already_signed", reason: "签到接口显示今日已签到" };
    if (checked !== false) return null;

    let checkinResponse;
    const unconfirmedSubmission = () => ({status:'needs_attention',reason:'签到请求已提交，但未获得完成证据，停止重复提交',submissionAttempted:true,retryable:false});
    try {
      checkinResponse = await fetch("/api/user/checkin", { method: "POST", credentials: "include", headers });
    } catch {
      return unconfirmedSubmission();
    }
    if ([401, 403].includes(checkinResponse.status)) {
      return sessionFailure();
    }
    let checkinBody;
    try { checkinBody = await checkinResponse.json(); } catch { return unconfirmedSubmission(); }
    const checkinMessage = String(checkinBody?.message || "");
    if (/turnstile|captcha|人机|人機/i.test(checkinMessage)) {
      return { status: "interactive_challenge", reason: "站点签到接口要求人机验证" };
    }
    if (/未启用|未啟用|not enabled/i.test(checkinMessage)) {
      return disabledFeature("new_api_checkin_action");
    }
    const submitted = checkinBody?.success || /已签到|已簽到|already/i.test(checkinMessage);
    if (!submitted) return null;

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const verifiedStatus = await readStatus();
      if (verifiedStatus?.loginRequired) {
        const pageResult = sessionFailure();
        return pageResult?.status === "already_signed" ? pageResult : {
          status: "needs_attention", reason: "签到请求已提交，但复核接口不可用，需核对页面完成状态",
          submissionAttempted: true,
        };
      }
      const verifiedBody = verifiedStatus?.body;
      const verified = verifiedBody?.success === true && true === (
        verifiedBody?.data?.stats?.checked_in_today
        ?? verifiedBody?.data?.checked_in_today
        ?? verifiedBody?.data?.checkedInToday
      );
      if (verified) {
        return {
          status: checkinBody?.success ? "signed" : "already_signed",
          reason: "站点状态接口确认今日已签到",
        };
      }
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 750));
    }
    return unconfirmedSubmission();
}

export async function tryNewApiCheckin(page) {
  const outcome = await runCheckinAdapter({
    id:'new_api_browser',
    detect:async()=>({supported:true}),
    execute:async()=>({result:await page.evaluate(runNewApiCheckinInBrowser)}),
    verify:async({result})=>{
      if (!['signed','already_signed'].includes(result?.status)) return result;
      return reconcileCheckinResult(result, successEvidence(/页面签到控件/.test(result.reason)?'page_text':'status_endpoint','checked_in_today'));
    },
  }, {});
  return outcome.result ?? null;
}
