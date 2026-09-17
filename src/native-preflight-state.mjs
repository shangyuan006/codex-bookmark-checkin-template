function freshNativeResults(report, allowedOrigins, accept, now) {
  const current = now.getTime();
  const fresh = value => {
    const time = Date.parse(value ?? '');
    return Number.isFinite(time) && time <= current
      && new Date(time).toDateString() === now.toDateString();
  };
  if (!fresh(report?.generatedAt)) return new Map();
  return new Map((report?.results ?? [])
    .filter(result => allowedOrigins.has(result?.origin) && accept(result)
      && fresh(result.observedAt ?? report.generatedAt))
    .map(result => [result.origin, result]));
}

export function freshNativePreflightResults(report, allowedOrigins, now = new Date()) {
  return freshNativeResults(report, allowedOrigins, result => ['signed', 'already_signed'].includes(result.status), now);
}

// Blockers apply only to the preflight that immediately precedes this runner.
// Unlike confirmations, they must not survive a new manual/explicit attempt.
export function freshNativePreflightHandoffs(report, allowedOrigins, attemptId, now = new Date()) {
  if (!/^[a-f0-9]{32}$/i.test(attemptId ?? '')) return new Map();
  return freshNativeResults(report, allowedOrigins, result =>
    result.preflightAttemptId === attemptId && result.status === 'interactive_challenge'
      && result.failureCode === 'safeline_client_challenge' && result.retryable === false, now);
}

export function nativePreflightProgress(targets, confirmations) {
  return targets.flatMap(target => {
    const result = confirmations.get(target.origin);
    return result ? [{
      origin: target.origin,
      title: target.title,
      folderNames: target.folderNames,
      status: result.status,
      reason: result.reason,
      url: result.url,
      observedAt: result.observedAt,
      attempt: 0,
      durationMs: 0,
      nativePreflight: true,
      ...(result.retryable === false ? {
        retryable: false,
        failureCode: result.failureCode,
        actionAttempted: result.actionAttempted === true,
        actionOutcome: result.actionOutcome,
      } : {}),
    }] : [];
  });
}
