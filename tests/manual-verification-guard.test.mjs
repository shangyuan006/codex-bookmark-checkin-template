import assert from "node:assert/strict";
import test from "node:test";
import {
  assertManualVerificationExecution,
  pendingManualVerificationOrigins,
} from "../src/manual-verification-guard.mjs";

const pending = {
  state: "pending_verification",
  authoritativeEvidenceRequired: true,
  sourceRunId: "20260812-090000",
  targets: [{
    origin: "https://one.example/path",
    verificationStatus: "pending_verification",
  }],
};

test("pending manual verification rejects direct execution", () => {
  assert.deepEqual(pendingManualVerificationOrigins(pending), ["https://one.example"]);
  assert.throws(() => assertManualVerificationExecution(pending, {
    selectedOrigins: new Set(["https://one.example"]),
    resumeRequested: true,
    runDate: "20260812",
  }), /Run-Checkin\.ps1/);
});

test("wrapper consumption requires the exact pending scope and a resume report", () => {
  assert.doesNotThrow(() => assertManualVerificationExecution(pending, {
    consume: true,
    selectedOrigins: new Set(["https://one.example"]),
    resumeRequested: true,
    runDate: "20260812",
  }));
  assert.throws(() => assertManualVerificationExecution(pending, {
    consume: true,
    selectedOrigins: new Set(["https://two.example"]),
    resumeRequested: true,
    runDate: "20260812",
  }), /范围/);
  assert.throws(() => assertManualVerificationExecution(pending, {
    consume: true,
    selectedOrigins: new Set(["https://one.example"]),
    runDate: "20260812",
  }), /完整报告/);
});

test("completed records do not block ordinary runs", () => {
  assert.doesNotThrow(() => assertManualVerificationExecution({
    ...pending,
    state: "verification_complete",
  }));
});

test("malformed current-day pending records fail closed", () => {
  assert.throws(() => assertManualVerificationExecution({
    ...pending,
    targets: [{ origin: "not-a-url", verificationStatus: "pending_verification" }],
  }, { runDate: "20260812" }), /没有有效的待复核站点/);
  assert.throws(() => assertManualVerificationExecution({
    ...pending,
    sourceRunId: null,
  }, { runDate: "20260812" }), /来源运行编号/);
});

test("a stale pending record does not block the next local day", () => {
  assert.doesNotThrow(() => assertManualVerificationExecution(pending, {
    selectedOrigins: new Set(["https://unrelated.example"]),
    runDate: "20260813",
  }));
});
