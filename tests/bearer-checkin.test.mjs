import test from "node:test";
import assert from "node:assert/strict";
import {
  configuredBearerCheckinRule,
  tryBearerCheckin,
  verifyConfiguredBearerSession,
} from "../src/bearer-checkin.mjs";

const ORIGIN = "https://bearer.example.test";

function config(overrides = {}) {
  return {
    bearerCheckinRules: {
      [ORIGIN]: {
        verificationDelayMs: 0,
        ...overrides,
      },
    },
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function page(fetchMock) {
  return {
    async evaluate(callback, argument) {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
      try {
        Object.defineProperty(globalThis, "fetch", {
          configurable: true,
          writable: true,
          value: fetchMock,
        });
        return await callback(argument);
      } finally {
        if (descriptor) Object.defineProperty(globalThis, "fetch", descriptor);
        else delete globalThis.fetch;
      }
    },
  };
}

function authenticatedResponses({ checked = true, after = true, userId = 42 } = {}) {
  const requests = [];
  let statusReads = 0;
  const fetchMock = async (rawUrl, options = {}) => {
    const url = new URL(String(rawUrl));
    requests.push({ url, options });
    if (url.pathname === "/api/user/auth/refresh") {
      return response({
        success: true,
        data: {
          ["access" + "_token"]: ["opaque", "value"].join("-"),
          token_type: "Bearer",
        },
      });
    }
    assert.equal(options.headers.Authorization, ["Bearer opaque", "value"].join("-"));
    if (url.pathname === "/api/data/self") {
      return response({ success: true, data: { user: { id: userId } } });
    }
    if (url.pathname === "/api/user/checkin" && options.method === "POST") {
      return response({ success: true });
    }
    if (url.pathname === "/api/user/checkin") {
      statusReads += 1;
      return response({
        success: true,
        data: { enabled: true, stats: { checked_in_today: statusReads === 1 ? checked : after } },
      });
    }
    throw new Error(`Unexpected request: ${url.href}`);
  };
  return { fetchMock, requests };
}

test("Bearer rules require same-origin HTTPS endpoints", () => {
  const rule = configuredBearerCheckinRule(`${ORIGIN}/profile`, config());
  assert.equal(rule.origin, ORIGIN);
  assert.equal(rule.refreshUrl, `${ORIGIN}/api/user/auth/refresh`);
  assert.equal(rule.selfUrl, `${ORIGIN}/api/data/self`);
  assert.equal(rule.checkinUrl, `${ORIGIN}/api/user/checkin`);
  assert.throws(
    () => configuredBearerCheckinRule(ORIGIN, config({ selfPath: "https://other.example.test/api/data/self" })),
    /same-origin HTTPS URL/,
  );
  assert.throws(
    () => configuredBearerCheckinRule(ORIGIN, { bearerCheckinRules: { [ORIGIN]: null } }),
    /rule must be an object/,
  );
});

test("Bearer check-in stops on authoritative already-signed state", async () => {
  const { fetchMock, requests } = authenticatedResponses({ checked: true });
  const result = await tryBearerCheckin(page(fetchMock), ORIGIN, config());
  assert.equal(result.status, "already_signed");
  assert.deepEqual(requests.map((request) => [request.url.pathname, request.options.method ?? "GET"]), [
    ["/api/user/auth/refresh", "POST"],
    ["/api/data/self", "GET"],
    ["/api/user/checkin", "GET"],
  ]);
});

test("Bearer check-in posts once and requires a verified follow-up state", async () => {
  const { fetchMock, requests } = authenticatedResponses({ checked: false, after: true });
  const result = await tryBearerCheckin(page(fetchMock), ORIGIN, config());
  assert.equal(result.status, "signed");
  assert.deepEqual(result.evidence, { source: "bearer_checkin_status", attempts: 1 });
  assert.equal(requests.filter((request) => request.options.method === "POST"
    && request.url.pathname === "/api/user/checkin").length, 1);

  const unverified = authenticatedResponses({ checked: false, after: false });
  assert.equal((await tryBearerCheckin(page(unverified.fetchMock), ORIGIN, config())).status, "unconfirmed");
});

test("Bearer session verification distinguishes invalid and transient states", async () => {
  const valid = authenticatedResponses();
  assert.deepEqual(await verifyConfiguredBearerSession(page(valid.fetchMock), ORIGIN, config()), { status: "valid" });

  const stringIdentity = authenticatedResponses({ userId: "example-user-id" });
  assert.deepEqual(
    await verifyConfiguredBearerSession(page(stringIdentity.fetchMock), ORIGIN, config()),
    { status: "valid" },
  );

  const refreshIdentity = page(async (rawUrl, options = {}) => {
    const url = new URL(String(rawUrl));
    if (url.pathname === "/api/user/auth/refresh") {
      return response({
        success: true,
        data: {
          ["access" + "_token"]: ["opaque", "value"].join("-"),
          token_type: "Bearer",
          user: { id: "example-user-id" },
        },
      });
    }
    assert.equal(url.pathname, "/api/data/self");
    assert.equal(options.headers.Authorization, ["Bearer opaque", "value"].join("-"));
    return response({ success: true, data: [] });
  });
  assert.deepEqual(
    await verifyConfiguredBearerSession(refreshIdentity, ORIGIN, config()),
    { status: "valid" },
  );

  const unauthorized = page(async () => response({ success: false }, 401));
  assert.deepEqual(await verifyConfiguredBearerSession(unauthorized, ORIGIN, config()), { status: "invalid" });

  const unavailable = page(async () => response(null, 503));
  assert.deepEqual(await verifyConfiguredBearerSession(unavailable, ORIGIN, config()), { status: "unknown" });
});
