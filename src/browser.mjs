import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { classifyPageText, formatDailyReason, normalizeText, scoreActionText } from "./detector.mjs";
import { assertBookmarkNavigation, safeErrorMessage, safeLogUrl } from "./security.mjs";
import { recognizeAlphanumericCaptcha, recognizeOpenCdCaptcha } from "./captcha-ocr.mjs";
import { solveU2VisualChallenge } from "./u2-vision.mjs";
import { resolveQaByWebSearch } from "./qa-solver.mjs";
import { withRetrySchedule } from "./retry-policy.mjs";
import { tryNewApiCaptchaCheckin, tryNewApiSignIn } from "./new-api-signin.mjs";
import { tryBearerCheckin } from "./bearer-checkin.mjs";
import { clickVisibleNativeChallengeControl } from "./native-checkin-action.mjs";
import {
  getConfiguredPreCheckinNavigationRule,
  navigateConfiguredPreCheckinPage,
} from "./pre-checkin-navigation.mjs";

export {
  getConfiguredPreCheckinNavigationRule,
  navigateConfiguredPreCheckinPage,
} from "./pre-checkin-navigation.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const rootDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const COMPLETED = new Set(["signed", "already_signed", "not_available"]);
const CHALLENGE = new Set(["interactive_challenge", "managed_challenge_timeout"]);
const UNCONFIRMED = new Set(["visited", "clicked"]);
const CANDIDATE_STATUS_PRIORITY = new Map([
  ["signed", 100],
  ["already_signed", 100],
  ["not_available", 95],
  ["needs_attention", 90],
  ["login_required", 85],
  ["interactive_challenge", 84],
  ["managed_challenge_timeout", 83],
  ["managed_challenge", 82],
  ["deferred", 80],
  ["unconfirmed", 70],
  ["clicked", 65],
  ["visited", 60],
  ["error", 30],
  ["no_action", 20],
]);
export const CHALLENGE_SELECTOR = 'iframe[src*="captcha" i], iframe[src*="turnstile" i], iframe[src*="challenge" i], .cf-turnstile, .h-captcha, .g-recaptcha, cap-widget, .cap-verify, altcha-widget, .altcha, [data-altcha], [data-cap-api-endpoint], [class*="captcha" i]';
const CALENDAR_DAY_ACTION_SELECTOR = 'button, [role="button"], a[href], input[type="button"], input[type="submit"], [onclick], [tabindex]:not([tabindex="-1"]), [role="gridcell"], td, li, [data-date], [aria-current="date"], [data-today], [data-is-today]';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MIN_TARGET_TIMEOUT_MS = 30_000;
const MAX_TARGET_TIMEOUT_MS = 10 * 60_000;

export function getTargetTimeoutMs(config) {
  return Math.max(
    MIN_TARGET_TIMEOUT_MS,
    Math.min(MAX_TARGET_TIMEOUT_MS, Number(config?.targetTimeoutMs) || 180_000),
  );
}

export class TargetTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`单站处理超过 ${Math.ceil(timeoutMs / 1000)} 秒`);
    this.name = "TargetTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

// page.evaluate() has no Playwright timeout option. Race every target against
// a deadline and close its page so a blocked renderer cannot hold the run open.
export async function runWithTargetTimeout(operation, timeoutMs, onTimeout = null) {
  const boundedTimeoutMs = Math.max(1, Number(timeoutMs) || 1);
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { void Promise.resolve(onTimeout?.()).catch(() => {}); } catch { /* timeout still wins */ }
      reject(new TargetTimeoutError(boundedTimeoutMs));
    }, boundedTimeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closePageBounded(page, timeoutMs = 5000) {
  await Promise.race([
    page.close({ runBeforeUnload: false }).catch(() => {}),
    sleep(timeoutMs),
  ]);
}

export function preferCandidateResult(current, candidate) {
  if (!candidate) return current;
  if (!current) return candidate;
  const currentPriority = CANDIDATE_STATUS_PRIORITY.get(current.status) ?? 0;
  const candidatePriority = CANDIDATE_STATUS_PRIORITY.get(candidate.status) ?? 0;
  return candidatePriority > currentPriority ? candidate : current;
}

export function candidateHistoryEntry(candidateUrl, result, attempt) {
  return {
    attempt,
    candidateUrl: safeLogUrl(candidateUrl),
    status: String(result?.status || "error"),
    reason: safeErrorMessage(result?.reason || "未知错误").slice(0, 240),
  };
}

function targetUsesConfiguredOrigins(target, configuredOrigins) {
  const configured = new Set(configuredOrigins ?? []);
  return (target.allowedOrigins ?? [target.origin]).some((origin) => configured.has(origin));
}

export function reliableNewApiCaptchaCandidates(recognition, minConfidence = 30) {
  const threshold = Number(minConfidence);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new Error("New API captcha minConfidence must be between 0 and 100");
  }
  const code = String(recognition?.code ?? "").trim().toUpperCase();
  const confidence = Number(recognition?.confidence);
  return /^[A-Z0-9]{5}$/.test(code) && Number.isFinite(confidence) && confidence >= threshold
    ? [code]
    : [];
}

export async function tryConfiguredNewApiCheckin(page, activeOrigin, config = {}) {
  const hasCaptchaRule = Object.hasOwn(config.newApiCaptchaRules ?? {}, activeOrigin);
  const hasSignInRule = Object.hasOwn(config.newApiSignInRules ?? {}, activeOrigin);
  const hasBearerRule = Object.hasOwn(config.bearerCheckinRules ?? {}, activeOrigin);
  if ([hasCaptchaRule, hasSignInRule, hasBearerRule].filter(Boolean).length > 1) {
    throw new Error(`New API origin has conflicting captcha, sign-in, or Bearer rules: ${activeOrigin}`);
  }
  if (hasCaptchaRule) {
    const rawRule = config.newApiCaptchaRules[activeOrigin];
    return tryNewApiCaptchaCheckin(page, activeOrigin, config, async (image) => {
      const recognition = await recognizeAlphanumericCaptcha(image, { minLength: 5, maxLength: 5 });
      return reliableNewApiCaptchaCandidates(recognition, rawRule?.minConfidence ?? 30);
    });
  }
  if (hasSignInRule) {
    return tryNewApiSignIn(page, activeOrigin, config);
  }
  if (hasBearerRule) {
    return tryBearerCheckin(page, activeOrigin, config);
  }
  return null;
}

function targetUsesConfiguredActiveOrigin(target, activeOrigin, configuredOrigins) {
  if (!activeOrigin || !(target.allowedOrigins ?? [target.origin]).includes(activeOrigin)) return false;
  return (configuredOrigins ?? []).includes(activeOrigin);
}

function currentAllowedLocation(page, allowedOrigins) {
  const activeUrl = assertBookmarkNavigation(page.url(), allowedOrigins);
  return { activeUrl, activeOrigin: new URL(activeUrl).origin };
}

export function targetNeedsManualChallenge(target, activeOrigin, config) {
  return targetUsesConfiguredActiveOrigin(target, activeOrigin, config?.manualChallengeOrigins);
}

export function challengeEvidenceIsUnresolved(evidence) {
  return Boolean(evidence?.visible)
    && evidence?.challengeLike !== false
    && !Boolean(evidence?.resolvedState)
    && !Boolean(evidence?.responsePresent);
}

export function shouldBlockManualChallengeAction(target, activeOrigin, config, state) {
  return targetNeedsManualChallenge(target, activeOrigin, config)
    && Boolean(state?.unresolvedChallenge);
}

export function getConfiguredChallengeInteractionRule(target, activeOrigin, config, phase = null) {
  if (!(target?.allowedOrigins ?? [target?.origin]).includes(activeOrigin)) return null;
  const raw = config?.challengeInteractionRules?.[activeOrigin];
  if (!raw) return null;
  const type = String(raw.type || "").toLowerCase();
  const configuredPhase = String(raw.phase || "before").toLowerCase();
  if (!["click", "slide", "wait"].includes(type)) throw new Error("验证交互规则类型无效");
  if (!["before", "after"].includes(configuredPhase)) throw new Error("验证交互规则阶段无效");
  if (phase && configuredPhase !== phase) return null;
  const configuredAppearanceWaitMs = Number(raw.appearanceWaitMs);
  return {
    type,
    phase: configuredPhase,
    optional: raw.optional === true,
    appearanceWaitMs: raw.optional === true && configuredPhase === "after"
      ? Math.max(0, Math.min(15_000, Number.isFinite(configuredAppearanceWaitMs) ? configuredAppearanceWaitMs : 5_000))
      : 0,
    waitMs: Math.max(1000, Math.min(60_000, Number(raw.waitMs) || 30_000)),
    settleMs: Math.max(500, Math.min(10_000, Number(raw.settleMs) || 3000)),
    retryAction: raw.retryAction === true,
    retryDomClick: raw.retryAction === true && raw.retryDomClick === true,
    retryActionWaitMs: raw.retryAction === true
      ? Math.max(500, Math.min(20_000, Number(raw.retryActionWaitMs) || 5000))
      : 0,
  };
}

export function shouldUseConfiguredNewApiPageRetry(initialResult, rule) {
  return ["interactive_challenge", "login_required"].includes(initialResult?.status)
    && rule?.phase === "after"
    && rule?.retryAction === true;
}

export function shouldRetryConfiguredCheckinPageAction(pendingApiRetry, rule, state) {
  if (!pendingApiRetry || rule?.phase !== "after" || rule?.retryAction !== true) return false;
  return ![
    "signed",
    "already_signed",
    "login_required",
    "needs_attention",
    "interactive_challenge",
    "managed_challenge",
    "managed_challenge_timeout",
    "deferred",
  ].includes(state?.status);
}

export function getConfiguredCheckinCaptchaDialogRule(target, activeOrigin, config) {
  if (!(target?.allowedOrigins ?? [target?.origin]).includes(activeOrigin)) return null;
  const raw = config?.checkinCaptchaDialogRules?.[activeOrigin];
  if (!raw) return null;
  const dialogSelector = String(raw.dialogSelector || "").trim();
  const imageSelector = String(raw.imageSelector || "").trim();
  const inputSelector = String(raw.inputSelector || "").trim();
  const confirmTexts = [...new Set((raw.confirmTexts ?? []).map((value) => normalizeText(value)).filter(Boolean))];
  const refreshTexts = [...new Set((raw.refreshTexts ?? []).map((value) => normalizeText(value)).filter(Boolean))];
  if (!dialogSelector || !imageSelector || !inputSelector || confirmTexts.length === 0) {
    throw new Error("签到图片验证码规则缺少选择器或确认按钮文本");
  }
  const minLength = Math.max(1, Math.min(12, Number(raw.minLength) || 4));
  const maxLength = Math.max(minLength, Math.min(12, Number(raw.maxLength) || 8));
  return {
    dialogSelector,
    imageSelector,
    inputSelector,
    confirmTexts,
    refreshTexts,
    minLength,
    maxLength,
    minImageWidth: Math.max(8, Math.min(500, Number(raw.minImageWidth) || 40)),
    minImageHeight: Math.max(8, Math.min(300, Number(raw.minImageHeight) || 20)),
    minConfidence: Math.max(0, Math.min(100, Number(raw.minConfidence) || 30)),
    waitMs: Math.max(1000, Math.min(10_000, Number(raw.waitMs) || 5000)),
    maxAttempts: Math.max(1, Math.min(3, Number(raw.maxAttempts) || 1)),
  };
}

function normalizedSequentialTexts(values, label, maximum = 20) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new Error(`${label} 必须是数组`);
  const normalized = [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))];
  if (normalized.length > maximum) throw new Error(`${label} 配置过多`);
  if (normalized.some((value) => value.length > 120)) throw new Error(`${label} 包含过长文本`);
  return normalized;
}

function normalizedSequentialTags(values, label, maximum = 8) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new Error(`${label} 必须是数组`);
  const normalized = [...new Set(values.map((value) => String(value ?? "").trim().toUpperCase()).filter(Boolean))];
  if (normalized.length > maximum || normalized.some((value) => !/^[A-Z][A-Z0-9-]{0,31}$/.test(value))) {
    throw new Error(`${label} 包含无效标签`);
  }
  return normalized;
}

function normalizeSequentialSuccessCondition(raw) {
  const pathValue = String(raw?.path || "").trim();
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(pathValue)) {
    throw new Error("顺序动作响应成功字段路径无效");
  }
  const hasEquals = Object.hasOwn(raw ?? {}, "equals");
  const includes = String(raw?.includes ?? "").trim();
  if (!hasEquals && !includes) throw new Error("顺序动作响应成功条件缺少 equals 或 includes");
  if (includes.length > 120) throw new Error("顺序动作响应成功条件过长");
  return {
    path: pathValue,
    ...(hasEquals ? { equals: raw.equals } : {}),
    ...(includes ? { includes } : {}),
  };
}

function normalizeSequentialResponseEvidence(raw) {
  const urlIncludes = String(raw?.urlIncludes || "").trim().toLowerCase();
  if (!urlIncludes || urlIncludes.length > 160 || /[\u0000-\u001f\u007f]/.test(urlIncludes)) {
    throw new Error("顺序动作响应 URL 特征无效");
  }
  const methods = normalizedSequentialTexts(raw.methods ?? ["POST"], "顺序动作响应方法", 6)
    .map((value) => value.toUpperCase());
  if (methods.some((value) => !/^[A-Z]{3,10}$/.test(value))) {
    throw new Error("顺序动作响应方法无效");
  }
  const statuses = [...new Set((raw.statuses ?? []).map((value) => Number(value)))];
  if (statuses.some((value) => !Number.isInteger(value) || value < 100 || value > 599)) {
    throw new Error("顺序动作响应状态码无效");
  }
  const successAny = (raw.successAny ?? []).map(normalizeSequentialSuccessCondition);
  if (successAny.length === 0 || successAny.length > 12) {
    throw new Error("顺序动作响应必须配置有限的成功字段条件");
  }
  return { urlIncludes, methods, statuses, successAny };
}

