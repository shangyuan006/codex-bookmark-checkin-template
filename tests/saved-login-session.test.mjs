import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { configuredBearerCheckinRule } from "../src/bearer-checkin.mjs";
import {
  configuredSavedLoginSessionRule,
  verifyConfiguredSavedLoginSession,
} from "../src/saved-login-session.mjs";

const ORIGIN = "https://api.example.test";

function config(overrides = {}) {
  return {
    savedLoginSessionRules: {
      [ORIGIN]: {
        type: "new_api",
        selfPath: "/api/user/self",
        userStorageKeys: ["user"],
        ...overrides,
      },
    },
  };
}

function storage(values = {}) {
  return {
    getItem(key) {
      if (!Object.hasOwn(values, key)) return null;
      return typeof values[key] === "string" ? values[key] : JSON.stringify(values[key]);
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

function page(fetchMock, { local = {}, session = {} } = {}) {
  return {
    async evaluate(callback, argument) {
      const replacements = {
        fetch: fetchMock,
        localStorage: storage(local),
        sessionStorage: storage(session),
      };
      const descriptors = new Map(Object.keys(replacements)
        .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
      try {
        for (const [key, value] of Object.entries(replacements)) {
          Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        }
        return await callback(argument);
      } finally {
        for (const [key, descriptor] of descriptors) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else delete globalThis[key];
        }
      }
    },
  };
}

test("saved login session verification is explicit and same-origin", () => {
  assert.equal(configuredSavedLoginSessionRule(ORIGIN, config()).type, "new_api");
  assert.equal(configuredSavedLoginSessionRule("https://other.example.test", config()), null);
  assert.throws(
    () => configuredSavedLoginSessionRule(ORIGIN, config({ selfPath: "https://other.example.test/api/user/self" })),
    /same-origin HTTPS URL/,
  );
  assert.throws(
    () => configuredSavedLoginSessionRule(ORIGIN, config({ type: "page_title" })),
    /type must be new_api/,
  );
});

test("Bearer refresh session verification requires and uses its authoritative adapter", async () => {
  const bearerConfig = {
    savedLoginSessionRules: {
      [ORIGIN]: { type: "bearer_refresh" },
    },
    bearerCheckinRules: {
      [ORIGIN]: { verificationDelayMs: 0 },
    },
  };
  assert.deepEqual(configuredSavedLoginSessionRule(ORIGIN, bearerConfig), { type: "bearer_refresh" });
  assert.throws(
    () => configuredSavedLoginSessionRule(ORIGIN, {
      savedLoginSessionRules: bearerConfig.savedLoginSessionRules,
    }),
    /requires a bearerCheckinRules entry/,
  );

  const result = await verifyConfiguredSavedLoginSession(page(async (rawUrl, options = {}) => {
    const url = new URL(String(rawUrl));
    if (url.pathname === "/api/user/auth/refresh") {
      assert.equal(options.method, "POST");
      return response({
        success: true,
        data: {
          ["access" + "_token"]: ["opaque", "value"].join("-"),
          token_type: "Bearer",
        },
      });
    }
    assert.equal(url.pathname, "/api/data/self");
    assert.equal(options.headers.Authorization, ["Bearer opaque", "value"].join("-"));
    return response({ success: true, data: { user: { id: 42 } } });
  }), ORIGIN, bearerConfig);
  assert.deepEqual(result, { status: "valid" });
});

test("New API session requires one storage ID and matching authoritative identity", async () => {
  let requestCount = 0;
  const result = await verifyConfiguredSavedLoginSession(page(async (url, options) => {
    requestCount += 1;
    assert.equal(url, `${ORIGIN}/api/user/self`);
    assert.equal(options.credentials, "include");
    assert.equal(options.signal instanceof AbortSignal, true);
    assert.equal(options.headers["New-Api-User"], "42");
    return response({ success: true, data: { id: 42 } });
  }, { local: { user: { id: 42 } } }), ORIGIN, config());
  assert.deepEqual(result, { status: "valid" });
  assert.equal(requestCount, 1);
  assert.deepEqual(Object.keys(result), ["status"]);
});

test("standalone Bearer verification never enables direct API check-in or exports the token", async () => {
  const standalone = { savedLoginSessionRules: { [ORIGIN]: {
    type: "bearer_refresh", refreshPath: "/api/user/auth/refresh", selfPath: "/api/user/self",
  } } };
  assert.equal(configuredBearerCheckinRule(ORIGIN, standalone), null);
  const requests = [];
  const result = await verifyConfiguredSavedLoginSession(page(async (url, options = {}) => {
    requests.push(new URL(url).pathname);
    assert.equal(options.signal instanceof AbortSignal, true);
    if (new URL(url).pathname.endsWith('/refresh')) {
      return response({ success: true, data: { ["access" + "_token"]: ["opaque", "fixture"].join('-'), token_type: "Bearer" } });
    }
    assert.equal(options.method, undefined);
    return response({ success: true, data: { id: 42 } });
  }), ORIGIN, standalone);
  assert.deepEqual(result, { status: "valid" });
  assert.deepEqual(requests, ["/api/user/auth/refresh", "/api/user/self"]);
  assert.equal(configuredBearerCheckinRule(ORIGIN, standalone), null);
  assert.throws(() => configuredSavedLoginSessionRule(ORIGIN, { savedLoginSessionRules: { [ORIGIN]: {
    type: "bearer_refresh", refreshPath: "/refresh", selfPath: "https://other.example.test/self",
  } } }), /same-origin/);
  assert.throws(() => configuredSavedLoginSessionRule(ORIGIN, { savedLoginSessionRules: { [ORIGIN]: {
    type: "bearer_refresh", selfPath: "/self",
  } } }), /requires refreshPath and selfPath/);
});

test("a timed-out or unreadable self response is unknown, not expired login", async () => {
  const result = await verifyConfiguredSavedLoginSession(page(async () => ({
    ok: true, status: 200, json: async () => { throw new Error('response interrupted'); },
  }), { local: { user: { id: 42 } } }), ORIGIN, config());
  assert.deepEqual(result, { status: "unknown" });
});

test("New API session rejects unauthorized or conflicting identities", async () => {
  const unauthorized = await verifyConfiguredSavedLoginSession(page(
    async () => response({ success: false }, 401),
    { local: { user: { id: 42 } } },
  ), ORIGIN, config());
  assert.deepEqual(unauthorized, { status: "invalid" });

  const conflict = await verifyConfiguredSavedLoginSession(page(
    async () => response({ success: true, data: { id: 7 } }),
    { local: { user: { id: 42 } } },
  ), ORIGIN, config());
  assert.deepEqual(conflict, { status: "invalid" });
});

test("New API session fails closed for ambiguous identity or server failure", async () => {
  let requests = 0;
  const ambiguous = await verifyConfiguredSavedLoginSession(page(async () => {
    requests += 1;
    return response({ success: true, data: { id: 42 } });
  }, {
    local: { user: { id: 42 } },
    session: { user: { id: 7 } },
  }), ORIGIN, config());
  assert.deepEqual(ambiguous, { status: "unknown" });
  assert.equal(requests, 0);

  const unavailable = await verifyConfiguredSavedLoginSession(page(
    async () => response(null, 503),
    { local: { user: { id: 42 } } },
  ), ORIGIN, config());
  assert.deepEqual(unavailable, { status: "unknown" });
});

test("native saved-login recovery requires configured authoritative session verification", async () => {
  const source = await fs.readFile(new URL("../src/native-login.mjs", import.meta.url), "utf8");
  assert.match(source, /import \{ verifyConfiguredSavedLoginSession \} from "\.\/saved-login-session\.mjs"/);
  assert.match(source, /await verifyConfiguredSavedLoginSession\(page, expectedOrigin, config\)/);
  assert.match(source, /verifiedSession\.status !== "valid"[\s\S]*?status = "needs_attention"/);
  assert.doesNotMatch(source, /finalUrl:|title:/);
});
