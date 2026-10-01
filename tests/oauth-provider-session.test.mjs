import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyLinuxDoSession,
  probeProviderSessionContext,
  probeProviderSessionInContext,
  probeSessionWithRetry,
  providerSessionProbeUrl,
  readProviderSession,
  readProviderSessionPage,
  waitForLinuxDoProbePage,
} from "../src/oauth-provider-session.mjs";
import { parseProviderSessionProbe } from "../src/reauth-checkin.mjs";
import { writeLinuxDoProbeDiagnostic } from "../src/linuxdo-probe-diagnostics.mjs";

test("LinuxDO provider session probe uses a fixed endpoint and returns no identity", () => {
  assert.equal(providerSessionProbeUrl("LinuxDO"), "https://linux.do/session/current.json");
  assert.equal(providerSessionProbeUrl("GitHub"), null);
  assert.equal(classifyLinuxDoSession({ current_user: { id: 123, username: "private" } }), "valid");
  assert.equal(classifyLinuxDoSession({ current_user: null }), "invalid");
  assert.equal(classifyLinuxDoSession(null), "unknown");
  assert.equal(classifyLinuxDoSession({ error: "unexpected payload" }), "unknown");
  assert.equal(classifyLinuxDoSession({ current_user: false }), "unknown");
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

test("provider session maps logged-out and failed requests without page state", async () => {
  const responseWithStatus = (status) => ({
    async get() {
      return {
        status: () => status,
        ok: () => false,
        json: async () => null,
      };
    },
  });
  const failed = { async get() { throw new Error("context closed"); } };

  for (const status of [401, 403, 404]) {
    assert.equal(await readProviderSession(
      responseWithStatus(status),
      "https://linux.do/session/current.json",
      1_000,
    ), "invalid");
  }
  assert.equal(await readProviderSession(failed, "https://linux.do/session/current.json", 1_000), "unknown");
});

test("provider page probe warms the provider home and fetches session state in-page", async () => {
  const calls = [];
  let currentUrl = "about:blank";
  const page = {
    url() { return currentUrl; },
    async goto(url, options) {
      calls.push({ type: "goto", url, options });
      currentUrl = url;
      return { status: () => 200, ok: () => true };
    },
    async evaluate(_callback, argument) {
      calls.push({ type: "evaluate", argument });
      return "valid";
    },
  };

  assert.equal(await readProviderSessionPage(
    page,
    "https://linux.do/session/current.json",
    12_000,
  ), "valid");
  assert.deepEqual(calls, [
    {
      type: "goto",
      url: "https://linux.do/",
      options: { waitUntil: "domcontentloaded", timeout: 12_000 },
    },
    {
      type: "evaluate",
      argument: {
        sessionEndpoint: "https://linux.do/session/current.json",
        requestTimeoutMs: 12_000,
      },
    },
  ]);
});

test("provider page fetch records Cloudflare response metadata without response content", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({
    status: 403,
    ok: false,
    headers: new Headers({ "content-type": "text/html", "cf-mitigated": "challenge" }),
  }));
  const observations = [];
  const page = {
    url: () => "https://linux.do/",
    evaluate: (callback, argument) => callback(argument),
  };
  assert.equal(await readProviderSessionPage(page, "https://linux.do/session/current.json", 1_000,
    (item) => observations.push(item)), "unknown");
  assert.deepEqual(observations.map(({ classification, httpStatus, responseType, challenge }) =>
    ({ classification, httpStatus, responseType, challenge })), [
    { classification: "unknown", httpStatus: 403, responseType: "html", challenge: true },
  ]);
});

test("HTML and Cloudflare errors cannot prove a logged-out provider session", async () => {
  for (const status of [200, 401, 403, 404, 429]) {
    const request = { get: async () => ({ status: () => status, ok: () => status === 200,
      headers: () => ({ "content-type": "text/html" }),
      json: async () => { throw new Error("HTML is not session JSON"); } }) };
    assert.equal(await readProviderSession(request, "https://linux.do/session/current.json", 1_000), "unknown");
  }
  const invalidJson = { get: async () => ({ status: () => 200, ok: () => true,
    headers: () => ({ "content-type": "application/json" }),
    json: async () => { throw new Error("invalid JSON"); } }) };
  assert.equal(await readProviderSession(invalidJson, "https://linux.do/session/current.json", 1_000), "unknown");
});

test("provider page probe rejects malformed JSON without claiming login expiry", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ status: 200, ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => { throw new Error("not JSON"); } }));
  const page = { url: () => "https://linux.do/", evaluate: (callback, argument) => callback(argument) };
  assert.equal(await readProviderSessionPage(page, "https://linux.do/session/current.json", 1_000), "unknown");
});

