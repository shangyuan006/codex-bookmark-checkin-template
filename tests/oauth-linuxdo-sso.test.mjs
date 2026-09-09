import assert from "node:assert/strict";
import test from "node:test";
import {
  clickUniqueLinuxDoSsoChallengeControl,
  inspectLinuxDoSsoChallenge,
  isLinuxDoSsoProviderPage,
  waitForLinuxDoSsoTransition,
} from "../src/oauth-linuxdo-sso.mjs";

function locator(candidates = []) {
  return {
    count: async () => candidates.length,
    nth: (index) => candidates[index],
  };
}

function control({ associated = false, click = () => {} } = {}) {
  return {
    isVisible: async () => true,
    isEnabled: async () => true,
    evaluate: async () => associated,
    click: async () => click(),
  };
}

function challengeFrame({
  url = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile",
  direct = [],
  labels = [],
  box = null,
} = {}) {
  return {
    url: () => url,
    locator: (selector) => selector.startsWith("label:") ? locator(labels) : locator(direct),
    frameElement: async () => ({ boundingBox: async () => box }),
  };
}

function ssoPage(frames, {
  onWait = () => {},
  onMouseClick = () => {},
  initialUrl = "https://linux.do/session/sso_provider",
} = {}) {
  let currentUrl = initialUrl;
  return {
    url: () => currentUrl,
    setUrl: (value) => { currentUrl = value; },
    isClosed: () => false,
    frames: () => frames,
    locator: () => locator(),
    mouse: { click: async (x, y) => onMouseClick(x, y) },
    waitForTimeout: async () => onWait(),
  };
}

test("LinuxDO SSO helper is restricted to the exact HTTPS transition page", () => {
  assert.equal(isLinuxDoSsoProviderPage("https://linux.do/session/sso_provider"), true);
  assert.equal(isLinuxDoSsoProviderPage("https://linux.do/session/sso_provider?return=oauth"), true);
  assert.equal(isLinuxDoSsoProviderPage("https://linux.do/session/current.json"), false);
  assert.equal(isLinuxDoSsoProviderPage("http://linux.do/session/sso_provider"), false);
  assert.equal(isLinuxDoSsoProviderPage("https://evil.example/session/sso_provider"), false);
});

test("LinuxDO SSO clicks one visible semantic Cloudflare checkbox", async () => {
  let clicks = 0;
  const checkbox = control({ click: () => { clicks += 1; } });
  const page = ssoPage([challengeFrame({ direct: [checkbox] })]);

  const result = await clickUniqueLinuxDoSsoChallengeControl(page);
  assert.equal(result.clicked, true);
  assert.equal(result.outcome, "challenge_control_clicked");
  assert.equal(result.frameCount, 1);
  assert.equal(result.directCandidateCount, 1);
  assert.equal(clicks, 1);
});

test("LinuxDO SSO never guesses coordinates when the frame exposes no control", async () => {
  const page = ssoPage([challengeFrame()]);

  assert.deepEqual(await inspectLinuxDoSsoChallenge(page), {
    applicable: true,
    frameCount: 1,
    directCandidateCount: 0,
    labelCandidateCount: 0,
    frameClickCandidateCount: 0,
    outcome: "challenge_control_not_found",
  });
  const result = await clickUniqueLinuxDoSsoChallengeControl(page);
  assert.equal(result.clicked, false);
  assert.equal(result.outcome, "challenge_control_not_found");
});

test("LinuxDO SSO coordinate fallback is opt-in and bounded to one valid frame", async () => {
  const clicks = [];
  const page = ssoPage([
    challengeFrame({ box: { x: 100, y: 200, width: 300, height: 80 } }),
  ], {
    onMouseClick: (x, y) => clicks.push({ x, y }),
  });

  const strict = await clickUniqueLinuxDoSsoChallengeControl(page);
  assert.equal(strict.clicked, false);
  assert.equal(strict.frameClickCandidateCount, 1);
  assert.equal(clicks.length, 0);

  const experimental = await clickUniqueLinuxDoSsoChallengeControl(page, {
    allowFrameCoordinateFallback: true,
  });
  assert.equal(experimental.clicked, true);
  assert.equal(experimental.outcome, "challenge_frame_clicked");
  assert.deepEqual(clicks, [{ x: 138, y: 240 }]);
});

test("LinuxDO SSO coordinate fallback rejects implausible frame dimensions", async () => {
  let clicks = 0;
  const page = ssoPage([
    challengeFrame({ box: { x: 10, y: 10, width: 800, height: 300 } }),
  ], {
    onMouseClick: () => { clicks += 1; },
  });

  const result = await clickUniqueLinuxDoSsoChallengeControl(page, {
    allowFrameCoordinateFallback: true,
  });
  assert.equal(result.clicked, false);
  assert.equal(result.frameClickCandidateCount, 0);
  assert.equal(clicks, 0);
});

