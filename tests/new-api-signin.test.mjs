import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyNewApiCaptchaObservation,
  classifyNewApiSignInObservation,
  configuredNewApiCaptchaRule,
  configuredNewApiSignInRule,
  normalizeNewApiCaptchaCandidates,
  tryNewApiCaptchaCheckin,
  tryNewApiSignIn,
} from "../src/new-api-signin.mjs";

const ORIGIN = "https://api.example.test";

function signInConfig(overrides = {}) {
  return {
    newApiSignInRules: {
      [ORIGIN]: {
        rewardAmount: 1,
        logType: 1,
        logSuccessText: "Daily reward",
        verificationDelayMs: 0,
        ...overrides,
      },
    },
  };
}

function captchaConfig(overrides = {}) {
  return {
    newApiCaptchaRules: {
      [ORIGIN]: {
        verificationDelayMs: 0,
        ...overrides,
      },
    },
  };
}

function observedPage(observed) {
  return { evaluate: async () => observed };
}

function storage(values = {}) {
  return {
    getItem(key) {
      if (!Object.hasOwn(values, key)) return null;
      return typeof values[key] === "string" ? values[key] : JSON.stringify(values[key]);
    },
  };
}

function jsonResponse(body, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text,
  };
}

function executablePage(fetchMock, { local = {}, session = {} } = {}) {
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

test("rules only permit same-origin credential-free HTTPS endpoints", () => {
  assert.throws(
    () => configuredNewApiSignInRule("http://api.example.test", signInConfig()),
    /HTTPS URL without credentials/,
  );
  assert.throws(
    () => configuredNewApiSignInRule(ORIGIN, signInConfig({ signInPath: "https://other.example.test/api/sign_in" })),
    /same-origin HTTPS URL/,
  );
  assert.throws(
    () => configuredNewApiCaptchaRule("https://example.com", {
      newApiCaptchaRules: {
        "https://example.com": { captchaPath: "https://name:secret@example.com/captcha" },
      },
    }),
    /without credentials/,
  );

  const rule = configuredNewApiCaptchaRule(`${ORIGIN}/account`, captchaConfig({ maxAttempts: 8 }));
  assert.equal(rule.origin, ORIGIN);
  assert.equal(rule.checkinUrl, `${ORIGIN}/api/user/checkin`);
  assert.equal(rule.maxAttempts, 8);
});

test("explicit null or non-object rule values fail closed", () => {
  for (const value of [null, "enabled", [], 1]) {
    assert.throws(
      () => configuredNewApiSignInRule(ORIGIN, { newApiSignInRules: { [ORIGIN]: value } }),
      /rule must be an object/,
    );
    assert.throws(
      () => configuredNewApiCaptchaRule(ORIGIN, { newApiCaptchaRules: { [ORIGIN]: value } }),
      /rule must be an object/,
    );
  }
  assert.throws(
    () => configuredNewApiSignInRule(ORIGIN, { newApiSignInRules: [] }),
    /must be an object keyed by canonical origin/,
  );
  assert.equal(configuredNewApiSignInRule(ORIGIN, { newApiSignInRules: {} }), null);
});

test("captcha candidates are uppercase, exactly five characters, and deduplicated", () => {
  assert.deepEqual(normalizeNewApiCaptchaCandidates([
    " abc12 ",
    { code: "ABC12" },
    { text: "xy9z8" },
    "TOO-LONG",
    "A B12",
    null,
  ]), ["ABC12", "XY9Z8"]);
  assert.deepEqual(normalizeNewApiCaptchaCandidates("ABC12"), []);
});

test("sign-in is not successful from HTTP or response success alone", async () => {
  const config = signInConfig();
  const rule = configuredNewApiSignInRule(ORIGIN, config);
  const observed = {
    state: "called",
    signInStatus: 200,
    responseSuccess: true,
    responseMessage: "Sign-in succeeded $1",
    quotaDelta: 0,
    rewardLogBefore: false,
    rewardLogAfter: false,
  };
  assert.equal(classifyNewApiSignInObservation(observed, rule).status, "unconfirmed");
  assert.equal((await tryNewApiSignIn(observedPage(observed), ORIGIN, config)).status, "unconfirmed");
});

test("sign-in accepts only a new usage log or exact authoritative quota delta", () => {
  const rule = configuredNewApiSignInRule(ORIGIN, signInConfig());
  const fromLog = classifyNewApiSignInObservation({
    state: "called",
    responseSuccess: false,
    rewardLogBefore: false,
    rewardLogAfter: true,
    quotaDelta: null,
  }, rule);
  assert.equal(fromLog.status, "signed");
  assert.deepEqual(fromLog.evidence.sources, ["usage_log"]);

  const fromState = classifyNewApiSignInObservation({
    state: "called",
    responseSuccess: true,
    rewardLogBefore: false,
    rewardLogAfter: false,
    quotaDelta: 1,
  }, rule);
  assert.equal(fromState.status, "signed");
  assert.deepEqual(fromState.evidence.sources, ["self_quota_delta"]);

  assert.equal(classifyNewApiSignInObservation({
    state: "called",
    responseSuccess: true,
    rewardLogBefore: false,
    rewardLogAfter: false,
    quotaDelta: 0.999,
  }, rule).status, "unconfirmed");
});

test("sign-in executes with one explicit user ID and stops on an existing daily log", async () => {
  const requests = [];
  const page = executablePage(async (rawUrl, options = {}) => {
    const url = new URL(String(rawUrl));
    requests.push({ url, options });
    assert.equal(options.headers?.["New-Api-User"], "42");
    if (url.pathname === "/api/user/self") {
      return jsonResponse({ success: true, data: { id: 42, quota: 100 } });
    }
    if (url.pathname === "/api/log/self") {
      return jsonResponse({
        success: true,
        data: {
          items: [{
            type: 1,
            created_at: Math.floor(Date.now() / 1000),
            content: "Daily reward increase quota $1",
          }],
        },
      });
    }
    throw new Error(`Unexpected request: ${url.href}`);
  }, { local: { user: { id: 42 } } });

  const result = await tryNewApiSignIn(page, ORIGIN, signInConfig());
  assert.equal(result.status, "already_signed");
  assert.deepEqual(requests.map((request) => request.url.pathname), [
    "/api/user/self",
    "/api/log/self",
  ]);
  assert.equal(requests.some((request) => request.options.method === "POST"), false);
});

test("sign-in polls authoritative log and quota after POST", async () => {
  const requests = [];
  let selfReads = 0;
  let logReads = 0;
  const page = executablePage(async (rawUrl, options = {}) => {
    const url = new URL(String(rawUrl));
    requests.push({ url, options });
    if (url.pathname !== "/api/status") {
      assert.equal(options.headers?.["New-Api-User"], "42");
    }
    if (url.pathname === "/api/user/self") {
      selfReads += 1;
      return jsonResponse({
        success: true,
        data: { id: 42, quota: selfReads >= 3 ? 110 : 100 },
      });
    }
    if (url.pathname === "/api/log/self") {
      logReads += 1;
      const items = logReads >= 3
        ? [{
          type: 1,
          created_at: Math.floor(Date.now() / 1000),
          content: "Daily reward increase quota $1",
        }]
        : [];
      return jsonResponse({ success: true, data: { items } });
    }
    if (url.pathname === "/api/status") {
      return jsonResponse({ success: true, data: { quota_per_unit: 10 } });
    }
    if (url.pathname === "/api/user/sign_in") {
      assert.equal(options.method, "POST");
      return jsonResponse({ success: true, message: "HTTP success alone is not evidence" });
    }
    throw new Error(`Unexpected request: ${url.href}`);
  }, { local: { user: { id: 42 } } });

  const result = await tryNewApiSignIn(page, ORIGIN, signInConfig({ verificationAttempts: 3 }));
  assert.equal(result.status, "signed");
  assert.deepEqual(result.evidence.sources, ["usage_log", "self_quota_delta"]);
  assert.equal(selfReads, 3);
  assert.equal(logReads, 3);
  assert.equal(requests.filter((request) => request.url.pathname === "/api/user/sign_in").length, 1);
});

test("sign-in maps an authoritative 401 to login_required", async () => {
  let requests = 0;
  const page = executablePage(async (_rawUrl, options = {}) => {
    requests += 1;
    assert.equal(options.headers?.["New-Api-User"], "42");
    return jsonResponse({ success: false, message: "Unauthorized" }, 401);
  }, { local: { user: { id: 42 } } });

  const result = await tryNewApiSignIn(page, ORIGIN, signInConfig());
  assert.equal(result.status, "login_required");
  assert.equal(requests, 1);
});

test("explicit user identity failures stop requests", () => {
  assert.equal(classifyNewApiSignInObservation({ state: "user_id_missing" }, {}).status, "login_required");
  assert.equal(classifyNewApiSignInObservation({ state: "user_id_ambiguous" }, {}).status, "unconfirmed");
  assert.equal(classifyNewApiCaptchaObservation({ state: "unauthorized" }).status, "login_required");
});

test("captcha passes the original decoded bytes and verifies status after submit", async () => {
  const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0xfe]);
  const requests = [];
  let statusReads = 0;
  const page = executablePage(async (rawUrl, options = {}) => {
    const url = new URL(String(rawUrl));
    requests.push({ url, options });
    assert.equal(options.headers?.["New-Api-User"], "42");
    if (url.pathname === "/api/user/checkin" && options.method !== "POST") {
      statusReads += 1;
      assert.match(url.searchParams.get("month"), /^\d{4}-\d{2}$/);
      return jsonResponse({
        success: true,
        data: { checked_in_today: statusReads >= 2 },
      });
    }
    if (url.pathname === "/api/user/checkin/captcha") {
      assert.equal(options.method, "POST");
      return jsonResponse({
        success: true,
        data: {
          captcha_id: "challenge-1",
          captcha_image: `data:image/png;base64,${original.toString("base64")}`,
        },
      });
    }
    if (url.pathname === "/api/user/checkin" && options.method === "POST") {
      assert.equal(options.headers?.["Content-Type"], "application/json");
      assert.deepEqual(JSON.parse(options.body), {
        captcha_id: "challenge-1",
        captcha_answer: "AB12C",
      });
      return jsonResponse({ success: true, message: "Submitted" });
    }
    throw new Error(`Unexpected request: ${url.href}`);
  }, { local: { user: { id: 42 } } });
  let solverCalls = 0;
  const result = await tryNewApiCaptchaCheckin(page, ORIGIN, captchaConfig(), async (image, context) => {
    solverCalls += 1;
    assert.deepEqual(image, original);
    assert.deepEqual(context, { attempt: 1 });
    return ["bad", { text: "ab12c" }, "AB12C"];
  });

  assert.equal(result.status, "signed");
  assert.equal(result.evidence.source, "new_api_checkin_status");
  assert.equal(result.evidence.attempts, 1);
  assert.equal(solverCalls, 1);
  assert.equal(statusReads, 2);
  assert.deepEqual(requests.map((request) => `${request.options.method ?? "GET"} ${request.url.pathname}`), [
    "GET /api/user/checkin",
    "POST /api/user/checkin/captcha",
    "POST /api/user/checkin",
    "GET /api/user/checkin",
  ]);
});