test("JSON error payloads cannot be mistaken for a logged-out provider", async (t) => {
  const response = { status: 200, ok: true, headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ errors: ["temporary service error"] }) };
  t.mock.method(globalThis, "fetch", async () => response);
  const page = { url: () => "https://linux.do/", evaluate: (callback, argument) => callback(argument) };
  assert.equal(await readProviderSessionPage(page, "https://linux.do/session/current.json", 1_000), "unknown");
  const request = { get: async () => ({ status: () => 200, ok: () => true,
    headers: () => ({ "content-type": "application/json" }), json: response.json }) };
  assert.equal(await readProviderSession(request, "https://linux.do/session/current.json", 1_000), "unknown");
});

test("blocked provider probes stop repeated requests and expose only safe handoff flags", async () => {
  let requestAttempts = 0;
  let pageAttempts = 0;
  const context = {
    request: { get: async () => {
      requestAttempts += 1;
      return { status: () => 403, ok: () => false,
        headers: () => ({ "content-type": "text/html", "cf-mitigated": "challenge" }) };
    } },
    newPage: async () => ({
      url: () => "https://linux.do/",
      evaluate: async () => {
        pageAttempts += 1;
        return { status: "unknown", httpStatus: 429, responseType: "html", challenge: true };
      },
      close: async () => {},
    }),
  };
  const result = await probeProviderSessionInContext(context, "https://linux.do/session/current.json", 1_000,
    { wait: async () => { assert.fail("A blocked probe must not wait to repeat the same request"); } });
  assert.deepEqual(result, { status: "unknown", attempts: 2, challengeObserved: true, rateLimited: true });
  assert.equal(requestAttempts, 1);
  assert.equal(pageAttempts, 1);
});

test("CF settlement reuses one provider page and requires a fresh authoritative session", async () => {
  for (const [afterSettlement, expected] of [["valid", "valid"], ["unknown", "unknown"]]) {
    let clock = 0;
    let sessionReads = 0;
    let closed = false;
    const observations = [];
    const context = {
      request: { get: async () => ({ status: () => 403, ok: () => false,
        headers: () => ({ "cf-mitigated": "challenge", "content-type": "text/html" }) }) },
      newPage: async () => ({
        url: () => "https://linux.do/",
        evaluate: async (_callback, argument) => {
          if (!argument?.sessionEndpoint) return clock >= 1_000;
          sessionReads += 1;
          return { status: sessionReads > 1 ? afterSettlement : "unknown",
            httpStatus: sessionReads > 1 && afterSettlement === "valid" ? 200 : 403,
            responseType: sessionReads > 1 && afterSettlement === "valid" ? "json" : "html",
            challenge: sessionReads === 1 || afterSettlement !== "valid" };
        },
        close: async () => { closed = true; },
        goto: async () => { assert.fail("The current provider page must not be reopened"); },
        reload: async () => { assert.fail("CF settlement must not reload the challenge"); },
      }),
    };
    const result = await probeProviderSessionInContext(context,
      "https://linux.do/session/current.json", 1_000, {
        challengeWaitMs: 5_000,
        challengeSettleOptions: { now: () => clock, wait: async (delay) => { clock += delay; } },
        onObservation: (item) => observations.push(item),
      });
    assert.equal(result.status, expected);
    assert.equal(result.attempts, 3);
    assert.equal(sessionReads, 2);
    assert.equal(clock, 3_000);
    assert.equal(closed, true);
    assert.equal(observations.find((item) => item.step === "settle")?.pageReady, true);
  }
});

test("persistent CF and rate limits do not cause repeated provider endpoint reads", async () => {
  for (const rateLimited of [false, true]) {
    let clock = 0;
    let sessionReads = 0;
    let pageClosed = false;
    const context = {
      request: { get: async () => ({ status: () => 403, ok: () => false,
        headers: () => ({ "cf-mitigated": "challenge" }) }) },
      newPage: async () => ({
        url: () => "https://linux.do/",
        evaluate: async (_callback, argument) => {
          if (!argument?.sessionEndpoint) return false;
          sessionReads += 1;
          return { status: "unknown", httpStatus: rateLimited ? 429 : 403,
            responseType: "html", challenge: true };
        },
        close: async () => { pageClosed = true; },
      }),
    };
    const result = await probeProviderSessionInContext(context,
      "https://linux.do/session/current.json", 1_000, {
        challengeWaitMs: 2_000,
        challengeSettleOptions: { now: () => clock, wait: async (delay) => { clock += delay; } },
      });
    assert.equal(result.status, "unknown");
    assert.equal(result.challengeObserved, true);
    assert.equal(sessionReads, 1);
    assert.equal(clock, rateLimited ? 0 : 2_000);
    assert.equal(pageClosed, true);
  }
});

test("provider readiness resets across navigation and cannot escape the LinuxDO origin", async () => {
  let clock = 0;
  const page = {
    url: () => "https://linux.do/",
    evaluate: async () => {
      if (clock === 1_000) throw new Error("Execution context was destroyed");
      return true;
    },
  };
  assert.equal(await waitForLinuxDoProbePage(page, {
    timeoutMs: 5_000, now: () => clock, wait: async (delay) => { clock += delay; },
  }), true);
  assert.equal(clock, 3_500);
  assert.equal(await waitForLinuxDoProbePage({ url: () => "https://unrelated.example/",
    evaluate: async () => { assert.fail("Do not read another origin"); } }), false);
  assert.equal(await waitForLinuxDoProbePage({ ...page, isClosed: () => true }), false);
  assert.equal(await waitForLinuxDoProbePage(page, { shouldStop: () => true }), false);
});

