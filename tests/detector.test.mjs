import test from "node:test";
import assert from "node:assert/strict";
import { classifyPageText, formatDailyReason, scoreActionText, solveArithmeticQuestion } from "../src/detector.mjs";

test("识别已签到状态", () => {
  assert.equal(classifyPageText({ title: "用户中心", bodyText: "已签到" }).status, "already_signed");
  assert.equal(classifyPageText({ bodyText: "您今日已签到，请明天再来" }).status, "already_signed");
  assert.equal(classifyPageText({ bodyText: "邀请 [发送]: 0 [已签到] 分享率" }).status, "already_signed");
  assert.equal(classifyPageText({ bodyText: "[查看签到记录] [21点]" }).status, "already_signed");
  assert.equal(classifyPageText({ bodyText: "[查看簽到記錄] [21點]" }).status, "already_signed");
  assert.equal(classifyPageText({ bodyText: "抱歉 您今天已经签到过了，请勿重复刷新。" }).status, "already_signed");
  assert.equal(classifyPageText({ bodyText: "鲸币 [使用]: 154,464.0 (签到已得350)" }).status, "already_signed");
});

test("权威已签到控件优先于公告中的登录注册说明", () => {
  assert.deepEqual(classifyPageText({
    url: "https://example.test/dashboard",
    bodyText: "公告：注册后可以登录使用服务",
    confirmedCheckinControl: true,
  }), {
    status: "already_signed",
    reason: "签到控件确认今日已签到",
  });
});

test("明确未签到与已签到控件冲突时不得判定成功", () => {
  assert.deepEqual(classifyPageText({
    bodyText: "今日未签到",
    confirmedCheckinControl: true,
  }), {
    status: "needs_attention",
    reason: "页面同时显示未签到和已签到控件",
  });
});

test("异步签到状态加载中不得提前判定为无动作", () => {
  assert.deepEqual(classifyPageText({ bodyText: "每日签到 正在加载签到状态... 加载中..." }), {
    status: "unconfirmed",
    reason: "签到状态仍在加载",
  });
  assert.equal(classifyPageText({ bodyText: "签到状态加载中" }).status, "unconfirmed");
});

test("未签到否定文案不得误判为已签到", () => {
  assert.equal(classifyPageText({ bodyText: "今日未签到" }).status, "ready");
  assert.equal(classifyPageText({ bodyText: "尚未完成簽到" }).status, "ready");
  assert.equal(classifyPageText({ bodyText: "Not checked in today" }).status, "ready");
  assert.equal(classifyPageText({ bodyText: "今日未签到 26 已签到" }).status, "ready");
  assert.equal(classifyPageText({ bodyText: "今日未签到 26 [已签到]" }).status, "ready");
  assert.equal(classifyPageText({ bodyText: "今日未签到，页面说明：签到成功后可获得积分" }).status, "ready");
  assert.equal(classifyPageText({ bodyText: "今日未签到，历史记录：昨日签到成功" }).status, "ready");
});

test("识别签到成功状态", () => {
  assert.equal(classifyPageText({ bodyText: "签到成功，获得 10 积分" }).status, "signed");
  assert.equal(classifyPageText({ bodyText: "这是您的第159次签到，本次签到获得800个憨豆。" }).status, "signed");
  assert.equal(classifyPageText({ bodyText: "回答正确，签到奖励已发放。" }).status, "signed");
  assert.equal(classifyPageText({ bodyText: "申请额度成功，额度已发放。" }).status, "signed");
  assert.equal(classifyPageText({ bodyText: "额度申请已提交，请稍后查看。" }).status, "signed");
  assert.equal(classifyPageText({ bodyText: "领取 Codex 权益成功" }).status, "signed");
  assert.equal(classifyPageText({ bodyText: "Codex 权益已领取" }).status, "already_signed");
});

test("带图片验证码的登录页仍识别为登录失效", () => {
  const result = classifyPageText({ url: "https://example.test/login", challengeSelectors: true, hasPassword: true });
  assert.equal(result.status, "login_required");
  assert.match(result.reason, /验证码/);
});

