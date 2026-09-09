import { nativeChallengeFrameIsAllowed } from "./native-checkin-action.mjs";

export function isLinuxDoSsoProviderPage(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:"
      && url.hostname === "linux.do"
      && /^\/session\/sso_provider\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

async function visibleEnabledCandidates(locator) {
  const candidates = [];
  const count = Math.min(20, await locator.count().catch(() => 0));
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)
      && await candidate.isEnabled().catch(() => true)) candidates.push(candidate);
  }
  return candidates;
}

function addUniqueFrameBox(candidates, box) {
  if (!box
    || box.width < 180 || box.width > 500
    || box.height < 40 || box.height > 180) return;
  const duplicate = candidates.some((candidate) => (
    Math.abs(candidate.x - box.x) < 2
    && Math.abs(candidate.y - box.y) < 2
    && Math.abs(candidate.width - box.width) < 2
    && Math.abs(candidate.height - box.height) < 2
  ));
  if (!duplicate) candidates.push(box);
}

function isTransientNavigationError(error) {
  const message = String(error?.message ?? error ?? "");
  return /execution context was destroyed|frame was detached|target page, context or browser has been closed|navigation/i.test(message);
}

function currentPageUrl(page) {
  try {
    return page?.url?.() ?? "";
  } catch {
    return "";
  }
}

async function visibleChallengeFrame(frameElement, box) {
  if (!frameElement) return true;
  if (typeof frameElement.isVisible === "function"
    && !await frameElement.isVisible().catch(() => false)) return false;
  return !box || (box.width > 0 && box.height > 0);
}

async function findLinuxDoSsoChallengeControl(page) {
  const report = {
    applicable: isLinuxDoSsoProviderPage(page?.url?.()),
    frameCount: 0,
    directCandidateCount: 0,
    labelCandidateCount: 0,
    frameClickCandidateCount: 0,
  };
  if (!report.applicable || typeof page.frames !== "function") {
    return {
      ...report,
      candidate: null,
      frameClickCandidate: null,
      outcome: "not_applicable",
    };
  }

  const expectedOrigin = new URL(page.url()).origin;
  const directCandidates = [];
  const labelCandidates = [];
  const frameClickCandidates = [];
  for (const frame of page.frames()) {
    if (!nativeChallengeFrameIsAllowed(frame.url(), expectedOrigin)) continue;
    const frameElement = await frame.frameElement?.().catch(() => null);
    const frameBox = await frameElement?.boundingBox().catch(() => null);
    if (!await visibleChallengeFrame(frameElement, frameBox)) continue;
    report.frameCount += 1;
    addUniqueFrameBox(frameClickCandidates, frameBox);
    directCandidates.push(...await visibleEnabledCandidates(frame.locator([
      'input[type="checkbox"]',
      '[role="checkbox"]',
      '[aria-checked][tabindex]',
    ].join(", "))));

    const labels = frame.locator('label:has(input[type="checkbox"]), label[for]');
    const visibleLabels = await visibleEnabledCandidates(labels);
    for (const label of visibleLabels) {
      const associated = await label.evaluate((element) => {
        const control = element.control
          || (element.htmlFor ? document.getElementById(element.htmlFor) : null)
          || element.querySelector('input[type="checkbox"], [role="checkbox"], [aria-checked]');
        return Boolean(control?.matches?.(
          'input[type="checkbox"], [role="checkbox"], [aria-checked]',
        ));
      }).catch(() => false);
      if (associated) labelCandidates.push(label);
    }
  }

  if (typeof page.locator === "function") {
    const parentFrames = page.locator('iframe[src]');
    const parentFrameCount = Math.min(20, await parentFrames.count().catch(() => 0));
    for (let index = 0; index < parentFrameCount; index += 1) {
      const candidate = parentFrames.nth(index);
      const src = await candidate.getAttribute("src").catch(() => null);
      if (!nativeChallengeFrameIsAllowed(src, expectedOrigin)
        || !await candidate.isVisible().catch(() => false)) continue;
      addUniqueFrameBox(frameClickCandidates, await candidate.boundingBox().catch(() => null));
    }
  }

  report.directCandidateCount = directCandidates.length;
  report.labelCandidateCount = labelCandidates.length;
  report.frameClickCandidateCount = frameClickCandidates.length;
  if (report.frameCount !== 1) {
    return {
      ...report,
      candidate: null,
      frameClickCandidate: null,
      outcome: report.frameCount === 0 ? "challenge_not_found" : "challenge_frame_not_unique",
    };
  }
  const candidates = directCandidates.length > 0 ? directCandidates : labelCandidates;
  if (candidates.length !== 1) {
    return {
      ...report,
      candidate: null,
      frameClickCandidate: frameClickCandidates.length === 1 ? frameClickCandidates[0] : null,
      outcome: candidates.length === 0 ? "challenge_control_not_found" : "challenge_control_not_unique",
    };
  }
  return {
    ...report,
    candidate: candidates[0],
    frameClickCandidate: null,
    outcome: "challenge_control_found",
  };
}

export async function inspectLinuxDoSsoChallenge(page) {
  const { candidate, frameClickCandidate, ...report } = await findLinuxDoSsoChallengeControl(page);
  return report;
}

