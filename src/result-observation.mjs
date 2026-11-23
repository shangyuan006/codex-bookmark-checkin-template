import { isTerminalResult } from './result-contract.mjs';
import { reconcileCheckinResult } from './checkin-evidence.mjs';
import { normalizeResultActionEntries } from './sequential-action-evidence.mjs';

const unresolved = new Set(['no_action', 'unconfirmed', 'needs_attention', 'login_required',
  'interactive_challenge', 'managed_challenge', 'managed_challenge_timeout', 'deferred', 'error']);
const identity = result => JSON.stringify([result?.origin, result?.accountKey ?? 'default', result?.actionType ?? 'checkin']);
const day = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', dateStyle: 'short' }).format(new Date(value));
const child = (item, parent) => ({ ...item, origin: item.origin ?? parent.origin,
  accountKey: item.accountKey ?? parent.accountKey ?? 'default' });
const actionKeys = (values, parent) => values.map(item => identity(child(item, parent))).sort();
function compatibleActionShape(current, incoming) {
  const left = current.actionResults ?? [], right = incoming.actionResults ?? [];
  const prior = current.requiredActionTypes ?? [], next = incoming.requiredActionTypes ?? [];
  if (![left, right, prior, next].every(Array.isArray)) return false;
  const declared = values => values.length > 0 && values.length <= 8 && new Set(values).size === values.length
    && values.every(value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value));
  const sameDeclarations = JSON.stringify([...prior].sort()) === JSON.stringify([...next].sort());
  // Only an early result without a declared or observed step may discover its
  // task shape. An established declaration can never be replaced or dropped.
  if (!sameDeclarations && (prior.length || left.length || !declared(next))) return false;
  if (left.length === right.length && JSON.stringify(actionKeys(left, current)) === JSON.stringify(actionKeys(right, incoming))
    && sameDeclarations) return true;
  if (!declared(next) || left.length > right.length || right.length > next.length) return false;
  const keys = actionKeys(right, incoming);
  const cycleId = incoming.cycle?.id ?? current.cycle?.id;
  return new Set(keys).size === keys.length && actionKeys(left, current).every(key => keys.includes(key))
    && right.every(item => {
      const value = child(item, incoming);
      return value.origin === incoming.origin && value.accountKey === (incoming.accountKey ?? 'default')
        && next.includes(value.actionType) && (!cycleId || !item.cycle?.id || cycleId === item.cycle.id)
        && !item.accountResults?.length && !item.actionResults?.length;
    });
}

export function sameResultIdentity(current, incoming) {
  current = normalizeResultActionEntries(current);
  incoming = normalizeResultActionEntries(incoming);
  if (identity(current) !== identity(incoming)) return false;
  if (current.cycle?.id && incoming.cycle?.id && current.cycle.id !== incoming.cycle.id) return false;
  for (const field of ['accountResults']) {
    const left = current[field] ?? [], right = incoming[field] ?? [];
    if (left.length !== right.length) return false;
    if (JSON.stringify(actionKeys(left, current)) !== JSON.stringify(actionKeys(right, incoming))) return false;
  }
  return compatibleActionShape(current, incoming);
}

export function failureObservation(result, at) {
  return Object.fromEntries(['status', 'reason', 'failureCode', 'retryCause', 'retryable', 'manualBrowserMode']
    .filter(key => result[key] !== undefined).map(key => [key, result[key]]).concat([['observedAt', at]]));
}

// Supplements may refine a failure, but can never revoke a completed task or
// cross the account/action/cycle boundary. Old observations remain auditable.
export function newerUnresolvedObservation(current, incoming, { currentAt, incomingAt, now = new Date() } = {}) {
  current = normalizeResultActionEntries(current);
  incoming = normalizeResultActionEntries(incoming);
  if (!incoming || !unresolved.has(incoming.status) || isTerminalResult(current, now)
    || ['signed', 'already_signed', 'abandoned'].includes(current.status) || !sameResultIdentity(current, incoming)) return null;
  const timestamp = value => typeof value === 'number' ? value : Date.parse(value ?? '');
  const prior = timestamp(current.observedAt ?? currentAt);
  const next = timestamp(incoming.observedAt ?? incomingAt);
  if (!Number.isFinite(prior) || !Number.isFinite(next) || next <= prior || next > now.getTime()
    || day(prior) !== day(next) || day(next) !== day(now)) return null;
  const observedAt = new Date(next).toISOString();
  for (const item of incoming.actionResults ?? []) {
    const value = child(item, incoming);
    if ((current.actionResults ?? []).some(old => identity(child(old, current)) === identity(value))) continue;
    if (unresolved.has(item.status)) continue;
    const checked = reconcileCheckinResult({ ...value, cycle: item.cycle ?? incoming.cycle }, item.evidence, now,
      { target: value, requireBinding: true });
    if (!['signed', 'already_signed'].includes(item.status) || checked.status !== item.status) return null;
  }
  const result = { ...current, ...incoming, observedAt,
    ...(current.cycle?.id && !incoming.cycle?.id ? { cycle: current.cycle } : {}),
    observationHistory: [...(current.observationHistory ?? []), failureObservation(current, new Date(prior).toISOString())].slice(-8) };
  for (const key of ['failureCode', 'retryCause', 'nextEligibleAt', 'manualBrowserMode', 'evidence']) {
    if (!Object.hasOwn(incoming, key)) delete result[key];
  }
  for (const field of ['accountResults', 'actionResults']) {
    if (!current[field]?.length) continue;
    result[field] = incoming[field].map(candidate => {
      const item = current[field].find(other => identity(child(other, current)) === identity(child(candidate, incoming)));
      if (!item) return candidate;
      if (isTerminalResult(item, now) || ['signed', 'already_signed'].includes(item.status)) return item;
      return newerUnresolvedObservation(child(item, current), child(candidate, incoming),
        { currentAt: prior, incomingAt: next, now }) ?? item;
    });
  }
  return result;
}
