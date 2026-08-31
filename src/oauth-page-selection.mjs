function targetPageScore(rawUrl, expectedOrigin) {
  let location;
  try {
    location = new URL(String(rawUrl));
  } catch {
    return null;
  }
  if (location.origin !== expectedOrigin) return null;

  const loginPage = /\/(?:log[-_]?in|sign[-_]?in)(?:[/?#]|$)/i.test(location.href);
  const profilePage = /^\/(?:profile|console\/personal)(?:\/|$)/i.test(location.pathname);
  return (loginPage ? 0 : 100) + (profilePage ? 50 : 0);
}

export function selectPreferredOAuthTargetPage(pages, expectedOrigin) {
  let selected = null;
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    if (!page || (typeof page.isClosed === "function" && page.isClosed())) continue;
    let rawUrl;
    try { rawUrl = page.url(); } catch { continue; }
    const score = targetPageScore(rawUrl, expectedOrigin);
    if (score === null) continue;
    if (!selected || score > selected.score || (score === selected.score && index > selected.index)) {
      selected = { page, score, index };
    }
  }
  return selected?.page ?? null;
}
