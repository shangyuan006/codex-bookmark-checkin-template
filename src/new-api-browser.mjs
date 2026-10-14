import { reconcileCheckinResult } from './checkin-evidence.mjs';
import { runCheckinAdapter } from './checkin-adapters.mjs';
import { runNewApiProtocol } from './new-api-protocol.mjs';

export { runNewApiProtocol as runNewApiCheckinInBrowser } from './new-api-protocol.mjs';

export async function tryNewApiCheckin(page, options = {}) {
  const outcome = await runCheckinAdapter({
    id: 'new_api_browser',
    detect: async () => ({ supported: true }),
    execute: async () => ({ result: await page.evaluate(runNewApiProtocol, options) }),
    verify: async ({ result }) => reconcileCheckinResult(result),
  }, {});
  return outcome.result ?? null;
}
