import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyLinuxDoSession,
  probeProviderSessionContext,
  probeProviderSessionInContext,
  probeSessionWithRetry,
  providerSessionProbeUrl,
  readProviderSession,
  readProviderSessionPage,
} from "../src/oauth-provider-session.mjs";
import { parseProviderSessionProbe } from "../src/reauth-checkin.mjs";

test("LinuxDO provider session probe uses a fixed endpoint and returns no identity", () => {
  assert.equal(providerSessionProbeUrl("LinuxDO"), "https://linux.do/session/current.json");
  assert.equal(providerSessionProbeUrl("GitHub"), null);
  assert.equal(classifyLinuxDoSession({ current_user: { id: 123, username: "private" } }), "valid");
  assert.equal(classifyLinuxDoSession({ current_user: null }), "invalid");
  assert.equal(classifyLinuxDoSession(null), "unknown");
});

test("provider session probe parser exposes only a fixed status", () => {
  assert.deepEqual(
    parseProviderSessionProbe('startup\n{"status":"valid","username":"private"}\n'),
    { status: "valid" },
  );
  assert.deepEqual(parseProviderSessionProbe("not json"), { status: "unknown" });
});

test("provider session reads cookies through the browser context request API", async () => {
  const calls = [];
  const requestContext = {
    async get(endpoint, options) {
      calls.push({ endpoint, options });
      return {
        status: () => 200,
        ok: () => true,
        json: async () => ({ current_user: { id: 123, username: "private" } }),
      };
    },
  };

  assert.equal(await readProviderSession(
    requestContext,
    "https://linux.do/session/current.json",
    12_000,
  ), "valid");
  assert.deepEqual(calls, [{
    endpoint: "https://linux.do/session/current.json",
    options: { timeout: 12_000 },
  }]);
});

test("provider session maps unauthorized and failed requests without page state", async () => {
  const unauthorized = {
    async get() {
      return {
        status: () => 401,
        ok: () => false,
        json: async () => null,
      };
    },
  };
  const failed = { async get() { throw new Error("context closed"); } };

  assert.equal(await readProviderSession(unauthorized, "https://linux.do/session/current.json", 1_000), "invalid");
  assert.equal(await readProviderSession(failed, "https://linux.do/session/current.json", 1_000), "unknown");
});

test("provider page probe uses browser navigation as a cold-profile fallback", async () => {
  const calls = [];
  const page = {
    async goto(endpoint, options) {
      calls.push({ endpoint, options });
      return {
        status: () => 200,
        ok: () => true,
        json: async () => ({ current_user: { id: 123 } }),
      };
    },
  };

  assert.equal(await readProviderSessionPage(
    page,
    "https://linux.do/session/current.json",
    12_000,
  ), "valid");
  assert.deepEqual(calls, [{
    endpoint: "https://linux.do/session/current.json",
    options: { waitUntil: "domcontentloaded", timeout: 12_000 },
  }]);
});

test("provider session probe corrects request-context false negatives before login UI", async () => {
  let requestAttempts = 0;
  let pageClosed = false;
  let contextClosed = false;
  const context = {
    request: {
      async get() {
        requestAttempts += 1;
        return {
          status: () => 200,
          ok: () => true,
          json: async () => ({ current_user: null }),
        };
      },
    },
    async newPage() {
      return {
        async goto() {
          return {
            status: () => 200,
            ok: () => true,
            json: async () => ({ current_user: { id: 123 } }),
          };
        },
        async close() { pageClosed = true; },
      };
    },
    async close() { contextClosed = true; },
  };

  assert.deepEqual(await probeProviderSessionContext(
    context,
    "https://linux.do/session/current.json",
    1_000,
  ), { status: "valid", attempts: 4 });
  assert.equal(requestAttempts, 3);
  assert.equal(pageClosed, true);
  assert.equal(contextClosed, true);
});