export function getConfiguredSequentialActionRule(target, config = {}) {
  const raw = config?.sequentialActionRules?.[target?.origin];
  if (!raw) return null;
  const allowedOrigins = target?.allowedOrigins ?? [target?.origin];
  const rawSteps = raw?.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0 || rawSteps.length > 8) {
    throw new Error("顺序动作规则必须包含 1 到 8 个步骤");
  }
  const steps = rawSteps.map((step, index) => {
    const url = assertBookmarkNavigation(String(step?.url || ""), allowedOrigins);
    const actionTexts = normalizedSequentialTexts(step?.actionTexts, `顺序动作第 ${index + 1} 步按钮文本`, 10);
    if (actionTexts.length === 0) throw new Error(`顺序动作第 ${index + 1} 步缺少按钮文本`);
    return {
      url,
      actionTexts,
      actionTags: normalizedSequentialTags(step?.actionTags, `顺序动作第 ${index + 1} 步控件标签`),
      preferInteractive: step?.preferInteractive === true,
      completedTexts: normalizedSequentialTexts(step?.completedTexts, `顺序动作第 ${index + 1} 步完成文本`),
      successTexts: normalizedSequentialTexts(step?.successTexts, `顺序动作第 ${index + 1} 步成功文本`),
      completedIncludes: normalizedSequentialTexts(step?.completedIncludes, `顺序动作第 ${index + 1} 步完成关键词`),
      successIncludes: normalizedSequentialTexts(step?.successIncludes, `顺序动作第 ${index + 1} 步成功关键词`),
      responseEvidence: (step?.responseEvidence ?? []).map(normalizeSequentialResponseEvidence),
      waitMs: Math.max(1000, Math.min(60_000, Number(step?.waitMs) || 10_000)),
      disabledActionIsComplete: step?.disabledActionIsComplete === true,
      acceptGenericCheckinState: step?.acceptGenericCheckinState !== false,
      reloadOnUnconfirmed: step?.reloadOnUnconfirmed === true,
    };
  });
  return { steps };
}

function valueAtJsonPath(value, pathValue) {
  return pathValue.split(".").reduce((current, key) => (
    current && typeof current === "object" ? current[key] : undefined
  ), value);
}

export function configuredSequentialResponseProvesSuccess(response, rule, expectedOrigin) {
  let url;
  try { url = new URL(response?.url); } catch { return false; }
  if (url.origin !== expectedOrigin || !url.pathname.toLowerCase().includes(rule.urlIncludes)) return false;
  if (!rule.methods.includes(String(response?.method || "").toUpperCase())) return false;
  const status = Number(response?.status);
  if (rule.statuses.length > 0 ? !rule.statuses.includes(status) : status < 200 || status >= 300) return false;
  return rule.successAny.some((condition) => {
    const actual = valueAtJsonPath(response?.json, condition.path);
    if (Object.hasOwn(condition, "equals") && Object.is(actual, condition.equals)) return true;
    return condition.includes && String(actual ?? "").includes(condition.includes);
  });
}

export function selectConfiguredSequentialActionCandidate(candidates, step, allowedOrigins) {
  const originSet = new Set(allowedOrigins);
  const matched = (Array.isArray(candidates) ? candidates : []).filter((candidate) => {
    if (!candidate?.visible || candidate.disabled || !step.actionTexts.includes(normalizeText(candidate.text))) return false;
    if (step.actionTags?.length > 0 && !step.actionTags.includes(String(candidate.tagName || "").toUpperCase())) return false;
    for (const destination of [candidate.href, candidate.formAction]) {
      if (!destination) continue;
      try {
        if (!originSet.has(new URL(destination).origin)) return false;
      } catch {
        return false;
      }
    }
    return true;
  });
  if (matched.length === 1) return { candidate: matched[0], outcome: "ready" };
  if (matched.length > 1 && step.preferInteractive) {
    const interactive = matched.filter((candidate) => candidate.hasHandler || candidate.formAction);
    if (interactive.length === 1) return { candidate: interactive[0], outcome: "ready" };
  }
  return { candidate: null, outcome: matched.length === 0 ? "action_not_found" : "action_not_unique" };
}

export function configuredCaptchaImageIsReady(metrics, rule) {
  if (!metrics || !rule) return false;
  if (Number(metrics.width) < rule.minImageWidth || Number(metrics.height) < rule.minImageHeight) return false;
  if (!metrics.isImage) return true;
  return metrics.complete === true
    && Number(metrics.naturalWidth) >= rule.minImageWidth
    && Number(metrics.naturalHeight) >= rule.minImageHeight;
}

export function selectSliderDragGeometry(candidates) {
  const values = Array.isArray(candidates) ? candidates : [];
  const tracks = values.filter((candidate) => candidate.parentCandidateIndex === -1
    && candidate.width >= 180 && candidate.height >= 20 && candidate.height <= 100
    && candidate.hasPointerChild);
  if (tracks.length !== 1) return null;
  const track = tracks[0];
  const handles = values.filter((candidate) => candidate.parentCandidateIndex === track.index
    && candidate.pointerCursor && candidate.width >= 20 && candidate.width <= 100
    && candidate.height >= 20 && candidate.height <= track.height + 4);
  if (handles.length !== 1) return null;
  const handle = handles[0];
  return {
    startX: handle.x + handle.width / 2,
    startY: handle.y + handle.height / 2,
    endX: track.x + track.width - handle.width / 2 - 2,
    endY: handle.y + handle.height / 2,
  };
}

export function selectConfiguredCapChallengeCandidate(candidates) {
  const valid = (Array.isArray(candidates) ? candidates : []).filter((candidate) => (
    candidate?.visible
    && !candidate.disabled
    && Number(candidate.width) >= 180
    && Number(candidate.width) <= 500
    && Number(candidate.height) >= 40
    && Number(candidate.height) <= 120
  ));
  if (valid.length === 1) return { candidate: valid[0], outcome: "ready" };
  return {
    candidate: null,
    outcome: valid.length === 0 ? "challenge_not_found" : "challenge_not_unique",
  };
}

export function targetUsesCalendarDayCheckin(target, activeUrl, config) {
  let url;
  try {
    url = new URL(activeUrl);
  } catch {
    return false;
  }
  if (!targetUsesConfiguredActiveOrigin(target, url.origin, config?.calendarDayCheckinOrigins)) return false;
  const configuredPaths = config?.calendarDayCheckinPaths?.[url.origin];
  const allowedPaths = Array.isArray(configuredPaths) && configuredPaths.length > 0
    ? configuredPaths
    : ["/user/attendance"];
  const activePath = url.pathname.replace(/\/+$/, "") || "/";
  return allowedPaths.some((value) => {
    const normalized = String(value || "").replace(/\/+$/, "") || "/";
    return normalized.startsWith("/") && activePath === normalized;
  });
}

export function assertCalendarDayCheckinLocation(target, activeUrl, config) {
  const destination = assertBookmarkNavigation(activeUrl, target.allowedOrigins ?? [target.origin]);
  if (!targetUsesCalendarDayCheckin(target, destination, config)) {
    throw new Error("日历签到导航离开了配置的来源或精确路径");
  }
  return destination;
}

export function isConfiguredGrowthCheckinPage(target, activeUrl, config) {
  let url;
  try {
    url = new URL(activeUrl);
  } catch {
    return false;
  }
  if (!targetNeedsManualChallenge(target, url.origin, config) || !url.hash.startsWith("#/")) return false;
  const route = new URL(url.hash.slice(1), "https://bookmark-route.invalid");
  return route.pathname.toLowerCase() === "/user/growth"
    && String(route.searchParams.get("tab") || "").toLowerCase() === "checkin";
}

const GROWTH_COMPLETED_CONTROL_TEXT = /^(?:(?:今日|今天|当日|當日)\s*)?已\s*(?:完成\s*)?(?:签到|簽到)(?:\s*[,，、;；]?\s*(?:明日|明天)\s*(?:继续|繼續))?$|^(?:签到|簽到)\s*(?:成功|已完成)$/i;

export function matchesConfiguredGrowthCompletedControlText(value) {
  return GROWTH_COMPLETED_CONTROL_TEXT.test(normalizeText(value));
}

export function classifyConfiguredGrowthCheckinEvidence(target, activeUrl, config, evidence) {
  if (!isConfiguredGrowthCheckinPage(target, activeUrl, config)) return null;
  const hasConfirmedSuccess = Number(evidence?.completedControlCount) > 0
    || Number(evidence?.todaySuccessfulRecordCount) > 0;
  if (evidence?.explicitlyUnsigned && hasConfirmedSuccess) {
    return { status: "needs_attention", reason: "成长签到页同时显示未签到和成功证据" };
  }
  if (!evidence?.explicitlyUnsigned && hasConfirmedSuccess) {
    return { status: "already_signed", reason: "成长签到页确认今日已签到" };
  }
  return null;
}

export function reconcileConfiguredGrowthCheckinState(target, activeUrl, config, state, evidence) {
  if (!isConfiguredGrowthCheckinPage(target, activeUrl, config)) return state;
  if (!["ready", "signed", "already_signed"].includes(state?.status)) return state;
  const confirmed = classifyConfiguredGrowthCheckinEvidence(target, activeUrl, config, evidence);
  if (confirmed) return confirmed;
  if (["signed", "already_signed"].includes(state.status)) {
    return { status: "ready", reason: "成长签到页的通用成功文案缺少今日证据" };
  }
  return state;
}

