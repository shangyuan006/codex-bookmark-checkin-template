// Return the inspected DOM element, not an indexed locator that could move to
// a different control when an announcement or a new login card is inserted.
// Trial clicks check actionability only; this helper never submits a login.
export async function waitForStableOAuthProviderControl(page, {
  findControl,
  preparePage = async () => {},
  handleChallenge = async () => {},
  assertActive = () => {},
  timeoutMs = 20_000,
  now = Date.now,
  wait = ms => page.waitForTimeout(ms),
} = {}) {
  const deadline = now() + Math.max(1, Math.min(120_000, Number(timeoutMs) || 20_000));
  let previous = null, current = null, previousUrl = null;
  try {
    while (now() < deadline) {
      assertActive();
      await preparePage();
      assertActive();
      if (now() >= deadline) break;
      const candidate = await findControl();
      if (now() >= deadline) break;
      let actionable = false;
      try {
        if (candidate && await candidate.count() === 1) {
          current = await candidate.elementHandle({ timeout: Math.min(1_000, deadline - now()) });
          if (current && await current.isVisible() && await current.isEnabled()) {
            await current.click({ trial: true, timeout: Math.max(1, Math.min(1_000, deadline - now())) });
            actionable = now() < deadline;
          }
        }
      } catch { /* detached, disabled, or covered controls are not ready */ }
      assertActive();
      if (actionable && previous && previousUrl === page.url()
        && await current.evaluate((element, other) => element === other, previous).catch(() => false)) {
        await previous.dispose().catch(() => {});
        previous = null;
        const ready = current;
        current = null;
        return ready;
      }
      await previous?.dispose().catch(() => {});
      previous = actionable ? current : null;
      previousUrl = actionable ? page.url() : null;
      if (!actionable) {
        await current?.dispose().catch(() => {});
        if (now() < deadline) await handleChallenge();
      }
      current = null;
      assertActive();
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await wait(Math.min(500, remaining));
    }
    return null;
  } finally {
    await previous?.dispose().catch(() => {});
    await current?.dispose().catch(() => {});
  }
}
