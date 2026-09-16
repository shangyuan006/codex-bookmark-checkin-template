import test from "node:test";
import assert from "node:assert/strict";
import { isConfirmedNotAvailable, isTerminalResult, normalizeResultContract } from "../src/result-contract.mjs";

const confirmedAt = "2026-07-25T08:00:00.000Z";

test("not_available requires an authoritative, typed evidence record", () => {
  assert.equal(isTerminalResult({ status: "not_available" }), false);
  assert.equal(normalizeResultContract({ status: "not_available", reason: "page text" }).status, "unconfirmed");
  assert.equal(isTerminalResult({
    status: "not_available",
    availabilityKind: "feature_disabled",
    evidence: { source: "configuration", outcome: "known_no_checkin_feature", authoritative: true, confirmedAt },
  }), true);
});

test("temporary operator unavailability is terminal only when explicitly confirmed", () => {
  const result = {
    status: "not_available",
    availabilityKind: "temporary_unavailable",
    temporarilyUnavailable: true,
    evidence: { source: "operator_confirmation", authoritative: true, confirmedAt },
  };
  assert.equal(isConfirmedNotAvailable(result), true);
  assert.equal(isConfirmedNotAvailable({ ...result, evidence: { ...result.evidence, authoritative: false } }), false);
});

test("future or unknown evidence timestamps are rejected", () => {
  const result = {
    status: "not_available",
    availabilityKind: "feature_disabled",
    evidence: { source: "configuration", outcome: "known_no_checkin_feature", authoritative: true, confirmedAt: "not-a-date" },
  };
  assert.equal(isConfirmedNotAvailable(result), false);
});