async function snapshotState(page) {
  const state = await page.evaluate((challengeSelector) => {
    const bodyText = String(document.body?.innerText ?? "").slice(0, 30000);
    const passwordInputs = [...document.querySelectorAll('input[type="password"]')]
      .some((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
    const challengeMatches = [...document.querySelectorAll(challengeSelector)];
    const challengeRoots = challengeMatches.filter((element) => !challengeMatches.some((candidate) => (
      candidate !== element && candidate.contains(element)
    )));
    const challengeEvidence = challengeRoots.map((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const visible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      const roots = [element, element.shadowRoot].filter(Boolean);
      const stateElements = [element, ...roots.flatMap((root) => [...root.querySelectorAll(
        'input[type="checkbox"], [aria-checked], [data-state], [data-status], [class*="success" i], [class*="verified" i], [class*="solved" i], [class*="complete" i], [class*="passed" i]',
      )])];
      const resolvedState = stateElements.some((candidate) => {
        const className = typeof candidate.className === "string" ? candidate.className : "";
        const stateText = [
          candidate.getAttribute("data-state"),
          candidate.getAttribute("data-status"),
          className,
        ].filter(Boolean).join(" ");
        return candidate.checked === true
          || candidate.getAttribute("aria-checked") === "true"
          || /(?:^|[-_\s])(?:success|verified|solved|complete|completed|passed)(?:$|[-_\s])/i.test(stateText);
      });
      const responseElements = roots.flatMap((root) => [...root.querySelectorAll(
        'textarea[name*="response" i], input[name*="response" i], textarea[name*="captcha" i], input[name*="captcha" i], input[name="altcha" i], [data-response]',
      )]);
      const responsePresent = responseElements.some((candidate) => {
        const value = "value" in candidate ? candidate.value : candidate.getAttribute("data-response");
        return String(value || "").trim().length > 0;
      });
      const explicitWidget = element.matches(
        'iframe, .cf-turnstile, .h-captcha, .g-recaptcha, cap-widget, .cap-verify, altcha-widget, [data-altcha], [data-cap-api-endpoint]',
      );
      const challengeLike = explicitWidget || responseElements.length > 0 || roots.some((root) => root.querySelector(
        'iframe[src*="captcha" i], iframe[src*="turnstile" i], iframe[src*="challenge" i], img[src*="captcha" i], img[alt*="captcha" i], canvas, input[type="checkbox"], [role="checkbox"], input[type="text"][name*="captcha" i], input[type="text"][id*="captcha" i], [data-sitekey]',
      ));
      return { visible, challengeLike, resolvedState, responsePresent };
    });
    const confirmedCheckinControl = [...document.querySelectorAll(
      'button, [role="button"], input[type="button"], input[type="submit"]',
    )].some((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) return false;
      const text = String(
        element.innerText || element.value || element.getAttribute("aria-label") || "",
      ).replace(/\s+/g, " ").trim();
      return /^(?:(?:今日|今天|当日|當日)\s*)?已\s*(?:完成\s*)?(?:签到|簽到)$/i.test(text);
    });
    return { bodyText, passwordInputs, challengeEvidence, confirmedCheckinControl };
  }, CHALLENGE_SELECTOR);
  const challengeEvidence = Array.isArray(state.challengeEvidence) ? state.challengeEvidence : [];
  const unresolvedChallenge = challengeEvidence.some(challengeEvidenceIsUnresolved);
  const resolvedChallenge = challengeEvidence.some((evidence) => (
    evidence.visible && !challengeEvidenceIsUnresolved(evidence)
  ));
  const classification = classifyPageText({
    url: page.url(),
    title: await page.title(),
    bodyText: state.bodyText,
    hasPassword: state.passwordInputs,
    challengeSelectors: unresolvedChallenge,
    resolvedChallengeSelectors: resolvedChallenge && !unresolvedChallenge,
    confirmedCheckinControl: state.confirmedCheckinControl,
  });
  return unresolvedChallenge ? { ...classification, unresolvedChallenge: true } : classification;
}

export async function waitForPendingCheckinState(page, config) {
  const waitMs = Math.max(10, Math.min(20_000, Number(config.checkinStateWaitMs) || 10_000));
  const pollMs = Math.max(5, Math.min(1_000, Number(config.checkinStatePollMs) || 500));
  const deadline = Date.now() + waitMs;
  let state = await snapshotState(page);
  while (state.status === "unconfirmed" && state.reason === "签到状态仍在加载") {
    if (Date.now() >= deadline) {
      return { status: "unconfirmed", reason: "签到状态在有限等待内未加载完成" };
    }
    await sleep(pollMs);
    state = await snapshotState(page);
  }
  return state;
}

export function getCheckinConfirmationWaitMs(waitMs = 5000) {
  return Math.max(10, Math.min(60_000, Number(waitMs) || 5000));
}

export async function waitForConfirmedCheckinState(page, config, waitMs = 5000) {
  const boundedWaitMs = getCheckinConfirmationWaitMs(waitMs);
  const pollMs = Math.max(5, Math.min(1000, Number(config.checkinStatePollMs) || 500));
  const deadline = Date.now() + boundedWaitMs;
  let state = await snapshotState(page);
  while (!["signed", "already_signed"].includes(state.status) && Date.now() < deadline) {
    await sleep(pollMs);
    state = await snapshotState(page);
  }
  return state;
}

async function confirmConfiguredCheckinAfterWait(page, allowedOrigins, config, rule, state) {
  if (!rule || state.status !== "ready") return state;
  const waitMs = Math.max(
    getCheckinConfirmationWaitMs(rule.waitMs),
    getCheckinConfirmationWaitMs(config.checkinStateWaitMs),
  );
  let confirmed = await waitForConfirmedCheckinState(page, config, waitMs);
  if (["signed", "already_signed"].includes(confirmed.status)) return confirmed;

  // Some sites finish the verification request server-side but update the
  // check-in control only on the next document load. Refresh once, within the
  // current bookmark origin, before returning an unresolved result.
  assertBookmarkNavigation(page.url(), allowedOrigins);
  await page.reload({ waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs }).catch(() => {});
  await sleep(Math.max(500, Number(config.actionWaitMs) || 0));
  assertBookmarkNavigation(page.url(), allowedOrigins);
  confirmed = await waitForConfirmedCheckinState(page, config, waitMs);
  return confirmed;
}

export async function waitForManagedChallenge(page, config) {
  const pendingState = await waitForPendingCheckinState(page, config);
  if (pendingState.status !== "managed_challenge") return pendingState;
  const deadline = Date.now() + config.cloudflareWaitMs;
  while (Date.now() < deadline) {
    const state = await snapshotState(page);
    if (state.status === "interactive_challenge") return state;
    if (state.status !== "managed_challenge") return state;
    await sleep(2000);
  }

  // A managed challenge can finish at the edge of the bounded wait while the
  // site updates its check-in state only on the next document load. Refresh
  // once and require stable page evidence before scheduling a later retry.
  let finalState = await snapshotState(page);
  if (finalState.status !== "managed_challenge") return finalState;
  const originalOrigin = (() => {
    try { return new URL(page.url()).origin; } catch { return null; }
  })();
  if (!originalOrigin) return { status: "needs_attention", reason: "托管验证刷新前无法确认页面来源" };
  const reloaded = await page.reload({
    waitUntil: "domcontentloaded",
    timeout: config.navigationTimeoutMs,
  }).then(() => true).catch(() => false);
  if (reloaded) {
    let reloadedOrigin;
    try { reloadedOrigin = new URL(page.url()).origin; } catch { reloadedOrigin = null; }
    if (reloadedOrigin !== originalOrigin) {
      return { status: "needs_attention", reason: "托管验证刷新后页面离开当前来源" };
    }
    finalState = await waitForConfirmedCheckinState(
      page,
      config,
      getCheckinConfirmationWaitMs(config.checkinStateWaitMs),
    );
    if (!["managed_challenge", "unconfirmed"].includes(finalState.status)) return finalState;
  }
  return withRetrySchedule({
    status: "deferred",
    retryCause: "managed_challenge_timeout",
    reason: "安全验证未自动通过，改为低频重试",
  }, {
    deferredRetryDelayMs: config.challengeRetryDelayMs ?? config.deferredRetryDelayMs,
  });
}

async function waitForConfiguredChallengeState(page, allowedOrigins, config, rule, sawChallenge = false) {
  const deadline = Date.now() + rule.waitMs;
  let latest = await snapshotState(page);
  let challengeObserved = sawChallenge || latest.status === "interactive_challenge";
  let resolvedAt = null;
  while (true) {
    assertBookmarkNavigation(page.url(), allowedOrigins);
    if (["signed", "already_signed", "login_required", "deferred", "needs_attention"].includes(latest.status)) {
      return latest;
    }
    if (latest.status === "interactive_challenge") {
      challengeObserved = true;
      resolvedAt = null;
    } else if (challengeObserved) {
      resolvedAt ??= Date.now();
      if (Date.now() - resolvedAt >= rule.settleMs) return latest;
    }
    if (Date.now() >= deadline && resolvedAt === null) break;
    if (Date.now() >= deadline && Date.now() - resolvedAt >= rule.settleMs) break;
    await sleep(Math.max(100, Math.min(1000, Number(config.checkinStatePollMs) || 500)));
    latest = await snapshotState(page);
  }
  if (latest.status === "interactive_challenge") {
    return { ...latest, reason: "自动安全验证在有限等待内未完成" };
  }
  return latest;
}

export async function clickConfiguredChallengeControl(page, rule, expectedOrigin, config) {
  const selector = [
    'altcha-widget input[type="checkbox"]',
    'altcha-widget [role="checkbox"]',
    '.h-captcha input[type="checkbox"]',
    '.cf-turnstile input[type="checkbox"]',
    '.g-recaptcha input[type="checkbox"]',
    '[class*="captcha" i] input[type="checkbox"]',
    '[class*="captcha" i] [role="checkbox"]',
    '[class*="verify" i] input[type="checkbox"]',
    '[class*="verify" i] [role="checkbox"]',
  ].join(", ");
  const deadline = Date.now() + rule.waitMs;
  let latest = await snapshotState(page);
  do {
    if (["signed", "already_signed", "login_required", "deferred", "needs_attention"].includes(latest.status)) {
      return latest;
    }
    if (rule.optional && !["interactive_challenge", "managed_challenge"].includes(latest.status)
      && !latest.unresolvedChallenge) {
      return latest;
    }
    const controls = page.locator(selector);
    const visibleIndexes = [];
    for (let index = 0; index < await controls.count(); index += 1) {
      if (await controls.nth(index).isVisible().catch(() => false)) visibleIndexes.push(index);
    }
    if (visibleIndexes.length > 1) {
      return { status: "needs_attention", reason: "自动验证找到多个可点击控件，已拒绝操作" };
    }
    if (visibleIndexes.length === 1) {
      const control = controls.nth(visibleIndexes[0]);
      try {
        if (await control.evaluate((element) => element.matches('input[type="checkbox"]'))) {
          await control.evaluate((element) => element.click());
        } else {
          await control.click({ timeout: 10000 });
        }
        return null;
      } catch {
        return { status: "needs_attention", reason: "自动验证控件点击失败" };
      }
    }
    const capWidgets = page.locator('.cap-verify');
    const capCandidates = await capWidgets.evaluateAll((elements) => elements.slice(0, 20).map((element, index) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        index,
        visible: style.display !== "none"
          && style.visibility !== "hidden"
          && rect.width > 0
          && rect.height > 0,
        disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
        width: rect.width,
        height: rect.height,
      };
    }));
    const capSelection = selectConfiguredCapChallengeCandidate(capCandidates);
    if (capSelection.outcome === "challenge_not_unique") {
      return { status: "needs_attention", reason: "自动验证找到多个可点击 Cap.js 控件，已拒绝操作" };
    }
    if (capSelection.candidate) {
      const capContainer = capWidgets.nth(capSelection.candidate.index);
      const embeddedWidgets = capContainer.locator('cap-widget');
      const embeddedCandidates = await embeddedWidgets.evaluateAll((elements) => elements.slice(0, 20).map((element, index) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          index,
          visible: style.display !== "none"
            && style.visibility !== "hidden"
            && rect.width > 0
            && rect.height > 0,
          disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
          width: rect.width,
          height: rect.height,
        };
      }));
      const embeddedSelection = selectConfiguredCapChallengeCandidate(embeddedCandidates);
      if (embeddedSelection.outcome === "challenge_not_unique") {
        return {
          status: "needs_attention",
          reason: "自动验证找到多个可见 Cap.js 组件，已拒绝操作",
        };
      }
      if (embeddedSelection.candidate) {
        const capWidget = embeddedWidgets.nth(embeddedSelection.candidate.index);
        const capControls = capWidget.locator([
          'input[type="checkbox"]',
          '[role="checkbox"]',
          '[aria-checked][tabindex]',
        ].join(", "));
        const visibleCapControls = [];
        for (let index = 0; index < Math.min(20, await capControls.count()); index += 1) {
          const candidate = capControls.nth(index);
          if (await candidate.isVisible().catch(() => false)
            && await candidate.isEnabled().catch(() => true)) {
            visibleCapControls.push(candidate);
          }
        }
        if (visibleCapControls.length > 1) {
          return { status: "needs_attention", reason: "自动验证找到多个可点击 Cap.js 控件，已拒绝操作" };
        }
        try {
          if (visibleCapControls.length === 1) {
            await visibleCapControls[0].click({ timeout: 10_000 });
          } else {
            const box = await capWidget.boundingBox();
            if (!box) throw new Error("Cap.js control is not visible");
            await page.mouse.click(box.x + Math.min(30, box.width * 0.15), box.y + box.height / 2);
          }
          assertBookmarkNavigation(page.url(), [expectedOrigin]);
          return null;
        } catch {
          return { status: "needs_attention", reason: "自动 Cap.js 验证控件点击失败" };
        }
      }
    }
    const frameResult = await clickVisibleNativeChallengeControl(page, expectedOrigin, {
      actionTexts: ["签到"],
      clickChallenge: true,
    });
    if (frameResult.clicked) return null;
    if (frameResult.outcome === "challenge_not_unique") {
      return { status: "needs_attention", reason: "自动验证找到多个可点击控件，已拒绝操作" };
    }
    if (frameResult.outcome === "challenge_click_failed") {
      return { status: "needs_attention", reason: "自动验证控件点击失败" };
    }
    await sleep(Math.max(100, Math.min(1000, Number(config.checkinStatePollMs) || 500)));
    latest = await snapshotState(page);
  } while (Date.now() < deadline);
  if (rule.optional) return latest;
  return { status: "needs_attention", reason: "自动验证未找到唯一可点击控件" };
}

async function inspectConfiguredSlider(page) {
  return page.evaluate(() => {
    const selector = 'input[type="range"], [role="slider"], [class*="slider" i], [class*="slide" i], [class*="verify" i], [class*="drag" i], [id*="slider" i], [id*="slide" i], [id*="verify" i], [id*="drag" i]';
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const elements = [...document.querySelectorAll(selector)].filter(visible).slice(0, 20);
    return elements.map((element, index) => {
      const rect = element.getBoundingClientRect();
      const cursor = getComputedStyle(element).cursor;
      return {
        index,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        pointerCursor: cursor === "pointer" || cursor === "grab",
        hasPointerChild: [...element.querySelectorAll("*")].some((candidate) => {
          const childCursor = getComputedStyle(candidate).cursor;
          return visible(candidate) && (childCursor === "pointer" || childCursor === "grab");
        }),
        parentCandidateIndex: elements.findIndex((candidate) => candidate !== element && candidate.contains(element)),
      };
    });
  });
}

export async function waitForOptionalChallengeAppearance(
  page,
  config,
  rule,
  initial,
  readState = snapshotState,
) {
  let latest = initial;
  const deadline = Date.now() + rule.appearanceWaitMs;
  while (Date.now() < deadline) {
    await sleep(Math.max(5, Math.min(1000, Number(config.checkinStatePollMs) || 500)));
    latest = await readState(page);
    if (["signed", "already_signed", "login_required", "deferred", "needs_attention"].includes(latest.status)) {
      return latest;
    }
    if (["interactive_challenge", "managed_challenge"].includes(latest.status)
      || latest.unresolvedChallenge) return latest;
  }
  return latest;
}

async function runConfiguredChallengePhase(page, target, activeOrigin, config, phase) {
  const rule = getConfiguredChallengeInteractionRule(target, activeOrigin, config, phase);
  if (!rule) return null;
  const allowedOrigins = target.allowedOrigins ?? [target.origin];
  assertBookmarkNavigation(page.url(), allowedOrigins);
  let initial = await snapshotState(page);
  if (["signed", "already_signed", "login_required", "deferred", "needs_attention"].includes(initial.status)) {
    return initial;
  }
  if (rule.optional && !["interactive_challenge", "managed_challenge"].includes(initial.status)
    && !initial.unresolvedChallenge) {
    initial = await waitForOptionalChallengeAppearance(page, config, rule, initial);
    if (!["interactive_challenge", "managed_challenge"].includes(initial.status)
      && !initial.unresolvedChallenge) return initial;
  }
  if (rule.type === "click") {
    const failure = await clickConfiguredChallengeControl(page, rule, activeOrigin, config);
    if (failure) return failure;
    return waitForConfiguredChallengeState(page, allowedOrigins, config, rule, true);
  }
  if (rule.type === "slide") {
    const geometry = selectSliderDragGeometry(await inspectConfiguredSlider(page));
    if (!geometry || geometry.endX <= geometry.startX) {
      return { status: "needs_attention", reason: "自动验证未找到唯一可拖动滑块" };
    }
    await page.mouse.move(geometry.startX, geometry.startY);
    await page.mouse.down();
    await page.mouse.move(geometry.endX, geometry.endY, { steps: 30 });
    await page.mouse.up();
    return waitForConfiguredChallengeState(page, allowedOrigins, config, rule, true);
  }
  return waitForConfiguredChallengeState(page, allowedOrigins, config, rule);
}

async function waitForExtendedDiscoveryContent(page, config) {
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  const renderWaitMs = Math.max(1000, Math.min(5000, Number(config.actionWaitMs) || 1000));
  await sleep(renderWaitMs);
}

function shanghaiCalendarDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  const month = String(Number(parts.month));
  const day = String(Number(parts.day));
  const longMonth = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    month: "long",
  }).format(now);
  const shortMonth = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    month: "short",
  }).format(now);
  return {
    day,
    fullDateTokens: [
      `${parts.year}-${parts.month}-${parts.day}`,
      `${parts.year}-${month}-${day}`,
      `${parts.year}/${parts.month}/${parts.day}`,
      `${parts.year}/${month}/${day}`,
      `${parts.year}.${parts.month}.${parts.day}`,
      `${parts.year}.${month}.${day}`,
      `${parts.year}年${month}月${day}日`,
      `${longMonth} ${day}, ${parts.year}`,
      `${shortMonth} ${day}, ${parts.year}`,
    ],
    periodTokens: [
      `${parts.year}-${parts.month}`,
      `${parts.year}-${month}`,
      `${parts.year}/${parts.month}`,
      `${parts.year}/${month}`,
      `${parts.year}.${parts.month}`,
      `${parts.year}.${month}`,
      `${parts.year}年${month}月`,
      `${longMonth} ${parts.year}`,
      `${shortMonth} ${parts.year}`,
    ],
  };
}

function shanghaiDateTokens(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  const month = String(Number(parts.month));
  const day = String(Number(parts.day));
  return [
    `${parts.year}-${parts.month}-${parts.day}`,
    `${parts.year}/${parts.month}/${parts.day}`,
    `${parts.year}年${month}月${day}日`,
    `${month}月${day}日`,
  ];
}

async function inspectConfiguredGrowthCheckin(page, dateTokens) {
  return page.evaluate(({ expectedDates, completedControlPattern }) => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const textOf = (element) => String(
      element.innerText
      || element.value
      || element.getAttribute("aria-label")
      || element.title
      || "",
    ).replace(/\s+/g, " ").trim();
    const bodyText = String(document.body?.innerText || "").replace(/\s+/g, " ");
    const explicitlyUnsigned = /(?:今日|今天|当日|當日)?\s*(?:尚未|还未|還未|未)\s*(?:完成)?\s*(?:签到|簽到)/i.test(bodyText);
    const completedControlCount = [...document.querySelectorAll(
      'button, [role="button"], input[type="button"], input[type="submit"]',
    )].filter((element) => {
      if (!visible(element)) return false;
      const text = textOf(element);
      if (!new RegExp(completedControlPattern, "i").test(text)) return false;
      const state = String(element.getAttribute("data-state") || "").toLowerCase();
      return Boolean(element.disabled)
        || element.getAttribute("aria-disabled") === "true"
        || element.getAttribute("aria-checked") === "true"
        || element.getAttribute("aria-pressed") === "true"
        || ["checked", "complete", "completed", "success"].includes(state);
    }).length;
    const todaySuccessfulRecordCount = [...document.querySelectorAll(
      'tr, [role="row"], li, .ant-table-row, .el-table__row',
    )].filter((element) => {
      if (!visible(element)) return false;
      const text = textOf(element);
      return expectedDates.some((date) => text.includes(date))
        && /(?:签到|簽到)\s*(?:成功|已完成)|已\s*(?:签到|簽到)/i.test(text);
    }).length;
    return { explicitlyUnsigned, completedControlCount, todaySuccessfulRecordCount };
  }, {
    expectedDates: dateTokens,
    completedControlPattern: GROWTH_COMPLETED_CONTROL_TEXT.source,
  });
}

