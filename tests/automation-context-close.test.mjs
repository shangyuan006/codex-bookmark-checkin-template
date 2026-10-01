import test from "node:test";
import assert from "node:assert/strict";
import { closeAutomationContext } from "../src/automation-context-close.mjs";

test("automation context close returns immediately after a normal close", async () => {
  let closed = false;
  const result = await closeAutomationContext({
    close: async () => { closed = true; },
  }, { timeoutMs: 100 });

  assert.equal(closed, true);
  assert.deepEqual(result, {
    closed: true,
    timedOut: false,
    fallbackAttempted: false,
    fallbackSucceeded: false,
  });
});

test("automation context close is bounded and runs one cleanup fallback", async () => {
  let fallbackCalls = 0;
  const startedAt = Date.now();
  const result = await closeAutomationContext({
    close: () => new Promise(() => {}),
  }, {
    timeoutMs: 100,
    fallback: async () => { fallbackCalls += 1; },
  });

  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(result, {
    closed: false,
    timedOut: true,
    fallbackAttempted: true,
    fallbackSucceeded: true,
  });
});

test("automation context close reports fallback failure without hanging", async () => {
  const result = await closeAutomationContext({
    close: async () => { throw new Error("close failed"); },
  }, {
    timeoutMs: 100,
    fallback: async () => { throw new Error("fallback failed"); },
  });

  assert.deepEqual(result, {
    closed: false,
    timedOut: false,
    fallbackAttempted: true,
    fallbackSucceeded: false,
  });
});
