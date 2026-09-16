import test from "node:test";
import assert from "node:assert/strict";
import {
  applyUpstreamGroupCircuitBreakers,
  advanceAttemptedDeferredRetries,
  advanceDeferredRetry,
  deferUnresolvedLogin,
  isCurrentLocalRunId,
  isRetryEligible,
  recoveryEntriesForResults,
  isResumeRetryEligible,
  nextDeferredRetryAt,
  nextShanghaiTime,
  withRetrySchedule,
} from "../src/retry-policy.mjs";

test("原生成功结果提前插入后，复查仍按来源匹配并替换原结果", () => {
  const targets = ['a', 'b', 'c', 'd'].map(name => ({origin:`https://${name}.example`}));
  const results = [
    {...targets[3], status:'signed'},
    {...targets[0], status:'signed'},
    {...targets[1], status:'login_required'},
    {...targets[2], status:'interactive_challenge'},
  ];
  const entries = recoveryEntriesForResults(results, targets);
  assert.deepEqual(entries.map(({resultIndex,target}) => [resultIndex,target.origin]), [
    [2,targets[1].origin], [3,targets[2].origin],
  ]);
  for (const {resultIndex,target} of entries) results[resultIndex] = {...target,status:'signed'};
  assert.equal(new Set(results.map(result => result.origin)).size,4);
  assert.ok(results.every(result => result.status === 'signed'));
  assert.deepEqual(recoveryEntriesForResults(results,targets),[]);
  assert.throws(() => recoveryEntriesForResults([{origin:'https://unknown.example',status:'login_required'}],targets),/no matching selected target/);
});

test("续跑只为配置了重认证的 needs_attention 站点放行", () => {
  const result = { origin: "https://reauth.test", status: "needs_attention" };
  assert.equal(isRetryEligible(result), false);
  assert.equal(isResumeRetryEligible(result, new Set(["https://reauth.test"])), true);
  assert.equal(isResumeRetryEligible(result, new Set(["https://other.test"])), false);
});

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

test("同站限频使用指数退避并在达到上限后转到次日", () => {
  const config = {
    schedule: "08:05",
    rateLimitRetryDelayMs: 3600000,
    rateLimitMaxDelayMs: 21600000,
    rateLimitMaxDailyAttempts: 3,
  };
  const now = new Date("2026-07-23T12:00:00Z");
  const first = advanceDeferredRetry({ status: "deferred", retryCause: "rate_limit" }, null, config, now);
  const second = advanceDeferredRetry({ status: "deferred", retryCause: "rate_limit" }, first, config, now);
  const third = advanceDeferredRetry({ status: "deferred", retryCause: "rate_limit" }, second, config, now);
  assert.equal(first.nextEligibleAt, "2026-07-23T13:00:00.000Z");
  assert.equal(second.nextEligibleAt, "2026-07-23T14:00:00.000Z");
  assert.equal(third.nextEligibleAt, "2026-07-24T00:05:00.000Z");
  assert.equal(third.retryExhaustedForDay, true);
});

test("上游站点上午达到探测上限后保留一次晚间恢复机会", () => {
  const config = {
    upstreamUnavailableMaxDailyAttempts: 3,
    upstreamUnavailableLateRetryTime: "21:05",
    schedule: "08:05",
  };
  const morning = new Date("2026-07-23T02:00:00Z");
  const first = advanceDeferredRetry({ status: "deferred", retryCause: "upstream_unavailable" }, null, config, morning);
  const second = advanceDeferredRetry({ status: "deferred", retryCause: "upstream_unavailable" }, first, config, morning);
  const late = advanceDeferredRetry({ status: "deferred", retryCause: "upstream_unavailable" }, second, config, morning);
  const exhausted = advanceDeferredRetry(
    { status: "deferred", retryCause: "upstream_unavailable" },
    late,
    config,
    new Date("2026-07-23T13:05:00Z"),
  );
  assert.equal(late.retrySequence, 3);
  assert.equal(late.lateRetryPending, true);
  assert.equal(late.retryExhaustedForDay, false);
  assert.equal(late.nextEligibleAt, "2026-07-23T13:05:00.000Z");
  assert.match(late.reason, /晚间再检查/);
  assert.equal(exhausted.retrySequence, 4);
  assert.equal(exhausted.retryExhaustedForDay, true);
  assert.equal(exhausted.nextEligibleAt, "2026-07-24T00:05:00.000Z");
});