test("automatic provider-only probe uses the page fallback without closing its context", async () => {
  let pageClosed = false;
  let contextClosed = false;
  const context = {
    request: {
      async get() {
        return {
          status: () => 200,
          ok: () => true,
          json: async () => ({ current_user: null }),
        };
      },
    },
    async newPage() {
      return {
        async goto() {
          return {
            status: () => 200,
            ok: () => true,
            json: async () => ({ current_user: {} }),
          };
        },
        async close() { pageClosed = true; },
      };
    },
    async close() { contextClosed = true; },
  };

  assert.deepEqual(await probeProviderSessionInContext(
    context,
    "https://linux.do/session/current.json",
    1_000,
    { retryDelaysMs: [0], wait: async () => {} },
  ), { status: "valid", attempts: 3 });
  assert.equal(pageClosed, true);
  assert.equal(contextClosed, false);
});

test("automatic provider-only probe fails closed when either signal is indeterminate", async () => {
  const context = {
    request: { async get() { throw new Error("request unavailable"); } },
    async newPage() {
      return {
        async goto() { return null; },
        async close() {},
      };
    },
  };

  assert.deepEqual(await probeProviderSessionInContext(
    context,
    "https://linux.do/session/current.json",
    1_000,
    { retryDelaysMs: [], wait: async () => {} },
  ), { status: "unknown", attempts: 2 });
});

test("provider page fallback tolerates a cold renderer before Agent Router opens", async () => {
  const pageStatuses = [
    { current_user: null },
    { current_user: {} },
  ];
  const waits = [];
  const context = {
    request: {
      async get() {
        return {
          status: () => 200,
          ok: () => true,
          json: async () => ({ current_user: null }),
        };
      },
    },
    async newPage() {
      return {
        async goto() {
          const value = pageStatuses.shift();
          return {
            status: () => 200,
            ok: () => true,
            json: async () => value,
          };
        },
        async close() {},
      };
    },
  };

  assert.deepEqual(await probeProviderSessionInContext(
    context,
    "https://linux.do/session/current.json",
    1_000,
    {
      retryDelaysMs: [],
      pageRetryDelaysMs: [1_000],
      wait: async (delayMs) => { waits.push(delayMs); },
    },
  ), { status: "valid", attempts: 3 });
  assert.deepEqual(waits, [1_000]);
});

test("provider session keeps the browser context open until classification completes", async () => {
  let closed = false;
  const context = {
    request: {
      async get() {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(closed, false);
        return {
          status: () => 200,
          ok: () => true,
          json: async () => ({ current_user: {} }),
        };
      },
    },
    async close() { closed = true; },
  };

  assert.deepEqual(await probeProviderSessionContext(
    context,
    "https://linux.do/session/current.json",
    1_000,
  ), { status: "valid", attempts: 1 });
  assert.equal(closed, true);
});

test("provider session probe tolerates a cold-start false negative", async () => {
  const statuses = ["invalid", "valid"];
  const waits = [];
  const result = await probeSessionWithRetry(
    async () => statuses.shift(),
    {
      retryDelaysMs: [1_000, 1_500],
      wait: async (delayMs) => { waits.push(delayMs); },
    },
  );

  assert.deepEqual(result, { status: "valid", attempts: 2 });
  assert.deepEqual(waits, [1_000]);
});

test("provider session probe distinguishes definitive invalid from indeterminate", async () => {
  for (const [statuses, expected] of [
    [["invalid", "invalid", "invalid"], { status: "invalid", attempts: 3 }],
    [["unknown", "invalid", "invalid"], { status: "unknown", attempts: 3 }],
    [["invalid", "unknown", "invalid"], { status: "unknown", attempts: 3 }],
  ]) {
    const pending = [...statuses];
    assert.deepEqual(await probeSessionWithRetry(
      async () => pending.shift(),
      { retryDelaysMs: [0, 0], wait: async () => {} },
    ), expected);
  }
});

test("provider session probe uses the documented 0, 1, and 2.5 second schedule", async () => {
  const waits = [];
  assert.deepEqual(await probeSessionWithRetry(
    async () => "invalid",
    { wait: async (delayMs) => { waits.push(delayMs); } },
  ), { status: "invalid", attempts: 3 });
  assert.deepEqual(waits, [1_000, 1_500]);
});
