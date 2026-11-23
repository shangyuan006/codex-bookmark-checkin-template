import { checkinCycle } from './checkin-cycle.mjs';
import { evidenceBinding } from './checkin-evidence.mjs';

// Explicit opt-in: a missing field or a failed read never disables check-in.
export async function readCheckinFeatureStatus(request, target, config, now = new Date()) {
  if (!config.newApiFeatureStatusOrigins?.includes(target.origin)) return null;
  try {
    const response = await request.get(new URL('/api/status', target.origin).href, {
      timeout: 10000, maxRedirects: 0,
    });
    if (!response.ok() || new URL(response.url()).origin !== target.origin
      || !/\bapplication\/(?:[\w.+-]*\+)?json\b/i.test(response.headers()['content-type'] ?? '')) return null;
    const body = await response.json();
    if (body?.success !== true || body.data?.checkin_enabled !== false) return null;
    return { origin: target.origin, status: 'not_available', availabilityKind: 'feature_disabled',
      reason: '站点状态接口明确关闭了签到功能', observedAt: now.toISOString(),
      cycle: checkinCycle(target.origin, config, now),
      evidence: { source: 'new_api_checkin_status', outcome: 'enabled_false', authoritative: true,
        confirmedAt: now.toISOString(), binding: { ...evidenceBinding(target, config, now), observedOrigin: target.origin } } };
  } catch { return null; }
}
