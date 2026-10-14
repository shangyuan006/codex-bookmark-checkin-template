import { checkinCycle } from './checkin-cycle.mjs';

// Account IDs stay in private configuration and request headers, never receipts.
export function newApiCheckinOptions(target, config = {}, now = new Date()) {
  const origin = new URL(target.origin).origin;
  const rule = config.newApiAccountRules?.[origin] ?? {};
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)
    || Object.keys(rule).some(key => !['expectedAccountId', 'requireCalendarRecord'].includes(key))) {
    throw new Error('Invalid private New API account rule');
  }
  const expectedAccountId = rule.expectedAccountId == null ? null : String(rule.expectedAccountId);
  if (expectedAccountId != null && (!/^[1-9][0-9]{0,19}$/.test(expectedAccountId)
    || typeof rule.expectedAccountId === 'number' && !Number.isSafeInteger(rule.expectedAccountId))) {
    throw new Error('Expected New API account ID must be a positive decimal string');
  }
  if (rule.requireCalendarRecord != null && typeof rule.requireCalendarRecord !== 'boolean') {
    throw new Error('requireCalendarRecord must be a boolean');
  }
  const cycle = checkinCycle(origin, config, now);
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: cycle.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(cycle.startAt));
  const parts = Object.fromEntries(dateParts.map(part => [part.type, part.value]));
  return { expectedAccountId, requireCalendarRecord: rule.requireCalendarRecord === true,
    timeZone: cycle.timeZone, checkinDate: `${parts.year}-${parts.month}-${parts.day}`, cycleEndAt: cycle.endAt };
}
