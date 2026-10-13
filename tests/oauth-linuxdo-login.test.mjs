import assert from "node:assert/strict";
import test from "node:test";
import {
  recoverSavedLinuxDoLogin,
  shouldRetryLinuxDoLoginRecovery,
  verifyLinuxDoRecoverySession,
} from "../src/oauth-linuxdo-login.mjs";

function createLinuxDoLoginPage({
  challengeBeforeSubmit = false,
  challengeAfterSubmit = false,
  leaveLoginAfterWaits = null,
  transitionUrl = 'https://linux.do/',
  sessionStatus = 'valid',
  sessionMetadata = {},
  savedFieldsFilled = true,
  googleLoginAvailable = false,
} = {}) {
  const state = {
    url: "https://linux.do/login",
    now: 0,
    submitted: 0,
    waitsAfterSubmit: 0,
    sessionReads: 0,
  };
  const challengeVisible = () => state.url.includes("/login")
    && (challengeBeforeSubmit || (state.submitted > 0 && challengeAfterSubmit));
  const emptyLocator = {
    count: async () => 0,
    isVisible: async () => false,
    nth: () => emptyLocator,
  };
  const inputLocator = {
    count: async () => 1,
    click: async () => {},
    press: async () => {},
  };
  const loginButton = {
    count: async () => 1,
    isVisible: async () => true,
    click: async () => { state.submitted += 1; },
  };
  const page = {
    url: () => state.url,
    locator: (selector) => {
      if (selector.includes("login-account-name") || selector.includes("login-account-password")) {
        return inputLocator;
      }
      return {
        count: async () => (challengeVisible() ? 1 : 0),
        nth: () => ({ isVisible: async () => challengeVisible() }),
      };
    },
    evaluate: async (_fn, options) => {
      if (options?.sessionEndpoint) {
        assert.equal(options.sessionEndpoint, 'https://linux.do/session/current.json');
        state.sessionReads += 1;
        return {status: sessionStatus,...sessionMetadata};
      }
      return savedFieldsFilled;
    },
    getByRole: (_role, { name }) => (name === "登录" || (googleLoginAvailable && name === '使用 Google 登录') ? loginButton : emptyLocator),
    waitForTimeout: async (milliseconds) => {
      state.now += milliseconds;
      if (state.submitted > 0) {
        state.waitsAfterSubmit += 1;
        if (leaveLoginAfterWaits !== null && state.waitsAfterSubmit >= leaveLoginAfterWaits) {
          state.url = transitionUrl;
        }
      }
    },
  };
  return { page, state, now: () => state.now };
}

test("LinuxDO saved login submits once and does not retry while CF remains visible", async () => {
  const fixture = createLinuxDoLoginPage({ challengeAfterSubmit: true });
  const result = await recoverSavedLinuxDoLogin(fixture.page, 5_000, { now: fixture.now });

  assert.deepEqual(result, {
    recovered: false,
    submitted: true,
    challengeObserved: true,
  });
  assert.equal(fixture.state.submitted, 1);
  assert.equal(shouldRetryLinuxDoLoginRecovery(result), false);
});

test("LinuxDO saved login does not submit over a pre-existing unresolved CF challenge", async () => {
  const fixture = createLinuxDoLoginPage({ challengeBeforeSubmit: true });
  const result = await recoverSavedLinuxDoLogin(fixture.page, 5_000, { now: fixture.now });

  assert.deepEqual(result, {
    recovered: false,
    submitted: false,
    challengeObserved: true,
  });
  assert.equal(fixture.state.submitted, 0);
  assert.equal(shouldRetryLinuxDoLoginRecovery(result), false);
});

test("LinuxDO saved login accepts a CF-assisted transition only after the session is valid", async () => {
  const fixture = createLinuxDoLoginPage({
    challengeAfterSubmit: true,
    leaveLoginAfterWaits: 2,
  });
  const result = await recoverSavedLinuxDoLogin(fixture.page, 5_000, { now: fixture.now });

  assert.deepEqual(result, {
    recovered: true,
    submitted: true,
    challengeObserved: true,
  });
  assert.equal(fixture.state.submitted, 1);
  assert.equal(fixture.state.sessionReads, 1);
  assert.equal(shouldRetryLinuxDoLoginRecovery(result), false);
});

test('unfinished Google login is not a recovered LinuxDO session', async () => {
  const fixture = createLinuxDoLoginPage({savedFieldsFilled:false,googleLoginAvailable:true,
    leaveLoginAfterWaits:1,transitionUrl:'https://accounts.google.com/v3/signin/identifier'});
  const result = await recoverSavedLinuxDoLogin(fixture.page, 10_000, {now:fixture.now});
  assert.equal(result.recovered, false);
  assert.equal(result.submitted, true);
  assert.equal(fixture.state.submitted, 1);
  assert.equal(fixture.state.sessionReads, 0);
  assert.equal(shouldRetryLinuxDoLoginRecovery(result), false);
});

for (const sessionStatus of ['invalid','unknown']) {
  test(`LinuxDO home without a valid session remains unrecovered: ${sessionStatus}`, async () => {
    const fixture = createLinuxDoLoginPage({leaveLoginAfterWaits:1,sessionStatus});
    const result = await recoverSavedLinuxDoLogin(fixture.page, 10_000, {now:fixture.now});
    assert.equal(result.recovered, false);
    assert.equal(fixture.state.submitted, 1);
    assert.equal(fixture.state.sessionReads, 3);
  });
}

test('a warming LinuxDO session may settle without a second login submission', async () => {
  const fixture = createLinuxDoLoginPage({leaveLoginAfterWaits:1});
  let reads = 0;
  const result = await recoverSavedLinuxDoLogin(fixture.page, 10_000, {now:fixture.now,
    verifySession:async () => ++reads >= 2});
  assert.equal(result.recovered, true);
  assert.equal(reads, 2);
  assert.equal(fixture.state.submitted, 1);
});

for (const sessionMetadata of [{challenge:true},{httpStatus:429}]) {
  test(`LinuxDO recovery stops session probes on CF or rate limiting: ${JSON.stringify(sessionMetadata)}`, async () => {
    const fixture = createLinuxDoLoginPage({leaveLoginAfterWaits:1,sessionStatus:'unknown',sessionMetadata});
    const result = await recoverSavedLinuxDoLogin(fixture.page, 10_000, {now:fixture.now});
    assert.equal(result.recovered, false);
    assert.equal(fixture.state.sessionReads,1);
    assert.equal(fixture.state.submitted,1);
  });
}

test('LinuxDO authorization return requires the fixed provider session endpoint', async () => {
  const requested = [];
  const page = {url:()=>'https://connect.linux.do/oauth2/authorize',context:()=>({request:{
    get:async (url)=>{requested.push(url);return {status:()=>200,ok:()=>true,
      headers:()=>({'content-type':'application/json'}),json:async()=>({current_user:{}})};},
  }})};
  assert.equal(await verifyLinuxDoRecoverySession(page, 1000), true);
  assert.deepEqual(requested, ['https://linux.do/session/current.json']);
  page.url = () => 'https://accounts.google.com/v3/signin/identifier';
  assert.equal(await verifyLinuxDoRecoverySession(page, 1000), false);
  assert.equal(requested.length, 1);
});

test("LinuxDO saved login may retry only when no submission or challenge occurred", () => {
  assert.equal(shouldRetryLinuxDoLoginRecovery({
    recovered: false,
    submitted: false,
    challengeObserved: false,
  }), true);
  assert.equal(shouldRetryLinuxDoLoginRecovery({
    recovered: true,
    submitted: false,
    challengeObserved: false,
  }), false);
});
