import test from "node:test";
import assert from "node:assert/strict";
import {
  CHALLENGE_SELECTOR,
  assertCalendarDayCheckinLocation,
  candidateHistoryEntry,
  challengeEvidenceIsUnresolved,
  classifyCalendarDayCheckinEvidence,
  getConfiguredChallengeInteractionRule,
  getConfiguredCheckinCaptchaDialogRule,
  getConfiguredPreCheckinDismissRule,
  getVisitCheckinWaitMs,
  getTargetTimeoutMs,
  classifyConfiguredGrowthCheckinEvidence,
  configuredCaptchaImageIsReady,
  dismissConfiguredPreCheckinOverlay,
  extractSingleChoiceQuestion,
  getCheckinConfirmationWaitMs,
  isConfiguredGrowthCheckinPage,
  isSafeDiscoveredHref,
  matchesConfiguredGrowthCompletedControlText,
  preferCandidateResult,
  reconcileConfiguredGrowthCheckinState,
  selectSliderDragGeometry,
  runWithTargetTimeout,
  shouldBlockManualChallengeAction,
  TargetTimeoutError,
  targetNeedsManualChallenge,
  targetUsesCalendarDayCheckin,
  waitForConfirmedCheckinState,
  waitForPendingCheckinState,
} from "../src/browser.mjs";

test("签到入口发现拒绝被浏览器解析成同源路径的畸形 href", () => {
  assert.equal(isSafeDiscoveredHref("/profile"), true);
  assert.equal(isSafeDiscoveredHref("/check-in?day=2026-08-08"), true);
  assert.equal(isSafeDiscoveredHref('"'), false);
  assert.equal(isSafeDiscoveredHref("/%22"), false);
  assert.equal(isSafeDiscoveredHref("%3Cscript%3E"), false);
  assert.equal(isSafeDiscoveredHref("/%"), false);
});

test("单选题必须包含位于选项之前的真实题干", () => {
  assert.equal(extractSingleChoiceQuestion(
    "你通常多久查看一次？ 经常看 偶尔看 不看 弃权",
    ["经常看", "偶尔看", "不看", "弃权"],
  ), "你通常多久查看一次？");
  assert.equal(extractSingleChoiceQuestion(
    "经常看 偶尔看 不看 弃权",
    ["经常看", "偶尔看", "不看", "弃权"],
  ), null);
});

test("打开即签到页面使用有界的成功确认等待", () => {
  assert.equal(getVisitCheckinWaitMs({}), 15000);
  assert.equal(getVisitCheckinWaitMs({ visitCheckinWaitMs: 5000 }), 5000);
  assert.equal(getVisitCheckinWaitMs({ visitCheckinWaitMs: 90000 }), 60000);
});

test("单站超时会取消阻塞操作而不等待页面自行恢复", async () => {
  let cancelled = false;
  await assert.rejects(
    runWithTargetTimeout(
      () => new Promise(() => {}),
      10,
      () => { cancelled = true; },
    ),
    TargetTimeoutError,
  );
  assert.equal(cancelled, true);
});

test("单站超时配置保留 Cloudflare 等待余量并限制错误值", () => {
  assert.equal(getTargetTimeoutMs({}), 180_000);
  assert.equal(getTargetTimeoutMs({ targetTimeoutMs: 1 }), 30_000);
  assert.equal(getTargetTimeoutMs({ targetTimeoutMs: 999_999_999 }), 600_000);
});

test("签到前公告关闭规则只作用于当前书签允许来源", () => {
  const target = {
    origin: "https://bookmark.test",
    allowedOrigins: ["https://bookmark.test", "https://related.test"],
  };
  const config = {
    preCheckinDismissRules: {
      "https://related.test": {
        buttonTexts: [" 关闭公告 ", "关闭公告"],
        selectors: ["button[aria-label=Close]"],
        waitMs: 50_000,
      },
    },
  };
  assert.deepEqual(getConfiguredPreCheckinDismissRule(target, "https://related.test", config), {
    buttonTexts: ["关闭公告"],
    selectors: ["button[aria-label=Close]"],
    waitMs: 10_000,
    maxDismissals: 3,
  });
  assert.equal(getConfiguredPreCheckinDismissRule(target, "https://outside.test", config), null);
  assert.throws(() => getConfiguredPreCheckinDismissRule(target, "https://related.test", {
    preCheckinDismissRules: { "https://related.test": {} },
  }), /缺少按钮文本或选择器/);
});

