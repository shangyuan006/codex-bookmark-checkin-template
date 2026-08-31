import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  acceptConfiguredLoginTerms,
  clickConfiguredLoginChallengeControl,
  waitForLoginSubmitEnabled,
} from "../src/protected-login-flow.mjs";

test("受保护登录先接受显式配置的新条款", async () => {
  let clicked = false;
  const button = {
    count: async () => 1,
    isVisible: async () => true,
    click: async () => { clicked = true; },
  };
  const page = {
    url: () => "https://protected.example/login",
    getByRole: (_role, options) => {
      assert.deepEqual(options, { name: "同意并继续", exact: true });
      return button;
    },
    waitForTimeout: async () => {},
  };
  assert.equal(await acceptConfiguredLoginTerms(page, "https://protected.example", {
    autoAcceptUpdatedTermsOrigins: ["https://protected.example"],
    actionWaitMs: 0,
  }), true);
  assert.equal(clicked, true);
});

test("受保护登录等待唯一的可访问挑战控件完成并启用提交按钮", async () => {
  let enabled = false;
  let clicked = false;
  const submit = { isEnabled: async () => enabled };
  const capButton = {
    count: async () => 1,
    isVisible: async () => true,
    click: async () => { clicked = true; enabled = true; },
  };
  const page = {
    url: () => "https://protected.example/login",
    getByRole: () => capButton,
    locator: () => ({ count: async () => 0 }),
    frameLocator: () => ({ locator: () => ({ count: async () => 0 }) }),
    waitForTimeout: async () => {},
  };
  assert.equal(await waitForLoginSubmitEnabled(page, submit, "https://protected.example", {
    autoClickTurnstileOrigins: ["https://protected.example"],
    cloudflareWaitMs: 10000,
  }), true);
  assert.equal(clicked, true);
});

test("OAuth 登录也只能推进已配置同源页面中的唯一挑战控件", async () => {
  let clicked = 0;
  const page = {
    url: () => "https://protected.example/sign-in",
    getByRole: () => ({
      count: async () => 1,
      isVisible: async () => true,
      click: async () => { clicked += 1; },
    }),
    locator: () => ({ count: async () => 0 }),
  };
  assert.equal(await clickConfiguredLoginChallengeControl(page, "https://protected.example", {
    autoClickTurnstileOrigins: ["https://protected.example"],
    actionTimeoutMs: 5000,
  }), true);
  assert.equal(clicked, 1);
  assert.equal(await clickConfiguredLoginChallengeControl(page, "https://outside.example", {
    autoClickTurnstileOrigins: ["https://protected.example"],
  }), false);
  assert.equal(clicked, 1);
});

test("未授权自动验证的登录页不会检查或点击挑战控件", async () => {
  let inspected = false;
  const page = {
    url: () => "https://protected.example/login",
    getByRole: () => { inspected = true; throw new Error("unexpected"); },
  };
  const submit = { isEnabled: async () => false };
  assert.equal(await waitForLoginSubmitEnabled(page, submit, "https://protected.example", {}), false);
  assert.equal(inspected, false);
});

test("顶层页面跨站后不会接受条款或点击挑战", async () => {
  let inspected = false;
  const page = {
    url: () => "https://unexpected.example/login",
    getByRole: () => { inspected = true; throw new Error("unexpected"); },
  };
  const submit = { isEnabled: async () => false };
  const config = {
    autoAcceptUpdatedTermsOrigins: ["https://protected.example"],
    autoClickTurnstileOrigins: ["https://protected.example"],
  };
  assert.equal(await acceptConfiguredLoginTerms(page, "https://protected.example", config), false);
  assert.equal(await waitForLoginSubmitEnabled(page, submit, "https://protected.example", config), false);
  assert.equal(inspected, false);
});

test("无法确认顶层页面来源时拒绝任何自动点击", async () => {
  let inspected = false;
  const page = {
    getByRole: () => { inspected = true; throw new Error("unexpected"); },
  };
  const submit = { isEnabled: async () => false };
  const config = {
    autoAcceptUpdatedTermsOrigins: ["https://protected.example"],
    autoClickTurnstileOrigins: ["https://protected.example"],
  };
  assert.equal(await acceptConfiguredLoginTerms(page, "https://protected.example", config), false);
  assert.equal(await waitForLoginSubmitEnabled(page, submit, "https://protected.example", config), false);
  assert.equal(inspected, false);
});

