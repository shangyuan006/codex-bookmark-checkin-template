export const OAUTH_HELPER_TIMEOUT_MS = 180_000;
export const OAUTH_CLEANUP_RESERVE_MS = 15_000;
export const OAUTH_SESSION_RESERVE_MS = 15_000;
export const OAUTH_CALLBACK_RESERVE_MS = 15_000;

export class OAuthTimeBudgetError extends Error {
  constructor(phase) {
    super('OAuth time budget exhausted');
    this.code = 'OAUTH_TIME_BUDGET_EXHAUSTED';
    this.phase = phase;
  }
}

// Provider work, callback arrival, session confirmation and cleanup each retain
// their own part of the caller's watchdog. A slow earlier phase cannot borrow
// the final session-confirmation or cleanup reserve.
export function createOAuthTimeBudget({ now = Date.now,
  helperTimeoutMs = OAUTH_HELPER_TIMEOUT_MS, cleanupReserveMs = OAUTH_CLEANUP_RESERVE_MS,
  sessionReserveMs = OAUTH_SESSION_RESERVE_MS, callbackReserveMs = OAUTH_CALLBACK_RESERVE_MS,
} = {}) {
  const startedAt = now();
  const sessionDeadline = startedAt + helperTimeoutMs - cleanupReserveMs;
  const callbackDeadline = sessionDeadline - sessionReserveMs;
  const providerDeadline = callbackDeadline - callbackReserveMs;
  if (providerDeadline <= startedAt || [cleanupReserveMs, sessionReserveMs, callbackReserveMs].some(ms => ms < 0)) {
    throw new Error('Invalid OAuth time budget');
  }
  const deadlines = { provider: providerDeadline, callback: callbackDeadline, session: sessionDeadline };
  let expired = false, timer = null, interactive = false, activePhase = 'provider';
  const budget = {
    startedAt,
    elapsedMs: () => Math.max(0, now() - startedAt),
    assertActive() {
      if (expired || (!interactive && now() >= sessionDeadline)) {
        expired = true;
        throw new OAuthTimeBudgetError(activePhase);
      }
    },
    remainingMs(phase = 'provider') {
      if (!Object.hasOwn(deadlines, phase)) throw new Error('Invalid OAuth budget phase');
      return Math.max(0, deadlines[phase] - now());
    },
    timeoutMs(phase, requestedMs) {
      budget.assertActive();
      const remaining = budget.remainingMs(phase);
      activePhase = phase;
      if (remaining <= 0) throw new OAuthTimeBudgetError(phase);
      return Math.min(requestedMs, remaining);
    },
    deadline(phase, requestedMs) { return now() + budget.timeoutMs(phase, requestedMs); },
    beginInteractiveWait() {
      budget.assertActive();
      interactive = true;
      clearTimeout(timer);
    },
    async run(operation) {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new OAuthTimeBudgetError(activePhase));
        }, budget.remainingMs('session'));
      });
      try {
        return await Promise.race([Promise.resolve().then(operation), timeout]);
      } finally {
        clearTimeout(timer);
        // Late completions after a timeout must not start another OAuth action.
        if (!interactive && now() >= sessionDeadline) expired = true;
      }
    },
  };
  return budget;
}