test("签到前公告关闭规则可有界处理复用同一关闭控件的连续公告", async () => {
  let remaining = 2;
  const candidate = {
    isVisible: async () => remaining > 0,
    click: async () => { remaining -= 1; },
  };
  const locator = {
    count: async () => remaining > 0 ? 1 : 0,
    nth: () => candidate,
  };
  const page = {
    locator: () => locator,
    getByRole: () => ({ count: async () => 0, nth: () => candidate }),
  };
  const target = { origin: "https://bookmark.test", allowedOrigins: ["https://bookmark.test"] };
  const config = {
    actionWaitMs: 1,
    preCheckinDismissRules: {
      "https://bookmark.test": {
        selectors: ["button.close"],
        waitMs: 1,
        maxDismissals: 3,
      },
    },
  };
  assert.equal(await dismissConfiguredPreCheckinOverlay(
    page,
    target,
    "https://bookmark.test",
    config,
  ), true);
  assert.equal(remaining, 0);
});

test("候选弱结果不会覆盖登录、挑战或延迟状态", () => {
  for (const status of ["login_required", "interactive_challenge", "managed_challenge_timeout", "deferred"]) {
    const valuable = { status, reason: "actionable" };
    assert.equal(preferCandidateResult(valuable, { status: "no_action" }), valuable);
    assert.equal(preferCandidateResult(valuable, { status: "error" }), valuable);
  }
});

test("候选完成状态会覆盖此前异常状态", () => {
  const completed = { status: "signed", reason: "done" };
  assert.equal(preferCandidateResult({ status: "login_required" }, completed), completed);
});

test("候选历史会脱敏网址和错误原因", () => {
  const entry = candidateHistoryEntry(
    "https://example.test/checkin?token=secret-value&day=2026-07-23",
    {
      status: "error",
      reason: "authorization=private-value https://example.test/error?code=secret-code",
    },
    2,
  );
  const serialized = JSON.stringify(entry);
  assert.equal(entry.attempt, 2);
  assert.equal(entry.status, "error");
  assert.doesNotMatch(serialized, /secret-value|private-value|secret-code|2026-07-23/);
  assert.match(decodeURIComponent(entry.candidateUrl), /token=\[REDACTED\]/);
  assert.match(decodeURIComponent(entry.candidateUrl), /day=\[VALUE\]/);
});

test("通用安全验证选择器覆盖 Cap.js", () => {
  assert.match(CHALLENGE_SELECTOR, /cap-widget/);
  assert.match(CHALLENGE_SELECTOR, /data-cap-api-endpoint/);
  assert.match(CHALLENGE_SELECTOR, /altcha-widget/);
});

test("验证控件保留在页面时只把未解决证据视为挑战", () => {
  assert.equal(challengeEvidenceIsUnresolved({ visible: true }), true);
  assert.equal(challengeEvidenceIsUnresolved({ visible: true, challengeLike: false }), false);
  assert.equal(challengeEvidenceIsUnresolved({ visible: true, resolvedState: true }), false);
  assert.equal(challengeEvidenceIsUnresolved({ visible: true, responsePresent: true }), false);
  assert.equal(challengeEvidenceIsUnresolved({ visible: false }), false);
});

test("验证交互规则严格限制当前书签来源和执行阶段", () => {
  const target = { origin: "https://bookmark.test", allowedOrigins: ["https://bookmark.test"] };
  const config = {
    challengeInteractionRules: {
      "https://bookmark.test": { type: "click", phase: "before", waitMs: 90_000 },
      "https://outside.test": { type: "wait", phase: "after" },
    },
  };
  assert.deepEqual(getConfiguredChallengeInteractionRule(target, "https://bookmark.test", config, "before"), {
    type: "click",
    phase: "before",
    waitMs: 60_000,
    settleMs: 3000,
    retryAction: false,
    retryActionWaitMs: 0,
  });
  assert.deepEqual(getConfiguredChallengeInteractionRule(target, "https://bookmark.test", {
    challengeInteractionRules: {
      "https://bookmark.test": {
        type: "wait",
        phase: "after",
        retryAction: true,
        retryActionWaitMs: 90_000,
      },
    },
  }, "after"), {
    type: "wait",
    phase: "after",
    waitMs: 30_000,
    settleMs: 3000,
    retryAction: true,
    retryActionWaitMs: 20_000,
  });
  assert.equal(getConfiguredChallengeInteractionRule(target, "https://bookmark.test", config, "after"), null);
  assert.equal(getConfiguredChallengeInteractionRule(target, "https://outside.test", config), null);
  assert.throws(() => getConfiguredChallengeInteractionRule(target, "https://bookmark.test", {
    challengeInteractionRules: { "https://bookmark.test": { type: "unknown" } },
  }), /类型无效/);
});

