import { assertBookmarkNavigation } from './security.mjs';

export function isNavigationContextLoss(error) {
  return /execution context was destroyed|cannot find context with specified id|cannot find context with id/i.test(String(error?.message ?? ''));
}

// Retry observations only. Never place a click, drag, navigation or POST here.
export async function readAfterNavigation(page, read, {
  timeoutMs = 3000, maxAttempts = 3, retryDelayMs = 150,
} = {}) {
  const origin = new URL(page.url()).origin;
  const deadline = Date.now() + Math.max(1, Math.min(5000, timeoutMs));
  const attempts = Math.max(1, Math.min(3, maxAttempts));
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (page.isClosed?.()) throw new Error('Page closed during state observation');
    const before = assertBookmarkNavigation(page.url(), [origin]);
    try {
      const result = await read();
      const after = assertBookmarkNavigation(page.url(), [origin]);
      if (before !== after) throw new Error('Execution context was destroyed during state observation');
      return result;
    } catch (error) {
      if (!isNavigationContextLoss(error) || page.isClosed?.()
        || attempt + 1 >= attempts || Date.now() >= deadline) throw error;
      await page.waitForLoadState('domcontentloaded', {
        timeout: Math.max(1, Math.min(1000, deadline - Date.now())),
      }).catch(loadError => {
        if (loadError?.name !== 'TimeoutError' && !isNavigationContextLoss(loadError)) throw loadError;
      });
      const delay = Math.max(0, Math.min(retryDelayMs, deadline - Date.now()));
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
