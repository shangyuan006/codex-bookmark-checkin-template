import test from "node:test";
import assert from "node:assert/strict";
import {
  authorizeConfiguredOAuthProvider,
  describeConfiguredAuthorizationSurface,
  isConfiguredProviderAuthorizationPage,
  selectLinuxDoAuthorizationControlIndex,
} from "../src/oauth-provider-authorization.mjs";

function page(url, count, labels = [], exactTextCandidates = {}) {
  let clicks = 0;
  return {
    url: () => url,
    getByText: (text, options) => {
      const configured = options?.exact ? (exactTextCandidates[text] ?? 0) : 0;
      const visibility = Array.isArray(configured)
        ? configured
        : Array.from({ length: configured }, () => true);
      return {
        count: async () => visibility.length,
        nth: (index) => ({
          isVisible: async () => Boolean(visibility[index]),
          click: async () => { clicks += 1; },
          locator: () => ({
            count: async () => 0,
            first: () => ({ isVisible: async () => false }),
          }),
        }),
      };
    },
    locator: (selector) => ({
      count: async () => count,
      first: () => ({ click: async () => { clicks += 1; } }),
      nth: () => ({ click: async () => { clicks += 1; } }),
      evaluateAll: async () => labels,
      selector,
    }),
    clicks: () => clicks,
  };
}

test("GitHub OAuth authorization is restricted to its exact HTTPS page", () => {
  assert.equal(isConfiguredProviderAuthorizationPage(
    "https://github.com/login/oauth/authorize?client_id=public",
    "GitHub",
  ), true);
  assert.equal(isConfiguredProviderAuthorizationPage("https://github.com/login", "GitHub"), false);
  assert.equal(isConfiguredProviderAuthorizationPage(
    "https://github.example/login/oauth/authorize",
    "GitHub",
  ), false);
  assert.equal(isConfiguredProviderAuthorizationPage(
    "http://github.com/login/oauth/authorize",
    "GitHub",
  ), false);
  assert.equal(isConfiguredProviderAuthorizationPage(
    "https://github.com/login/oauth/authorize",
    "LinuxDO",
  ), false);
});

test("LinuxDO authorization is restricted to its exact HTTPS Connect page", () => {
  assert.equal(isConfiguredProviderAuthorizationPage(
    "https://connect.linux.do/oauth2/authorize?client_id=public",
    "LinuxDO",
  ), true);
  assert.equal(isConfiguredProviderAuthorizationPage(
    "https://connect.linux.do/oauth2/token",
    "LinuxDO",
  ), false);
  assert.equal(isConfiguredProviderAuthorizationPage(
    "https://linux.do/oauth2/authorize",
    "LinuxDO",
  ), false);
  assert.equal(isConfiguredProviderAuthorizationPage(
    "http://connect.linux.do/oauth2/authorize",
    "LinuxDO",
  ), false);
});

test("LinuxDO OAuth selects one allow action and rejects deny or ambiguity", async () => {
  assert.equal(selectLinuxDoAuthorizationControlIndex(["取消", "继续并允许访问"]), 1);
  assert.equal(selectLinuxDoAuthorizationControlIndex(["取消", "確認授權"]), 1);
  assert.equal(selectLinuxDoAuthorizationControlIndex(["Cancel", "Continue"]), 1);
  assert.equal(selectLinuxDoAuthorizationControlIndex(["拒绝", "取消"]), -1);
  assert.equal(selectLinuxDoAuthorizationControlIndex(["允许", "确认授权"]), -1);

  const unique = page(
    "https://connect.linux.do/oauth2/authorize?client_id=public",
    2,
    ["取消", "继续并允许访问"],
  );
  assert.deepEqual(await authorizeConfiguredOAuthProvider(unique, "LinuxDO"), {
    applicable: true,
    clicked: true,
    outcome: "authorization_clicked",
  });
  assert.equal(unique.clicks(), 1);

  const nonStandardExactControl = page(
    "https://connect.linux.do/oauth2/authorize?client_id=public",
    0,
    [],
    { "确认授权": 1 },
  );
  assert.deepEqual(await authorizeConfiguredOAuthProvider(nonStandardExactControl, "LinuxDO"), {
    applicable: true,
    clicked: true,
    outcome: "authorization_clicked",
  });
  assert.equal(nonStandardExactControl.clicks(), 1);

  const exactConfirm = page(
    "https://connect.linux.do/oauth2/authorize?client_id=public",
    0,
    [],
    { "确认": 1 },
  );
  assert.deepEqual(await authorizeConfiguredOAuthProvider(exactConfirm, "LinuxDO"), {
    applicable: true,
    clicked: true,
    outcome: "authorization_clicked",
  });
  assert.equal(exactConfirm.clicks(), 1);

  const exactTraditionalConfirm = page(
    "https://connect.linux.do/oauth2/authorize?client_id=public",
    0,
    [],
    { "確認": 1 },
  );
  assert.deepEqual(await authorizeConfiguredOAuthProvider(exactTraditionalConfirm, "LinuxDO"), {
    applicable: true,
    clicked: true,
    outcome: "authorization_clicked",
  });
  assert.equal(exactTraditionalConfirm.clicks(), 1);

  const ambiguousConfirm = page(
    "https://connect.linux.do/oauth2/authorize?client_id=public",
    0,
    [],
    { "确认": 2 },
  );
  assert.deepEqual(await authorizeConfiguredOAuthProvider(ambiguousConfirm, "LinuxDO"), {
    applicable: true,
    clicked: false,
    outcome: "authorization_not_unique",
  });
  assert.equal(ambiguousConfirm.clicks(), 0);

  const visibleConfirmWithHiddenDuplicate = page(
    "https://connect.linux.do/oauth2/authorize?client_id=public",
    0,
    [],
    { "确认": [true, false] },
  );
  assert.deepEqual(await authorizeConfiguredOAuthProvider(visibleConfirmWithHiddenDuplicate, "LinuxDO"), {
    applicable: true,
    clicked: true,
    outcome: "authorization_clicked",
  });
  assert.equal(visibleConfirmWithHiddenDuplicate.clicks(), 1);

  const wrongOrigin = page(
    "https://example.com/oauth2/authorize",
    0,
    [],
    { "确认": 1 },
  );
  assert.deepEqual(await authorizeConfiguredOAuthProvider(wrongOrigin, "LinuxDO"), {
    applicable: false,
    clicked: false,
    outcome: "not_applicable",
  });
  assert.equal(wrongOrigin.clicks(), 0);
});

