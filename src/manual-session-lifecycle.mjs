import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { atomicWriteJson } from './security.mjs';
import { acquireRunLock, releaseRunLock } from './run-lock.mjs';
import { validManualCompletion, syncManualCompletion } from './manual-result-reconciliation.mjs';
import { readTodayAbandonment } from './manual-abandonment.mjs';

const reasons = new Set(['completed', 'user_requested', 'abandoned', 'external_close']);
export async function dispatchRemainingManualHandoff(root, config = {}) {
  const script = path.join(root, 'scripts/Continue-ManualHandoff.ps1');
  if (process.platform !== 'win32' || !await fs.access(script).then(() => true).catch(() => false)) return false;
  const child = spawn(config.powershellExecutable || 'pwsh.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    { cwd: root, detached: true, windowsHide: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return true;
}
export async function recordManualSessionClosure(root, state, report, config, {
  reason = 'external_close', now = new Date(),
} = {}) {
  const identity = state.sessionId ?? state.launchMarker;
  if (!/^[a-f0-9]{32}$/.test(identity ?? '') || !reasons.has(reason)) throw new Error('Invalid manual closure identity');
  const abandoned = new Set((await readTodayAbandonment(root, now))?.origins ?? []);
  const targets = (state.targets ?? []).map(target => {
    const origin = new URL(target.origin).origin;
    const site = report?.results?.find(result => result.origin === origin);
    const result = target.accountKey ? site?.accountResults?.find(account => account.accountKey === target.accountKey) : site;
    const completed = result && validManualCompletion({ ...result, origin }, now, config);
    return { origin, accountKey: target.accountKey ?? '', status: completed ? result.status : abandoned.has(origin) ? 'abandoned' : 'unconfirmed',
      completedAt: completed ? result.evidence?.confirmedAt ?? null : null };
  });
  const completionConfirmed = targets.length > 0 && targets.every(target => ['signed', 'already_signed', 'not_available'].includes(target.status));
  const handledConfirmed = targets.length > 0 && targets.every(target => ['signed', 'already_signed', 'not_available', 'abandoned'].includes(target.status));
  const entry = { identity, mode: state.mode, state: 'closed', closedAt: now.toISOString(),
    closeReason: completionConfirmed ? 'completed' : handledConfirmed ? 'abandoned' : reason === 'completed' ? 'external_close' : reason,
    completionConfirmed, handledConfirmed, targets };
  const file = path.join(root, 'tmp/manual-session-history.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lease = await acquireRunLock(`${file}.lock`);
  try {
    const history = await fs.readFile(file, 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return { schemaVersion: 1, sessions: [] };
      throw error;
    });
    await atomicWriteJson(file, { schemaVersion: 1,
      sessions: [...(history.sessions ?? []).filter(item => item.identity !== identity), entry].slice(-24) });
  } finally { await releaseRunLock(lease); }
  return entry;
}

const source = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === source) {
  const root = path.dirname(path.dirname(source));
  const reason = process.argv[2];
  const state = JSON.parse(await fs.readFile(path.join(root, 'tmp/manual-session.json'), 'utf8'));
  const report = await fs.readFile(path.join(root, 'logs/latest.json'), 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const config = JSON.parse(await fs.readFile(path.join(root, 'config/config.json'), 'utf8'));
  if (report) await syncManualCompletion(root, report);
  await recordManualSessionClosure(root, state, report, config, { reason });
}