test("同一 OAuth 上游故障按组熔断且保留晚间机会", () => {
  const results = ["one", "two", "three"].map((name) => ({
    origin: `https://${name}.example`,
    status: "deferred",
    retryCause: "upstream_unavailable",
    failureCode: "oauth_upstream_unavailable",
    provider: "LinuxDO",
    upstreamProvider: "GitHub",
    retrySequence: 1,
  }));
  const circuit = applyUpstreamGroupCircuitBreakers(results, {
    upstreamFailureGroupMaxDailyAttempts: 3,
    upstreamUnavailableLateRetryTime: "21:05",
    schedule: "08:05",
  }, new Date("2026-07-23T02:00:00Z"));
  assert.equal(circuit.every((result) => result.status === "deferred"), true);
  assert.equal(circuit.every((result) => result.lateRetryPending === true), true);
  assert.equal(circuit.every((result) => result.retryGroup === "oauth:linuxdo:github"), true);
  assert.equal(circuit[0].nextEligibleAt, "2026-07-23T13:05:00.000Z");
});

test("Agent Router 可按账号提供方区分共享 OAuth 上游", () => {
  const [result] = applyUpstreamGroupCircuitBreakers([{
    origin: "https://agent.example",
    accountKey: "linuxdo",
    status: "deferred",
    retryCause: "upstream_unavailable",
    failureCode: "oauth_upstream_unavailable",
  }], {
    upstreamFailureGroupMaxDailyAttempts: 3,
    agentrouterAccounts: [
      { origin: "https://agent.example", accountKey: "github", provider: "GitHub" },
      { origin: "https://agent.example", accountKey: "linuxdo", provider: "LinuxDO" },
    ],
  });
  assert.equal(result.retryGroup, "oauth:linuxdo:shared");
});

test("续跑只推进本轮真正尝试过的站点", () => {
  const now = new Date("2026-07-23T12:00:00Z");
  const previous = [
    { origin: "https://wait.test", status: "deferred", retryCause: "rate_limit", retrySequence: 1, retrySequenceDate: "20260723", nextEligibleAt: "2026-07-23T13:00:00.000Z" },
    { origin: "https://retry.test", status: "deferred", retryCause: "rate_limit", retrySequence: 1, retrySequenceDate: "20260723", nextEligibleAt: "2026-07-23T13:00:00.000Z" },
  ];
  const current = previous.map((result) => ({ ...result }));
  const advanced = advanceAttemptedDeferredRetries(current, new Set(["https://retry.test"]), previous, {
    rateLimitRetryDelayMs: 3600000,
  }, now);
  assert.deepEqual(advanced[0], current[0]);
  assert.equal(advanced[1].retrySequence, 2);
  assert.equal(advanced[1].nextEligibleAt, "2026-07-23T14:00:00.000Z");
});

test("限频序列跨上海日期会重置且耗尽始终转到次日", () => {
  const config = {
    schedule: "08:05",
    rateLimitRetryDelayMs: 3600000,
    rateLimitMaxDailyAttempts: 3,
  };
  const afterMidnight = new Date("2026-07-23T16:01:00Z");
  const yesterday = {
    status: "deferred",
    retryCause: "rate_limit",
    retrySequence: 3,
    retrySequenceDate: "20260723",
    retryExhaustedForDay: true,
  };
  const reset = advanceDeferredRetry({ status: "deferred", retryCause: "rate_limit" }, yesterday, config, afterMidnight);
  assert.equal(reset.retrySequence, 1);
  assert.equal(reset.retrySequenceDate, "20260724");
  assert.equal(reset.retryExhaustedForDay, false);

  const atSevenShanghai = new Date("2026-07-23T23:00:00Z");
  const first = advanceDeferredRetry({ status: "deferred", retryCause: "rate_limit" }, null, config, atSevenShanghai);
  const second = advanceDeferredRetry({ status: "deferred", retryCause: "rate_limit" }, first, config, atSevenShanghai);
  const exhausted = advanceDeferredRetry({ status: "deferred", retryCause: "rate_limit" }, second, config, atSevenShanghai);
  assert.equal(exhausted.nextEligibleAt, "2026-07-25T00:05:00.000Z");

  const fallback = advanceDeferredRetry(
    { status: "deferred", retryCause: "rate_limit" },
    { ...second, retrySequence: 2 },
    { ...config, rateLimitNextDayTime: "invalid", schedule: "09:10" },
    atSevenShanghai,
  );
  assert.equal(fallback.nextEligibleAt, "2026-07-25T01:10:00.000Z");
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
  assert.match(result.reason, /^登录状态失效/);
  assert.match(result.reason, /已安排低频重试$/);
});

test("非登录异常不会被登录退避策略改写", () => {
  const result = { status: "interactive_challenge", reason: "需要验证" };
  assert.equal(deferUnresolvedLogin(result, { loginRetryDelayMs: 21600000 }), result);
});
