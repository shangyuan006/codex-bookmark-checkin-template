import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReauthStateEntry,
  classifyQuotaIncrease,
  configuredProviderIsExplicitlyUnavailable,
  aggregateReauthResults,
  getConfiguredReauthAccounts,
  getConfiguredReauthRule,
  parseQuotaDisplayText,
  readQuotaUntilIncrease,
  reauthLoginFailureReason,
  valueAtFieldPath,
} from "../src/reauth-checkin.mjs";

const target = {
  origin: "https://reauth.example",
  candidates: ["https://reauth.example/console"],
  allowedOrigins: ["https://reauth.example"],
};

const config = {
  reauthCheckinRules: {
    "https://reauth.example": {
      pageUrl: "https://reauth.example/console",
      loginUrl: "https://reauth.example/login",
      after: "08:00",
      provider: "LinuxDO",
      accountMenuSelector: "button[aria-haspopup=true]",
      logoutTexts: ["退出登录", "退出"],
      quotaEndpoint: "https://reauth.example/api/user/self",
      quotaField: "data.quota",
      quotaDomEvidence: { labelText: "当前余额", valueSiblingIndex: 1 },
      loginSuccessStorageEvidence: {
        storage: "localStorage",
        key: "user",
        field: "checked_in",
        expected: true,
      },
    },
  },
};

test("重认证规则严格限制为书签目标的同源 HTTPS 地址", () => {
  const rule = getConfiguredReauthRule(target, config);
  assert.equal(rule.origin, target.origin);
  assert.equal(rule.quotaField, "data.quota");
  assert.deepEqual(rule.loginSuccessStorageEvidence, {
    storage: "localStorage",
    key: "user",
    field: "checked_in",
    expected: true,
  });
  assert.throws(() => getConfiguredReauthRule(target, {
    reauthCheckinRules: {
      [target.origin]: { ...config.reauthCheckinRules[target.origin], quotaEndpoint: "https://outside.example/api/user/self" },
    },
  }), /同源 HTTPS/);
  assert.throws(() => getConfiguredReauthRule(target, {
    reauthCheckinRules: {
      [target.origin]: {
        ...config.reauthCheckinRules[target.origin],
        quotaEndpoint: "",
        quotaDomEvidence: null,
      },
    },
  }), /缺少额度接口或页面额度证据/);
  assert.throws(() => getConfiguredReauthRule(target, {
    reauthCheckinRules: {
      [target.origin]: {
        ...config.reauthCheckinRules[target.origin],
        loginSuccessStorageEvidence: { storage: "cookie", key: "user", field: "checked_in" },
      },
    },
  }), /登录成功证据配置无效/);
  assert.throws(() => getConfiguredReauthRule(target, {
    reauthCheckinRules: {
      [target.origin]: { ...config.reauthCheckinRules[target.origin], provider: "  " },
    },
  }), /缺少登录提供方/);
});

test("重认证保留配置的 OAuth 提供方并在失败时据实说明", () => {
  const githubRule = getConfiguredReauthRule(target, {
    reauthCheckinRules: {
      [target.origin]: { ...config.reauthCheckinRules[target.origin], provider: "GitHub" },
    },
  });
  assert.equal(githubRule.provider, "GitHub");
  assert.equal(reauthLoginFailureReason(githubRule.provider), "GitHub 重新登录未完成，需要人工处理");
});

test("退出前只在登录页明确展示冲突提供方时阻止重认证", () => {
  assert.equal(configuredProviderIsExplicitlyUnavailable("GitHub", ["使用 GitHub 登录", "使用 Linux DO 登录"]), false);
  assert.equal(configuredProviderIsExplicitlyUnavailable("GitHub", ["使用 Linux DO 登录", "使用 Google 登录"]), true);
  assert.equal(configuredProviderIsExplicitlyUnavailable("GitHub", ["账号密码登录", "注册"]), false);
});

test("额度证据只接受重新登录后的严格增加", () => {
  assert.deepEqual(classifyQuotaIncrease(100, 101), {
    status: "signed",
    reason: "重新登录后确认额度已到账",
  });
  assert.equal(classifyQuotaIncrease(100, 100).status, "needs_attention");
  assert.equal(classifyQuotaIncrease(100, 99).status, "needs_attention");
  assert.equal(classifyQuotaIncrease(undefined, 101).status, "needs_attention");
});

test("额度字段读取不依赖响应中的其他个人字段", () => {
  assert.equal(valueAtFieldPath({ data: { quota: 12, account: "private" } }, "data.quota"), 12);
  assert.equal(valueAtFieldPath({ data: {} }, "data.quota"), undefined);
});

test("页面额度文本只接受一个可解析数字", () => {
  assert.equal(parseQuotaDisplayText("$1,234.50"), 1234.5);
  assert.equal(parseQuotaDisplayText(" 42 Credit "), 42);
  assert.equal(parseQuotaDisplayText("余额 10，已用 2"), null);
  assert.equal(parseQuotaDisplayText("--"), null);
});

test("每日状态只保存日期、阶段和时间，不保存额度", () => {
  const entry = buildReauthStateEntry("20260729", "completed", new Date("2026-07-29T03:00:00.000Z"));
  assert.deepEqual(entry, {
    date: "20260729",
    status: "completed",
    updatedAt: "2026-07-29T03:00:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(entry), /quota|credit|balance|amount/i);
  assert.equal(buildReauthStateEntry("20260729", "logged_out").status, "logged_out");
});

test("Agent Router accounts use isolated profiles and state files", () => {
  const accounts = getConfiguredReauthAccounts(target, {
    ...config,
    agentrouterAccounts: [
      {
        origin: target.origin,
        accountId: "github",
        provider: "GitHub",
        automationUserDataDir: "data/edge-agentrouter-github",
        statePath: "data/agentrouter-github-state.json",
      },
      {
        origin: target.origin,
        accountId: "linuxdo",
        provider: "LinuxDO",
        automationUserDataDir: "data/edge-agentrouter-linuxdo",
        statePath: "data/agentrouter-linuxdo-state.json",
      },
    ],
  });
  assert.deepEqual(accounts.map((account) => [account.accountId, account.provider]), [
    ["github", "GitHub"],
    ["linuxdo", "LinuxDO"],
  ]);
  assert.notEqual(accounts[0].automationUserDataDir, accounts[1].automationUserDataDir);
  assert.notEqual(accounts[0].statePath, accounts[1].statePath);
});

test("Agent Router aggregation requires every account to have authoritative evidence", () => {
  assert.equal(aggregateReauthResults([
    { accountId: "github", status: "already_signed" },
    { accountId: "linuxdo", status: "signed" },
  ]).status, "signed");
  assert.equal(aggregateReauthResults([
    { accountId: "github", status: "signed" },
    { accountId: "linuxdo", status: "needs_attention" },
  ]).status, "needs_attention");
});

test("登录后额度异步增加时会继续轮询而不是采信第一次旧值", async () => {
  const snapshots = [100, 100, 101];
  const session = {
    page: {
      evaluate: async () => snapshots.shift() ?? 101,
      waitForTimeout: async () => {},
    },
  };
  const rule = {
    quotaEndpoint: "https://reauth.example/api/user/self",
    quotaField: "data.quota",
    evidenceWaitMs: 100,
  };
  assert.equal(await readQuotaUntilIncrease(session, rule, 100), 101);
});
