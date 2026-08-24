import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { finalizeTimedOutResults } from "../src/finalize-timeout-report.mjs";
import { aggregateReauthResults } from "../src/reauth-checkin.mjs";
import { buildCompletedReauthProgressResult, buildReauthProgressResult } from "../src/reauth-progress.mjs";

const target = {
  origin: "https://router.example",
  title: "Router",
  folderNames: ["Daily"],
};

test("partial Agent Router progress is deferred and strips private identity fields", () => {
  const now = new Date("2026-08-08T08:00:00.000Z");
  const progress = buildReauthProgressResult(target, [{
    origin: target.origin,
    accountKey: "github",
    accountLabel: "private label",
    accountId: "private-id",
    provider: "GitHub",
    supplementalAccount: false,
    status: "signed",
  }], 2, now);

  assert.equal(progress.status, "deferred");
  assert.equal(progress.retryCause, "task_timeout");
  assert.deepEqual(progress.accountProgress, { completed: 1, total: 2 });
  assert.equal(progress.accountResults[0].status, "signed");
  assert.equal(Object.hasOwn(progress.accountResults[0], "accountLabel"), false);
  assert.equal(Object.hasOwn(progress.accountResults[0], "accountId"), false);

  const [finalized] = finalizeTimedOutResults([target], [progress], now);
  assert.equal(finalized.status, "deferred");
  assert.equal(finalized.accountResults[0].status, "signed");
});

test("runner wires account callbacks into progress without counting the parent complete", async () => {
  const source = await fs.readFile(new URL("../src/index.mjs", import.meta.url), "utf8");
  assert.match(source, /onAccountResult:/);
  assert.match(source, /buildReauthProgressResult/);
  assert.match(source, /processedTotal: completedProgressResults\.length/);
  assert.match(source, /selectedProcessedTotal: completedSelectedResults\.length/);
  assert.match(source, /completedResults\.length === accounts\.length/);
  assert.match(source, /aggregateReauthResults\(completedResults\)/);
  assert.match(source, /reauthProgressResults\.delete\(target\.origin\)/);
});

test("fully completed account progress keeps the authoritative parent status through timeout finalization", () => {
  const aggregate = aggregateReauthResults([
    { origin: target.origin, accountKey: "github", provider: "GitHub", status: "already_signed" },
    { origin: target.origin, accountKey: "linuxdo", provider: "LinuxDO", status: "signed" },
  ]);
  const completed = buildCompletedReauthProgressResult(target, aggregate, 2, 1234);
  assert.equal(completed.status, "signed");
  assert.deepEqual(completed.accountProgress, { completed: 2, total: 2 });

  const [finalized] = finalizeTimedOutResults([target], [completed], new Date("2026-08-08T08:00:00.000Z"));
  assert.equal(finalized.status, "signed");
  assert.deepEqual(finalized.accountResults.map((result) => result.status), ["already_signed", "signed"]);
});
