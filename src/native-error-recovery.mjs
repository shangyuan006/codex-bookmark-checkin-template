import { assertBookmarkNavigation } from './security.mjs';

const recoverable = new Set(['ERR_BLOCKED_BY_CLIENT', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_TIMED_OUT', 'ERR_TIMED_OUT', 'ERR_NAME_NOT_RESOLVED',
  'ERR_NETWORK_CHANGED', 'ERR_INTERNET_DISCONNECTED', 'ERR_EMPTY_RESPONSE']);

export async function readNativeErrorDocument(page) {
  return page.evaluate(() => {
    if (!/^(?:chrome|edge)-error:$/.test(location.protocol) && !document.querySelector('#main-frame-error')) return null;
    const codes = String(document.body?.innerText ?? '').match(/\bERR_[A-Z_]+\b/g) ?? [];
    return codes.length === 1 ? codes[0] : null;
  }).catch(() => null);
}

function recoveryRule(target, config) {
  const navigation = config.preCheckinNavigationRules?.[target.origin];
  if (navigation?.dailyUnsignedForm) {
    const homes = (config.nativeChallengePreflight ?? []).flatMap(entry => {
      try {
        const url = new URL(assertBookmarkNavigation(entry.url, [target.origin]));
        return url.origin === target.origin && !url.search && !url.hash
          && (navigation.terminalMissingControlPaths ?? ['/', '/index.php']).includes(url.pathname)
          && !navigation.terminalPaths?.includes(url.pathname) ? [url.href] : [];
      } catch { return []; }
    });
    if (homes.length !== 1) return null;
    return { expectedPaths: [navigation.expectedPath, new URL(homes[0]).pathname], destination: homes[0], terminalPaths: navigation.terminalPaths ?? [] };
  }
  const manual = config.samePageManualCheckinRules?.[target.origin];
  const steps = config.sequentialActionRules?.[target.origin]?.steps;
  if (manual?.browserMode !== 'native' || steps?.length !== 1 || steps[0].actionType !== manual.sequentialActionType) return null;
  try {
    const url = new URL(assertBookmarkNavigation(steps[0].url, [target.origin]));
    if (url.pathname !== manual.expectedPath || url.search || url.hash) return null;
    return { expectedPaths: [manual.expectedPath], destination: url.href, terminalPaths: [] };
  } catch { return null; }
}

export async function boundNativeErrorUrl(page, target, config) {
  if (!recoverable.has(await readNativeErrorDocument(page))) return null;
  const rule = recoveryRule(target, config);
  if (!rule) return null;
  let session;
  try {
    session = await page.context().newCDPSession(page);
    const [history, info] = await Promise.all([session.send('Page.getNavigationHistory'), session.send('Target.getTargetInfo')]);
    const value = history.entries?.[history.currentIndex]?.url;
    if (!value || value !== info.targetInfo?.url) return null;
    const url = new URL(assertBookmarkNavigation(value, [target.origin]));
    return !url.search && !url.hash && rule.expectedPaths.includes(url.pathname)
      && !rule.terminalPaths.includes(url.pathname) ? url.href : null;
  } catch { return null; }
  finally { await session?.detach().catch(() => {}); }
}

export async function selectNativeErrorPage(pages, target, config) {
  const candidates = [];
  for (const page of pages) if (await boundNativeErrorUrl(page, target, config)) candidates.push(page);
  return candidates.length === 1 ? candidates[0] : null;
}

// Recover only a uniquely bound browser error, never a live verification form.
// The caller persists attempted across observer passes, even if GET fails.
export async function recoverNativeErrorPage(page, target, config, { currentPending = false, attempted = false, pages = [page] } = {}) {
  const code = await readNativeErrorDocument(page);
  if (!code) return null;
  const result = { attempted, recovered: false, outcome: attempted ? 'already_attempted' : 'recovery_not_allowed' };
  if (attempted || currentPending || !recoverable.has(code)
    || await selectNativeErrorPage(pages, target, config) !== page) return result;
  const rule = recoveryRule(target, config);
  await page.goto(rule.destination, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs ?? 15000 }).catch(() => {});
  const recovered = page.url() === rule.destination && !await readNativeErrorDocument(page);
  return { attempted: true, recovered, outcome: recovered ? 'entry_restored' : 'entry_restore_failed' };
}