test("签到图片验证码规则严格限制当前书签来源并验证结构", () => {
  const target = { origin: "https://bookmark.test", allowedOrigins: ["https://bookmark.test"] };
  const config = {
    checkinCaptchaDialogRules: {
      "https://bookmark.test": {
        dialogSelector: ".modal",
        imageSelector: "img.captcha",
        inputSelector: "input[name=code]",
        confirmTexts: [" 确认 ", "确认"],
        refreshTexts: [" 刷新 ", "刷新"],
        minLength: 4,
        maxLength: 6,
        minConfidence: 40,
        waitMs: 20_000,
        maxAttempts: 8,
      },
    },
  };
  assert.deepEqual(getConfiguredCheckinCaptchaDialogRule(target, "https://bookmark.test", config), {
    dialogSelector: ".modal",
    imageSelector: "img.captcha",
    inputSelector: "input[name=code]",
    confirmTexts: ["确认"],
    refreshTexts: ["刷新"],
    minLength: 4,
    maxLength: 6,
    minImageWidth: 40,
    minImageHeight: 20,
    minConfidence: 40,
    waitMs: 10_000,
    maxAttempts: 3,
  });
  assert.equal(getConfiguredCheckinCaptchaDialogRule(target, "https://outside.test", config), null);
  assert.throws(() => getConfiguredCheckinCaptchaDialogRule(target, "https://bookmark.test", {
    checkinCaptchaDialogRules: { "https://bookmark.test": {} },
  }), /缺少选择器/);
});

test("签到验证码只截取加载完成且达到稳定尺寸的图像", () => {
  const rule = { minImageWidth: 40, minImageHeight: 20 };
  assert.equal(configuredCaptchaImageIsReady({
    width: 2,
    height: 36,
    isImage: true,
    complete: true,
    naturalWidth: 120,
    naturalHeight: 36,
  }, rule), false);
  assert.equal(configuredCaptchaImageIsReady({
    width: 120,
    height: 36,
    isImage: true,
    complete: true,
    naturalWidth: 120,
    naturalHeight: 36,
  }, rule), true);
});

test("签到确认等待保留站点验证余量并限制异常配置", () => {
  assert.equal(getCheckinConfirmationWaitMs(20_000), 20_000);
  assert.equal(getCheckinConfirmationWaitMs(999_999), 60_000);
  assert.equal(getCheckinConfirmationWaitMs(1), 10);
});

test("滑块拖动只接受唯一轨道和唯一指针滑块", () => {
  const geometry = selectSliderDragGeometry([
    { index: 0, x: 10, y: 20, width: 304, height: 37, parentCandidateIndex: -1, hasPointerChild: true },
    { index: 1, x: 12, y: 22, width: 300, height: 33, parentCandidateIndex: 0 },
    { index: 2, x: 12, y: 22, width: 40, height: 33, parentCandidateIndex: 0, pointerCursor: true },
  ]);
  assert.deepEqual(geometry, { startX: 32, startY: 38.5, endX: 292, endY: 38.5 });
  assert.equal(selectSliderDragGeometry([
    { index: 0, x: 0, y: 0, width: 300, height: 40, parentCandidateIndex: -1, hasPointerChild: true },
  ]), null);
});

function checkinStatePage(bodyTexts) {
  let index = 0;
  return {
    url: () => "https://checkin.test/dashboard",
    title: async () => "用户中心",
    evaluate: async () => ({
      bodyText: bodyTexts[Math.min(index++, bodyTexts.length - 1)],
      passwordInputs: false,
      challengeSelectors: false,
    }),
  };
}

test("异步签到状态完成加载后重新判定页面", async () => {
  const state = await waitForPendingCheckinState(checkinStatePage([
    "每日签到 正在加载签到状态... 加载中...",
    "每日签到 今日已签到",
  ]), { checkinStateWaitMs: 100, checkinStatePollMs: 5 });
  assert.deepEqual(state, { status: "already_signed", reason: "今天已经签到" });
});

