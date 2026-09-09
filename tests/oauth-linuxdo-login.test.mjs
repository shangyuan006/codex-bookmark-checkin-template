import assert from "node:assert/strict";
import test from "node:test";
import {
  recoverSavedLinuxDoLogin,
  shouldRetryLinuxDoLoginRecovery,
} from "../src/oauth-linuxdo-login.mjs";

function createLinuxDoLoginPage({
  challengeBeforeSubmit = false,
  challengeAfterSubmit = false,
  leaveLoginAfterWaits = null,
} = {}) {
  const state = {
    url: "https://linux.do/login",
    now: 0,
    submitted: 0,
    waitsAfterSubmit: 0,
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
    evaluate: async () => true,
    getByRole: (_role, { name }) => (name === "登录" ? loginButton : emptyLocator),
    waitForTimeout: async (milliseconds) => {
      state.now += milliseconds;
      if (state.submitted > 0) {
        state.waitsAfterSubmit += 1;
        if (leaveLoginAfterWaits !== null && state.waitsAfterSubmit >= leaveLoginAfterWaits) {
          state.url = "https://linux.do/";
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

test("LinuxDO saved login accepts a CF-assisted transition away from the login page", async () => {
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
  assert.equal(shouldRetryLinuxDoLoginRecovery(result), false);
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
