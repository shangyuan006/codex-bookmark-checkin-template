import test from "node:test";
import assert from "node:assert/strict";
import { applyPreferredCandidates, updateSiteState } from "../src/site-state.mjs";

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
});