test("说明文字不被误判为当前人机挑战", () => {
  assert.equal(classifyPageText({ bodyText: "每日签到 完成人机验证即可领取奖励" }).status, "ready");
});

test("签到功能说明和历史入口不被误判为已完成", () => {
  assert.equal(classifyPageText({ bodyText: "每日签到可获得随机额度奖励" }).status, "ready");
  assert.equal(classifyPageText({ bodyText: "查看签到记录" }).status, "ready");
  assert.equal(classifyPageText({ bodyText: "签到说明：已签到用户可获得额外积分" }).status, "ready");
  assert.equal(classifyPageText({ bodyText: "历史记录：昨日已签到" }).status, "ready");
});

test("识别 Linux DO 登录入口", () => {
  assert.equal(classifyPageText({ bodyText: "使用 Linux DO 登录" }).status, "login_required");
});

test("可见的 Cloudflare 复选框优先识别为交互挑战", () => {
  assert.equal(classifyPageText({ bodyText: "正在进行安全验证 请验证您是真人" }).status, "interactive_challenge");
});

test("滑块验证提示识别为交互挑战", () => {
  assert.equal(classifyPageText({ bodyText: "请拖动滑块验证" }).status, "interactive_challenge");
  assert.equal(classifyPageText({ bodyText: "Drag the slider to continue" }).status, "interactive_challenge");
  assert.equal(classifyPageText({ bodyText: "请先进行验证" }).status, "ready");
  assert.equal(classifyPageText({
    bodyText: "请先进行验证",
    challengeSelectors: true,
  }).status, "interactive_challenge");
});

test("已解决的验证控件不会因残留提示文案再次阻止签到", () => {
  assert.equal(classifyPageText({
    bodyText: "请先进行验证 今日未签到",
    resolvedChallengeSelectors: true,
  }).status, "ready");
  assert.equal(classifyPageText({
    bodyText: "请先进行验证 今日未签到",
    challengeSelectors: true,
    resolvedChallengeSelectors: true,
  }).status, "interactive_challenge");
});

test("无复选框的托管验证继续等待", () => {
  assert.equal(classifyPageText({ bodyText: "Just a moment... 正在验证您是否是真人" }).status, "managed_challenge");
});

test("识别带连字符的登录路径", () => {
  assert.equal(classifyPageText({ url: "https://example.test/sign-in?redirect=%2Fconsole" }).status, "login_required");
});

test("识别站点频率限制并延后处理", () => {
  const result = classifyPageText({ bodyText: "操作过于频繁，请稍后再试" });
  assert.equal(result.status, "deferred");
  assert.equal(result.retryCause, "rate_limit");
});

test("额度申请理由按上海日期生成唯一文案", () => {
  assert.equal(formatDailyReason("{date} 用于开发测试", new Date("2026-07-23T00:30:00Z")), "2026年7月23日 用于开发测试");
});

test("识别公开首页的登录注册入口", () => {
  assert.equal(classifyPageText({ bodyText: "首页 控制台 登录 注册 获取密钥" }).status, "login_required");
});

test("只选择明确的签到动作", () => {
  assert.ok(scoreActionText("立即签到") > 0);
  assert.ok(scoreActionText("[签到]") > 0);
  assert.ok(scoreActionText("福利站") > 0);
  assert.ok(scoreActionText("开始转动") > 0);
  assert.ok(scoreActionText("申请额度") > 0);
  assert.ok(scoreActionText("领取 Codex 权益") > 0);
  assert.ok(scoreActionText("領取Codex權益") > 0);
  assert.equal(scoreActionText("签到记录"), -1);
  assert.equal(scoreActionText("购买"), -1);
});

test("只计算简单安全整数算式", () => {
  assert.equal(solveArithmeticQuestion("请回答 12 × 3"), "36");
  assert.equal(solveArithmeticQuestion("10 / 4"), null);
  assert.equal(solveArithmeticQuestion("没有算式"), null);
});
