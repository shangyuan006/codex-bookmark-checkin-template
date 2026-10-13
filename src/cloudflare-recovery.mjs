const finished = new Set(['signed','already_signed','login_required','deferred','needs_attention','not_available','error']);
const challenge = state => ['interactive_challenge','managed_challenge'].includes(state?.status)
  || state?.unresolvedChallenge === true;

export function getCloudflareRecoveryRule(origin, config = {}) {
  const raw = config.cloudflareRecoveryRules?.[origin];
  if (!raw || raw.enabled === false) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Cloudflare recovery rule must be an object');
  return {
    waitMs: Math.max(1000, Math.min(60_000, Number(raw.waitMs) || 45_000)),
    maxClicks: Math.max(1, Math.min(3, Math.trunc(Number(raw.maxClicks) || 3))),
    settleMs: Math.max(2000, Math.min(10_000, Number(raw.settleMs) || 5000)),
    frameStableMs: Math.max(3000, Math.min(5000, Number(raw.frameStableMs) || 4000)),
  };
}

export function cloudflareRecoveryHandoff(attempts) {
  return {status:'interactive_challenge',
    reason:'Cloudflare 验证在有限点击和等待后仍未确认通过，停止自动重试并转原生可见浏览器人工处理',
    failureCode:'cloudflare_verification_unresolved',retryable:false,
    manualBrowserMode:'native',challengeAttempts:attempts};
}

// Preserve the current document. Never reload it or repeat the check-in action.
// Only counters and booleans leave this function; frame URLs/tokens stay private.
export async function continueCloudflareRecovery({readState, clickChallenge, wait,
  now = Date.now, waitMs = 45_000, maxClicks = 3, settleMs = 5000, initialAttempts = 0}) {
  const deadline = now() + Math.max(0, Math.min(60_000, Number(waitMs) || 0));
  maxClicks = Math.max(1, Math.min(3, Math.trunc(Number(maxClicks) || 3)));
  settleMs = Math.max(2000, Math.min(10_000, Number(settleMs) || 5000));
  let attempts = initialAttempts;
  let nextClickAt = now() + (attempts > 0 ? settleMs : 0);
  let resolvedSince = null;
  let observed = attempts > 0;
  while (true) {
    const state = await readState();
    if (finished.has(state?.status)) return state;
    const unresolved = challenge(state);
    observed ||= unresolved;
    if (!observed) return state;
    if (!unresolved && state?.status === 'ready') {
      resolvedSince ??= now();
      if (now() - resolvedSince >= settleMs) return state;
    } else resolvedSince = null;
    if (now() >= deadline) return cloudflareRecoveryHandoff(attempts);
    if (unresolved && now() >= nextClickAt) {
      if (attempts >= maxClicks) return cloudflareRecoveryHandoff(attempts);
      if (state.status === 'interactive_challenge') {
        const result = await clickChallenge();
        if (result.clicked) attempts += 1;
        if (['challenge_not_unique','challenge_frame_not_unique','challenge_click_failed'].includes(result.outcome)) {
          return cloudflareRecoveryHandoff(attempts);
        }
        nextClickAt = now() + settleMs;
      }
    }
    const remaining = deadline - now();
    if (remaining > 0) await wait(Math.min(500, remaining));
  }
}