async function reconcileConfiguredGrowthCheckinPage(page, target, activeUrl, config, state) {
  if (!isConfiguredGrowthCheckinPage(target, activeUrl, config)) return state;
  const evidence = await inspectConfiguredGrowthCheckin(page, shanghaiDateTokens());
  return reconcileConfiguredGrowthCheckinState(target, activeUrl, config, state, evidence);
}

async function inspectCalendarDayCheckin(page, expectedDate) {
  return page.evaluate(({ actionSelector, expectedDay, fullDateTokens, periodTokens }) => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const compact = (value) => String(value || "").replace(/\s+/g, "").toLowerCase();
    const containsToken = (value, tokens) => {
      const candidate = compact(value);
      return tokens.some((token) => candidate.includes(compact(token)));
    };
    const dateCellSelector = '[role="gridcell"], td, li, [data-date], [aria-current="date"], [data-today], [data-is-today]';
    const hasTodayMarker = (element) => {
      const candidates = [element, element.closest(dateCellSelector)].filter(Boolean);
      return candidates.some((candidate) => {
        const state = String(candidate.getAttribute("data-state") || "").toLowerCase();
        const className = typeof candidate.className === "string" ? candidate.className : "";
        const dataToday = candidate.getAttribute("data-today");
        const dataIsToday = candidate.getAttribute("data-is-today");
        return candidate.getAttribute("aria-current") === "date"
          || (dataToday !== null && !/^(?:false|0)$/i.test(dataToday))
          || (dataIsToday !== null && !/^(?:false|0)$/i.test(dataIsToday))
          || state === "today"
          || /(?:^|[-_\s])(?:is[-_])?today(?:$|[-_\s])/i.test(className);
      });
    };
    const hasFullDateIdentity = (element) => {
      const cell = element.closest(dateCellSelector);
      const candidates = [element, cell, ...element.querySelectorAll("[datetime], [data-date], [aria-label], [title]")]
        .filter(Boolean);
      return candidates.some((candidate) => containsToken([
        candidate.getAttribute("datetime"),
        candidate.getAttribute("data-date"),
        candidate.getAttribute("aria-label"),
        candidate.getAttribute("title"),
      ].filter(Boolean).join(" "), fullDateTokens));
    };
    const hasCurrentPeriodContext = (element) => {
      const calendarRoot = element.closest(
        '[role="grid"], [role="table"], table, [class*="calendar" i], [class*="attendance" i], [class*="date-picker" i], [class*="datepicker" i], [class*="picker-panel" i]',
      );
      let current = calendarRoot || element.parentElement;
      const maxDepth = calendarRoot ? 5 : 8;
      for (let depth = 0; current && current !== document.body && depth < maxDepth; depth += 1, current = current.parentElement) {
        if (containsToken(current.innerText, periodTokens)) return true;
      }
      return false;
    };
    const cellText = (element) => String(
      element.closest(dateCellSelector)?.innerText || element.innerText || "",
    ).replace(/\s+/g, " ");
    const unsignedPattern = /(?:尚未|还未|還未|未)\s*(?:完成)?\s*(?:签到|簽到)/i;
    const signedPattern = /(?:已\s*(?:完成)?|成功)\s*(?:签到|簽到)/i;
    const normalized = String(document.body?.innerText || "").replace(/\s+/g, " ");
    const allControls = [...document.querySelectorAll(actionSelector)];
    const matchingControls = allControls.map((element, index) => ({ element, index })).filter(({ element }) => {
      if (!visible(element)) return false;
      const lines = String(element.innerText || element.value || "")
        .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      return lines.includes(expectedDay);
    });
    const dayButtons = matchingControls.filter(({ element }) => !matchingControls.some(({ element: candidate }) => (
      candidate !== element && element.contains(candidate)
    )));
    const currentDateButtons = dayButtons.filter(({ element }) => (
      hasTodayMarker(element) || hasFullDateIdentity(element) || hasCurrentPeriodContext(element)
    ));
    const disabled = (element) => element.disabled || element.getAttribute("aria-disabled") === "true";
    return {
      explicitTodayUnsigned: /(?:今日|今天|当日|當日)\s*(?:尚未|还未|還未|未)\s*(?:完成)?\s*(?:签到|簽到)/i.test(normalized),
      currentDateCellUnsignedCount: currentDateButtons.filter(({ element }) => unsignedPattern.test(cellText(element))).length,
      currentDateCellSignedCount: currentDateButtons.filter(({ element }) => signedPattern.test(cellText(element))).length,
      explicitSuccess: /(?:今日|今天|当日|當日)\s*已\s*(?:签到|簽到)/i.test(normalized),
      buttonCount: dayButtons.length,
      currentDateEvidenceCount: currentDateButtons.length,
      enabledCurrentDateButtonCount: currentDateButtons.filter(({ element }) => !disabled(element)).length,
      disabledCurrentDateButtonCount: currentDateButtons.filter(({ element }) => disabled(element)).length,
      currentButtonIndex: currentDateButtons.length === 1 ? currentDateButtons[0].index : -1,
    };
  }, {
    actionSelector: CALENDAR_DAY_ACTION_SELECTOR,
    expectedDay: expectedDate.day,
    fullDateTokens: expectedDate.fullDateTokens,
    periodTokens: expectedDate.periodTokens,
  });
}

export function classifyCalendarDayCheckinEvidence(evidence, { afterClick = false } = {}) {
  if (Number(evidence?.buttonCount) === 0) {
    return { status: "needs_attention", reason: afterClick
      ? "点击当天日期后未获得持久化签到确认"
      : "日历签到页未找到当天日期按钮" };
  }
  const hasCurrentUnsignedState = evidence?.explicitTodayUnsigned
    || Number(evidence?.currentDateCellUnsignedCount) > 0;
  const hasCurrentSignedState = Number(evidence?.currentDateCellSignedCount) === 1;
  const confirmed = (evidence?.explicitSuccess || hasCurrentSignedState)
    && !hasCurrentUnsignedState
    && Number(evidence?.currentDateEvidenceCount) === 1
    && (Number(evidence?.disabledCurrentDateButtonCount) === 1 || hasCurrentSignedState);
  if (confirmed) {
    return {
      status: afterClick ? "signed" : "already_signed",
      reason: afterClick ? "点击当天日期后刷新确认签到成功" : "日历签到页确认今日已签到",
    };
  }
  if (afterClick) return { status: "needs_attention", reason: "点击当天日期后未获得持久化签到确认" };
  if (Number(evidence?.currentDateEvidenceCount) !== 1
    || Number(evidence?.enabledCurrentDateButtonCount) !== 1) {
    return { status: "needs_attention", reason: "日历签到页未找到可证明属于今天的唯一日期按钮" };
  }
  if (!hasCurrentUnsignedState) {
    return { status: "needs_attention", reason: "日历签到页缺少明确的今日未签到证据" };
  }
  return { status: "ready", reason: "日历签到页找到唯一可点击的当天日期" };
}

