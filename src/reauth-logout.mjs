import { findUniqueOAuthProviderControl } from './oauth-provider-control.mjs';
import { readOAuthTargetSurface } from './oauth-target-state.mjs';

export async function readReauthLogoutEvidence(page, rule) {
  const config = { reauthCheckinRules: { [rule.origin]: rule } };
  const surface = await readOAuthTargetSurface(page, rule.origin, config);
  if (surface.kind !== 'target_login' || !surface.ready || surface.authenticatedControl) {
    return { confirmed: false, targetSurface: surface.kind };
  }
  const providerControl = await findUniqueOAuthProviderControl(page, rule.provider, { allowIconOnly: true });
  const providerReady = Boolean(providerControl && await providerControl.isEnabled().catch(() => false));
  return { confirmed: providerReady || surface.passwordReady === true, targetSurface: surface.kind };
}

export async function waitForReauthLogout(page, rule, {
  timeoutMs = rule.evidenceWaitMs, stableMs = 1000, pollMs = 250,
  readEvidence = readReauthLogoutEvidence, now = Date.now,
} = {}) {
  const deadline = now() + Math.max(1000, Math.min(30000, Number(timeoutMs) || 15000));
  let stableSince = null;
  let current = { confirmed: false, targetSurface: 'unavailable' };
  do {
    try {
      current = await readEvidence(page, rule);
    } catch {
      // A navigation can detach the login controls between two reads. Keep
      // waiting within this boundary instead of closing the new login page.
      current = { confirmed: false, targetSurface: 'unavailable' };
    }
    if (current.targetSurface === 'other_origin' || page.isClosed?.()) return { ...current, confirmed: false };
    if (current.confirmed === true) {
      stableSince ??= now();
      if (now() - stableSince >= stableMs) return current;
    } else stableSince = null;
    if (now() >= deadline) break;
    await page.waitForTimeout(Math.min(pollMs, Math.max(0, deadline - now())));
  } while (true);
  return { ...current, confirmed: false };
}