test("异步签到状态超过有限等待时保持未确认", async () => {
  const state = await waitForPendingCheckinState(checkinStatePage([
    "每日签到 正在加载签到状态... 加载中...",
  ]), { checkinStateWaitMs: 10, checkinStatePollMs: 5 });
  assert.deepEqual(state, { status: "unconfirmed", reason: "签到状态在有限等待内未加载完成" });
});

test("验证码弹窗提交后等待完成控件异步更新", async () => {
  const state = await waitForConfirmedCheckinState(checkinStatePage([
    "每日签到 立即签到",
    "每日签到 处理中",
    "每日签到 今日已签到",
  ]), { checkinStatePollMs: 5 }, 100);
  assert.deepEqual(state, { status: "already_signed", reason: "今天已经签到" });
});

test("验证码弹窗提交后有限等待不把普通页面误报成功", async () => {
  const state = await waitForConfirmedCheckinState(checkinStatePage([
    "每日签到 立即签到",
  ]), { checkinStatePollMs: 5 }, 10);
  assert.equal(state.status, "ready");
});

test("本机人工验证规则只作用于当前页面来源", () => {
  const target = {
    origin: "https://bookmark.test",
    allowedOrigins: ["https://bookmark.test", "https://related.test"],
  };
  const config = {
    manualChallengeOrigins: ["https://related.test"],
  };
  assert.equal(targetNeedsManualChallenge(target, "https://related.test", config), true);
  assert.equal(targetNeedsManualChallenge(target, "https://bookmark.test", config), false);
  assert.equal(targetNeedsManualChallenge(target, "https://other.test", config), false);
  assert.equal(shouldBlockManualChallengeAction(target, "https://related.test", config, {
    unresolvedChallenge: true,
  }), true);
  assert.equal(shouldBlockManualChallengeAction(target, "https://related.test", config, {
    unresolvedChallenge: false,
  }), false);
});

test("日历日期签到规则同时限定当前页面来源和精确路径", () => {
  const target = {
    origin: "https://bookmark.test",
    allowedOrigins: ["https://bookmark.test", "https://related.test"],
  };
  const config = {
    calendarDayCheckinOrigins: ["https://related.test"],
    calendarDayCheckinPaths: { "https://related.test": ["/user/attendance"] },
  };
  assert.equal(targetUsesCalendarDayCheckin(target, "https://related.test/user/attendance", config), true);
  assert.equal(targetUsesCalendarDayCheckin(target, "https://related.test/user/attendance/", config), true);
  assert.equal(targetUsesCalendarDayCheckin(target, "https://related.test/dashboard", config), false);
  assert.equal(targetUsesCalendarDayCheckin(target, "https://bookmark.test/user/attendance", config), false);
  assert.equal(targetUsesCalendarDayCheckin(target, "https://other.test/user/attendance", config), false);
  assert.equal(targetUsesCalendarDayCheckin(target, "https://related.test/user/attendance/history", config), false);
  assert.equal(targetUsesCalendarDayCheckin(target, "https://related.test/user/attendance", {
    calendarDayCheckinOrigins: ["https://related.test"],
  }), true);
  assert.equal(targetUsesCalendarDayCheckin(target, "https://related.test/user/attendance", {}), false);
});

test("日历日期签到在导航后重新拒绝非配置来源或路径", () => {
  const target = {
    origin: "https://bookmark.test",
    allowedOrigins: ["https://bookmark.test", "https://related.test"],
  };
  const config = {
    calendarDayCheckinOrigins: ["https://related.test"],
    calendarDayCheckinPaths: { "https://related.test": ["/user/attendance"] },
  };
  assert.equal(assertCalendarDayCheckinLocation(
    target,
    "https://related.test/user/attendance",
    config,
  ), "https://related.test/user/attendance");
  assert.throws(() => assertCalendarDayCheckinLocation(
    target,
    "https://related.test/dashboard",
    config,
  ), /配置的来源或精确路径/);
  assert.throws(() => assertCalendarDayCheckinLocation(
    target,
    "https://outside.test/user/attendance",
    config,
  ), /跨站|not allowed|不允许/i);
});