async function tryCalendarDayCheckin(page, target, activeUrl, config) {
  const allowedOrigins = target.allowedOrigins ?? [target.origin];
  const currentUrl = assertBookmarkNavigation(page.url(), allowedOrigins);
  if (!targetUsesCalendarDayCheckin(target, currentUrl, config)) return null;
  if (currentUrl !== activeUrl) {
    throw new Error("日历签到页地址在执行前发生变化");
  }
  await waitForExtendedDiscoveryContent(page, config);
  assertCalendarDayCheckinLocation(target, page.url(), config);
  const expectedDate = shanghaiCalendarDate();
  const before = await inspectCalendarDayCheckin(page, expectedDate);
  const beforeState = classifyCalendarDayCheckinEvidence(before);
  if (beforeState.status !== "ready") return beforeState;

  const action = page.locator(CALENDAR_DAY_ACTION_SELECTOR).nth(before.currentButtonIndex);
  if (!Number.isInteger(before.currentButtonIndex)
    || before.currentButtonIndex < 0
    || !await action.isVisible().catch(() => false)
    || !await action.isEnabled().catch(() => false)) {
    return { status: "needs_attention", reason: "日历签到当天日期按钮不唯一" };
  }
  await action.click({ timeout: 10000 });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await sleep(Math.max(1000, Number(config.actionWaitMs) || 0));
  assertCalendarDayCheckinLocation(target, page.url(), config);
  await page.reload({ waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
  await waitForExtendedDiscoveryContent(page, config);
  assertCalendarDayCheckinLocation(target, page.url(), config);

  const after = await inspectCalendarDayCheckin(page, expectedDate);
  return classifyCalendarDayCheckinEvidence(after, { afterClick: true });
}

export function getConfiguredPreCheckinDismissRule(target, activeOrigin, config) {
  if (!(target?.allowedOrigins ?? [target?.origin]).includes(activeOrigin)) return null;
  const raw = config?.preCheckinDismissRules?.[activeOrigin];
  if (!raw || raw.enabled === false) return null;
  const buttonTexts = [...new Set((raw.buttonTexts ?? [])
    .map((value) => normalizeText(value))
    .filter((value) => value && value.length <= 80))];
  const selectors = [...new Set((raw.selectors ?? [])
    .map((value) => String(value).trim())
    .filter((value) => value && value.length <= 200))];
  if (buttonTexts.length + selectors.length === 0) {
    throw new Error("签到前公告关闭规则缺少按钮文本或选择器");
  }
  return {
    buttonTexts,
    selectors,
    waitMs: Math.max(0, Math.min(10_000, Number(raw.waitMs) || 3_000)),
    maxDismissals: Math.max(1, Math.min(5, Number(raw.maxDismissals) || 3)),
  };
}

async function visibleCandidates(locators) {
  const visible = [];
  for (const locator of locators) {
    const count = Math.min(20, await locator.count());
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
    }
  }
  return visible;
}

async function waitForConfiguredDismissCandidates(selectorLocators, textLocators, waitMs) {
  const deadline = Date.now() + waitMs;
  do {
    let candidates = await visibleCandidates(selectorLocators);
    if (candidates.length === 0) candidates = await visibleCandidates(textLocators);
    if (candidates.length > 0 || Date.now() >= deadline) return candidates;
    await sleep(250);
  } while (true);
}

export async function dismissConfiguredPreCheckinOverlay(page, target, activeOrigin, config) {
  const rule = getConfiguredPreCheckinDismissRule(target, activeOrigin, config);
  if (!rule) return false;
  const selectorLocators = rule.selectors.map((selector) => page.locator(selector));
  const textLocators = rule.buttonTexts.map((text) => page.getByRole("button", { name: text, exact: true }));
  let dismissed = 0;
  for (; dismissed < rule.maxDismissals; dismissed += 1) {
    const candidates = await waitForConfiguredDismissCandidates(
      selectorLocators,
      textLocators,
      rule.waitMs,
    );
    if (candidates.length === 0) break;
    // Announcement stacks commonly reuse one close button or expose more than
    // one exact close control. Work from the topmost DOM candidate and keep the
    // operation bounded by maxDismissals.
    await candidates[candidates.length - 1].click({ timeout: 10_000 });
    await sleep(Math.max(500, Number(config.actionWaitMs) || 0));
  }
  const remaining = await waitForConfiguredDismissCandidates(
    selectorLocators,
    textLocators,
    rule.waitMs,
  );
  if (remaining.length > 0) {
    throw new Error(`签到前公告在有限的 ${rule.maxDismissals} 次关闭后仍然可见`);
  }
  return dismissed > 0;
}

export function getVisitCheckinWaitMs(config) {
  return Math.max(0, Math.min(60_000, Number(config?.visitCheckinWaitMs) || 15_000));
}

async function acceptConfiguredTerms(page, state, activeOrigin, config) {
  if (state.status !== "login_required"
    || !(config.autoAcceptUpdatedTermsOrigins ?? []).includes(activeOrigin)) return state;
  const bodyText = String(await page.locator("body").innerText({ timeout: 3000 }).catch(() => ""));
  if (!/服务条款已.*更新|继续使用服务之前.*同意|同意并继续/.test(bodyText)) return state;
  const acceptButton = page.locator("button").filter({ hasText: /^\s*同意并继续\s*$/ });
  if (await acceptButton.count() !== 1 || !await acceptButton.isVisible().catch(() => false)) return state;
  await acceptButton.click({ timeout: 10000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await sleep(Math.max(1000, Number(config.actionWaitMs) || 0));
  const acceptedState = await snapshotState(page);
  return acceptedState.status === "login_required"
    ? { ...acceptedState, reason: "已同意新版服务条款，继续执行自动登录" }
    : acceptedState;
}

async function passLeichiConfirmation(page, config) {
  const button = page.locator("button#sl-check");
  const description = page.locator("#sl-text");
  if (await button.count() !== 1 || await description.count() !== 1) return null;
  const text = String(await description.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (!/客户端异常.*确认.*合法用户/.test(text) || !await button.isVisible()) return null;

  await button.click({ timeout: 10000 });
  const deadline = Date.now() + Math.min(config.cloudflareWaitMs, 30000);
  while (Date.now() < deadline) {
    await sleep(1000);
    if (await button.count() === 0 || !await button.isVisible().catch(() => false)) return { passed: true };
    const currentText = String(await description.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (/失败|错误|异常/.test(currentText) && !/客户端异常.*确认.*合法用户/.test(currentText)) {
      return { passed: false, reason: currentText.slice(0, 200) };
    }
  }
  return { passed: false, reason: "雷池 WAF 合法用户确认等待超时" };
}

async function findCheckinAction(page, allowedOrigins, excludedAction = null) {
  const originSet = new Set(Array.isArray(allowedOrigins) ? allowedOrigins : [allowedOrigins]);
  const raw = await page.locator('button, a, [role="button"], input[type="button"], input[type="submit"]').evaluateAll((elements) => {
    return elements.slice(0, 400).map((element, index) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const visible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      const text = String(element.innerText || element.value || element.getAttribute("aria-label") || element.title || "")
        .replace(/\s+/g, " ").trim();
      return {
        index,
        text,
        visible,
        disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
        tagName: element.tagName,
        href: element instanceof HTMLAnchorElement ? element.href : null,
        formAction: element.form ? element.form.action : null,
      };
    });
  });

  return raw
    .map((candidate) => ({ ...candidate, score: scoreActionText(candidate.text) }))
    .filter((candidate) => candidate.visible && !candidate.disabled && candidate.score >= 0)
    .filter((candidate) => {
      if (!candidate.href) return true;
      try {
        const href = new URL(candidate.href);
        if (!originSet.has(href.origin)) return false;
        if (/(attendance|check[-_]?in|showup|bakatest|sign|签到|簽到|申请额度|申請額度)/i.test(href.href)) return true;
        if (/(?:领取|領取).*codex.*(?:权益|權益)|codex.*(?:权益|權益)/i.test(candidate.text)) return true;
        // Some NexusPHP trackers expose check-in as an onclick handler on a
        // same-page "#" link (for example onclick="signin(this)").  The
        // visible label remains the authoritative signal in that case.
        return candidate.href.endsWith("#") && /^(?:\[?\s*)?(?:签到|簽到)(?:\s*\]?)$/i.test(candidate.text);
      } catch {
        return false;
      }
    })
    .filter((candidate) => {
      if (!candidate.formAction) return true;
      try { return originSet.has(new URL(candidate.formAction).origin); } catch { return false; }
    })
    .filter((candidate) => !excludedAction || !(
      candidate.tagName === excludedAction.tagName
      && candidate.text === excludedAction.text
      && candidate.href === excludedAction.href
    ))
    .sort((a, b) => b.score - a.score)[0] ?? null;
}

async function clickCandidate(page, candidate, { domClick = false } = {}) {
  const locator = page.locator('button, a, [role="button"], input[type="button"], input[type="submit"]').nth(candidate.index);
  if (domClick) await locator.evaluate((element) => element.click());
  else await locator.click({ timeout: 10000 });
}

async function readConfiguredSequentialStepEvidence(page, step, phase, responseConfirmed = false) {
  const state = await snapshotState(page);
  const evidence = await page.evaluate(({ actionTexts, completedTexts, successTexts, completedIncludes, successIncludes }) => {
    const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const bodyLines = String(document.body?.innerText ?? "").split(/[\r\n]+/).map(normalize).filter(Boolean);
    const bodyLineSet = new Set(bodyLines);
    const controls = [...document.querySelectorAll(
      'button, a, [role="button"], input[type="button"], input[type="submit"]',
    )].slice(0, 400).map((element, index) => ({
      index,
      tagName: element.tagName,
      text: normalize(element.innerText || element.value || element.getAttribute("aria-label") || element.title || ""),
      visible: visible(element),
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      href: element instanceof HTMLAnchorElement ? element.href : null,
      formAction: element.form ? element.form.action : null,
      hasHandler: Boolean(element.form || element.getAttribute("onclick") || element.getAttribute("data-action")),
    }));
    return {
      controls,
      completedTextPresent: completedTexts.some((text) => bodyLineSet.has(text))
        || completedIncludes.some((text) => bodyLines.some((line) => line.includes(text))),
      successTextPresent: successTexts.some((text) => bodyLineSet.has(text))
        || successIncludes.some((text) => bodyLines.some((line) => line.includes(text))),
      disabledActionPresent: controls.some((control) => (
        control.visible && control.disabled && actionTexts.includes(control.text)
      )),
    };
  }, {
    actionTexts: step.actionTexts,
    completedTexts: step.completedTexts,
    successTexts: step.successTexts,
    completedIncludes: step.completedIncludes,
    successIncludes: step.successIncludes,
  });

  if (step.acceptGenericCheckinState && ["signed", "already_signed"].includes(state.status)) {
    return { done: true, status: state.status, reason: state.reason, controls: evidence.controls };
  }
  if (evidence.completedTextPresent) {
    return { done: true, status: phase === "before" ? "already_signed" : "signed", reason: "步骤页面显示完成状态", controls: evidence.controls };
  }
  if (phase === "after" && evidence.successTextPresent) {
    return { done: true, status: "signed", reason: "步骤页面显示成功状态", controls: evidence.controls };
  }
  if (step.disabledActionIsComplete && evidence.disabledActionPresent) {
    return { done: true, status: phase === "before" ? "already_signed" : "signed", reason: "步骤动作控件确认已完成", controls: evidence.controls };
  }
  if (phase === "after" && responseConfirmed) {
    return { done: true, status: "signed", reason: "步骤接口确认成功", controls: evidence.controls };
  }
  return { done: false, state, controls: evidence.controls };
}

function watchConfiguredSequentialResponses(page, step, expectedOrigin) {
  let confirmed = false;
  const pending = new Set();
  const handler = (response) => {
    const task = (async () => {
      const request = response.request();
      const url = response.url();
      const pathMatches = step.responseEvidence.some((rule) => {
        try {
          const parsed = new URL(url);
          return parsed.origin === expectedOrigin
            && parsed.pathname.toLowerCase().includes(rule.urlIncludes)
            && rule.methods.includes(request.method().toUpperCase());
        } catch {
          return false;
        }
      });
      if (!pathMatches) return;
      const json = await response.json().catch(() => null);
      confirmed ||= step.responseEvidence.some((rule) => configuredSequentialResponseProvesSuccess({
        url,
        method: request.method(),
        status: response.status(),
        json,
      }, rule, expectedOrigin));
    })().catch(() => {});
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  page.on("response", handler);
  return {
    confirmed: () => confirmed,
    async stop() {
      page.off("response", handler);
      await Promise.allSettled([...pending]);
      return confirmed;
    },
  };
}

async function waitForConfiguredSequentialStep(page, target, config, step, watcher) {
  const allowedOrigins = target.allowedOrigins ?? [target.origin];
  const deadline = Date.now() + step.waitMs;
  do {
    assertBookmarkNavigation(page.url(), allowedOrigins);
    const evidence = await readConfiguredSequentialStepEvidence(page, step, "after", watcher.confirmed());
    if (evidence.done) return evidence;
    if (["login_required", "interactive_challenge", "managed_challenge", "managed_challenge_timeout", "deferred", "needs_attention"].includes(evidence.state?.status)) {
      return { done: false, terminal: evidence.state };
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.max(100, Math.min(1000, Number(config.checkinStatePollMs) || 500)));
  } while (true);

  if (step.reloadOnUnconfirmed) {
    await page.reload({ waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs }).catch(() => {});
    await sleep(Math.max(500, Number(config.actionWaitMs) || 0));
    assertBookmarkNavigation(page.url(), allowedOrigins);
    const reloaded = await readConfiguredSequentialStepEvidence(page, step, "after", watcher.confirmed());
    if (reloaded.done) return reloaded;
  }
  return { done: false };
}

async function tryConfiguredSequentialActions(page, target, config) {
  const rule = getConfiguredSequentialActionRule(target, config);
  if (!rule) return null;
  const allowedOrigins = target.allowedOrigins ?? [target.origin];
  const completedActions = [];
  let anyActionClicked = false;

  for (const step of rule.steps) {
    await page.goto(assertBookmarkNavigation(step.url, allowedOrigins), {
      waitUntil: "domcontentloaded",
      timeout: config.navigationTimeoutMs,
    });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    assertBookmarkNavigation(page.url(), allowedOrigins);

    let before = await readConfiguredSequentialStepEvidence(page, step, "before");
    if (["interactive_challenge", "managed_challenge"].includes(before.state?.status)) {
      const activeOrigin = new URL(page.url()).origin;
      const challengeState = await runConfiguredChallengePhase(page, target, activeOrigin, config, "before");
      if (challengeState && ["login_required", "interactive_challenge", "managed_challenge_timeout", "deferred", "needs_attention"].includes(challengeState.status)) {
        return { ...challengeState, action: completedActions.join(" → ") || undefined };
      }
      before = await readConfiguredSequentialStepEvidence(page, step, "before");
    }
    if (before.done) {
      completedActions.push(step.actionTexts[0]);
      continue;
    }
    if (["login_required", "interactive_challenge", "managed_challenge_timeout", "deferred", "needs_attention"].includes(before.state?.status)) {
      return { ...before.state, action: completedActions.join(" → ") || undefined };
    }

    const selection = selectConfiguredSequentialActionCandidate(before.controls, step, allowedOrigins);
    if (!selection.candidate) {
      return {
        status: "needs_attention",
        reason: selection.outcome === "action_not_unique" ? "顺序动作页面出现多个同名目标控件" : "顺序动作页面未找到唯一目标控件",
        action: completedActions.join(" → ") || undefined,
      };
    }

    const expectedOrigin = new URL(step.url).origin;
    const watcher = watchConfiguredSequentialResponses(page, step, expectedOrigin);
    try {
      await clickCandidate(page, selection.candidate);
      anyActionClicked = true;
      let confirmation = await waitForConfiguredSequentialStep(page, target, config, step, watcher);
      if (["interactive_challenge", "managed_challenge"].includes(confirmation.terminal?.status)) {
        const activeOrigin = new URL(page.url()).origin;
        const challengeState = await runConfiguredChallengePhase(page, target, activeOrigin, config, "after");
        if (challengeState && ["login_required", "interactive_challenge", "managed_challenge_timeout", "deferred", "needs_attention"].includes(challengeState.status)) {
          return { ...challengeState, action: [...completedActions, selection.candidate.text].join(" → ") };
        }
        confirmation = await waitForConfiguredSequentialStep(page, target, config, step, watcher);
      }
      if (confirmation.terminal) {
        return { ...confirmation.terminal, action: [...completedActions, selection.candidate.text].join(" → ") };
      }
      if (!confirmation.done) {
        return {
          status: "needs_attention",
          reason: "顺序动作已执行，但页面或接口未提供权威完成证据",
          action: [...completedActions, selection.candidate.text].join(" → "),
        };
      }
    } finally {
      await watcher.stop();
    }
    completedActions.push(selection.candidate.text);
  }

  return {
    status: anyActionClicked ? "signed" : "already_signed",
    reason: anyActionClicked ? "全部顺序动作均获得权威完成证据" : "全部顺序动作均已完成",
    action: completedActions.join(" → "),
  };
}

async function visibleLocatorIndexes(locator) {
  const indexes = [];
  for (let index = 0; index < await locator.count(); index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) indexes.push(index);
  }
  return indexes;
}

async function waitForConfiguredCaptchaImage(dialog, rule) {
  const deadline = Date.now() + rule.waitMs;
  do {
    const images = dialog.locator(rule.imageSelector);
    const ready = [];
    for (let index = 0; index < Math.min(20, await images.count()); index += 1) {
      const candidate = images.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const metrics = await candidate.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const isImage = element.tagName === "IMG";
        return {
          width: rect.width,
          height: rect.height,
          isImage,
          complete: isImage ? Boolean(element.complete) : true,
          naturalWidth: isImage ? Number(element.naturalWidth) : rect.width,
          naturalHeight: isImage ? Number(element.naturalHeight) : rect.height,
        };
      }).catch(() => null);
      if (configuredCaptchaImageIsReady(metrics, rule)) ready.push(candidate);
    }
    if (ready.length > 1) {
      return { error: "签到验证码出现多个达到稳定尺寸的可见图像，已拒绝操作" };
    }
    if (ready.length === 1) return { image: ready[0] };
    await sleep(150);
  } while (Date.now() < deadline);
  return { error: "签到验证码图像未在有限等待内达到稳定尺寸" };
}

async function readConfiguredCaptchaImage(image) {
  const bytes = await image.evaluate(async (element) => {
    const source = String(element.currentSrc || element.src || "");
    if (!source) return null;
    let url;
    try { url = new URL(source, location.href); } catch { return null; }
    if (!["data:", "blob:"].includes(url.protocol) && url.origin !== location.origin) return null;
    try {
      if (!element.complete || element.naturalWidth <= 0 || element.naturalHeight <= 0) return null;
      const canvas = document.createElement("canvas");
      canvas.width = element.naturalWidth;
      canvas.height = element.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return null;
      context.drawImage(element, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) return null;
      const value = new Uint8Array(await blob.arrayBuffer());
      if (value.length < 8 || value.length > 1_000_000) return null;
      return Array.from(value);
    } catch {
      return null;
    }
  }).catch(() => null);
  if (Array.isArray(bytes) && bytes.length > 0) return Buffer.from(bytes);
  return image.screenshot();
}

async function tryConfiguredCheckinCaptchaDialog(page, target, activeOrigin, config) {
  const rule = getConfiguredCheckinCaptchaDialogRule(target, activeOrigin, config);
  if (!rule) return null;
  const deadline = Date.now() + rule.waitMs;
  let dialog = null;
  do {
    const dialogs = page.locator(rule.dialogSelector);
    const visibleDialogs = await visibleLocatorIndexes(dialogs);
    if (visibleDialogs.length > 1) {
      return { status: "needs_attention", reason: "签到验证码出现多个可见弹窗，已拒绝操作" };
    }
    if (visibleDialogs.length === 1) {
      dialog = dialogs.nth(visibleDialogs[0]);
      break;
    }
    await sleep(250);
  } while (Date.now() < deadline);
  if (!dialog) return null;

  const inputs = dialog.locator(rule.inputSelector);
  const visibleInputs = await visibleLocatorIndexes(inputs);
  const buttons = dialog.locator('button, [role="button"], input[type="button"], input[type="submit"]');
  const buttonCandidates = await buttons.evaluateAll((elements, texts) => elements.map((element, index) => ({
    index,
    text: String(element.innerText || element.value || element.getAttribute("aria-label") || "")
      .replace(/\s+/g, " ").trim(),
    visible: (() => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    })(),
  })).filter((candidate) => candidate.visible && texts.includes(candidate.text)), rule.confirmTexts);
  const refreshCandidates = await buttons.evaluateAll((elements, texts) => elements.map((element, index) => ({
    index,
    text: String(element.innerText || element.value || element.getAttribute("aria-label") || "")
      .replace(/\s+/g, " ").trim(),
    visible: (() => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    })(),
  })).filter((candidate) => candidate.visible && texts.includes(candidate.text)), rule.refreshTexts);
  if (visibleInputs.length !== 1 || buttonCandidates.length !== 1) {
    return { status: "needs_attention", reason: "签到验证码弹窗结构不唯一，已拒绝操作" };
  }
  if (rule.maxAttempts > 1 && refreshCandidates.length !== 1) {
    return { status: "needs_attention", reason: "签到验证码缺少唯一刷新控件，已拒绝重复识别" };
  }

  for (let attempt = 1; attempt <= rule.maxAttempts; attempt += 1) {
    const captchaImage = await waitForConfiguredCaptchaImage(dialog, rule);
    if (!captchaImage.image) {
      return { status: "needs_attention", reason: captchaImage.error };
    }
    const recognition = await recognizeAlphanumericCaptcha(
      await readConfiguredCaptchaImage(captchaImage.image),
      { minLength: rule.minLength, maxLength: rule.maxLength },
    );
    const codePattern = new RegExp(`^[A-Z0-9]{${rule.minLength},${rule.maxLength}}$`);
    const reliable = codePattern.test(recognition.code) && Number(recognition.confidence) >= rule.minConfidence;
    if (reliable) {
      await inputs.nth(visibleInputs[0]).fill(recognition.code);
      await buttons.nth(buttonCandidates[0].index).click({ timeout: 10000 });
      await sleep(Math.max(1000, Number(config.actionWaitMs) || 0));
      const state = await waitForConfirmedCheckinState(page, config, rule.waitMs);
      if (["signed", "already_signed"].includes(state.status)) {
        return { ...state, reason: `本地图片验证码提交后页面确认签到成功（置信度 ${Math.round(recognition.confidence)}）` };
      }
      if (!await dialog.isVisible().catch(() => false)) {
        return { status: "needs_attention", reason: "签到图片验证码提交后页面未确认成功" };
      }
    }
    if (attempt < rule.maxAttempts) {
      await buttons.nth(refreshCandidates[0].index).click({ timeout: 10000 });
      await sleep(750);
      continue;
    }
    if (!reliable) {
      return {
        status: "interactive_challenge",
        reason: `签到图片验证码本地识别结果不可靠（字符数 ${recognition.code.length}，置信度 ${Math.round(Number(recognition.confidence) || 0)}）`,
      };
    }
  }
  return { status: "interactive_challenge", reason: "签到图片验证码在有限次数内未通过" };
}

