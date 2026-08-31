function normalizedText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function selectOAuthProviderControlIndex(labels, provider) {
  const expected = normalizedText(provider).toLowerCase();
  if (!expected || !Array.isArray(labels)) return -1;
  const actionPattern = /continue|sign\s*in|log\s*in|login|\u7ee7\u7eed|\u7e7c\u7e8c|\u767b\u5f55|\u767b\u9304|\u767b\u5165/i;
  const matches = labels
    .map((value, index) => ({ index, text: normalizedText(value) }))
    .filter((entry) => entry.text.toLowerCase().includes(expected) && actionPattern.test(entry.text));
  return matches.length === 1 ? matches[0].index : -1;
}

export async function findUniqueOAuthProviderControl(page, provider) {
  const controls = page.locator('button:visible, a:visible, [role="button"]:visible');
  const count = await controls.count();
  if (count === 0 || count > 30) return null;
  const labels = await controls.evaluateAll((elements) => elements.map((element) => [
    element.innerText,
    element.textContent,
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.querySelector("img")?.getAttribute("alt"),
  ].filter(Boolean).join(" ")));
  const index = selectOAuthProviderControlIndex(labels, provider);
  return index >= 0 ? controls.nth(index) : null;
}
