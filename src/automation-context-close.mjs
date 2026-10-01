export async function closeAutomationContext(context, {
  timeoutMs = 10_000,
  fallback = null,
} = {}) {
  if (!context) {
    return { closed: true, timedOut: false, fallbackAttempted: false, fallbackSucceeded: false };
  }

  const boundedTimeoutMs = Math.max(100, Math.min(30_000, Number(timeoutMs) || 10_000));
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ closed: false, timedOut: true }), boundedTimeoutMs);
  });
  let closeResult;
  try {
    closeResult = await Promise.race([
      Promise.resolve()
        .then(() => context.close())
        .then(
          () => ({ closed: true, timedOut: false }),
          () => ({ closed: false, timedOut: false }),
        ),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (closeResult.closed || typeof fallback !== "function") {
    return { ...closeResult, fallbackAttempted: false, fallbackSucceeded: false };
  }

  try {
    await fallback();
    return { ...closeResult, fallbackAttempted: true, fallbackSucceeded: true };
  } catch {
    return { ...closeResult, fallbackAttempted: true, fallbackSucceeded: false };
  }
}
