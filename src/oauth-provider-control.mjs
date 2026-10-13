function normalizedText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizedProviderText(value) {
  return normalizedText(value).toLowerCase().replace(/linux\s+do/g, "linuxdo");
}

function isProviderLoginAction(label, expected) {
  const actionPattern = /continue|sign\s*in|log\s*in|login|\u7ee7\u7eed|\u7e7c\u7e8c|\u767b\u5f55|\u767b\u9304|\u767b\u5165/i;
  return normalizedProviderText(label).includes(expected) && actionPattern.test(label);
}

export function selectOAuthProviderControlIndex(labels, provider) {
  const expected = normalizedProviderText(provider);
  if (!expected || !Array.isArray(labels)) return -1;
  const matches = labels
    .map((value, index) => ({ index, text: normalizedText(value) }))
    .filter((entry) => isProviderLoginAction(entry.text, expected));
  return matches.length === 1 ? matches[0].index : -1;
}

export async function findUniqueOAuthProviderControl(page, provider, { allowIconOnly = false } = {}) {
  const expected = normalizedProviderText(provider);
  if (!expected) return null;
  const controls = page.locator('button:visible, a:visible, [role="button"]:visible');
  const count = await controls.count();
  if (count === 0 || count > 30) return null;
  const descriptions = await controls.evaluateAll((elements) => elements.map((element) => ({
    label: [
      element.innerText,
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.querySelector("img")?.getAttribute("alt"),
    ].filter(Boolean).join(" "),
    visibleIconLabels: [...element.querySelectorAll("img")].filter(image => {
      const rect = image.getBoundingClientRect(), style = getComputedStyle(image);
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }).map(image => image.getAttribute("alt")),
  })));
  const matches = descriptions.map((description, index) => ({ description, index }))
    .filter(({ description }) => isProviderLoginAction(description.label, expected)
      || (allowIconOnly && description.visibleIconLabels.some(label => normalizedProviderText(label) === expected)));
  return matches.length === 1 ? controls.nth(matches[0].index) : null;
}
