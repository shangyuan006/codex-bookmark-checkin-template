import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { atomicWriteJson } from './security.mjs';
import { acquireRunLock, releaseRunLock } from './run-lock.mjs';
import { reauthRecoveryAction } from './reauth-recovery.mjs';

export function isUnresolvedOAuthChallenge(result) {
  return ['provider_challenge_unresolved', 'provider_challenge_not_clickable'].includes(result?.authorizationOutcome)
    || ['unresolved_after_click', 'observed_not_clickable'].includes(result?.providerAuthorizationChallengeOutcome);
}

export function isStalledOAuthCallback(result) {
  return result?.succeeded !== true && result?.status !== 'logged_in'
    && result?.authorizationOutcome === 'authorization_departed'
    && ['target_callback', 'session_verification'].includes(result?.oauthStage)
    && ['target_not_returned', 'budget_exhausted'].includes(result?.callbackWaitDiagnostics?.outcome);
}

// A budget belongs to one verified logout, never to another account or day.
export function oauthRetryBudgetBinding(account, previous, now = new Date()) {
  if (account?.provider !== 'LinuxDO' || !account.statePath
    || reauthRecoveryAction(previous, now) !== 'resume') return null;
  return {
    file: `${account.statePath}.oauth-budget.json`,
    key: createHash('sha256').update(`${account.origin}::${account.accountKey}`).digest('hex'),
    cycle: createHash('sha256').update(`${previous.date}::${previous.updatedAt}`).digest('hex'),
    limit: Math.max(1, Math.min(3, Number(account.oauthAttempts) || 2)),
  };
}

async function readBudget(binding) {
  let data;
  try { data = JSON.parse(await fs.readFile(binding.file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const saved = data?.entries?.[binding.key];
  const entry = saved?.cycle === binding.cycle ? saved
    : { cycle: binding.cycle, automatic: 0, native: 0, challengeBlocked: false };
  if (!Object.hasOwn(entry, 'callbackBlocked')) entry.callbackBlocked = false;
  if (!Number.isInteger(entry.automatic) || !Number.isInteger(entry.native)
    || entry.automatic < 0 || entry.native < 0 || typeof entry.challengeBlocked !== 'boolean'
    || typeof entry.callbackBlocked !== 'boolean') {
    throw new Error('Invalid OAuth retry budget');
  }
  return { data: { version: 1, entries: data?.entries ?? {} }, entry };
}

export async function inspectOAuthRetryBudget(binding) {
  if (!binding) return { automaticAllowed: true, nativeAllowed: true };
  const { entry } = await readBudget(binding);
  return { automaticAllowed: !entry.challengeBlocked && !entry.callbackBlocked && entry.automatic < binding.limit,
    nativeAllowed: entry.native < 1 };
}

export async function updateOAuthRetryBudget(binding, mode, result = null) {
  if (!binding) return { allowed: true };
  if (!['automatic', 'native'].includes(mode)) throw new Error('Invalid OAuth retry mode');
  const lease = await acquireRunLock(`${binding.file}.lock`);
  try {
    const { data, entry } = await readBudget(binding);
    if (result === null) {
      const allowed = mode === 'native' ? entry.native < 1
        : !entry.challengeBlocked && !entry.callbackBlocked && entry.automatic < binding.limit;
      if (!allowed) return { allowed: false };
      entry[mode]++;
    } else {
      if (isUnresolvedOAuthChallenge(result)) entry.challengeBlocked = true;
      if (isStalledOAuthCallback(result)) entry.callbackBlocked = true;
    }
    data.entries[binding.key] = entry;
    await atomicWriteJson(binding.file, data);
    return { allowed: true };
  } finally { await releaseRunLock(lease); }
}