test("LinuxDO SSO fails closed for multiple Cloudflare frames", async () => {
  let clicks = 0;
  const checkbox = control({ click: () => { clicks += 1; } });
  const page = ssoPage([
    challengeFrame({ direct: [checkbox] }),
    challengeFrame({ url: "https://challenges.cloudflare.com/second", direct: [checkbox] }),
  ]);

  const result = await clickUniqueLinuxDoSsoChallengeControl(page);
  assert.equal(result.clicked, false);
  assert.equal(result.outcome, "challenge_frame_not_unique");
  assert.equal(clicks, 0);
});

test("LinuxDO SSO ignores hidden zero-size challenge frames", async () => {
  let clicks = 0;
  const checkbox = control({ click: () => { clicks += 1; } });
  const page = ssoPage([
    challengeFrame({ box: { x: 0, y: 0, width: 0, height: 0 } }),
    challengeFrame({ direct: [checkbox] }),
  ]);
  const result = await inspectLinuxDoSsoChallenge(page);
  assert.equal(result.frameCount, 1);
  assert.equal(result.directCandidateCount, 1);
  assert.equal((await clickUniqueLinuxDoSsoChallengeControl(page)).clicked, true);
  assert.equal(clicks, 1);
});

test("LinuxDO SSO waits in the same page until the provider advances", async () => {
  let waits = 0;
  let observations = 0;
  const page = ssoPage([challengeFrame()], {
    onWait: () => {
      waits += 1;
      if (waits === 2) page.setUrl("https://connect.linux.do/oauth2/authorize");
    },
  });

  const result = await waitForLinuxDoSsoTransition(page, {
    timeoutMs: 1_000,
    pollMs: 50,
    onChallengeObserved: () => { observations += 1; },
  });
  assert.deepEqual(result, {
    transitioned: true,
    challengeObserved: true,
    challengeClicked: false,
    challengeOutcome: "observed_auto_resolved",
    timedOut: false,
  });
  assert.equal(observations, 1);
});

test("LinuxDO SSO clicks a unique semantic control at most once while waiting", async () => {
  let clicks = 0;
  let page;
  const checkbox = control({ click: () => {
    clicks += 1;
    page.setUrl("https://connect.linux.do/oauth2/authorize");
  } });
  page = ssoPage([challengeFrame({ direct: [checkbox] })]);

  const result = await waitForLinuxDoSsoTransition(page, { timeoutMs: 1_000, pollMs: 50 });
  assert.equal(result.transitioned, true);
  assert.equal(result.challengeObserved, true);
  assert.equal(result.challengeClicked, true);
  assert.equal(result.challengeOutcome, "semantic_clicked");
  assert.equal(clicks, 1);
});

test("LinuxDO SSO experimental wait reports a bounded frame click", async () => {
  let page;
  let clicks = 0;
  page = ssoPage([
    challengeFrame({ box: { x: 40, y: 60, width: 300, height: 80 } }),
  ], {
    onMouseClick: () => {
      clicks += 1;
      page.setUrl("https://connect.linux.do/oauth2/authorize");
    },
  });

  const result = await waitForLinuxDoSsoTransition(page, {
    timeoutMs: 1_000,
    pollMs: 50,
    allowFrameCoordinateFallback: true,
  });
  assert.equal(result.transitioned, true);
  assert.equal(result.challengeClicked, true);
  assert.equal(result.challengeOutcome, "frame_clicked");
  assert.equal(clicks, 1);
});

test("LinuxDO SSO ignores a transient detached-frame evaluation", async () => {
  let threw = false;
  let waits = 0;
  let page;
  const frames = [challengeFrame()];
  page = ssoPage(frames, {
    onWait: () => {
      waits += 1;
      if (waits === 2) page.setUrl("https://connect.linux.do/oauth2/authorize");
    },
  });
  const originalFrames = page.frames;
  page.frames = () => {
    if (!threw) {
      threw = true;
      throw new Error("Execution context was destroyed, most likely because of a navigation");
    }
    return originalFrames();
  };

  const result = await waitForLinuxDoSsoTransition(page, { timeoutMs: 1_000, pollMs: 50 });
  assert.equal(result.transitioned, true);
  assert.equal(result.challengeObserved, true);
  assert.equal(result.challengeOutcome, "observed_auto_resolved");
});

test("LinuxDO SSO waits for a configured stable frame before coordinate fallback", async () => {
  let clicks = 0;
  const page = ssoPage([
    challengeFrame({ box: { x: 40, y: 60, width: 300, height: 80 } }),
  ], {
    onMouseClick: () => {
      clicks += 1;
      page.setUrl("https://connect.linux.do/oauth2/authorize");
    },
    onWait: () => new Promise((resolve) => setTimeout(resolve, 40)),
  });

  const result = await waitForLinuxDoSsoTransition(page, {
    timeoutMs: 1_000,
    pollMs: 20,
    frameStableMs: 100,
    allowFrameCoordinateFallback: true,
  });
  assert.equal(result.transitioned, true);
  assert.equal(result.challengeClicked, true);
  assert.equal(result.challengeOutcome, "frame_clicked");
  assert.equal(clicks, 1);
});
