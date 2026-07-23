import test from "node:test";
import assert from "node:assert/strict";
import { isCurrentLocalRunId, isRetryEligible, nextDeferredRetryAt, nextShanghaiTime, withRetrySchedule } from "../src/retry-policy.mjs";

test("频率限制会获得有界的下次执行时间", () => {
  const now = new Date("2026-07-23T05:00:00Z");
  const result = withRetrySchedule({ status: "deferred", reason: "操作过于频繁" }, { deferredRetryDelayMs: 900000 }, now);
  assert.equal(result.nextEligibleAt, "2026-07-23T05:15:00.000Z");
  assert.equal(isRetryEligible(result, now), false);
  assert.equal(isRetryEligible(result, new Date("2026-07-23T05:15:01Z")), true);
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