test("provider readiness requires a loaded Discourse page without visible CF controls", async (t) => {
  let clock = 0;
  let challengeVisible = true;
  const challengeElement = { getBoundingClientRect: () => ({ width: challengeVisible ? 300 : 0, height: 65 }) };
  const globals = {
    location: { origin: "https://linux.do" },
    document: { readyState: "complete", querySelectorAll: () => [challengeElement], querySelector: () => ({}) },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const page = { url: () => "https://linux.do/", evaluate: async (callback) => callback() };
  assert.equal(await waitForLinuxDoProbePage(page, {
    timeoutMs: 4_000, now: () => clock,
    wait: async (delay) => { clock += delay; challengeVisible = clock < 1_000; },
  }), true);
  assert.equal(clock, 3_000);
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
      let currentUrl = "about:blank";
      return {
        url() { return currentUrl; },
        async goto(url) { currentUrl = url; return {}; },
        async evaluate() { return "valid"; },
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

test("LinuxDO probe records bounded request and page evidence without changing classification", async () => {
  const observations = [];
  const context = {
    request: { async get() {
      return { status: () => 403, ok: () => false,
        headers: () => ({ "content-type": "text/html", "cf-mitigated": "challenge" }) };
    } },
    async newPage() {
      let currentUrl = "about:blank";
      return {
        url() { return currentUrl; },
        async goto(url) { currentUrl = url; return { status: () => 200,
          headers: () => ({ "content-type": "text/html" }) }; },
        async evaluate() { return { status: "valid", httpStatus: 200,
          responseType: "json", challenge: false }; },
        async close() {},
      };
    },
  };
  const result = await probeProviderSessionInContext(
    context, "https://linux.do/session/current.json", 1_000,
    { retryDelaysMs: [], onObservation: (item) => observations.push(item) },
  );
  assert.deepEqual(result, { status: "valid", attempts: 2 });
  assert.deepEqual(observations.map(({ surface, step, httpStatus, responseType, challenge }) =>
    ({ surface, step, httpStatus, responseType, challenge })), [
    { surface: "request", step: "session", httpStatus: 403, responseType: "html", challenge: true },
    { surface: "page", step: "landing", httpStatus: 200, responseType: "html", challenge: false },
    { surface: "page", step: "session", httpStatus: 200, responseType: "json", challenge: false },
  ]);
});

test("LinuxDO diagnostic file allowlists fields and rotates old daily files", async () => {
  const logsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "linuxdo-probe-"));
  try {
    const now = new Date(2026, 8, 28, 16, 0, 0);
    const fakeCookieValue = "private-cookie";
    const fakeSecretValue = "private-secret";
    const oldFile = path.join(logsRoot, "linuxdo-session-probes-20260801.jsonl");
    await fs.writeFile(oldFile, "old\n");
    await fs.utimes(oldFile, new Date("2026-08-01T00:00:00Z"), new Date("2026-08-01T00:00:00Z"));
    assert.equal(await writeLinuxDoProbeDiagnostic({
      stage: "automatic_provider", status: "invalid", attempts: 2, elapsedMs: 100,
      cookie: fakeCookieValue, observations: [{ surface: "request", step: "session",
        attempt: 1, classification: "invalid", httpStatus: 403, responseType: "html",
        challenge: true, secret: fakeSecretValue, error: "private-error" }],
    }, { logsRoot, now, retentionDays: 14 }), true);
    const saved = await fs.readFile(path.join(logsRoot, "linuxdo-session-probes-20260928.jsonl"), "utf8");
    const record = JSON.parse(saved.trim());
    assert.equal(record.stage, "automatic_provider");
    assert.equal(record.observations[0].httpStatus, 403);
    assert.equal(record.observations[0].challenge, true);
    assert.equal(record.observations[0].error, null);
    assert.doesNotMatch(saved, /private-cookie|private-secret|private-error/);
    await assert.rejects(fs.access(oldFile), { code: "ENOENT" });
    assert.equal(await writeLinuxDoProbeDiagnostic({ stage: "arbitrary", status: "valid" },
      { logsRoot, now }), false);
  } finally {
    await fs.rm(logsRoot, { recursive: true, force: true });
  }
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
      let currentUrl = "about:blank";
      return {
        url() { return currentUrl; },
        async goto(url) { currentUrl = url; return {}; },
        async evaluate() { return "valid"; },
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
        url() { return "about:blank"; },
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
  const pageStatuses = ["invalid", "valid"];
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
      let currentUrl = "about:blank";
      return {
        url() { return currentUrl; },
        async goto(url) { currentUrl = url; return {}; },
        async evaluate() { return pageStatuses.shift(); },
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
