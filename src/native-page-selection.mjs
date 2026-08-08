export function pagesForOrigin(pages, expectedOrigin) {
  return (pages ?? []).filter((page) => {
    try {
      return new URL(page.url()).origin === expectedOrigin;
    } catch {
      return false;
    }
  });
}

export function selectNewestOriginPage(pages, expectedOrigin) {
  return pagesForOrigin(pages, expectedOrigin).at(-1) ?? null;
}
