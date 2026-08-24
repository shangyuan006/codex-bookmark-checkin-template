import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildReauthStateEntry,
  classifyQuotaIncrease,
  configuredProviderIsExplicitlyUnavailable,
  aggregateReauthResults,
  getConfiguredReauthAccounts,
  getConfiguredReauthRule,
  mergeSelectedReauthAccountResult,
  parseQuotaDisplayText,
  preferOAuthFailureStage,
  readQuotaUntilIncrease,
  reauthLoginFailureReason,
  runConfiguredReauthCheckin,
  selectConfiguredReauthAccount,
  valueAtFieldPath,
  withReauthAccountMetadata,
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
  assert.throws(() => getConfiguredReauthRule(target, {
    reauthCheckinRules: {
      [target.origin]: { ...config.reauthCheckinRules[target.origin], provider: "Personal Login" },
    },
  }), /allowed OAuth provider/);
});

test("重认证保留配置的 OAuth 提供方并在失败时据实说明", () => {
  const githubRule = getConfiguredReauthRule(target, {
    reauthCheckinRules: {
      [target.origin]: { ...config.reauthCheckinRules[target.origin], provider: "GitHub" },
    },
  });
  assert.equal(githubRule.provider, "GitHub");
  assert.equal(reauthLoginFailureReason(githubRule.provider), "GitHub 重新登录未完成，需要人工处理");
  assert.equal(
    reauthLoginFailureReason(githubRule.provider, "target_callback"),
    "GitHub 重新登录未完成（登录回调未返回目标站），需要人工处理",
  );
  assert.doesNotMatch(reauthLoginFailureReason(githubRule.provider, "private-page-text"), /private-page-text/);
});

test("OAuth retries retain a specific stage over a later generic helper failure", () => {
  assert.equal(preferOAuthFailureStage("linuxdo_session", "helper_failed"), "linuxdo_session");
  assert.equal(preferOAuthFailureStage("provider_button", "target_callback"), "target_callback");
  assert.equal(preferOAuthFailureStage(null, "helper_failed"), "helper_failed");
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
  assert.deepEqual(accounts.map((account) => [account.accountKey, account.provider]), [
    ["github", "GitHub"],
    ["linuxdo", "LinuxDO"],
  ]);
  assert.equal(accounts.some((account) => Object.hasOwn(account, "accountId")), false);
  assert.notEqual(accounts[0].automationUserDataDir, accounts[1].automationUserDataDir);
  assert.notEqual(accounts[0].statePath, accounts[1].statePath);
});

test("Agent Router account OAuth timing overrides stay account-scoped and bounded", () => {
  const [account] = getConfiguredReauthAccounts(target, {
    ...config,
    agentrouterAccounts: [{
      origin: target.origin,
      accountKey: "linuxdo",
      provider: "LinuxDO",
      oauthAttempts: 3,
      oauthRetryDelayMs: 5000,
      oauthWaitMs: 90000,
    }],
  });
  assert.deepEqual(
    [account.oauthAttempts, account.oauthRetryDelayMs, account.oauthWaitMs],
    [3, 5000, 90000],
  );
  assert.throws(() => getConfiguredReauthAccounts(target, {
    ...config,
    agentrouterAccounts: [{
      origin: target.origin,
      accountKey: "linuxdo",
      provider: "LinuxDO",
      oauthAttempts: 4,
    }],
  }), /oauthAttempts must be an integer from 1 to 3/);
});

test("Agent Router account origins fail closed instead of falling back to the default account", () => {
  for (const origin of ["not-a-url", `${target.origin}/private`, `http://${new URL(target.origin).host}`]) {
    assert.throws(() => getConfiguredReauthAccounts(target, {
      ...config,
      agentrouterAccounts: [{ origin, accountKey: "github", provider: "GitHub" }],
    }), /canonical HTTPS origin/);
  }
  assert.throws(() => getConfiguredReauthAccounts(target, {
    ...config,
    agentrouterAccounts: [null],
  }), /must be an object/);

  const [fallback] = getConfiguredReauthAccounts(target, {
    ...config,
    agentrouterAccounts: [{ origin: "https://other.example", accountKey: "other", provider: "GitHub" }],
  });
  assert.equal(fallback.accountKey, "default");
});