export async function clickUniqueLinuxDoSsoChallengeControl(page, {
  timeoutMs = 5_000,
  allowFrameCoordinateFallback = false,
} = {}) {
  const {
    candidate,
    frameClickCandidate,
    ...report
  } = await findLinuxDoSsoChallengeControl(page);
  if (candidate) {
    const clicked = await candidate.click({
      timeout: Math.max(1, Math.min(5_000, Number(timeoutMs) || 5_000)),
    }).then(() => true, () => false);
    return {
      ...report,
      clicked,
      outcome: clicked ? "challenge_control_clicked" : "challenge_control_click_failed",
    };
  }
  if (!allowFrameCoordinateFallback
    || !frameClickCandidate
    || !isLinuxDoSsoProviderPage(page.url())
    || typeof page.mouse?.click !== "function") return { ...report, clicked: false };

  const box = frameClickCandidate;
  const clicked = await page.mouse.click(
    box.x + Math.min(38, box.width * 0.15),
    box.y + box.height / 2,
  ).then(() => true, () => false);
  return {
    ...report,
    clicked,
    outcome: clicked ? "challenge_frame_clicked" : "challenge_frame_click_failed",
  };
}

export async function waitForLinuxDoSsoTransition(page, {
  timeoutMs = 60_000,
  pollMs = 500,
  onChallengeObserved = null,
  allowFrameCoordinateFallback = false,
  frameStableMs = 0,
} = {}) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const interval = Math.max(50, Number(pollMs) || 500);
  const requiredStableMs = Math.max(0, Math.min(5_000, Number(frameStableMs) || 0));
  let challengeObserved = false;
  let challengeClicked = false;
  let clickAttempted = false;
  let challengeOutcome = "not_observed";
  let previousFrameBox = null;
  let frameStableSince = 0;

  while (!page.isClosed?.() && isLinuxDoSsoProviderPage(currentPageUrl(page))) {
    let observation;
    try {
      observation = await inspectLinuxDoSsoChallenge(page);
    } catch (error) {
      // Turnstile navigation can detach the iframe while the provider page is
      // rebuilding its context. Treat that short window as transient and let
      // the next bounded poll inspect the new frame tree.
      if (!isTransientNavigationError(error)) throw error;
      previousFrameBox = null;
      frameStableSince = 0;
      if (Date.now() >= deadline) break;
      await page.waitForTimeout(Math.min(interval, Math.max(1, deadline - Date.now())));
      continue;
    }
    if (observation.frameCount > 0 && !challengeObserved) {
      challengeObserved = true;
      challengeOutcome = "observed_not_clickable";
      await onChallengeObserved?.(observation);
    }
    const frameBoxReady = observation.frameClickCandidateCount === 1;
    if (frameBoxReady) {
      const frameBox = await findLinuxDoSsoChallengeControl(page)
        .then(({ frameClickCandidate }) => frameClickCandidate)
        .catch((error) => {
          if (!isTransientNavigationError(error)) throw error;
          return null;
        });
      if (!frameBox) {
        previousFrameBox = null;
        frameStableSince = 0;
      } else if (!previousFrameBox
        || Math.abs(previousFrameBox.x - frameBox.x) >= 2
        || Math.abs(previousFrameBox.y - frameBox.y) >= 2
        || Math.abs(previousFrameBox.width - frameBox.width) >= 2
        || Math.abs(previousFrameBox.height - frameBox.height) >= 2) {
        previousFrameBox = frameBox;
        frameStableSince = Date.now();
      }
    } else {
      previousFrameBox = null;
      frameStableSince = 0;
    }
    const stableEnough = requiredStableMs === 0
      || (frameStableSince > 0 && Date.now() - frameStableSince >= requiredStableMs);
    if (!clickAttempted
      && observation.frameCount === 1
      && ((observation.directCandidateCount + observation.labelCandidateCount) > 0
        || (allowFrameCoordinateFallback && observation.frameClickCandidateCount === 1 && stableEnough))) {
      const result = await clickUniqueLinuxDoSsoChallengeControl(
        page,
        {
          timeoutMs: Math.max(1, deadline - Date.now()),
          allowFrameCoordinateFallback,
        },
      );
      if ([
        "challenge_control_clicked",
        "challenge_control_click_failed",
        "challenge_frame_clicked",
        "challenge_frame_click_failed",
      ].includes(result.outcome)) {
        clickAttempted = true;
        challengeClicked = result.clicked;
        challengeOutcome = {
          challenge_control_clicked: "semantic_clicked",
          challenge_control_click_failed: "click_failed",
          challenge_frame_clicked: "frame_clicked",
          challenge_frame_click_failed: "click_failed",
        }[result.outcome];
      }
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(Math.min(interval, Math.max(1, deadline - Date.now())));
  }

  const transitioned = !page.isClosed?.() && !isLinuxDoSsoProviderPage(currentPageUrl(page));
  if (transitioned && challengeObserved && !challengeClicked) {
    challengeOutcome = "observed_auto_resolved";
  }
  return {
    transitioned,
    challengeObserved,
    challengeClicked,
    challengeOutcome,
    timedOut: !page.isClosed?.() && isLinuxDoSsoProviderPage(page.url()),
  };
}
