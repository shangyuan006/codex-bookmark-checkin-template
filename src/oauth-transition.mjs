export async function waitForFirstTransition(candidates) {
  const pendingCandidates = [...candidates];
  if (pendingCandidates.length === 0) return null;

  return new Promise((resolve) => {
    let remaining = pendingCandidates.length;
    let resolved = false;

    const settle = (value) => {
      if (resolved) return;
      if (value != null) {
        resolved = true;
        resolve(value);
        return;
      }

      remaining -= 1;
      if (remaining === 0) resolve(null);
    };

    for (const candidate of pendingCandidates) {
      Promise.resolve(candidate).then(settle, () => settle(null));
    }
  });
}

export async function waitForUsableHttpsPage(page, {
  timeoutMs = 20_000,
  pollMs = 100,
} = {}) {
  if (!page || typeof page.url !== "function") return null;
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const interval = Math.max(10, Number(pollMs) || 100);

  do {
    if (page.isClosed?.()) return null;
    try {
      const location = new URL(page.url());
      if (location.protocol === "https:") return page;
    } catch {
      // A newly-created page can temporarily have no parseable URL.
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(
      resolve,
      Math.min(interval, Math.max(0, deadline - Date.now())),
    ));
  } while (true);

  return null;
}

function pageOrigin(page) {
  try {
    return new URL(page.url()).origin;
  } catch {
    return null;
  }
}

export async function waitForOriginPage(context, expectedOrigin, {
  timeoutMs = 30_000,
  pollMs = 250,
  preferredPage = null,
  acceptPage = () => true,
  onObservation = () => {},
  now = Date.now,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const origin = new URL(expectedOrigin).origin;
  const startedAt = now(), deadline = startedAt + Math.max(0, Number(timeoutMs) || 0);
  const interval = Math.max(10, Number(pollMs) || 250);
  let polls = 0;
  const observe = outcome => onObservation({ outcome, polls, elapsedMs: now() - startedAt });

  do {
    polls++;
    const pages = context.pages().filter((page) => !page.isClosed?.());
    const candidates = preferredPage
      ? [preferredPage, ...pages.filter((page) => page !== preferredPage).reverse()]
      : pages.reverse();
    for (const page of candidates) {
      if (pageOrigin(page) === origin && await acceptPage(page)) {
        observe('target_returned');
        return page;
      }
    }
    observe('waiting');
    if (now() >= deadline) break;
    await wait(Math.min(interval, Math.max(0, deadline - now())));
  } while (true);

  observe('target_not_returned');
  return null;
}