test("Agent Router account profiles and state files stay inside project data", () => {
  assert.throws(() => getConfiguredReauthAccounts(target, {
    ...config,
    agentrouterAccounts: [{
      origin: target.origin,
      accountKey: "github",
      provider: "GitHub",
      automationUserDataDir: "../outside-profile",
    }],
  }), /inside the project data directory/);
  assert.throws(() => getConfiguredReauthAccounts(target, {
    ...config,
    agentrouterAccounts: [{
      origin: target.origin,
      accountKey: "github",
      provider: "GitHub",
      statePath: "../outside-state.json",
    }],
  }), /inside the project data directory/);
  assert.throws(() => getConfiguredReauthAccounts(target, {
    ...config,
    automationUserDataDir: "../outside-default-profile",
    agentrouterAccounts: [],
  }), /inside the project data directory/);
});

test("Agent Router ignores free-text labels and keeps authoritative ids in memory only", () => {
  const [account] = getConfiguredReauthAccounts(target, {
    ...config,
    agentrouterAccounts: [{
      origin: target.origin,
      accountKey: "github",
      accountLabel: "Primary GitHub",
      provider: "GitHub",
      authoritativeAccountId: "site-user+42",
    }],
  });
  assert.equal(account.accountKey, "github");
  assert.equal(Object.hasOwn(account, "accountLabel"), false);
  assert.equal(account.accountId, "site-user+42");
  assert.equal(account.supplementalAccount, false);
  assert.match(account.automationUserDataDir, /edge-agentrouter-github$/);
  assert.match(account.statePath, /agentrouter-github-state\.json$/);
});

test("nested reauth results always carry account identity metadata", () => {
  const account = {
    origin: target.origin,
    accountKey: "github",
    provider: "GitHub",
    supplementalAccount: false,
  };
  assert.deepEqual(withReauthAccountMetadata({ status: "signed" }, account), {
    status: "signed",
    origin: target.origin,
    accountKey: "github",
    provider: "GitHub",
    supplementalAccount: false,
  });
  assert.equal(Object.hasOwn(withReauthAccountMetadata({ status: "signed" }, account), "accountId"), false);
  assert.equal(Object.hasOwn(withReauthAccountMetadata(
    { status: "signed", accountId: "must-not-persist", accountLabel: "must-not-persist" },
    { ...account, accountId: "verified-user" },
  ), "accountId"), false);
});

test("legacy accountId remains a key and explicit authoritative ids are validated", () => {
  assert.throws(() => getConfiguredReauthAccounts(target, {
    ...config,
    agentrouterAccounts: [{
      origin: target.origin,
      accountKey: "github",
      accountId: "linuxdo",
      provider: "GitHub",
    }],
  }), /legacy agentrouter accountId/);
  assert.throws(() => getConfiguredReauthAccounts(target, {
    ...config,
    agentrouterAccounts: [{
      origin: target.origin,
      accountKey: "github",
      provider: "GitHub",
      siteAccountId: "one",
      authoritativeAccountId: "two",
    }],
  }), /conflicts/);
});

test("account selection accepts accountKey and the legacy accountId option", () => {
  const accounts = getConfiguredReauthAccounts(target, {
    ...config,
    agentrouterAccounts: [
      { origin: target.origin, accountKey: "github", provider: "GitHub", authoritativeAccountId: "site-user+42" },
      { origin: target.origin, accountId: "linuxdo", provider: "LinuxDO" },
    ],
  });
  assert.equal(selectConfiguredReauthAccount(accounts, { accountKey: "github" }).accountKey, "github");
  assert.equal(selectConfiguredReauthAccount(accounts, { accountId: "linuxdo" }).accountKey, "linuxdo");
  assert.equal(selectConfiguredReauthAccount(accounts, { accountId: "site-user+42" }).accountKey, "github");
  assert.throws(() => selectConfiguredReauthAccount(
    accounts,
    { accountKey: "github", accountId: "linuxdo" },
  ), /Unknown or ambiguous/);
});