test("GitHub OAuth clicks only one explicit authorize submit control", async () => {
  const unique = page("https://github.com/login/oauth/authorize?client_id=public", 1);
  assert.deepEqual(await authorizeConfiguredOAuthProvider(unique, "GitHub"), {
    applicable: true,
    clicked: true,
    outcome: "authorization_clicked",
  });
  assert.equal(unique.clicks(), 1);

  for (const count of [0, 2]) {
    const ambiguous = page("https://github.com/login/oauth/authorize?client_id=public", count);
    const result = await authorizeConfiguredOAuthProvider(ambiguous, "GitHub");
    assert.equal(result.clicked, false);
    assert.equal(ambiguous.clicks(), 0);
  }
});

test("LinuxDO OAuth accepts one same-origin frame and ignores cross-origin frames", async () => {
  const mainFrame = { url: () => "https://connect.linux.do/oauth2/authorize" };
  const sameOriginFrame = page(
    "https://connect.linux.do/oauth2/authorize/consent",
    0,
    [],
    { "确认": 1 },
  );
  const crossOriginFrame = page(
    "https://challenges.cloudflare.com/turnstile",
    0,
    [],
    { "确认": 1 },
  );
  const top = page(
    "https://connect.linux.do/oauth2/authorize?client_id=public",
    0,
  );
  top.mainFrame = () => mainFrame;
  top.frames = () => [mainFrame, crossOriginFrame, sameOriginFrame];

  assert.deepEqual(await authorizeConfiguredOAuthProvider(top, "LinuxDO"), {
    applicable: true,
    clicked: true,
    outcome: "authorization_clicked",
  });
  assert.equal(top.clicks(), 0);
  assert.equal(crossOriginFrame.clicks(), 0);
  assert.equal(sameOriginFrame.clicks(), 1);
});

test("LinuxDO OAuth fails closed when top page and same-origin frame both match", async () => {
  const mainFrame = { url: () => "https://connect.linux.do/oauth2/authorize" };
  const sameOriginFrame = page(
    "https://connect.linux.do/oauth2/authorize/consent",
    0,
    [],
    { "确认": 1 },
  );
  const top = page(
    "https://connect.linux.do/oauth2/authorize?client_id=public",
    0,
    [],
    { "确认": 1 },
  );
  top.mainFrame = () => mainFrame;
  top.frames = () => [mainFrame, sameOriginFrame];

  assert.deepEqual(await authorizeConfiguredOAuthProvider(top, "LinuxDO"), {
    applicable: true,
    clicked: false,
    outcome: "authorization_not_unique",
  });
  assert.equal(top.clicks(), 0);
  assert.equal(sameOriginFrame.clicks(), 0);
});

test("LinuxDO authorization surface diagnostics expose counts but no page content", async () => {
  const mainFrame = { url: () => "https://connect.linux.do/oauth2/authorize" };
  const sameOriginFrame = page("https://connect.linux.do/consent", 2);
  const challengeFrame = page("https://challenges.cloudflare.com/turnstile", 1);
  const top = page("https://connect.linux.do/oauth2/authorize?private=query", 3);
  top.mainFrame = () => mainFrame;
  top.frames = () => [mainFrame, sameOriginFrame, challengeFrame];

  assert.deepEqual(await describeConfiguredAuthorizationSurface(top, "LinuxDO"), {
    topControlCount: 3,
    sameOriginFrameCount: 1,
    sameOriginControlCount: 2,
    challengeFrameCount: 1,
  });
  assert.equal(await describeConfiguredAuthorizationSurface(top, "GitHub"), null);
});
