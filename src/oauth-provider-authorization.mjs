function configuredProviderAuthorizationKind(rawUrl, provider) {
  const normalizedProvider = String(provider).trim().toLowerCase().replace(/\s+/g, "");
  try {
    const url = new URL(rawUrl);
    if (normalizedProvider === "github" && url.protocol === "https:"
      && url.hostname === "github.com"
      && /^\/login\/oauth\/authorize\/?$/i.test(url.pathname)) return "github";
    if (normalizedProvider === "linuxdo" && url.protocol === "https:"
      && url.hostname === "connect.linux.do"
      && /^\/oauth2\/authorize\/?$/i.test(url.pathname)) return "linuxdo";
    return null;
  } catch {
    return null;
  }
}

export function isConfiguredProviderAuthorizationPage(rawUrl, provider) {
  return configuredProviderAuthorizationKind(rawUrl, provider) !== null;
}

export function selectLinuxDoAuthorizationControlIndex(labels) {
  if (!Array.isArray(labels) || labels.length === 0 || labels.length > 30) return -1;
  const allowPattern = /\u5141\u8bb8|\u5141\u8a31|authorize|approve|\u540c\u610f|\u6388\u6743|\u6388\u6b0a|\u786e\u8ba4|\u78ba\u8a8d|\u7ee7\u7eed|\u7e7c\u7e8c|continue|\u767b\u5f55|login|\u767b\u5165/i;
  const denyPattern = /cancel|\u53d6\u6d88|\u62d2\u7edd|deny|reject|\u4e0d\u540c\u610f|decline/i;
  const matches = labels
    .map((value, index) => ({ index, text: String(value ?? "").replace(/\s+/g, " ").trim() }))
    .filter((entry) => allowPattern.test(entry.text) && !denyPattern.test(entry.text));
  return matches.length === 1 ? matches[0].index : -1;
}

function countLinuxDoAuthorizationControls(labels) {
  if (!Array.isArray(labels) || labels.length === 0 || labels.length > 30) return 0;
  const allowPattern = /\u5141\u8bb8|\u5141\u8a31|authorize|approve|\u540c\u610f|\u6388\u6743|\u6388\u6b0a|\u786e\u8ba4|\u78ba\u8a8d|\u7ee7\u7eed|\u7e7c\u7e8c|continue|\u767b\u5f55|login|\u767b\u5165/i;
  const denyPattern = /cancel|\u53d6\u6d88|\u62d2\u7edd|deny|reject|\u4e0d\u540c\u610f|decline/i;
  return labels
    .map((value) => String(value ?? "").replace(/\s+/g, " ").trim())
    .filter((value) => allowPattern.test(value) && !denyPattern.test(value))
    .length;
}

async function findUniqueLinuxDoAuthorizationControl(page) {
  const candidates = [
    "\u786e\u8ba4",
    "\u786e\u8ba4\u6388\u6743",
    "\u78ba\u8a8d",
    "\u78ba\u8a8d\u6388\u6b0a",
  ].map((text) => ({
    text,
    locator: page.getByText(text, { exact: true }),
  }));
  const visibleMatches = [];
  for (const { locator } of candidates) {
    const count = await locator.count();
    if (count > 30) return { button: null, ambiguous: true };
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) visibleMatches.push(candidate);
    }
  }
  if (visibleMatches.length !== 1) {
    return { button: null, ambiguous: visibleMatches.length > 1 };
  }

  const exactText = visibleMatches[0];
  const clickableAncestor = exactText.locator(
    'xpath=ancestor-or-self::*[self::button or self::a or @role="button" or @onclick or @tabindex][1]',
  );
  if (await clickableAncestor.count() === 1
    && await clickableAncestor.first().isVisible().catch(() => false)) {
    return { button: clickableAncestor.first(), ambiguous: false };
  }
  // A non-semantic clickable wrapper still receives a bubbled pointer event
  // when its unique visible text node is clicked.
  return { button: exactText, ambiguous: false };
}

function linuxDoAuthorizationScopes(page) {
  const scopes = [page];
  if (typeof page.frames !== "function") return scopes;
  const mainFrame = typeof page.mainFrame === "function" ? page.mainFrame() : null;
  for (const frame of page.frames()) {
    if (!frame || frame === mainFrame) continue;
    try {
      const url = new URL(frame.url());
      if (url.protocol === "https:" && url.hostname === "connect.linux.do") scopes.push(frame);
    } catch {
      // Ignore detached or unparseable frames.
    }
  }
  return scopes;
}

