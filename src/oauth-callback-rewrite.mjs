function normalizeHttpsOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function rewriteConfiguredOAuthCallbackUrl(
  currentUrl,
  targetOrigin,
  aliasesByTarget = {},
) {
  const normalizedTarget = normalizeHttpsOrigin(targetOrigin);
  if (!normalizedTarget) return null;

  let current;
  try {
    current = new URL(currentUrl);
  } catch {
    return null;
  }
  if (current.protocol !== "https:" || current.username || current.password
    || current.origin === normalizedTarget) return null;

  const configuredAliases = aliasesByTarget?.[normalizedTarget];
  if (!Array.isArray(configuredAliases)) return null;
  const allowed = configuredAliases.some(
    (candidate) => normalizeHttpsOrigin(candidate) === current.origin,
  );
  if (!allowed) return null;

  return `${normalizedTarget}${current.pathname}${current.search}${current.hash}`;
}
