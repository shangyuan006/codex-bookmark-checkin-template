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
} = {}) {
  const origin = new URL(expectedOrigin).origin;
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const interval = Math.max(10, Number(pollMs) || 250);

  do {
    const pages = context.pages().filter((page) => !page.isClosed?.());
    const candidates = preferredPage
      ? [preferredPage, ...pages.filter((page) => page !== preferredPage).reverse()]
      : pages.reverse();
    for (const page of candidates) {
      if (pageOrigin(page) === origin && await acceptPage(page)) return page;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now()))));
  } while (true);

  return null;
}