test("凭据与保存密码登录按顺序接入 opt-in 条款和挑战处理", async () => {
  for (const file of ["credential-login.mjs", "saved-password-login.mjs"]) {
    const source = await fs.readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.match(source, /import \{ acceptConfiguredLoginTerms, waitForLoginSubmitEnabled \} from "\.\/protected-login-flow\.mjs"/);
    const stableCall = source.indexOf('await page.waitForLoadState("networkidle"');
    const acceptCall = source.indexOf("await acceptConfiguredLoginTerms(page, origin, config)");
    const passwordLookup = source.indexOf("const password = page.locator");
    const challengeCall = source.indexOf("await waitForLoginSubmitEnabled(page, submit, origin, config)");
    const submitClick = source.indexOf("await submit.click");
    assert.ok(stableCall >= 0 && stableCall < acceptCall, `${file} 应在页面稳定后处理条款`);
    assert.ok(acceptCall < passwordLookup, `${file} 应在查找登录表单前处理条款`);
    assert.ok(challengeCall >= 0 && challengeCall < submitClick, `${file} 应在提交前处理挑战`);
    assert.match(source, /if \(!pageMatchesOrigin\(page\)\) throw new Error/);
    assert.match(source, /if \(requireChallengeReady && !submitReady\)[\s\S]{0,160}?status = "needs_attention"/);
  }
  const credentialSource = await fs.readFile(new URL("../src/credential-login.mjs", import.meta.url), "utf8");
  assert.match(credentialSource, /import \{ expandSavedPasswordLogin \} from "\.\/login-form\.mjs"/);
  assert.match(credentialSource, /await expandSavedPasswordLogin\(page, origin, config\)/);
  assert.match(credentialSource, /if \(submitAttempted\) \{/);
  assert.match(credentialSource, /if \(requireChallengeReady && !submitReady\) \{[\s\S]*?status = "needs_attention"/);
});

test("原生保存密码恢复暂不接入受保护登录提交策略", async () => {
  const source = await fs.readFile(new URL("../src/native-login.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /protected-login-flow|acceptConfiguredLoginTerms|waitForLoginSubmitEnabled/);
});

function emptyChallengeLocator() {
  return {
    count: async () => 0,
    isVisible: async () => false,
  };
}

function challengeFrame(url, box) {
  return {
    url: () => url,
    frameElement: async () => ({ boundingBox: async () => box }),
    locator: () => emptyChallengeLocator(),
  };
}

function parentFrameLocator(frames) {
  return {
    count: async () => frames.length,
    nth: (index) => ({
      getAttribute: async () => frames[index].url,
      isVisible: async () => true,
      boundingBox: async () => frames[index].box,
    }),
  };
}

test("OAuth login challenge uses one configured same-origin Cloudflare frame and never clicks it twice", async () => {
  let clicked = 0;
  const box = { x: 100, y: 50, width: 300, height: 70 };
  const frameUrl = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/if/ov2";
  const frames = [{ url: frameUrl, box }];
  const page = {
    url: () => "https://protected.example/sign-in",
    getByRole: () => emptyChallengeLocator(),
    locator: (selector) => selector === "iframe[src]" ? parentFrameLocator(frames) : emptyChallengeLocator(),
    frames: () => [challengeFrame(frameUrl, box)],
    mouse: { click: async () => { clicked += 1; } },
  };
  const config = { autoClickTurnstileOrigins: ["https://protected.example"] };
  assert.equal(await clickConfiguredLoginChallengeControl(page, "https://protected.example", config), true);
  assert.equal(await clickConfiguredLoginChallengeControl(page, "https://protected.example", config), false);
  assert.equal(clicked, 1);
});

test("OAuth login challenge fails closed when multiple Cloudflare frames are visible", async () => {
  let clicked = 0;
  const frameUrl = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/if/ov2";
  const frames = [
    { url: frameUrl, box: { x: 100, y: 50, width: 300, height: 70 } },
    { url: frameUrl, box: { x: 100, y: 150, width: 300, height: 70 } },
  ];
  const page = {
    url: () => "https://protected.example/sign-in",
    getByRole: () => emptyChallengeLocator(),
    locator: (selector) => selector === "iframe[src]" ? parentFrameLocator(frames) : emptyChallengeLocator(),
    frames: () => frames.map((frame) => challengeFrame(frame.url, frame.box)),
    mouse: { click: async () => { clicked += 1; } },
  };
  assert.equal(await clickConfiguredLoginChallengeControl(page, "https://protected.example", {
    autoClickTurnstileOrigins: ["https://protected.example"],
  }), false);
  assert.equal(clicked, 0);
});