test("日历日期签到证据只在刷新后持久确认成功", () => {
  assert.deepEqual(classifyCalendarDayCheckinEvidence({
    explicitTodayUnsigned: true,
    currentDateCellUnsignedCount: 0,
    explicitSuccess: false,
    buttonCount: 1,
    currentDateEvidenceCount: 1,
    enabledCurrentDateButtonCount: 1,
    disabledCurrentDateButtonCount: 0,
  }), { status: "ready", reason: "日历签到页找到唯一可点击的当天日期" });
  assert.deepEqual(classifyCalendarDayCheckinEvidence({
    explicitTodayUnsigned: false,
    currentDateCellUnsignedCount: 0,
    explicitSuccess: true,
    buttonCount: 1,
    currentDateEvidenceCount: 1,
    enabledCurrentDateButtonCount: 0,
    disabledCurrentDateButtonCount: 1,
  }, { afterClick: true }), { status: "signed", reason: "点击当天日期后刷新确认签到成功" });
  assert.deepEqual(classifyCalendarDayCheckinEvidence({
    explicitTodayUnsigned: true,
    currentDateCellUnsignedCount: 0,
    explicitSuccess: true,
    buttonCount: 1,
    currentDateEvidenceCount: 1,
    enabledCurrentDateButtonCount: 0,
    disabledCurrentDateButtonCount: 1,
  }, { afterClick: true }), { status: "needs_attention", reason: "点击当天日期后未获得持久化签到确认" });
  assert.deepEqual(classifyCalendarDayCheckinEvidence({
    explicitTodayUnsigned: false,
    currentDateCellUnsignedCount: 0,
    currentDateCellSignedCount: 1,
    explicitSuccess: false,
    buttonCount: 1,
    currentDateEvidenceCount: 1,
    enabledCurrentDateButtonCount: 1,
    disabledCurrentDateButtonCount: 0,
  }, { afterClick: true }), { status: "signed", reason: "点击当天日期后刷新确认签到成功" });
});

test("配置的日历页缺少当天按钮时失败关闭", () => {
  assert.deepEqual(classifyCalendarDayCheckinEvidence({
    explicitTodayUnsigned: true,
    currentDateCellUnsignedCount: 0,
    explicitSuccess: false,
    buttonCount: 0,
    currentDateEvidenceCount: 0,
    enabledCurrentDateButtonCount: 0,
    disabledCurrentDateButtonCount: 0,
  }), { status: "needs_attention", reason: "日历签到页未找到当天日期按钮" });
});

test("日历页拒绝其他月份日号和历史未签到文案", () => {
  assert.deepEqual(classifyCalendarDayCheckinEvidence({
    explicitTodayUnsigned: false,
    currentDateCellUnsignedCount: 0,
    historicalUnsigned: true,
    explicitSuccess: false,
    buttonCount: 1,
    currentDateEvidenceCount: 0,
    enabledCurrentDateButtonCount: 0,
    disabledCurrentDateButtonCount: 0,
  }), { status: "needs_attention", reason: "日历签到页未找到可证明属于今天的唯一日期按钮" });
  assert.deepEqual(classifyCalendarDayCheckinEvidence({
    explicitTodayUnsigned: false,
    currentDateCellUnsignedCount: 0,
    historicalUnsigned: true,
    explicitSuccess: false,
    buttonCount: 1,
    currentDateEvidenceCount: 1,
    enabledCurrentDateButtonCount: 1,
    disabledCurrentDateButtonCount: 0,
  }), { status: "needs_attention", reason: "日历签到页缺少明确的今日未签到证据" });
  assert.deepEqual(classifyCalendarDayCheckinEvidence({
    explicitTodayUnsigned: false,
    currentDateCellUnsignedCount: 1,
    historicalUnsigned: true,
    explicitSuccess: false,
    buttonCount: 1,
    currentDateEvidenceCount: 1,
    enabledCurrentDateButtonCount: 1,
    disabledCurrentDateButtonCount: 0,
  }), { status: "ready", reason: "日历签到页找到唯一可点击的当天日期" });
});

test("成长签到页规则同时限定配置来源和 checkIn 哈希路由", () => {
  const target = {
    origin: "https://bookmark.test",
    allowedOrigins: ["https://bookmark.test", "https://growth.test"],
  };
  const config = { manualChallengeOrigins: ["https://growth.test"] };
  assert.equal(isConfiguredGrowthCheckinPage(
    target,
    "https://growth.test/#/user/growth?tab=checkIn",
    config,
  ), true);
  assert.equal(isConfiguredGrowthCheckinPage(
    target,
    "https://growth.test/#/user/growth?tab=history",
    config,
  ), false);
  assert.equal(isConfiguredGrowthCheckinPage(
    target,
    "https://bookmark.test/#/user/growth?tab=checkIn",
    config,
  ), false);
  assert.equal(isConfiguredGrowthCheckinPage(
    target,
    "https://growth.test/user/attendance",
    config,
  ), false);
});

