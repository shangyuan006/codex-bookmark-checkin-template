import assert from "node:assert/strict";
import test from "node:test";
import { buildCurrentPlan, computePlanFingerprint, planFingerprintInput } from "../src/current-plan.mjs";

function basePlan(candidate = "https://router.example/checkin") {
  return {
    targets: [{
      origin: "https://router.example",
      candidates: [candidate],
      allowedOrigins: ["https://router.example"],
      folderNames: ["每日签到"],
    }],
  };
}

test("计划指纹与数组顺序无关但会随候选路径改变", () => {
  const first = computePlanFingerprint(basePlan(), []);
  const reordered = computePlanFingerprint({
    targets: [{ ...basePlan().targets[0], candidates: ["https://router.example/checkin"] }],
  }, []);
  const changed = computePlanFingerprint(basePlan("https://router.example/profile"), []);
  assert.equal(first, reordered);
  assert.notEqual(first, changed);
  assert.equal(planFingerprintInput(basePlan(), []).version, 1);
});

test("当前计划输出账号集合指纹", () => {
  const current = buildCurrentPlan(basePlan(), {
    reauthCheckinRules: { "https://router.example": { enabled: true, provider: "LinuxDO" } },
    agentrouterAccounts: [
      { origin: "https://router.example", accountId: "github", provider: "GitHub" },
      { origin: "https://router.example", accountId: "linuxdo", provider: "LinuxDO" },
    ],
  });
  assert.match(current.planFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(current.accountIdentityCount, 2);
});