function boundedCount(value) {
  return Math.max(0, Math.min(31, Number(value) || 0));
}

export async function describeConfiguredAuthorizationSurface(page, provider) {
  if (configuredProviderAuthorizationKind(page.url(), provider) !== "linuxdo") return null;
  const selector = 'button:visible, input[type="submit"]:visible, input[type="button"]:visible, [role="button"]:visible, a.btn:visible';
  const topControlCount = boundedCount(await page.locator(selector).count().catch(() => 0));
  let sameOriginFrameCount = 0;
  let sameOriginControlCount = 0;
  let challengeFrameCount = 0;
  if (typeof page.frames === "function") {
    const mainFrame = typeof page.mainFrame === "function" ? page.mainFrame() : null;
    for (const frame of page.frames()) {
      if (!frame || frame === mainFrame) continue;
      try {
        const url = new URL(frame.url());
        if (url.protocol === "https:" && url.hostname === "connect.linux.do") {
          sameOriginFrameCount += 1;
          sameOriginControlCount += await frame.locator(selector).count().catch(() => 0);
        } else if (url.protocol === "https:" && url.hostname === "challenges.cloudflare.com") {
          challengeFrameCount += 1;
        }
      } catch {
        // Ignore detached or unparseable frames.
      }
    }
  }
  return {
    topControlCount,
    sameOriginFrameCount: boundedCount(sameOriginFrameCount),
    sameOriginControlCount: boundedCount(sameOriginControlCount),
    challengeFrameCount: boundedCount(challengeFrameCount),
  };
}

async function findLinuxDoAuthorizationControl(scope) {
  const exactAuthorization = await findUniqueLinuxDoAuthorizationControl(scope);
  if (exactAuthorization.button || exactAuthorization.ambiguous) return exactAuthorization;

  const controls = scope.locator(
    'button:visible, input[type="submit"]:visible, input[type="button"]:visible, [role="button"]:visible, a.btn:visible',
  );
  const count = await controls.count();
  if (count === 0 || count > 30) {
    return { button: null, ambiguous: count > 30 };
  }
  const labels = await controls.evaluateAll((elements) => elements.map((element) => [
    element.innerText,
    element.textContent,
    element.value,
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
  ].filter(Boolean).join(" ")));
  const index = selectLinuxDoAuthorizationControlIndex(labels);
  if (index < 0) {
    return {
      button: null,
      ambiguous: countLinuxDoAuthorizationControls(labels) > 0,
    };
  }
  return { button: controls.nth(index), ambiguous: false };
}

async function clickAuthorizationControl(control) {
  try {
    await control.click({ timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function authorizeConfiguredOAuthProvider(page, provider) {
  const kind = configuredProviderAuthorizationKind(page.url(), provider);
  if (!kind) {
    return { applicable: false, clicked: false, outcome: "not_applicable" };
  }
  if (kind === "linuxdo") {
    const matches = [];
    for (const scope of linuxDoAuthorizationScopes(page)) {
      const match = await findLinuxDoAuthorizationControl(scope);
      if (match.ambiguous) {
        return { applicable: true, clicked: false, outcome: "authorization_not_unique" };
      }
      if (match.button) matches.push(match.button);
    }
    if (matches.length === 0) {
      return { applicable: true, clicked: false, outcome: "authorization_not_found" };
    }
    if (matches.length !== 1) {
      return { applicable: true, clicked: false, outcome: "authorization_not_unique" };
    }
    const clicked = await clickAuthorizationControl(matches[0]);
    return {
      applicable: true,
      clicked,
      outcome: clicked ? "authorization_clicked" : "authorization_click_failed",
    };
  }
  const controls = page.locator(
    'button[name="authorize"][type="submit"]:visible, input[name="authorize"][type="submit"]:visible',
  );
  const count = await controls.count();
  if (count === 0) return { applicable: true, clicked: false, outcome: "authorization_not_found" };
  if (count !== 1) return { applicable: true, clicked: false, outcome: "authorization_not_unique" };
  const clicked = await clickAuthorizationControl(controls.first());
  return {
    applicable: true,
    clicked,
    outcome: clicked ? "authorization_clicked" : "authorization_click_failed",
  };
}