test("captcha POST success remains unconfirmed when status does not change", async () => {
  let call = 0;
  const page = {
    async evaluate() {
      call += 1;
      if (call === 1) return { state: "ready", userId: "7" };
      if (call === 2) return { state: "ready", id: "captcha", image: Buffer.from("image").toString("base64") };
      if (call === 3) return { state: "submitted", httpStatus: 200 };
      return { state: "verification_failed" };
    },
  };
  const result = await tryNewApiCaptchaCheckin(page, ORIGIN, captchaConfig(), async () => ["ABCDE"]);
  assert.equal(result.status, "unconfirmed");
  assert.equal(call, 4);
});

test("captcha attempts are bounded and repeated OCR candidates are not resubmitted", async () => {
  let challenges = 0;
  const submitted = [];
  const page = {
    async evaluate(_callback, argument) {
      if (argument.origin) return { state: "ready", userId: "9" };
      if (argument.captchaId) {
        submitted.push(argument.captchaAnswer);
        return { state: "retry" };
      }
      challenges += 1;
      return {
        state: "ready",
        id: `captcha-${challenges}`,
        image: Buffer.from(`image-${challenges}`).toString("base64"),
      };
    },
  };
  let solverCalls = 0;
  const result = await tryNewApiCaptchaCheckin(
    page,
    ORIGIN,
    captchaConfig({ maxAttempts: 3 }),
    async () => {
      solverCalls += 1;
      return ["ABCDE", "abcde", "FGHIJ"];
    },
  );

  assert.equal(result.status, "interactive_challenge");
  assert.equal(challenges, 3);
  assert.equal(solverCalls, 3);
  assert.deepEqual(submitted, ["ABCDE", "FGHIJ"]);
});

test("invalid captcha images fail closed without calling OCR", async () => {
  let solverCalled = false;
  let call = 0;
  const page = {
    async evaluate() {
      call += 1;
      if (call === 1) return { state: "ready", userId: "11" };
      return { state: "ready", id: "captcha", image: "https://api.example.test/image.png" };
    },
  };
  const result = await tryNewApiCaptchaCheckin(page, ORIGIN, captchaConfig(), async () => {
    solverCalled = true;
    return ["ABCDE"];
  });
  assert.equal(result.status, "unconfirmed");
  assert.equal(solverCalled, false);
});