test("成长签到页只接受完成控件或当日成功记录作为已签到证据", () => {
  const target = { origin: "https://growth.test", allowedOrigins: ["https://growth.test"] };
  const config = { manualChallengeOrigins: ["https://growth.test"] };
  const activeUrl = "https://growth.test/#/user/growth?tab=checkIn";
  assert.deepEqual(classifyConfiguredGrowthCheckinEvidence(target, activeUrl, config, {
    explicitlyUnsigned: false,
    completedControlCount: 1,
    todaySuccessfulRecordCount: 0,
  }), { status: "already_signed", reason: "成长签到页确认今日已签到" });
  assert.deepEqual(classifyConfiguredGrowthCheckinEvidence(target, activeUrl, config, {
    explicitlyUnsigned: false,
    completedControlCount: 0,
    todaySuccessfulRecordCount: 1,
  }), { status: "already_signed", reason: "成长签到页确认今日已签到" });
  assert.equal(classifyConfiguredGrowthCheckinEvidence(target, activeUrl, config, {
    explicitlyUnsigned: false,
    completedControlCount: 0,
    todaySuccessfulRecordCount: 0,
  }), null);
});

test("成长签到页接受禁用控件使用的明日继续完成文案", () => {
  assert.equal(matchesConfiguredGrowthCompletedControlText("已签到，明日继续"), true);
  assert.equal(matchesConfiguredGrowthCompletedControlText("已签到 明天继续"), true);
  assert.equal(matchesConfiguredGrowthCompletedControlText("已签到"), true);
  assert.equal(matchesConfiguredGrowthCompletedControlText("立即签到"), false);
  assert.equal(matchesConfiguredGrowthCompletedControlText("昨日已签到"), false);
});

test("成长签到页的未签到文案与成功证据冲突时不得判成功", () => {
  const target = { origin: "https://growth.test", allowedOrigins: ["https://growth.test"] };
  const config = { manualChallengeOrigins: ["https://growth.test"] };
  const activeUrl = "https://growth.test/#/user/growth?tab=checkIn";
  assert.deepEqual(classifyConfiguredGrowthCheckinEvidence(target, activeUrl, config, {
    explicitlyUnsigned: true,
    completedControlCount: 0,
    todaySuccessfulRecordCount: 1,
  }), { status: "needs_attention", reason: "成长签到页同时显示未签到和成功证据" });
});

test("成长签到页不会把缺少今日证据的通用成功文案沿用为结果", () => {
  const target = { origin: "https://growth.test", allowedOrigins: ["https://growth.test"] };
  const config = { manualChallengeOrigins: ["https://growth.test"] };
  const activeUrl = "https://growth.test/#/user/growth?tab=checkIn";
  assert.deepEqual(reconcileConfiguredGrowthCheckinState(
    target,
    activeUrl,
    config,
    { status: "signed", reason: "页面显示签到成功" },
    { explicitlyUnsigned: false, completedControlCount: 0, todaySuccessfulRecordCount: 0 },
  ), { status: "ready", reason: "成长签到页的通用成功文案缺少今日证据" });
  assert.deepEqual(reconcileConfiguredGrowthCheckinState(
    target,
    activeUrl,
    config,
    { status: "signed", reason: "页面显示签到成功" },
    { explicitlyUnsigned: false, completedControlCount: 0, todaySuccessfulRecordCount: 1 },
  ), { status: "already_signed", reason: "成长签到页确认今日已签到" });
});

test("成长签到证据不会影响 SunnyPT 日历页面", () => {
  const target = { origin: "https://calendar.test", allowedOrigins: ["https://calendar.test"] };
  const config = {
    manualChallengeOrigins: ["https://calendar.test"],
    calendarDayCheckinOrigins: ["https://calendar.test"],
  };
  assert.equal(classifyConfiguredGrowthCheckinEvidence(
    target,
    "https://calendar.test/user/attendance",
    config,
    { completedControlCount: 1, todaySuccessfulRecordCount: 1 },
  ), null);
});
