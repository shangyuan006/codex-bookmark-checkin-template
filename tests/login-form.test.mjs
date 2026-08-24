import assert from "node:assert/strict";
import test from "node:test";
import { expandSavedPasswordLogin, loginFormExpanderPattern } from "../src/login-form.mjs";

test("generic login expander recognizes email or username login controls", () => {
  const pattern = loginFormExpanderPattern();
  assert.match("使用 邮箱或用户名 登录", pattern);
  assert.match("Continue with email", pattern);
  assert.doesNotMatch("使用 GitHub 继续", pattern);
});

test("configured login expander clicks exactly one matching visible control", async () => {
  let clicks = 0;
  const elements = [
    { visible: true, text: "使用 GitHub 继续" },
    { visible: true, text: "使用 邮箱或用户名 登录" },
  ];
  const page = {
    locator: (selector) => ({
      count: async () => selector.startsWith("input") ? 0 : elements.length,
      nth: (index) => ({
        isVisible: async () => elements[index].visible,
        evaluate: async () => elements[index].text,
        click: async () => { clicks += 1; },
      }),
    }),
    waitForTimeout: async () => {},
  };
  assert.equal(await expandSavedPasswordLogin(page, "https://example.test", {
    savedLoginFormRules: {
      "https://example.test": { expanderTexts: ["使用 邮箱或用户名 登录"] },
    },
  }), true);
  assert.equal(clicks, 1);
});

test("login expander leaves an already visible unique form unchanged", async () => {
  let candidateLookups = 0;
  const page = {
    locator: (selector) => ({
      count: async () => {
        if (selector.startsWith('input[type="password"]')) return 1;
        if (selector.startsWith("input:visible")) return 1;
        candidateLookups += 1;
        return 0;
      },
    }),
  };
  assert.equal(await expandSavedPasswordLogin(page, "https://example.test", {}), false);
  assert.equal(candidateLookups, 0);
});
