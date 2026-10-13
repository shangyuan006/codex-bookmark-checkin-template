import { assertBookmarkNavigation } from "./security.mjs";

export function getSamePageManualRule(target, config) {
  const raw = config.samePageManualCheckinRules?.[target.origin];
  if (!raw || raw.enabled === false) return null;
  if (typeof raw.expectedPath !== "string" || !/^\/(?!\/)/.test(raw.expectedPath) || /[?#]/.test(raw.expectedPath)
    || ![raw.widgetSelector, raw.responseSelector, raw.actionName].every(value => typeof value === "string" && value.trim() && value.length <= 300)) {
    throw new Error("Same-page manual check-in requires an exact path and explicit controls");
  }
  return { ...raw, attentionAfterMs: Math.max(1000, Math.min(600_000, Number(raw.attentionAfterMs) || 120_000)) };
}

export async function readSamePageReadiness(page, target, rule) {
  const url = assertBookmarkNavigation(page.url(), target.allowedOrigins ?? [target.origin]);
  if (new URL(url).origin !== target.origin || new URL(url).pathname !== rule.expectedPath) {
    return { widgetPresent: false, responseReady: false, buttonReady: false };
  }
  const response = await page.evaluate(({ widgetSelector, responseSelector }) => ({
    widgetPresent: document.querySelectorAll(widgetSelector).length > 0,
    responseReady: [...document.querySelectorAll(responseSelector)].some(element =>
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && String(element.value).trim().length > 0),
  }), rule);
  const action = page.getByRole("button", { name: rule.actionName, exact: true });
  return { ...response, buttonReady: await action.count() === 1 && await action.isVisible() && await action.isEnabled() && page.url() === url };
}

// Keep the original verified document alive. Human completion can remove the
// verification response, so always look for success before waiting for readiness.
// A wait timeout reports attention; it never closes or refreshes the window.
export async function continueCheckinOnSamePage({ readState, readReady, submit, isClosed, shouldClose,
  onStage, delay, now = Date.now, attentionAfterMs = 120_000 }) {
  let attempted = false, waitingSince = now(), lastStage = null;
  const stage = async (name, readiness) => {
    if (name === lastStage) return;
    await onStage({ stage: name, submissionAttempted: attempted, ...(readiness ? { readiness } : {}) });
    lastStage = name;
  };
  while (!isClosed()) {
    if (await shouldClose()) return { status: "unconfirmed", reason: "用户已停止同页接管", submissionAttempted: attempted };
    try {
      const state = await readState();
      if (["signed", "already_signed"].includes(state?.status)) {
        await stage("completed");
        return { ...state, submissionAttempted: attempted };
      }
      if (isClosed() || await shouldClose()) break;
      const readiness = attempted ? null : await readReady();
      if (!attempted && readiness?.responseReady && readiness.buttonReady) {
        // Once intent is reserved, a failed/ambiguous click must not be repeated.
        attempted = true;
        await stage("submitting_once", readiness);
        if (await submit() === false) { attempted = false; lastStage = null; }
        else waitingSince = now();
      }
      const timedOut = now() - waitingSince >= attentionAfterMs;
      await stage(timedOut ? (attempted ? "completion_wait_timeout" : "verification_wait_timeout")
        : (attempted ? "waiting_for_completion" : "waiting_for_verification"), readiness);
    } catch {
      if (isClosed()) break;
      await stage("needs_attention");
    }
    await delay(500);
  }
  return { status: "unconfirmed", reason: "同页接管窗口已关闭，尚未确认签到完成", submissionAttempted: attempted };
}
