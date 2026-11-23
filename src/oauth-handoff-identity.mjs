import path from 'node:path';
import fs from 'node:fs/promises';
import { atomicWriteJson } from './security.mjs';

// Only a visible, tracked project session may use the one handoff-start slot.
// The caller also checks the live process and window identity in PowerShell.
export function assertOAuthHandoffIdentity(state, { accountKey, profile, port, provider, native, stage, root }) {
  if (!native || provider !== 'LinuxDO' || stage !== 'manual_target_oauth'
    || state?.stage !== 'agentrouter' || state.accountKey !== accountKey
    || !Number.isInteger(port) || state.nativeDebugPort !== port
    || !Number.isInteger(state.pid) || state.pid <= 0
    || !Number.isFinite(Date.parse(state.processStartedAt ?? ''))
    || !/^[a-f0-9]{32}$/.test(state.launchMarker ?? '')
    || typeof state.profile !== 'string'
    || path.resolve(root, state.profile).toLowerCase() !== path.resolve(root, profile).toLowerCase()) {
    throw new Error('OAuth handoff identity mismatch');
  }
}

// A successful session probe is durable before stdout or CDP teardown. This
// checkpoint confirms login only; the reward still requires PostOAuthVerify.
export async function recordOAuthHandoffCompletion(stateFile, scope, result, now = new Date()) {
  if (result?.status !== 'logged_in' || result.oauthStage !== 'completed') return false;
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assertOAuthHandoffIdentity(state, scope);
  if (scope.launchMarker !== state.launchMarker) throw new Error('OAuth completion session changed');
  await atomicWriteJson(stateFile, { ...state, oauthCompletion: {
    status: 'logged_in', oauthStage: 'completed', confirmedAt: now.toISOString(),
    launchMarker: state.launchMarker,
  } });
  return true;
}
