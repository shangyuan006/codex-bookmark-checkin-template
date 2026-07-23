import test from "node:test";
import assert from "node:assert/strict";
import {
  deferUnresolvedLogin,
  isCurrentLocalRunId,
  isRetryEligible,
  nextDeferredRetryAt,
  nextShanghaiTime,
  withRetrySchedule,
} from "../src/retry-policy.mjs";

test("频率限制会获得有界的下次执行时间", () => {
  const now = new Date("2026-07-23T05:00:00Z");
  const result = withRetrySchedule(
    { status: "deferred", retryCause: "rate_limit", reason: "操作过于频繁" },
    { deferredRetryDelayMs: 900000, rateLimitRetryDelayMs: 3600000 },
    now,
  );
  assert.equal(result.nextEligibleAt, "2026-07-23T06:00:00.000Z");
  assert.equal(result.retryCause, "rate_limit");
  assert.equal(isRetryEligible(result, now), false);
  assert.equal(isRetryEligible(result, new Date("2026-07-23T06:00:01Z")), true);
});

test("站点指定的上海时间会转换为准确的下一次时间", () => {
  assert.equal(nextShanghaiTime("08:00", new Date("2026-07-22T23:30:00Z")), "2026-07-23T00:00:00.000Z");
  const result = withRetrySchedule({ status: "deferred", reason: "站点要求 08:00 后访问" }, {}, new Date("2026-07-22T23:30:00Z"));
  assert.equal(result.nextEligibleAt, "2026-07-23T00:00:00.000Z");
});

test("只返回未来最近的延迟重试时间", () => {
  const now = new Date("2026-07-23T05:00:00Z");
  assert.equal(nextDeferredRetryAt([
    { status: "deferred", nextEligibleAt: "2026-07-23T06:00:00Z" },
    { status: "deferred", nextEligibleAt: "2026-07-23T05:20:00Z" },
    { status: "signed" },
  ], now), "2026-07-23T05:20:00.000Z");
});

test("续跑只接受同一上海日期的运行编号", () => {
  const now = new Date("2026-07-22T16:30:00Z");
  assert.equal(isCurrentLocalRunId("20260723-080500", now), true);
  assert.equal(isCurrentLocalRunId("20260722-235959", now), false);
});

test("安全验证可使用独立的低频退避时间", () => {
  const now = new Date("2026-07-23T05:00:00Z");
  const result = withRetrySchedule({
    status: "deferred",
    retryCause: "managed_challenge_timeout",
    reason: "安全验证未自动通过，改为低频重试",
  }, { deferredRetryDelayMs: 3600000 }, now);
  assert.equal(result.nextEligibleAt, "2026-07-23T06:00:00.000Z");
  assert.equal(result.retryCause, "managed_challenge_timeout");
});

test("自动登录恢复仍失败时使用独立的六小时退避时间", () => {
  const now = new Date("2026-07-23T05:00:00Z");
  const result = deferUnresolvedLogin({
    status: "login_required",
    reason: "登录状态失效",
  }, {
    loginRetryDelayMs: 6 * 60 * 60 * 1000,
    deferredRetryDelayMs: 30 * 60 * 1000,
  }, now);

  assert.equal(result.status, "deferred");
  assert.equal(result.retryCause, "login_required");
  assert.equal(result.nextEligibleAt, "2026-07-23T11:00:00.000Z");
  assert.equal(result.reason, "自动登录恢复未成功，已安排低频重试");
});

test("非登录异常不会被登录退避策略改写", () => {
  const result = { status: "interactive_challenge", reason: "需要验证" };
  assert.equal(deferUnresolvedLogin(result, { loginRetryDelayMs: 21600000 }), result);
});
