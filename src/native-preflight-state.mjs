export function freshNativePreflightResults(report, allowedOrigins, now = new Date()) {
  const current = now.getTime();
  const fresh = value => {
    const time = Date.parse(value ?? '');
    return Number.isFinite(time) && time <= current
      && new Date(time).toDateString() === now.toDateString();
  };
  if (!fresh(report?.generatedAt)) return new Map();
  return new Map((report?.results ?? [])
    .filter(result => allowedOrigins.has(result?.origin) && ['signed', 'already_signed'].includes(result.status)
      && fresh(result.observedAt ?? report.generatedAt))
    .map(result => [result.origin, result]));
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
    }] : [];
  });
}
