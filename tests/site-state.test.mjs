import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPreferredCandidates,
  reuseRecentNotAvailable,
  runWithRecentNotAvailableCache,
  updateSiteState,
} from "../src/site-state.mjs";

test("优先复用同一允许来源内最近成功的签到入口", () => {
  const targets = [{
    origin: "https://example.test",
    candidates: ["https://example.test/"],
    allowedOrigins: ["https://example.test", "https://checkin.example.test"],
  }];
  const state = { sites: { "https://example.test": { preferredUrl: "https://checkin.example.test/daily" } } };
  assert.deepEqual(applyPreferredCandidates(targets, state)[0].candidates, [
    "https://checkin.example.test/daily",
    "https://example.test/",
  ]);
});

test("拒绝复用书签允许范围之外的历史入口", () => {
  const targets = [{ origin: "https://example.test", candidates: ["https://example.test/"], allowedOrigins: ["https://example.test"] }];
  const state = { sites: { "https://example.test": { preferredUrl: "https://evil.test/daily" } } };
  assert.deepEqual(applyPreferredCandidates(targets, state)[0].candidates, ["https://example.test/"]);
});

test("累计成功、失败连续次数与平均耗时", () => {
  const first = updateSiteState({ version: 1, sites: {} }, [{
    origin: "https://example.test", status: "signed", reason: "ok", url: "https://example.test/checkin", durationMs: 1000,
  }], new Date("2026-07-20T00:00:00Z"));
  const second = updateSiteState(first, [{
    origin: "https://example.test", status: "error", reason: "network", url: "https://example.test/checkin", durationMs: 3000,
  }], new Date("2026-07-21T00:00:00Z"));
  assert.equal(second.sites["https://example.test"].failureStreak, 1);
  assert.equal(second.sites["https://example.test"].confirmedCount, 1);
  assert.equal(second.sites["https://example.test"].averageDurationMs, 2000);
  assert.equal(second.sites["https://example.test"].preferredUrl, "https://example.test/checkin");
  assert.equal(second.sites["https://example.test"].lastConfirmedStatus, "signed");
});

test("近期确认未开放签到的站点会复用结论并在周期后重新探测", () => {
  const target = { origin: "https://example.test", candidates: ["https://example.test/console"] };
  const state = { sites: { "https://example.test": {
    lastConfirmedAt: "2026-07-20T00:00:00Z",
    lastConfirmedStatus: "not_available",
    confirmedCount: 2,
    lastSuccessAt: null,
  } } };
  const config = { knownNoCheckinFeatureOrigins: ["https://example.test"], knownNoCheckinRecheckHours: 168 };
  const cached = reuseRecentNotAvailable(target, state, config, new Date("2026-07-23T00:00:00Z"));
  assert.equal(cached.status, "not_available");
  assert.equal(cached.cached, true);
  assert.equal(reuseRecentNotAvailable(target, state, config, new Date("2026-07-28T00:00:00Z")), null);
});

test("旧版状态可从从未成功且已有确认记录推断未开放签到", () => {
  const target = { origin: "https://example.test", candidates: ["https://example.test/"] };
  const state = { sites: { "https://example.test": {
    lastConfirmedAt: "2026-07-22T00:00:00Z",
    confirmedCount: 3,
    lastSuccessAt: null,
  } } };
  const config = { knownNoCheckinFeatureOrigins: ["https://example.test"] };
  assert.equal(reuseRecentNotAvailable(target, state, config, new Date("2026-07-23T00:00:00Z")).status, "not_available");
});

test("近期未开放缓存会在生产包装中跳过浏览器执行", async () => {
  const target = { origin: "https://example.test", candidates: ["https://example.test/console?token=private"] };
  const state = { sites: { "https://example.test": {
    lastConfirmedAt: "2026-07-22T00:00:00Z",
    lastConfirmedStatus: "not_available",
  } } };
  const config = { knownNoCheckinFeatureOrigins: ["https://example.test"], knownNoCheckinRecheckHours: 168 };
  let browserRuns = 0;
  const result = await runWithRecentNotAvailableCache(target, state, config, async () => {
    browserRuns += 1;
    return { status: "signed" };
  }, new Date("2026-07-23T00:00:00Z"));

  assert.equal(result.status, "not_available");
  assert.equal(result.cached, true);
  assert.equal(result.attempt, 0);
  assert.equal(browserRuns, 0);
  assert.equal("url" in result, false);
});

test("未开放缓存到期后恢复浏览器复核", async () => {
  const target = { origin: "https://example.test", candidates: ["https://example.test/"] };
  const state = { sites: { "https://example.test": {
    lastConfirmedAt: "2026-07-20T00:00:00Z",
    lastConfirmedStatus: "not_available",
  } } };
  const config = { knownNoCheckinFeatureOrigins: ["https://example.test"], knownNoCheckinRecheckHours: 24 };
  let browserRuns = 0;
  const result = await runWithRecentNotAvailableCache(target, state, config, async () => {
    browserRuns += 1;
    return { status: "signed" };
  }, new Date("2026-07-23T00:00:00Z"));

  assert.equal(result.status, "signed");
  assert.equal(browserRuns, 1);
});
