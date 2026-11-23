import { createHash } from 'node:crypto';
import { evidenceBinding } from './checkin-evidence.mjs';
import { piggoBusinessDate, piggoCalendarRule } from './piggo-calendar.mjs';

// Deliberately limited to the reviewed calendar contract. Other readers must
// prove their account/day semantics before they can opt into this mechanism.
export function unsignedRecoveryPolicy(target, config = {}) {
  const raw = config.unsignedSubmissionRecoveryRules?.[target.origin];
  if (!raw || raw.enabled === false) return null;
  if (raw.enabled !== true || raw.reader !== 'piggo_calendar'
    || Object.keys(raw).some(key => !['enabled', 'reader', 'actionType'].includes(key))
    || !/^[a-z][a-z0-9_-]{0,63}$/.test(raw.actionType ?? '') || !piggoCalendarRule(target, config)) {
    throw new Error('Unsigned recovery requires a reviewed private account/day reader');
  }
  return raw.actionType === (target.actionType ?? 'checkin') ? raw : null;
}

export function unsignedRecoveryReceipt(result, target, config, profileBinding, now) {
  const policy = unsignedRecoveryPolicy(target, config), proof = result?.evidence;
  const expected = evidenceBinding(target, config, now), at = Date.parse(proof?.confirmedAt ?? '');
  const observed = Date.parse(result?.passiveObservedAt ?? '');
  if (!policy || !/^[a-f0-9]{64}$/.test(profileBinding ?? '') || result.status !== 'not_signed'
    || result.passiveReader !== policy.reader || result.submissionAttempted !== false
    || !/^[a-f0-9]{64}$/.test(result.accountFingerprint ?? '') || proof?.source !== 'status_endpoint'
    || proof.authoritative !== true || proof.outcome !== 'daily_checkin_not_signed'
    || !Number.isFinite(at) || observed !== at || at > now.getTime() || now.getTime() - at > 30_000
    || result.businessDate !== piggoBusinessDate(now) || piggoBusinessDate(at) !== result.businessDate
    || !Number.isFinite(result.passiveDocumentStartedAt) || result.passiveDocumentStartedAt > at
    || ['version', 'siteOrigin', 'accountKey', 'actionType', 'cycleId'].some(key => proof.binding?.[key] !== expected[key])
    || proof.binding?.observedOrigin !== target.origin) return null;
  const receipt = { version: 1, reader: policy.reader, identity: expected, profileBinding,
    accountFingerprint: result.accountFingerprint, businessDate: result.businessDate,
    observedAt: proof.confirmedAt, documentStartedAt: result.passiveDocumentStartedAt };
  return { ...receipt, id: createHash('sha256').update(JSON.stringify(receipt)).digest('hex') };
}

export function validStoredUnsignedRecovery(entry) {
  const saved = entry?.unsignedRecovery, value = saved?.receipt;
  if (!saved || saved.originalOutcome !== 'unknown' || !Array.isArray(saved.originalIntentIds)
    || saved.originalIntentIds.length !== 1 || !value || value.version !== 1 || value.reader !== 'piggo_calendar'
    || !/^[a-f0-9]{64}$/.test(value.profileBinding ?? '') || !/^[a-f0-9]{64}$/.test(value.accountFingerprint ?? '')
    || value.profileBinding !== entry.profileBinding || value.accountFingerprint !== entry.accountFingerprint
    || value.identity?.version !== 2 || value.identity.cycleId !== entry.cycleId
    || ['siteOrigin', 'accountKey', 'actionType'].some(key => value.identity[key] !== entry.identity?.[key])
    || !Number.isFinite(Date.parse(value.observedAt)) || Date.parse(value.observedAt) > Date.parse(entry.startedAt)
    || !Number.isFinite(value.documentStartedAt) || value.documentStartedAt > Date.parse(value.observedAt)
    || piggoBusinessDate(value.observedAt) !== value.businessDate) return false;
  const receipt = { version: 1, reader: value.reader, identity: value.identity, profileBinding: value.profileBinding,
    accountFingerprint: value.accountFingerprint, businessDate: value.businessDate,
    observedAt: value.observedAt, documentStartedAt: value.documentStartedAt };
  return createHash('sha256').update(JSON.stringify(receipt)).digest('hex') === value.id;
}