async function detectActiveQuotaBenefit(page, activeOrigin, config, status = "already_signed") {
  if (!config.quotaRequestRules?.[activeOrigin]) return null;
  const bodyText = String(await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  const claimButton = page.getByRole("button", { name: "领取 Codex 权益", exact: true });
  const claimButtonVisible = await claimButton.count() === 1 && await claimButton.isVisible().catch(() => false);
  if (!claimButtonVisible
    && /当前套餐\s*[-—:]?\s*Codex/i.test(bodyText)
    && /剩余(?:额度|額度)|下次重置|有效期/i.test(bodyText)
    && !/已过期|已過期/i.test(bodyText)) {
    return { status, reason: "Codex 权益已领取，页面显示有效套餐" };
  }
  return null;
}

async function tryQuotaRequestFlow(page, activeOrigin, config) {
  const rule = config.quotaRequestRules?.[activeOrigin];
  if (!rule) return null;
  const reason = formatDailyReason(String(rule.reason || "{date}正常使用服务，申请额度用于开发测试和日常体验，谢谢。"));
  const minimumLength = Math.max(10, Number(rule.minimumReasonLength) || 10);
  if ([...reason].length < minimumLength) throw new Error(`额度申请理由少于 ${minimumLength} 个字符`);
  const reasonFields = page.locator([
    'textarea:visible',
    'input[name*="reason" i]:visible',
    'input[name*="remark" i]:visible',
    'input[name*="message" i]:visible',
    'input[placeholder*="理由" i]:visible',
    'input[placeholder*="原因" i]:visible',
  ].join(", "));
  if (await reasonFields.count() !== 1) return null;
  await reasonFields.fill(reason);
  let submit = null;
  for (const label of ["领取", "領取", "提交申请", "确认申请", "确认提交", "提交", "确认"]) {
    const candidate = page.getByRole("button", { name: label, exact: true });
    if (await candidate.count() === 1 && await candidate.isVisible().catch(() => false)) { submit = candidate; break; }
    const input = page.locator(`input[type="submit"][value="${label}"], input[type="button"][value="${label}"]`);
    if (await input.count() === 1 && await input.isVisible().catch(() => false)) { submit = input; break; }
  }
  if (!submit) return { status: "needs_attention", reason: "已填写额度申请理由，但未找到提交按钮" };
  await submit.click({ timeout: 10000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await sleep(Math.max(1000, Number(config.actionWaitMs) || 0));
  const state = await waitForManagedChallenge(page, config);
  if (["signed", "already_signed"].includes(state.status)) return state;
  const bodyText = String(await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (/(额度申请已提交|申请额度成功|额度已发放|额度申请成功|申请成功.*额度|今日已申请|今天已申请|codex\s*(?:权益|權益)\s*已(?:领取|領取)|(?:领取|領取)\s*codex\s*(?:权益|權益)\s*成功)/i.test(bodyText)) return { status: "signed", reason: "额度申请已提交并获得页面确认" };
  const activeBenefit = await detectActiveQuotaBenefit(page, activeOrigin, config, "signed");
  if (activeBenefit) return activeBenefit;
  return { status: "unconfirmed", reason: "额度申请已提交，但页面未确认结果" };
}

export function isSafeDiscoveredHref(rawHref) {
  const value = String(rawHref || "").trim();
  if (!value || /[\u0000-\u001f\u007f<>"'`]/.test(value)) return false;
  try {
    return !/[<>"'`]/.test(decodeURIComponent(value));
  } catch {
    return false;
  }
}

async function findCheckinDiscoveryUrls(page, expectedOrigin) {
  const links = await page.locator("a[href]").evaluateAll((elements) => elements.slice(0, 300).map((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      rawHref: element.getAttribute("href"),
      href: element.href,
      text: String(element.innerText || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim(),
      visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
    };
  }));

  return links
    .filter((link) => link.visible && link.href && isSafeDiscoveredHref(link.rawHref))
    .map((link) => {
      try {
        const url = new URL(link.href);
        if (url.origin !== expectedOrigin) return null;
        let score = 0;
        if (/(立即签到|立即簽到|每日签到|每日簽到|签到中心|簽到中心|福利中心|任务中心|任務中心)/i.test(link.text)) score = 130;
        else if (/\/(check[-_]?in|daily[-_]?sign|attendance|welfare|rewards?)(?:[/?#]|$)/i.test(url.href)) score = 120;
        else if (/(个人设置|個人設置|个人资料|個人資料|个人中心|個人中心)/i.test(link.text)) score = 100;
        else if (/\/(profile|personal|account)(?:[/?#]|$)/i.test(url.href)) score = 90;
        else if (/(钱包|錢包|福利|奖励|獎勵)/i.test(link.text)) score = 85;
        else if (/\/(wallet|billing|setting|settings)(?:[/?#]|$)/i.test(url.href)) score = 80;
        else if (/(设置|設置)/i.test(link.text) && /\/(console|user)(?:[/?#]|$)/i.test(url.href)) score = 60;
        return score > 0 ? { href: url.href, score } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score)
    .filter((link, index, rows) => rows.findIndex((candidate) => candidate.href === link.href) === index)
    .slice(0, 8)
    .map((link) => link.href);
}

async function findMatchingQaRule(page, rules, origin) {
  const bodyText = normalizeText(await page.locator("body").innerText({ timeout: 5000 })).slice(0, 30000);
  return rules.find((rule) => {
    if (!rule || rule.origin !== origin || !rule.questionIncludes) return false;
    return bodyText.includes(String(rule.questionIncludes));
  }) ?? null;
}

async function applyQaRule(page, rule) {
  if (!rule?.answerText || !rule?.submitText) return false;
  const answerText = normalizeText(rule.answerText);
  const radioOptions = await page.locator('input[type="radio"]').evaluateAll((elements) => elements.map((element, index) => {
    let siblingText = "";
    let sibling = element.nextSibling;
    while (sibling && sibling.nodeName !== "BR" && !(sibling instanceof HTMLInputElement)) {
      siblingText += ` ${sibling.textContent || ""}`;
      sibling = sibling.nextSibling;
    }
    return { index, text: String(siblingText).replace(/\s+/g, " ").trim() };
  }));
  const matchingRadios = radioOptions.filter((option) => option.text === answerText);
  if (matchingRadios.length === 1) {
    await page.locator('input[type="radio"]').nth(matchingRadios[0].index).check();
  } else {
    const answer = page.getByText(answerText, { exact: true });
    if (await answer.count() !== 1) return false;
    await answer.click();
  }

  const submitText = normalizeText(rule.submitText);
  const submitInputs = await page.locator('input[type="submit"], button[type="submit"]').evaluateAll((elements) => elements.map((element, index) => ({
    index,
    text: String(element.value || element.innerText || "").replace(/\s+/g, " ").trim(),
  })));
  const matchingSubmits = submitInputs.filter((option) => option.text === submitText);
  if (matchingSubmits.length === 1) {
    await page.locator('input[type="submit"], button[type="submit"]').nth(matchingSubmits[0].index).click();
  } else {
    const submit = page.getByText(submitText, { exact: true });
    if (await submit.count() !== 1) return false;
    await submit.click();
  }
  return true;
}

export function extractSingleChoiceQuestion(containerText, optionTexts) {
  const options = optionTexts.map((value) => normalizeText(value)).filter(Boolean);
  if (options.length < 2) return null;
  let question = normalizeText(containerText);
  const firstOptionIndex = question.indexOf(options[0]);
  if (firstOptionIndex <= 0) return null;
  question = question.slice(0, firstOptionIndex);
  const markers = [question.lastIndexOf("请问"), question.lastIndexOf("請問"), question.lastIndexOf("[单选]"), question.lastIndexOf("[單選]")];
  const marker = Math.max(...markers);
  if (marker >= 0) question = question.slice(marker);
  const normalized = normalizeText(question);
  return normalized ? normalized.slice(-320) : null;
}

async function readSingleChoiceChallenge(page) {
  const radios = page.locator('input[type="radio"]');
  if (await radios.count() < 2) return null;
  const challenge = await radios.evaluateAll((elements) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const options = elements.map((element, index) => {
      let text = "";
      let sibling = element.nextSibling;
      while (sibling && sibling.nodeName !== "BR" && !(sibling instanceof HTMLInputElement)) {
        text += ` ${sibling.textContent || ""}`;
        sibling = sibling.nextSibling;
      }
      return { index, text: normalize(text) };
    }).filter((option) => option.text);
    if (options.length < 2) return null;
    const container = elements[0].closest("form") || elements[0].closest("table") || elements[0].parentElement;
    return { containerText: normalize(container?.innerText || ""), options: options.map((option) => option.text) };
  });
  if (!challenge) return null;
  const question = extractSingleChoiceQuestion(challenge.containerText, challenge.options);
  return question ? { question, options: challenge.options } : null;
}

async function clickQaChange(page, config) {
  const labels = config.qaChangeButtonTexts ?? ["仅可换一题", "僅可換一題", "换一题", "換一題"];
  const controls = page.locator('input[type="submit"], button');
  const values = await controls.evaluateAll((elements) => elements.map((element, index) => ({
    index,
    text: String(element.value || element.innerText || "").replace(/\s+/g, " ").trim(),
  })));
  const matches = values.filter((item) => labels.includes(item.text));
  if (matches.length !== 1) return false;
  await controls.nth(matches[0].index).click();
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await sleep(1000);
  return true;
}

async function tryQaFlow(page, rules, origin, config) {
  const configuredChanges = Number(config.qaMaxQuestionChanges);
  const maxChanges = Math.max(0, Math.min(2, Number.isFinite(configuredChanges) ? configuredChanges : 1));
  for (let changeIndex = 0; changeIndex <= maxChanges; changeIndex += 1) {
    const challenge = await readSingleChoiceChallenge(page);
    if (!challenge) return null;

    let rule = await findMatchingQaRule(page, rules, origin);
    let source = rule ? (rule.source || "configured") : null;
    if (!rule) {
      const searched = await resolveQaByWebSearch(page, challenge.question, challenge.options, config);
      if (searched?.answer) {
        rule = { answerText: searched.answer, submitText: "提交" };
        source = searched.source;
      }
    }

    if (rule) {
      const applied = await applyQaRule(page, rule);
      if (!applied) {
        return { status: "interactive_challenge", reason: "已找到问答答案，但页面选项结构无法安全提交" };
      }
      await sleep(config.actionWaitMs);
      const state = await waitForManagedChallenge(page, config);
      const verified = ["signed", "already_signed"].includes(state.status);
      return {
        ...(verified ? state : { status: "interactive_challenge", reason: "问答答案已提交，但页面未确认签到成功" }),
        qa: {
          question: challenge.question,
          answer: String(rule.answerText),
          submitText: String(rule.submitText || "提交"),
          source,
          verified,
        },
      };
    }

    if (changeIndex < maxChanges && await clickQaChange(page, config)) continue;
    return {
      status: "interactive_challenge",
      reason: `遇到未知站内问答：${challenge.question.slice(0, 120)}`,
    };
  }
  return null;
}

export async function runNewApiCheckinInBrowser() {
    let userId = null;
    const storages = [localStorage, sessionStorage];
    for (const storage of storages) {
      for (let index = 0; index < storage.length; index += 1) {
        try {
          const value = JSON.parse(storage.getItem(storage.key(index)) || "null");
          userId = value?.id ?? value?.user?.id ?? value?.state?.user?.id ?? value?.data?.id ?? null;
          if (userId != null) break;
        } catch { /* continue */ }
      }
      if (userId != null) break;
    }
    if (userId == null) {
      const visibleId = String(document.body?.innerText || "").match(/ID\s*[:：]\s*(\d+)/i);
      userId = visibleId?.[1] ?? null;
    }
    if (userId == null) {
      try {
        const response = await fetch("/api/user/self", { credentials: "include", headers: { Accept: "application/json" } });
        if ([401, 403].includes(response.status)) {
          return { status: "login_required", reason: "签到接口显示登录状态无效" };
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
      return { status: "login_required", reason: "签到接口显示登录状态无效" };
    }
    const statusBody = initialStatus.body;
    const message = String(statusBody?.message || "");
    if (!statusBody?.success) {
      if (/未启用|未啟用|not enabled/i.test(message)) {
        return { status: "not_available", reason: "站点签到功能未启用" };
      }
      if (/turnstile|captcha|人机|人機/i.test(message)) {
        return { status: "interactive_challenge", reason: "站点签到接口要求人机验证" };
      }
      return null;
    }
    const checked = Boolean(
      statusBody?.data?.stats?.checked_in_today
      ?? statusBody?.data?.checked_in_today
      ?? statusBody?.data?.checkedInToday
    );
    if (checked) return { status: "already_signed", reason: "签到接口显示今日已签到" };

    let checkinResponse;
    try {
      checkinResponse = await fetch("/api/user/checkin", { method: "POST", credentials: "include", headers });
    } catch {
      return null;
    }
    if ([401, 403].includes(checkinResponse.status)) {
      return { status: "login_required", reason: "签到接口显示登录状态无效" };
    }
    let checkinBody;
    try { checkinBody = await checkinResponse.json(); } catch { return null; }
    const checkinMessage = String(checkinBody?.message || "");
    if (/turnstile|captcha|人机|人機/i.test(checkinMessage)) {
      return { status: "interactive_challenge", reason: "站点签到接口要求人机验证" };
    }
    if (/未启用|未啟用|not enabled/i.test(checkinMessage)) {
      return { status: "not_available", reason: "站点签到功能未启用" };
    }
    const submitted = checkinBody?.success || /已签到|已簽到|already/i.test(checkinMessage);
    if (!submitted) return null;

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const verifiedStatus = await readStatus();
      if (verifiedStatus?.loginRequired) {
        return { status: "login_required", reason: "签到接口显示登录状态无效" };
      }
      const verifiedBody = verifiedStatus?.body;
      const verified = verifiedBody?.success && Boolean(
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
    return null;
}

export async function tryNewApiCheckin(page) {
  return page.evaluate(runNewApiCheckinInBrowser);
}

async function tryOpenCdCaptcha(page, expectedOrigin) {
  if (expectedOrigin !== "https://open.cd") return null;
  const frame = page.frameLocator("iframe#i_signin");
  const input = frame.locator('input[name="imagestring"]');
  const submit = frame.locator("button#ok");
  const images = frame.locator("img");
  if (await input.count() !== 1 || await submit.count() !== 1 || await images.count() !== 1) return null;
  const screenshot = await images.first().screenshot();
  const recognition = await recognizeOpenCdCaptcha(screenshot);
  if (!/^[A-Z0-9]{6}$/.test(recognition.code)) {
    return { status: "interactive_challenge", reason: "OpenCD 六位验证码本地识别结果无效" };
  }
  await input.fill(recognition.code);
  await submit.click();
  await sleep(2000);
  const responseText = String(await frame.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (/"state"\s*:\s*"success"|签到成功|簽到成功|已签到|已簽到/i.test(responseText)) {
    return {
      status: "signed",
      reason: `OpenCD 图片验证码识别成功（置信度 ${Math.round(recognition.confidence)}）`,
    };
  }
  // OpenCD 的 iframe 有时不返回可识别的成功文本，但服务器已经完成
  // 签到。刷新主页面并检查“查看签到记录”这一权威状态，避免误报。
  await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  await sleep(1200);
  const refreshedState = await snapshotState(page);
  if (["signed", "already_signed"].includes(refreshedState.status)) {
    return {
      ...refreshedState,
      reason: `OpenCD 图片验证码已提交并复查成功（置信度 ${Math.round(recognition.confidence)}）`,
    };
  }
  return { status: "interactive_challenge", reason: "OpenCD 验证码已提交，但未收到成功结果" };
}

async function tryHddolbyPostRedirectVerification(page, expectedOrigin, config) {
  if (expectedOrigin !== "https://www.hddolby.com") return null;
  const current = new URL(page.url());
  if (current.pathname !== "/take2fa.php") return null;

  await page.goto(`${expectedOrigin}/index.php`, {
    waitUntil: "domcontentloaded",
    timeout: config.navigationTimeoutMs,
  });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  const state = await snapshotState(page);
  if (["signed", "already_signed"].includes(state.status)) {
    return {
      ...state,
      reason: "HDDolby 首页确认今日签到奖励已到账",
    };
  }
  return {
    status: "interactive_challenge",
    reason: "HDDolby 要求完成两步验证，且首页未显示今日签到",
  };
}

async function tryNexusImageCaptcha(page) {
  const input = page.locator("#imagestring");
  const submit = page.locator("#showupbutton");
  const image = page.locator("#showupimg");
  if (await input.count() !== 1 || await submit.count() !== 1 || await image.count() !== 1) return null;
  const screenshot = await image.screenshot();
  const recognition = await recognizeOpenCdCaptcha(screenshot);
  if (!/^[A-Z0-9]{6}$/.test(recognition.code)) {
    return { status: "interactive_challenge", reason: "NexusPHP 六位验证码本地识别结果无效" };
  }
  await input.fill(recognition.code);
  await submit.click();
  await sleep(3000);
  const state = await snapshotState(page);
  if (["signed", "already_signed"].includes(state.status)) {
    return { ...state, reason: `${state.reason}；图片验证码置信度 ${Math.round(recognition.confidence)}` };
  }
  const showup = page.locator("#showup");
  if (await showup.count() === 1) {
    const showupText = String(await showup.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (/已签到|已簽到|showed up/i.test(showupText)) {
      return { status: "signed", reason: `HDSky 图片验证码识别成功（置信度 ${Math.round(recognition.confidence)}）` };
    }
  }
  if (await page.locator("#showupimg").count() === 0) {
    return { status: "clicked", reason: `已提交 NexusPHP 图片验证码（置信度 ${Math.round(recognition.confidence)}）` };
  }
  return { status: "interactive_challenge", reason: "NexusPHP 图片验证码提交后仍显示验证弹窗" };
}

async function tryU2Captcha(page, expectedOrigin, config) {
  if (expectedOrigin !== "https://u2.dmhy.org") return null;
  const buttons = page.locator('input[type="submit"][name^="captcha_"]');
  if (await buttons.count() < 2) return null;
  const image = page.locator('img[alt="captcha"]');
  if (await image.count() !== 1) {
    return { status: "interactive_challenge", reason: "U2 验证题缺少题图" };
  }
  try {
    await page.waitForFunction(() => {
      const element = document.querySelector('img[alt="captcha"]');
      return Boolean(element?.complete && element.naturalWidth > 0 && element.naturalHeight > 0);
    }, null, { timeout: 50000 });
  } catch {
    return { status: "interactive_challenge", reason: "U2 验证题图片加载超时" };
  }
  const options = await buttons.evaluateAll((elements) => elements.map((element) => ({
    name: element.name,
    text: element.value,
  })));
  const screenshot = await image.screenshot();
  const solution = await solveU2VisualChallenge(screenshot, options);
  if (!solution.answer?.name) {
    return { status: "interactive_challenge", reason: `U2 本地视觉识别未得出可靠答案：${solution.reason}` };
  }
  const message = page.locator('textarea[name="message"]');
  if (await message.count() !== 1) return { status: "interactive_challenge", reason: "U2 留言框不存在" };
  await message.fill(String(config.u2Message || "今日天气不错"));
  const chosen = page.locator(`input[type="submit"][name="${solution.answer.name}"]`);
  if (await chosen.count() !== 1) return { status: "interactive_challenge", reason: "U2 识别答案不属于当前题目" };
  await chosen.click();
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  const bodyText = String(await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
  if (/(回答正確|回答正确|簽到成功|签到成功|獎勵UCoin|奖励UCoin|今日已簽到|今天已签到)/i.test(bodyText)) {
    return {
      status: "signed",
      reason: `U2 图片题识别正确：${solution.answer.text}`,
    };
  }
  return { status: "interactive_challenge", reason: "U2 答案已提交，但页面未显示签到成功" };
}

export async function processCandidate(page, target, candidateUrl, config, qaRules) {
  const allowedOrigins = target.allowedOrigins ?? [target.origin];
  const useNewApiCheckin = targetUsesConfiguredOrigins(target, config.newApiCheckinOrigins);
  const useExtendedDiscovery = targetUsesConfiguredOrigins(target, config.extendedDiscoveryOrigins);
  const destination = assertBookmarkNavigation(candidateUrl, allowedOrigins);
  await page.goto(destination, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
  if (useExtendedDiscovery) {
    await waitForExtendedDiscoveryContent(page, config);
  }
  let activeUrl = assertBookmarkNavigation(page.url(), allowedOrigins);
  let activeOrigin = new URL(activeUrl).origin;
  if (activeOrigin === "https://hdsky.me") {
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await sleep(500);
  }
  const leichi = await passLeichiConfirmation(page, config);
  if (leichi && !leichi.passed) {
    return { status: "interactive_challenge", reason: leichi.reason, url: safeLogUrl(page.url()) };
  }
  if (leichi?.passed) {
    await page.waitForLoadState("domcontentloaded", { timeout: config.navigationTimeoutMs }).catch(() => {});
    activeUrl = assertBookmarkNavigation(page.url(), allowedOrigins);
    activeOrigin = new URL(activeUrl).origin;
  }
  const u2Result = await tryU2Captcha(page, activeOrigin, config);
  if (u2Result) return { ...u2Result, url: safeLogUrl(page.url()) };

  await dismissConfiguredPreCheckinOverlay(page, target, activeOrigin, config);
  ({ activeUrl, activeOrigin } = currentAllowedLocation(page, allowedOrigins));
  const hasConfiguredPreCheckinNavigation = Boolean(
    getConfiguredPreCheckinNavigationRule(target, activeOrigin, config),
  );
  const directCheckinAction = hasConfiguredPreCheckinNavigation
    ? await findCheckinAction(page, allowedOrigins)
    : null;
  const preCheckinNavigated = await navigateConfiguredPreCheckinPage(
    page,
    target,
    activeOrigin,
    config,
    { hasCheckinAction: Boolean(directCheckinAction) },
  );
  ({ activeUrl, activeOrigin } = currentAllowedLocation(page, allowedOrigins));
  if (preCheckinNavigated) {
    await dismissConfiguredPreCheckinOverlay(page, target, activeOrigin, config);
    ({ activeUrl, activeOrigin } = currentAllowedLocation(page, allowedOrigins));
  }

  const configuredNewApiResult = await tryConfiguredNewApiCheckin(page, activeOrigin, config);
  let pendingConfiguredNewApiRetry = false;
  if (configuredNewApiResult) {
    const challengeRule = getConfiguredChallengeInteractionRule(target, activeOrigin, config, "after");
    if (shouldUseConfiguredNewApiPageRetry(configuredNewApiResult, challengeRule)) {
      pendingConfiguredNewApiRetry = true;
    } else {
      return { ...configuredNewApiResult, url: safeLogUrl(page.url()) };
    }
  }

  // New API exposes an authoritative current-day status endpoint.  Query it
  // before interpreting generic page copy such as “每日签到可获得奖励”, which is
  // a feature description rather than proof that today's check-in succeeded.
  let initialApiResult = null;
  let pendingNewApiRetry = false;
  if (useNewApiCheckin) {
    initialApiResult = await tryNewApiCheckin(page);
    if (initialApiResult && initialApiResult.status !== "not_available") {
      const challengeRule = getConfiguredChallengeInteractionRule(target, activeOrigin, config, "after");
      if (shouldUseConfiguredNewApiPageRetry(initialApiResult, challengeRule)) {
        pendingNewApiRetry = true;
      } else {
        return { ...initialApiResult, url: safeLogUrl(page.url()) };
      }
    }
    if (initialApiResult?.status === "not_available"
      && (config.knownNoCheckinFeatureOrigins ?? []).includes(activeOrigin)) {
      return { ...initialApiResult, reason: "站点签到接口确认未启用", url: safeLogUrl(page.url()) };
    }
  }
  let state = await runConfiguredChallengePhase(page, target, activeOrigin, config, "before")
    ?? await waitForManagedChallenge(page, config);
  ({ activeUrl, activeOrigin } = currentAllowedLocation(page, allowedOrigins));
  state = await acceptConfiguredTerms(page, state, activeOrigin, config);
  ({ activeUrl, activeOrigin } = currentAllowedLocation(page, allowedOrigins));
  state = await reconcileConfiguredGrowthCheckinPage(page, target, activeUrl, config, state);
  if (["ready", "signed", "already_signed", "unconfirmed"].includes(state.status)) {
    const sequentialResult = await tryConfiguredSequentialActions(page, target, config);
    if (sequentialResult) return { ...sequentialResult, url: safeLogUrl(page.url()) };
  }
  if (state.status !== "ready") return { ...state, url: safeLogUrl(page.url()) };

  const calendarDayResult = await tryCalendarDayCheckin(page, target, activeUrl, config);
  if (calendarDayResult) return { ...calendarDayResult, url: safeLogUrl(page.url()) };

  const hddolbyResult = await tryHddolbyPostRedirectVerification(page, activeOrigin, config);
  if (hddolbyResult) return { ...hddolbyResult, url: safeLogUrl(page.url()) };

  const activeBenefit = await detectActiveQuotaBenefit(page, activeOrigin, config);
  if (activeBenefit) return { ...activeBenefit, url: safeLogUrl(page.url()) };

  const visitRule = (config.visitCheckinRules ?? {})[activeOrigin];
  if (visitRule?.after) {
    const match = String(visitRule.after).match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!match) throw new Error(`访问签到时间配置无效：${activeOrigin}`);
    const current = new Date();
    const currentMinutes = current.getHours() * 60 + current.getMinutes();
    const requiredMinutes = Number(match[1]) * 60 + Number(match[2]);
    if (currentMinutes >= requiredMinutes) {
      return {
        status: "signed",
        reason: `${visitRule.after} 后已登录访问，按站点规则完成签到`,
        url: safeLogUrl(page.url()),
      };
    }
    return {
      status: "deferred",
      reason: `站点要求 ${visitRule.after} 后访问，当前尚未到签到时间`,
      url: safeLogUrl(page.url()),
    };
  }

  const qaResult = await tryQaFlow(page, qaRules, activeOrigin, config);
  if (qaResult) return { ...qaResult, url: safeLogUrl(page.url()) };

  let action = await findCheckinAction(page, allowedOrigins);
  if (!action && useExtendedDiscovery) {
    const discoveryUrls = await findCheckinDiscoveryUrls(page, activeOrigin);
    for (const discoveryUrl of discoveryUrls) {
      if (discoveryUrl === page.url()) continue;
      await page.goto(assertBookmarkNavigation(discoveryUrl, allowedOrigins), { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
      await waitForExtendedDiscoveryContent(page, config);
      activeUrl = assertBookmarkNavigation(page.url(), allowedOrigins);
      activeOrigin = new URL(activeUrl).origin;
      await dismissConfiguredPreCheckinOverlay(page, target, activeOrigin, config);
      ({ activeUrl, activeOrigin } = currentAllowedLocation(page, allowedOrigins));
      state = await waitForManagedChallenge(page, config);
      ({ activeUrl, activeOrigin } = currentAllowedLocation(page, allowedOrigins));
      state = await acceptConfiguredTerms(page, state, activeOrigin, config);
      ({ activeUrl, activeOrigin } = currentAllowedLocation(page, allowedOrigins));
      state = await reconcileConfiguredGrowthCheckinPage(page, target, activeUrl, config, state);
      if (state.status !== "ready") return { ...state, url: safeLogUrl(page.url()) };
      const discoveredCalendarResult = await tryCalendarDayCheckin(page, target, activeUrl, config);
      if (discoveredCalendarResult) return { ...discoveredCalendarResult, url: safeLogUrl(page.url()) };
      action = await findCheckinAction(page, allowedOrigins);
      if (action) break;
    }
  }
  if (action && shouldBlockManualChallengeAction(target, activeOrigin, config, state)) {
    return {
      status: "interactive_challenge",
      reason: "站点签到需要人工完成安全验证",
      action: action.text,
      url: safeLogUrl(page.url()),
    };
  }
  if (!action && (pendingConfiguredNewApiRetry || pendingNewApiRetry)) {
    return {
      status: "needs_attention",
      reason: "签到接口要求验证，但页面未找到唯一签到入口",
      url: safeLogUrl(page.url()),
    };
  }
  if (action) {
    const captchaDialogRule = getConfiguredCheckinCaptchaDialogRule(target, activeOrigin, config);
    await clickCandidate(page, action, { domClick: Boolean(captchaDialogRule) });
    activeUrl = assertBookmarkNavigation(page.url(), allowedOrigins);
    activeOrigin = new URL(activeUrl).origin;
    const captchaDialogResult = await tryConfiguredCheckinCaptchaDialog(page, target, activeOrigin, config);
    if (captchaDialogResult) return { ...captchaDialogResult, action: action.text, url: safeLogUrl(page.url()) };
    const configuredAfterRule = getConfiguredChallengeInteractionRule(target, activeOrigin, config, "after");
    state = await runConfiguredChallengePhase(page, target, activeOrigin, config, "after");
    if (!state) {
      await sleep(config.actionWaitMs);
      state = await waitForManagedChallenge(page, config);
    }
    state = await acceptConfiguredTerms(page, state, activeOrigin, config);
    let retryActionText = null;
    const pendingApiPageRetry = pendingConfiguredNewApiRetry || pendingNewApiRetry;
    if (shouldRetryConfiguredCheckinPageAction(
      pendingApiPageRetry,
      configuredAfterRule,
      state,
    )) {
      let retryAction = await findCheckinAction(page, allowedOrigins, null);
      if (!retryAction) {
        const retryDeadline = Date.now() + configuredAfterRule.retryActionWaitMs;
        do {
          await sleep(Math.max(100, Math.min(1000, Number(config.checkinStatePollMs) || 500)));
          assertBookmarkNavigation(page.url(), allowedOrigins);
          state = await snapshotState(page);
          if ([
            "signed",
            "already_signed",
            "login_required",
            "needs_attention",
            "interactive_challenge",
            "managed_challenge_timeout",
            "deferred",
          ].includes(state.status)) break;
          retryAction = await findCheckinAction(page, allowedOrigins, null);
        } while (!retryAction && Date.now() < retryDeadline);
      }
      if (retryAction) {
        try {
          await clickCandidate(page, retryAction, { domClick: configuredAfterRule.retryDomClick });
        } catch {
          return {
            status: "needs_attention",
            reason: "安全验证完成后的有限签到重试未能提交",
            action: action.text,
            url: safeLogUrl(page.url()),
          };
        }
        retryActionText = retryAction.text;
        activeUrl = assertBookmarkNavigation(page.url(), allowedOrigins);
        activeOrigin = new URL(activeUrl).origin;
        state = await runConfiguredChallengePhase(page, target, activeOrigin, config, "after");
        if (!state) {
          await sleep(config.actionWaitMs);
          state = await waitForManagedChallenge(page, config);
        }
        state = await acceptConfiguredTerms(page, state, activeOrigin, config);
      } else if (shouldRetryConfiguredCheckinPageAction(
        pendingApiPageRetry,
        configuredAfterRule,
        state,
      )) {
        return {
          status: "needs_attention",
          reason: "安全验证完成后未找到唯一签到按钮进行有限重试",
          action: action.text,
          url: safeLogUrl(page.url()),
        };
      }
    }
    state = await confirmConfiguredCheckinAfterWait(
      page,
      allowedOrigins,
      config,
      configuredAfterRule,
      state,
    );
    if (pendingConfiguredNewApiRetry) {
      if (["signed", "already_signed"].includes(state.status)) {
        return { ...state, action: retryActionText ? `${action.text} → ${retryActionText}` : action.text, url: safeLogUrl(page.url()) };
      }
      if (["login_required", "needs_attention", "interactive_challenge", "managed_challenge_timeout", "deferred"].includes(state.status)) {
        return { ...state, action: action.text, url: safeLogUrl(page.url()) };
      }
      const retryConfiguredResult = await tryConfiguredNewApiCheckin(page, activeOrigin, config);
      if (["signed", "already_signed", "login_required", "deferred", "not_available"].includes(retryConfiguredResult?.status)) {
        return { ...retryConfiguredResult, action: retryActionText ? `${action.text} → ${retryActionText}` : action.text, url: safeLogUrl(page.url()) };
      }
      return {
        status: retryConfiguredResult?.status === "interactive_challenge" ? "interactive_challenge" : "needs_attention",
        reason: retryConfiguredResult?.status === "interactive_challenge"
          ? "页面验证完成后，配置化签到接口仍要求人机验证"
          : "页面验证完成后，配置化签到接口未确认今日已签到",
        action: action.text,
        url: safeLogUrl(page.url()),
      };
    }
    if (pendingNewApiRetry) {
      if (["signed", "already_signed"].includes(state.status)) {
        return { ...state, action: retryActionText ? `${action.text} → ${retryActionText}` : action.text, url: safeLogUrl(page.url()) };
      }
      if (["login_required", "needs_attention", "interactive_challenge", "managed_challenge_timeout", "deferred"].includes(state.status)) {
        return { ...state, action: action.text, url: safeLogUrl(page.url()) };
      }
      const retryApiResult = await tryNewApiCheckin(page);
      if (["signed", "already_signed"].includes(retryApiResult?.status)) {
        return { ...retryApiResult, action: retryActionText ? `${action.text} → ${retryActionText}` : action.text, url: safeLogUrl(page.url()) };
      }
      if (retryApiResult?.status === "login_required") {
        return { ...retryApiResult, action: action.text, url: safeLogUrl(page.url()) };
      }
      return {
        status: retryApiResult?.status === "interactive_challenge" ? "interactive_challenge" : "needs_attention",
        reason: retryApiResult?.status === "interactive_challenge"
          ? "页面验证完成后，签到接口仍要求人机验证"
          : "页面验证完成后，签到接口未确认今日已签到",
        action: action.text,
        url: safeLogUrl(page.url()),
      };
    }
    if (["signed", "already_signed", "login_required", "needs_attention", "interactive_challenge", "managed_challenge_timeout", "deferred", "unconfirmed"].includes(state.status)) {
      return { ...state, action: action.text, url: safeLogUrl(page.url()) };
    }
    if (state.status === "ready") {
      const quotaResult = await tryQuotaRequestFlow(page, activeOrigin, config);
      if (quotaResult) return { ...quotaResult, action: `${action.text} → 申请理由`, url: safeLogUrl(page.url()) };
    }

    const openCdResult = await tryOpenCdCaptcha(page, activeOrigin);
    if (openCdResult) return { ...openCdResult, action: action.text, url: safeLogUrl(page.url()) };
    const nexusCaptchaResult = await tryNexusImageCaptcha(page);
    if (nexusCaptchaResult) return { ...nexusCaptchaResult, action: action.text, url: safeLogUrl(page.url()) };

    const afterRule = configuredAfterRule;
    let secondAction = await findCheckinAction(page, allowedOrigins, afterRule?.retryAction ? null : action);
    if (!secondAction && afterRule?.retryAction) {
      const retryDeadline = Date.now() + afterRule.retryActionWaitMs;
      do {
        await sleep(Math.max(100, Math.min(1000, Number(config.checkinStatePollMs) || 500)));
        assertBookmarkNavigation(page.url(), allowedOrigins);
        state = await snapshotState(page);
        if (["signed", "already_signed", "login_required", "needs_attention", "interactive_challenge", "deferred", "unconfirmed"].includes(state.status)) {
          return { ...state, action: action.text, url: safeLogUrl(page.url()) };
        }
        secondAction = await findCheckinAction(page, allowedOrigins, null);
      } while (!secondAction && Date.now() < retryDeadline);
    }
    if (secondAction) {
      await clickCandidate(page, secondAction);
      activeUrl = assertBookmarkNavigation(page.url(), allowedOrigins);
      activeOrigin = new URL(activeUrl).origin;
      state = await runConfiguredChallengePhase(page, target, activeOrigin, config, "after");
      if (!state) {
        await sleep(/转动|轉動/.test(secondAction.text) ? Math.max(config.actionWaitMs, 8000) : config.actionWaitMs);
        state = await waitForManagedChallenge(page, config);
      }
      state = await acceptConfiguredTerms(page, state, activeOrigin, config);
      if (["signed", "already_signed", "login_required", "needs_attention", "interactive_challenge", "managed_challenge_timeout", "deferred", "unconfirmed"].includes(state.status)) {
        return { ...state, action: `${action.text} → ${secondAction.text}`, url: safeLogUrl(page.url()) };
      }
      return {
        status: "clicked",
        reason: "已依次点击明确的签到流程控件",
        action: `${action.text} → ${secondAction.text}`,
        url: safeLogUrl(page.url()),
      };
    }
    if (afterRule) {
      return { status: "needs_attention", reason: "验证完成后页面未确认签到成功", action: action.text, url: safeLogUrl(page.url()) };
    }
    return { status: "clicked", reason: "已点击明确的签到控件", action: action.text, url: safeLogUrl(page.url()) };
  }

  if (/(attendance|check[-_]?in|showup)\.(php|asp)|\/(attendance|check[-_]?in|showup)(?:[/?#]|$)/i.test(activeUrl)) {
    const waitMs = getVisitCheckinWaitMs(config);
    if (waitMs > 0) {
      let confirmation = await waitForConfirmedCheckinState(page, config, waitMs);
      if (["signed", "already_signed"].includes(confirmation.status)) {
        return { ...confirmation, url: safeLogUrl(page.url()) };
      }
      // Open-and-sign pages can update the success text after the initial
      // response. Refresh once before falling through to related candidates.
      await page.reload({ waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs }).catch(() => {});
      await sleep(Math.max(500, Number(config.actionWaitMs) || 0));
      confirmation = await waitForConfirmedCheckinState(page, config, waitMs);
      if (["signed", "already_signed"].includes(confirmation.status)) {
        return { ...confirmation, url: safeLogUrl(page.url()) };
      }
    }
    return { status: "visited", reason: "已访问打开即签到的网址", url: safeLogUrl(page.url()) };
  }

  if (useNewApiCheckin) {
    const apiResult = initialApiResult ?? await tryNewApiCheckin(page);
    if (apiResult) return { ...apiResult, url: safeLogUrl(page.url()) };
  }
  if ((config.knownNoCheckinFeatureOrigins ?? []).includes(activeOrigin)) {
    return { status: "not_available", reason: "站点当前版本未提供签到功能", url: safeLogUrl(page.url()) };
  }
  if (isConfiguredGrowthCheckinPage(target, activeUrl, config)) {
    return { status: "needs_attention", reason: "成长签到页未提供可验证的今日成功状态", url: safeLogUrl(page.url()) };
  }

  return { status: "no_action", reason: "未发现明确签到控件", url: safeLogUrl(page.url()) };
}

async function saveFailureScreenshot(page, logDirectory, target) {
  const host = new URL(target.origin).hostname.replace(/[^a-z0-9.-]/gi, "_");
  const file = path.join(logDirectory, `${host}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

export async function launchAutomationContext(config) {
  const browserExecutable = config.browserExecutable ?? config.chromeExecutable;
  if (!browserExecutable) throw new Error("Browser executable is not configured");
  await fs.access(browserExecutable);
  const disabledFeatures = [
    "Translate",
    "MediaRouter",
    ...(config.disableOptimizationGuideOnDeviceModel === false ? [] : ["OptimizationGuideOnDeviceModel"]),
  ];
  const context = await chromium.launchPersistentContext(config.automationUserDataDir, {
    executablePath: browserExecutable,
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain", "--enable-automation"],
    headless: config.headless,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    viewport: config.headless ? { width: 1365, height: 900 } : null,
    acceptDownloads: false,
    serviceWorkers: "allow",
    args: [
      "--profile-directory=Default",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-component-update",
      "--disable-features=" + disabledFeatures.join(","),
      "--disable-blink-features=AutomationControlled",
      ...(config.backgroundWindowMode === "offscreen" ? ["--window-position=-32000,-32000", "--window-size=1365,900"] : []),
      ...(config.backgroundWindowMode === "visible" ? ["--window-position=80,80", "--window-size=1365,900"] : []),
    ],
  });
  return context;
}

export async function processTarget(context, target, config, qaRules, logDirectory) {
  let lastResult = null;
  const candidateHistory = [];
  const targetTimeoutMs = getTargetTimeoutMs(config);
  const targetDeadline = Date.now() + targetTimeoutMs;
  for (let attempt = 0; attempt <= config.retryCount; attempt += 1) {
    const page = await context.newPage();
    let attemptResult = null;
    try {
      for (const candidateUrl of target.candidates) {
        let result;
        try {
          const remainingMs = targetDeadline - Date.now();
          if (remainingMs <= 0) throw new TargetTimeoutError(targetTimeoutMs);
          result = withRetrySchedule(
            await runWithTargetTimeout(
              () => processCandidate(page, target, candidateUrl, config, qaRules),
              remainingMs,
              () => closePageBounded(page, 1000),
            ),
            config,
          );
        } catch (error) {
          if (error instanceof TargetTimeoutError) {
            result = {
              status: "error",
              reason: `单站处理超过 ${Math.ceil(targetTimeoutMs / 1000)} 秒，已终止并继续后续站点`,
              url: safeLogUrl(page.url()),
            };
            candidateHistory.push(candidateHistoryEntry(candidateUrl, result, attempt + 1));
            return { ...result, attempt: attempt + 1, candidateHistory };
          }
          result = {
            status: "error",
            reason: safeErrorMessage(error),
            url: safeLogUrl(page.url()),
          };
        }
        candidateHistory.push(candidateHistoryEntry(candidateUrl, result, attempt + 1));
        attemptResult = preferCandidateResult(attemptResult, result);
        lastResult = preferCandidateResult(lastResult, result);
        // A logical bookmark target can contain multiple related URLs.  One
        // public/API URL may require login while another dedicated check-in
        // URL already has a valid session, so only a completed result should
        // prevent trying the remaining candidates.
        if (COMPLETED.has(result.status)) break;
      }

      const effectiveResult = preferCandidateResult(lastResult, attemptResult);
      if (effectiveResult && !CHALLENGE.has(effectiveResult.status)
        && (!UNCONFIRMED.has(effectiveResult.status) || attempt === config.retryCount)) {
        if (config.failureScreenshots && !COMPLETED.has(effectiveResult.status) && effectiveResult.status !== "login_required") {
          effectiveResult.screenshot = await saveFailureScreenshot(page, logDirectory, target);
        }
        return { ...effectiveResult, attempt: attempt + 1, candidateHistory };
      }
      if (effectiveResult?.status === "interactive_challenge") {
        if (config.failureScreenshots) effectiveResult.screenshot = await saveFailureScreenshot(page, logDirectory, target);
        return { ...effectiveResult, attempt: attempt + 1, candidateHistory };
      }
      if (effectiveResult && CHALLENGE.has(effectiveResult.status) && attempt === config.retryCount && config.failureScreenshots) {
        effectiveResult.screenshot = await saveFailureScreenshot(page, logDirectory, target);
      }
    } catch (error) {
      const result = { status: "error", reason: safeErrorMessage(error), url: safeLogUrl(page.url()) };
      candidateHistory.push(candidateHistoryEntry(page.url(), result, attempt + 1));
      attemptResult = preferCandidateResult(attemptResult, result);
      lastResult = preferCandidateResult(lastResult, result);
      if (config.failureScreenshots) {
        try { result.screenshot = await saveFailureScreenshot(page, logDirectory, target); } catch { /* 页面可能已经关闭 */ }
      }
    } finally {
      await closePageBounded(page);
    }

    if (attempt < config.retryCount) await sleep(config.retryDelayMs);
  }
  return {
    ...(lastResult ?? { status: "error", reason: "未知错误" }),
    attempt: config.retryCount + 1,
    candidateHistory,
  };
}