test("per-account progress callback receives sanitized nested snapshots", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "reauth-progress-"));
  const statePath = path.join(temporaryDirectory, "state.json");
  const now = new Date("2026-07-29T03:00:00.000Z");
  await fs.writeFile(statePath, JSON.stringify({
    version: 2,
    entries: {
      [`${target.origin}::github`]: { date: "20260729", status: "completed", updatedAt: now.toISOString() },
      [`${target.origin}::linuxdo`]: { date: "20260729", status: "completed", updatedAt: now.toISOString() },
    },
  }), "utf8");
  try {
    const snapshots = [];
    const result = await runConfiguredReauthCheckin(target, {
      ...config,
      agentrouterAccounts: [
        {
          origin: target.origin,
          accountKey: "github",
          accountLabel: "Private primary",
          provider: "GitHub",
          authoritativeAccountId: "private-one",
        },
        { origin: target.origin, accountId: "linuxdo", provider: "LinuxDO" },
      ],
    }, {
      now,
      statePath,
      onAccountResult: async (accountResult, completedResults, accounts) => {
        snapshots.push({ accountResult, completedResults, accounts });
        accountResult.status = "mutated-by-callback";
        completedResults[0].status = "mutated-by-callback";
      },
    });
    assert.equal(result.accountResults.length, 2);
    assert.deepEqual(result.accountResults.map((entry) => entry.status), ["already_signed", "already_signed"]);
    assert.deepEqual(snapshots.map((snapshot) => snapshot.completedResults.length), [1, 2]);
    assert.deepEqual(snapshots.map((snapshot) => snapshot.accounts.length), [2, 2]);
    assert.equal(snapshots[0].accountResult.accountKey, "github");
    assert.equal(snapshots[1].accountResult.supplementalAccount, true);
    assert.equal(JSON.stringify(snapshots).includes("private-one"), false);
    assert.equal(JSON.stringify(snapshots).includes("Private primary"), false);
    assert.equal(snapshots.flatMap((snapshot) => snapshot.accounts)
      .some((account) => Object.hasOwn(account, "accountId")), false);
    assert.equal(snapshots.flatMap((snapshot) => snapshot.accounts)
      .some((account) => Object.hasOwn(account, "accountLabel")), false);
    assert.equal(result.accountResults.some((entry) => Object.hasOwn(entry, "accountId")), false);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("progress callback errors propagate without rewriting a successful account result", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "reauth-progress-error-"));
  const statePath = path.join(temporaryDirectory, "state.json");
  const now = new Date("2026-07-29T03:00:00.000Z");
  await fs.writeFile(statePath, JSON.stringify({
    version: 2,
    entries: {
      [`${target.origin}::github`]: { date: "20260729", status: "completed", updatedAt: now.toISOString() },
    },
  }), "utf8");
  const observed = [];
  try {
    await assert.rejects(runConfiguredReauthCheckin(target, {
      ...config,
      agentrouterAccounts: [{ origin: target.origin, accountKey: "github", provider: "GitHub" }],
    }, {
      now,
      statePath,
      onAccountResult: async (accountResult) => {
        observed.push(accountResult.status);
        throw new Error("progress write failed");
      },
    }), /progress write failed/);
    assert.deepEqual(observed, ["already_signed"]);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("Agent Router closes configured overlays before opening the account menu", async () => {
  const source = await fs.readFile(new URL("../src/reauth-checkin.mjs", import.meta.url), "utf8");
  const dismissIndex = source.indexOf("await dismissConfiguredPreCheckinOverlay(");
  const accountMenuIndex = source.indexOf("beforeSession.page.locator(rule.accountMenuSelector)");
  assert.notEqual(dismissIndex, -1);
  assert.notEqual(accountMenuIndex, -1);
  assert.ok(dismissIndex < accountMenuIndex);
});

test("Agent Router completes one LinuxDO provider stage before opening the target page", async () => {
  const source = await fs.readFile(new URL("../src/reauth-checkin.mjs", import.meta.url), "utf8");
  const providerRecoveryIndex = source.indexOf("await runProviderOnlyWithRetry(rule, accountConfig, rule)");
  const openIndex = source.indexOf("beforeSession = await openRulePage(accountConfig, rule)");
  const stateIndex = source.indexOf('buildReauthStateEntry(date, "started", now)');
  assert.ok(providerRecoveryIndex >= 0 && providerRecoveryIndex < openIndex && openIndex < stateIndex);
  assert.equal(source.includes("probeConfiguredProviderSession"), false);
  assert.match(source, /isLinuxDoProvider/);
  assert.match(source, /provider-only helper is the single authoritative LinuxDO stage/);
});

test("LinuxDO provider recovery uses one bounded native refresh before Agent Router", async () => {
  const source = await fs.readFile(new URL("../src/reauth-checkin.mjs", import.meta.url), "utf8");
  const initialProbe = source.indexOf("const providerResult = await retryOAuthOperation(");
  const nativeRefresh = source.indexOf("await runNativeProviderSessionRefresh(config, account)", initialProbe);
  const refreshedProbe = source.indexOf("const refreshedResult = await runOAuthHelper", nativeRefresh);
  const targetOpen = source.indexOf("beforeSession = await openRulePage(accountConfig, rule)");
  assert.ok(initialProbe >= 0 && nativeRefresh > initialProbe && refreshedProbe > nativeRefresh);
  assert.ok(targetOpen > refreshedProbe);
  assert.match(source, /Refresh-AgentRouterProviderSession\.ps1/);
  assert.match(source, /timeout: 70_000/);
});

test("LinuxDO automatic OAuth recovery runs provider and Agent Router phases sequentially", async () => {
  const source = await fs.readFile(new URL("../src/reauth-checkin.mjs", import.meta.url), "utf8");
  const providerPhase = source.indexOf('["--provider-only"]');
  const agentRouterPhase = source.indexOf('["--agent-router-only"]');
  assert.ok(providerPhase >= 0 && agentRouterPhase > providerPhase);
  const postLogoutPhase = source.indexOf("const oauthResult = normalizeReauthProvider(rule.provider");
  assert.ok(postLogoutPhase > stateIndex(source, 'buildReauthStateEntry(date, "logged_out", new Date())'));
  assert.match(source, /runAgentRouterOnlyWithRetry\(rule, accountConfig, rule\)/);
  assert.match(source, /same encrypted browser profile/);

  const oauth = await fs.readFile(new URL("../src/oauth-login.mjs", import.meta.url), "utf8");
  assert.match(oauth, /const providerOnly = process\.argv\.includes\("--provider-only"\)/);
  assert.match(oauth, /const agentRouterOnly = process\.argv\.includes\("--agent-router-only"\)/);
  assert.match(oauth, /https:\/\/linux\.do\/session\/current\.json/);
  assert.match(oauth, /async function waitForLinuxDoSession/);
  assert.match(oauth, /waitForLinuxDoSession\(providerPage, 2\)/);
  assert.match(oauth, /await providerPage\.waitForTimeout\(Math\.min\(2_500, providerWaitMs\)\)/);
  assert.match(oauth, /if \(!await waitForLinuxDoSession\(page\)\)/);
  assert.match(oauth, /destinationPage !== currentPage/);
  const providerFlowStart = oauth.indexOf("async function runProviderOnlyFlow");
  const providerFlowEnd = oauth.indexOf("if (providerOnly)", providerFlowStart);
  const providerFlow = oauth.slice(providerFlowStart, providerFlowEnd);
  assert.match(providerFlow, /await providerContext\.close\(\);/);
  assert.doesNotMatch(providerFlow, /providerContext\.close\(\)\.catch/);
});

function stateIndex(source, expression) {
  return source.indexOf(expression);
}

test("Agent Router aggregation requires every account to have authoritative evidence", () => {
  const successful = aggregateReauthResults([
    {
      accountKey: "github",
      accountId: "must-not-persist",
      accountLabel: "must-not-persist",
      provider: "github",
      status: "already_signed",
    },
    { accountKey: "linuxdo", status: "signed" },
  ]);
  assert.equal(successful.status, "signed");
  assert.equal(successful.accountResults.some((result) => Object.hasOwn(result, "accountId")), false);
  assert.equal(successful.accountResults.some((result) => Object.hasOwn(result, "accountLabel")), false);
  assert.equal(successful.accountResults[0].provider, "GitHub");
  assert.equal(aggregateReauthResults([
    { accountKey: "github", status: "already_signed" },
    { accountKey: "linuxdo", status: "signed" },
  ]).status, "signed");
  assert.equal(aggregateReauthResults([
    { accountKey: "github", status: "signed" },
    { accountKey: "linuxdo", status: "needs_attention" },
  ]).status, "needs_attention");
});

test("single-account completion preserves the other account from the current daily report", () => {
  const accounts = [
    { origin: target.origin, accountKey: "github", provider: "GitHub" },
    { origin: target.origin, accountKey: "linuxdo", provider: "LinuxDO" },
  ];
  const merged = mergeSelectedReauthAccountResult(accounts, {
    accountResults: [
      { accountKey: "github", provider: "GitHub", status: "already_signed" },
      { accountKey: "linuxdo", provider: "LinuxDO", status: "needs_attention" },
    ],
  }, {
    accountKey: "linuxdo",
    provider: "LinuxDO",
    status: "signed",
  });
  assert.equal(merged.status, "signed");
  assert.deepEqual(merged.accountResults.map((entry) => [entry.accountKey, entry.status]), [
    ["github", "already_signed"],
    ["linuxdo", "signed"],
  ]);
});

test("single-account completion fails closed when the other daily account result is missing", () => {
  const merged = mergeSelectedReauthAccountResult([
    { origin: target.origin, accountKey: "github", provider: "GitHub" },
    { origin: target.origin, accountKey: "linuxdo", provider: "LinuxDO" },
  ], null, {
    accountKey: "linuxdo",
    provider: "LinuxDO",
    status: "signed",
  });
  assert.equal(merged.status, "needs_attention");
  assert.equal(merged.accountResults.find((entry) => entry.accountKey === "github").status, "needs_attention");
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
